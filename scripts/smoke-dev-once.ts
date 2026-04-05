#!/usr/bin/env -S node --import tsx
import { execFile as execFileCallback, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const instanceId = "default";
const startupTimeoutMs = 150_000;
const shutdownTimeoutMs = 30_000;
const healthPollIntervalMs = 1_000;
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const spawnUsesShell = process.platform === "win32";
const execFile = promisify(execFileCallback);
const tempHomeCleanupRetryCount = 20;
const tempHomeCleanupRetryDelayMs = 500;

type CommandResult = {
  code: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

function createTempPaperclipHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-dev-once-smoke-"));
}

async function reservePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to determine reserved port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function allocateDistinctPorts(count: number): Promise<number[]> {
  const ports = new Set<number>();
  while (ports.size < count) {
    ports.add(await reservePort());
  }
  return [...ports];
}

function writeTempConfig(tempHome: string, serverPort: number, dbPort: number) {
  const instanceRoot = path.join(tempHome, "instances", instanceId);
  const configPath = path.join(instanceRoot, "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });

  const config = {
    $meta: {
      version: 1,
      updatedAt: new Date().toISOString(),
      source: "doctor",
    },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: path.join(instanceRoot, "db"),
      embeddedPostgresPort: dbPort,
      backup: {
        enabled: false,
        intervalMinutes: 60,
        retentionDays: 1,
        dir: path.join(instanceRoot, "data", "backups"),
      },
    },
    logging: {
      mode: "file",
    },
    server: {
      deploymentMode: "local_trusted",
      host: "127.0.0.1",
      port: serverPort,
      serveUi: true,
    },
    auth: {
      baseUrlMode: "auto",
    },
    storage: {
      provider: "local_disk",
      localDisk: {
        baseDir: path.join(instanceRoot, "data", "storage"),
      },
    },
    secrets: {
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: {
        keyFilePath: path.join(instanceRoot, "secrets", "master.key"),
      },
    },
    telemetry: {
      enabled: false,
    },
  };

  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function toError(error: unknown, fallback = "Command failed"): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string") return new Error(error);
  if (error === undefined) return new Error(fallback);
  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error(String(error));
  }
}

function spawnPnpm(
  args: string[],
  env: NodeJS.ProcessEnv,
  options: { stdio?: "inherit" | ["ignore", "pipe", "pipe"] } = {},
) {
  return spawn(pnpmCommand, args, {
    cwd: repoRoot,
    env,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    shell: spawnUsesShell,
  });
}

async function runPnpm(
  args: string[],
  env: NodeJS.ProcessEnv,
  options: { stdio?: "inherit" | ["ignore", "pipe", "pipe"] } = {},
): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawnPnpm(args, env, options);
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      resolve({
        code: code ?? 0,
        signal,
        stdout,
        stderr,
      });
    });
  });
}

async function waitForExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }> {
  if (child.exitCode !== null) {
    return { code: child.exitCode, signal: child.signalCode, timedOut: false };
  }

  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ code: null, signal: null, timedOut: true });
    }, timeoutMs);

    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut: false });
    });
  });
}

async function forceKillProcessTree(pid: number) {
  if (process.platform === "win32") {
    await execFile("taskkill", ["/PID", `${pid}`, "/T", "/F"]).catch(() => undefined);
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  await delay(1_000);
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Best effort only.
  }
}

async function cleanupTempHome(tempHome: string) {
  for (let attempt = 0; attempt < tempHomeCleanupRetryCount; attempt += 1) {
    try {
      fs.rmSync(tempHome, { recursive: true, force: true });
      return;
    } catch (error) {
      const isLastAttempt = attempt === tempHomeCleanupRetryCount - 1;
      if (isLastAttempt) {
        const err = toError(error, `Failed to remove temporary PAPERCLIP_HOME at ${tempHome}`);
        process.stderr.write(`[paperclip] warning: ${err.message}\n`);
        return;
      }
      await delay(tempHomeCleanupRetryDelayMs);
    }
  }
}

async function waitForHealthyServer(
  port: number,
  child: ReturnType<typeof spawn>,
  stdoutRef: { value: string },
  stderrRef: { value: string },
) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < startupTimeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(
        `pnpm dev:once exited before health became ready (code=${child.exitCode}).\nSTDOUT:\n${stdoutRef.value}\nSTDERR:\n${stderrRef.value}`,
      );
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until startup timeout.
    }

    await delay(healthPollIntervalMs);
  }

  throw new Error(
    `Timed out waiting for pnpm dev:once health on port ${port}.\nSTDOUT:\n${stdoutRef.value}\nSTDERR:\n${stderrRef.value}`,
  );
}

async function stopManagedDevRunner(
  env: NodeJS.ProcessEnv,
  child: ReturnType<typeof spawn>,
  stdoutRef: { value: string },
  stderrRef: { value: string },
) {
  const stopResult = await runPnpm(["dev:stop"], env);
  if (stopResult.code !== 0) {
    throw new Error(
      `pnpm dev:stop failed with code ${stopResult.code}.\nSTDOUT:\n${stopResult.stdout}\nSTDERR:\n${stopResult.stderr}\nDEV STDOUT:\n${stdoutRef.value}\nDEV STDERR:\n${stderrRef.value}`,
    );
  }

  const exit = await waitForExit(child, shutdownTimeoutMs);
  if (!exit.timedOut) {
    return;
  }

  if (typeof child.pid === "number") {
    await forceKillProcessTree(child.pid);
  }
  throw new Error(
    `pnpm dev:once did not exit within ${shutdownTimeoutMs}ms after pnpm dev:stop.\nSTDOUT:\n${stdoutRef.value}\nSTDERR:\n${stderrRef.value}`,
  );
}

async function main() {
  const [serverPort, dbPort] = await allocateDistinctPorts(2);
  const tempHome = createTempPaperclipHome();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PAPERCLIP_HOME: tempHome,
    PAPERCLIP_INSTANCE_ID: instanceId,
    BETTER_AUTH_SECRET: "paperclip-dev-once-smoke-secret",
    HEARTBEAT_SCHEDULER_ENABLED: "false",
    PAPERCLIP_DB_BACKUP_ENABLED: "false",
  };

  writeTempConfig(tempHome, serverPort, dbPort);

  const stdoutRef = { value: "" };
  const stderrRef = { value: "" };
  const spawnErrorRef = { value: null as Error | null };
  const child = spawnPnpm(["dev:once"], env);

  child.stdout?.on("data", (chunk) => {
    stdoutRef.value += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderrRef.value += String(chunk);
  });
  child.on("error", (error) => {
    spawnErrorRef.value = error;
    stderrRef.value += `${error.stack ?? error.message}\n`;
  });

  try {
    if (spawnErrorRef.value) {
      throw spawnErrorRef.value;
    }
    await waitForHealthyServer(serverPort, child, stdoutRef, stderrRef);
    console.log(`[paperclip] pnpm dev:once health check passed on http://127.0.0.1:${serverPort}/api/health`);
    await stopManagedDevRunner(env, child, stdoutRef, stderrRef);
  } catch (error) {
    if (typeof child.pid === "number" && child.exitCode === null) {
      await forceKillProcessTree(child.pid).catch(() => undefined);
    }
    throw error;
  } finally {
    await cleanupTempHome(tempHome);
  }
}

main().catch((error) => {
  const err = toError(error, "pnpm dev:once smoke failed");
  process.stderr.write(`${err.stack ?? err.message}\n`);
  process.exit(1);
});
