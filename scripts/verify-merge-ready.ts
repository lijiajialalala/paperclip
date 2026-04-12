#!/usr/bin/env -S node --import tsx
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findWorktreeIntegrityIssues, formatWorktreeIntegrityIssues } from "../cli/src/worktree-integrity.js";
import { buildPnpmSpawnSpec } from "./pnpm-command.js";

type VerificationStep = {
  layer: "environment" | "migrations" | "code" | "tests" | "build";
  name: string;
  run: () => void;
};

type ScriptOptions = {
  cwd: string;
  full: boolean;
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

function parseArgs(argv: string[]): ScriptOptions {
  let cwd = repoRoot;
  let full = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--full") {
      full = true;
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

  return { cwd, full };
}

function runPnpmCommand(cwd: string, args: string[], label: string) {
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
    throw new Error(`${label} failed with exit code ${result.status ?? "unknown"}`);
  }
}

function buildVerificationSteps(options: ScriptOptions): VerificationStep[] {
  const steps: VerificationStep[] = [
    {
      layer: "environment",
      name: "worktree-integrity",
      run: () => {
        const issues = findWorktreeIntegrityIssues(options.cwd);
        if (issues.length > 0) {
          throw new Error(formatWorktreeIntegrityIssues(issues));
        }
      },
    },
    {
      layer: "migrations",
      name: "db:check-migrations",
      run: () => runPnpmCommand(options.cwd, ["--dir", "packages/db", "run", "check:migrations"], "db check:migrations"),
    },
    {
      layer: "code",
      name: "cli:typecheck",
      run: () => runPnpmCommand(options.cwd, ["--dir", "cli", "run", "typecheck"], "cli typecheck"),
    },
    {
      layer: "code",
      name: "server:typecheck",
      run: () => runPnpmCommand(options.cwd, ["--dir", "server", "run", "typecheck"], "server typecheck"),
    },
    {
      layer: "code",
      name: "ui:typecheck",
      run: () => runPnpmCommand(options.cwd, ["--dir", "ui", "run", "typecheck"], "ui typecheck"),
    },
  ];

  if (options.full) {
    steps.push(
      {
        layer: "tests",
        name: "test:run",
        run: () => runPnpmCommand(options.cwd, ["run", "test:run"], "root test:run"),
      },
      {
        layer: "build",
        name: "server:build",
        run: () => runPnpmCommand(options.cwd, ["--dir", "server", "run", "build"], "server build"),
      },
      {
        layer: "build",
        name: "ui:build",
        run: () => runPnpmCommand(options.cwd, ["--dir", "ui", "run", "build"], "ui build"),
      },
    );
  }

  return steps;
}

function main(options: ScriptOptions) {
  const steps = buildVerificationSteps(options);

  for (const step of steps) {
    console.log(`\n[paperclip] ${step.layer}: ${step.name}`);
    step.run();
  }

  console.log("\n[paperclip] merge-ready verification passed.");
  console.log("[paperclip] If a code-layer check fails on a feature branch, compare the same command against origin/master to separate baseline failures from branch-specific regressions.");
}

try {
  main(parseArgs(process.argv.slice(2)));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
