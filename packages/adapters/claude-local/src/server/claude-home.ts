import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const COPIED_SHARED_FILES = ["settings.json"] as const;
const DEFAULT_PAPERCLIP_INSTANCE_ID = "default";
const managedClaudeConfigLocks = new Map<string, Promise<void>>();

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

export function resolveSharedClaudeConfigDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = nonEmpty(env.CLAUDE_CONFIG_DIR);
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), ".claude");
}

export function resolveManagedClaudeConfigDir(
  env: NodeJS.ProcessEnv,
  companyId?: string,
  agentId?: string,
): string {
  const paperclipHome = nonEmpty(env.PAPERCLIP_HOME) ?? path.resolve(os.homedir(), ".paperclip");
  const instanceId = nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? DEFAULT_PAPERCLIP_INSTANCE_ID;
  if (companyId && agentId) {
    return path.resolve(
      paperclipHome,
      "instances",
      instanceId,
      "companies",
      companyId,
      "agents",
      agentId,
      "claude-home",
    );
  }
  if (companyId) {
    return path.resolve(paperclipHome, "instances", instanceId, "companies", companyId, "claude-home");
  }
  return path.resolve(paperclipHome, "instances", instanceId, "claude-home");
}

async function ensureParentDir(target: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
}

async function ensureCopiedFile(target: string, source: string): Promise<void> {
  const existing = await fs.lstat(target).catch(() => null);
  if (existing) return;
  await ensureParentDir(target);
  await fs.copyFile(source, target);
}

async function withManagedClaudeConfigLock<T>(
  targetDir: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = managedClaudeConfigLocks.get(targetDir);
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const chain = (previous ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => current);
  managedClaudeConfigLocks.set(targetDir, chain);

  await previous?.catch(() => undefined);

  try {
    return await task();
  } finally {
    releaseCurrent();
    if (managedClaudeConfigLocks.get(targetDir) === chain) {
      managedClaudeConfigLocks.delete(targetDir);
    }
  }
}

export async function prepareManagedClaudeConfigDir(
  env: NodeJS.ProcessEnv,
  onLog: AdapterExecutionContext["onLog"],
  companyId?: string,
  agentId?: string,
): Promise<string> {
  const targetDir = resolveManagedClaudeConfigDir(env, companyId, agentId);
  const sourceDir = resolveSharedClaudeConfigDir(env);
  if (path.resolve(sourceDir) === path.resolve(targetDir)) return targetDir;

  await withManagedClaudeConfigLock(targetDir, async () => {
    await fs.mkdir(targetDir, { recursive: true });
    for (const name of COPIED_SHARED_FILES) {
      const source = path.join(sourceDir, name);
      if (!(await pathExists(source))) continue;
      await ensureCopiedFile(path.join(targetDir, name), source);
    }
  });

  await onLog(
    "stdout",
    `[paperclip] Using agent-isolated Claude config dir "${targetDir}" (seeded from "${sourceDir}").\n`,
  );
  return targetDir;
}
