import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPnpmSpawnSpec } from "./pnpm-command.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

function fail(message: string): never {
  throw new Error(message);
}

async function copyDir(source: string, destination: string): Promise<void> {
  const sourcePath = resolve(process.cwd(), source);
  const destinationPath = resolve(process.cwd(), destination);
  await rm(destinationPath, { force: true, recursive: true });
  await mkdir(dirname(destinationPath), { recursive: true });
  await cp(sourcePath, destinationPath, { force: true, recursive: true });
}

async function removePath(target: string): Promise<void> {
  const targetPath = resolve(process.cwd(), target);
  await rm(targetPath, { force: true, recursive: true });
}

async function ensureExecutable(target: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }

  const targetPath = resolve(process.cwd(), target);
  const currentMode = (await stat(targetPath)).mode;
  await chmod(targetPath, currentMode | 0o111);
}

function runPnpm(args: string[]): void {
  const spawnSpec = buildPnpmSpawnSpec(args);
  const result = spawnSync(spawnSpec.command, spawnSpec.args, {
    cwd: repoRoot,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function prepareServerUiDist(): Promise<void> {
  const uiDist = resolve(repoRoot, "ui", "dist");
  const serverUiDist = resolve(repoRoot, "server", "ui-dist");

  console.log("  -> Building @paperclipai/ui...");
  runPnpm(["--dir", repoRoot, "--filter", "@paperclipai/ui", "build"]);

  if (!existsSync(resolve(uiDist, "index.html"))) {
    fail(`UI build output missing at ${resolve(uiDist, "index.html")}`);
  }

  await rm(serverUiDist, { force: true, recursive: true });
  await mkdir(dirname(serverUiDist), { recursive: true });
  await cp(uiDist, serverUiDist, { force: true, recursive: true });
  console.log("  -> Copied ui/dist to server/ui-dist");
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [command, ...args] = argv;

  switch (command) {
    case "copy-dir": {
      const [source, destination] = args;
      if (!source || !destination) {
        fail("Usage: tsx scripts/package-files.ts copy-dir <source> <destination>");
      }
      await copyDir(source, destination);
      return;
    }
    case "remove": {
      const [target] = args;
      if (!target) {
        fail("Usage: tsx scripts/package-files.ts remove <target>");
      }
      await removePath(target);
      return;
    }
    case "ensure-executable": {
      const [target] = args;
      if (!target) {
        fail("Usage: tsx scripts/package-files.ts ensure-executable <target>");
      }
      await ensureExecutable(target);
      return;
    }
    case "prepare-server-ui-dist":
      await prepareServerUiDist();
      return;
    default:
      fail(
        "Usage: tsx scripts/package-files.ts <copy-dir|remove|ensure-executable|prepare-server-ui-dist> ...args",
      );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
