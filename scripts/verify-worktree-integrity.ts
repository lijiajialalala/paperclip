#!/usr/bin/env -S node --import tsx
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findWorktreeIntegrityIssues, formatWorktreeIntegrityIssues } from "../cli/src/worktree-integrity.js";
import { buildPnpmSpawnSpec } from "./pnpm-command.js";

type ScriptOptions = {
  cwd: string;
  repair: boolean;
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

function parseArgs(argv: string[]): ScriptOptions {
  let cwd = repoRoot;
  let repair = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repair") {
      repair = true;
      continue;
    }
    if (arg === "--cwd") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--cwd requires a value");
      }
      cwd = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { cwd, repair };
}

function runPnpmInstall(cwd: string, args: string[]) {
  const spawnSpec = buildPnpmSpawnSpec(args);
  const result = spawnSync(spawnSpec.command, spawnSpec.args, {
    cwd,
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`pnpm ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`);
  }
}

function printIssues(prefix: string, cwd: string) {
  const issues = findWorktreeIntegrityIssues(cwd);
  if (issues.length === 0) {
    console.log(`${prefix}: ok`);
    return issues;
  }

  console.error(`${prefix}:`);
  console.error(formatWorktreeIntegrityIssues(issues));
  return issues;
}

function ensureIntegrity(opts: ScriptOptions) {
  const initialIssues = printIssues("[paperclip] worktree integrity", opts.cwd);
  if (initialIssues.length === 0 || !opts.repair) {
    return initialIssues.length === 0 ? 0 : 1;
  }

  console.log("[paperclip] attempting dependency refresh with pnpm install --frozen-lockfile");
  runPnpmInstall(opts.cwd, ["install", "--frozen-lockfile"]);
  if (printIssues("[paperclip] post-install integrity", opts.cwd).length === 0) {
    return 0;
  }

  console.log("[paperclip] retrying dependency refresh with pnpm install --force");
  runPnpmInstall(opts.cwd, ["install", "--force", "--config.confirmModulesPurge=false"]);
  return printIssues("[paperclip] post-force integrity", opts.cwd).length === 0 ? 0 : 1;
}

try {
  const options = parseArgs(process.argv.slice(2));
  process.exitCode = ensureIntegrity(options);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
