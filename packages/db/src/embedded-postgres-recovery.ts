import { execFile as execFileCallback } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const portReleaseRetryCount = 20;
const portReleaseDelayMs = 250;

type RecoveryDeps = {
  existsSync: typeof existsSync;
  readFileSync: typeof readFileSync;
  isPortInUse: (port: number) => Promise<boolean>;
  listListeningPids: (port: number, platform: NodeJS.Platform) => Promise<number[]>;
  terminateProcessTree: (pid: number, platform: NodeJS.Platform) => Promise<void>;
  waitForPortRelease: (port: number, isPortInUse: (port: number) => Promise<boolean>) => Promise<boolean>;
  platform: NodeJS.Platform;
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error === undefined) return "";
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function normalizePathForCommandLine(input: string): string {
  return path.resolve(input).replace(/\\/g, "/");
}

function postmasterOptsMatchesPreferredCluster(
  postmasterOptsContents: string,
  dataDir: string,
  preferredPort: number,
): boolean {
  const normalized = postmasterOptsContents.replace(/\\/g, "/");
  const normalizedDataDir = normalizePathForCommandLine(dataDir);

  return (
    normalized.toLowerCase().includes("embedded-postgres") &&
    normalized.includes(`"${normalizedDataDir}"`) &&
    normalized.includes(`"${preferredPort}"`)
  );
}

async function defaultIsPortInUse(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => {
      resolve(error.code === "EADDRINUSE");
    });
    server.listen(port, "127.0.0.1", () => {
      server.close();
      resolve(false);
    });
  });
}

function parseWindowsListeningPids(stdout: string, port: number): number[] {
  const pids = new Set<number>();

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 5 || parts[0].toUpperCase() !== "TCP" || parts[3].toUpperCase() !== "LISTENING") {
      continue;
    }
    if (!parts[1]?.endsWith(`:${port}`)) continue;
    const pid = Number(parts[4]);
    if (Number.isInteger(pid) && pid > 0) {
      pids.add(pid);
    }
  }

  return [...pids];
}

async function defaultListListeningPids(port: number, platform: NodeJS.Platform): Promise<number[]> {
  if (platform === "win32") {
    try {
      const { stdout } = await execFile("netstat", ["-ano", "-p", "tcp"]);
      return parseWindowsListeningPids(stdout, port);
    } catch {
      return [];
    }
  }

  try {
    const { stdout } = await execFile("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
    return stdout
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

async function defaultTerminateProcessTree(pid: number, platform: NodeJS.Platform): Promise<void> {
  if (platform === "win32") {
    try {
      await execFile("taskkill", ["/PID", `${pid}`, "/T", "/F"]);
    } catch {
      // Best effort only.
    }
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Best effort only.
  }
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultWaitForPortRelease(
  port: number,
  isPortInUse: (port: number) => Promise<boolean>,
): Promise<boolean> {
  for (let attempt = 0; attempt < portReleaseRetryCount; attempt += 1) {
    if (!(await isPortInUse(port))) return true;
    await wait(portReleaseDelayMs);
  }
  return !(await isPortInUse(port));
}

function buildRecoveryDeps(overrides: Partial<RecoveryDeps> = {}): RecoveryDeps {
  return {
    existsSync,
    readFileSync,
    isPortInUse: defaultIsPortInUse,
    listListeningPids: defaultListListeningPids,
    terminateProcessTree: defaultTerminateProcessTree,
    waitForPortRelease: defaultWaitForPortRelease,
    platform: process.platform,
    ...overrides,
  };
}

export function hasEmbeddedPostgresSharedMemoryConflict(
  error: unknown,
  recentLogs: string[] = [],
): boolean {
  const haystack = [toErrorMessage(error), ...recentLogs].join("\n").toLowerCase();
  return (
    haystack.includes("pre-existing shared memory block is still in use") ||
    haystack.includes("could not create shared memory segment")
  );
}

export async function tryRecoverStaleEmbeddedPostgresPreferredPort(
  input: {
    dataDir: string;
    preferredPort: number;
    error: unknown;
    recentLogs?: string[];
  },
  overrides: Partial<RecoveryDeps> = {},
): Promise<boolean> {
  const deps = buildRecoveryDeps(overrides);

  if (!hasEmbeddedPostgresSharedMemoryConflict(input.error, input.recentLogs ?? [])) {
    return false;
  }

  const clusterVersionFile = path.resolve(input.dataDir, "PG_VERSION");
  const postmasterOptsFile = path.resolve(input.dataDir, "postmaster.opts");
  if (!deps.existsSync(clusterVersionFile) || !deps.existsSync(postmasterOptsFile)) {
    return false;
  }

  if (!(await deps.isPortInUse(input.preferredPort))) {
    return false;
  }

  let postmasterOptsContents = "";
  try {
    postmasterOptsContents = deps.readFileSync(postmasterOptsFile, "utf8");
  } catch {
    return false;
  }

  if (!postmasterOptsMatchesPreferredCluster(postmasterOptsContents, input.dataDir, input.preferredPort)) {
    return false;
  }

  const listenerPids = await deps.listListeningPids(input.preferredPort, deps.platform);
  if (listenerPids.length === 0) {
    return false;
  }

  for (const pid of listenerPids) {
    await deps.terminateProcessTree(pid, deps.platform);
  }

  return await deps.waitForPortRelease(input.preferredPort, deps.isPortInUse);
}
