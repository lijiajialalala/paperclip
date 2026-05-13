import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const TRUTHY_ENV_RE = /^(1|true|yes|on)$/i;
const COPIED_SHARED_FILES = ["config.json", "config.toml", "instructions.md"] as const;
const MIRRORED_SHARED_DIRS = ["agents"] as const;
const SYMLINKED_SHARED_FILES = ["auth.json"] as const;
const DEFAULT_PAPERCLIP_INSTANCE_ID = "default";
const managedCodexHomeLocks = new Map<string, Promise<void>>();

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveOpenAiBaseUrl(env: NodeJS.ProcessEnv): string | null {
  return (
    nonEmpty(env.OPENAI_BASE_URL) ??
    nonEmpty(env.OPENAI_API_BASE) ??
    nonEmpty(env.OPENAI_API_BASE_URL)
  );
}

export async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

export function resolveSharedCodexHomeDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = nonEmpty(env.CODEX_HOME);
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), ".codex");
}

function isWorktreeMode(env: NodeJS.ProcessEnv): boolean {
  return TRUTHY_ENV_RE.test(env.PAPERCLIP_IN_WORKTREE ?? "");
}

export function resolveManagedCodexHomeDir(
  env: NodeJS.ProcessEnv,
  companyId?: string,
): string {
  const paperclipHome = nonEmpty(env.PAPERCLIP_HOME) ?? path.resolve(os.homedir(), ".paperclip");
  const instanceId = nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? DEFAULT_PAPERCLIP_INSTANCE_ID;
  return companyId
    ? path.resolve(paperclipHome, "instances", instanceId, "companies", companyId, "codex-home")
    : path.resolve(paperclipHome, "instances", instanceId, "codex-home");
}

async function ensureParentDir(target: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
}

function isSymlinkPermissionError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "EPERM" || code === "EACCES" || code === "ENOTSUP";
}

async function copyFileMirror(target: string, source: string): Promise<void> {
  await ensureParentDir(target);
  await fs.copyFile(source, target);
}

async function ensureSharedFileLinkOrCopy(
  target: string,
  source: string,
  options: { preferSymlink: boolean },
): Promise<"symlink" | "copy" | "unchanged"> {
  const existing = await fs.lstat(target).catch(() => null);
  if (existing?.isDirectory()) {
    return "unchanged";
  }

  if (existing?.isSymbolicLink()) {
    const linkedPath = await fs.readlink(target).catch(() => null);
    if (linkedPath) {
      const resolvedLinkedPath = path.resolve(path.dirname(target), linkedPath);
      if (resolvedLinkedPath === source) {
        return "unchanged";
      }
    }
    await fs.unlink(target);
  }

  if (options.preferSymlink) {
    try {
      if (existing && !existing.isSymbolicLink()) {
        await fs.unlink(target);
      }
      await ensureParentDir(target);
      await fs.symlink(source, target);
      return "symlink";
    } catch (err) {
      if (!isSymlinkPermissionError(err)) throw err;
    }
  }

  if (existing && existing.isDirectory()) {
    return "unchanged";
  }

  await copyFileMirror(target, source);
  return "copy";
}

async function ensureCopiedFile(target: string, source: string): Promise<void> {
  const existing = await fs.lstat(target).catch(() => null);
  if (existing) return;
  await copyFileMirror(target, source);
}

async function ensureCodexConfigBaseUrl(targetHome: string, env: NodeJS.ProcessEnv): Promise<void> {
  const configuredBaseUrl = resolveOpenAiBaseUrl(env);
  if (!configuredBaseUrl) return;

  const configPath = path.join(targetHome, "config.toml");
  const existing = await fs.readFile(configPath, "utf8").catch(() => "");
  const baseUrlLine = `base_url = "${configuredBaseUrl}"`;
  const next = /(^|\r?\n)\s*base_url\s*=.*(?=\r?\n|$)/m.test(existing)
    ? existing.replace(/(^|\r?\n)\s*base_url\s*=.*(?=\r?\n|$)/m, (match, prefix) => `${prefix}${baseUrlLine}`)
    : `${existing.trimEnd()}${existing.trim().length > 0 ? "\n" : ""}${baseUrlLine}\n`;
  if (next === existing) return;
  await ensureParentDir(configPath);
  await fs.writeFile(configPath, next, "utf8");
}

async function mirrorDirectory(target: string, source: string): Promise<void> {
  const existing = await fs.lstat(target).catch(() => null);
  if (existing && !existing.isDirectory()) {
    await fs.rm(target, { recursive: true, force: true });
  }
  await ensureParentDir(target);
  await fs.cp(source, target, { recursive: true, force: true });
}

async function withManagedCodexHomeLock<T>(
  targetHome: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = managedCodexHomeLocks.get(targetHome);
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const chain = (previous ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => current);
  managedCodexHomeLocks.set(targetHome, chain);

  await previous?.catch(() => undefined);

  try {
    return await task();
  } finally {
    releaseCurrent();
    if (managedCodexHomeLocks.get(targetHome) === chain) {
      managedCodexHomeLocks.delete(targetHome);
    }
  }
}

export async function prepareManagedCodexHome(
  env: NodeJS.ProcessEnv,
  onLog: AdapterExecutionContext["onLog"],
  companyId?: string,
): Promise<string> {
  const targetHome = resolveManagedCodexHomeDir(env, companyId);

  const sourceHome = resolveSharedCodexHomeDir(env);
  if (path.resolve(sourceHome) === path.resolve(targetHome)) return targetHome;

  await withManagedCodexHomeLock(targetHome, async () => {
    await fs.mkdir(targetHome, { recursive: true });

    for (const name of SYMLINKED_SHARED_FILES) {
      const source = path.join(sourceHome, name);
      if (!(await pathExists(source))) continue;
      const target = path.join(targetHome, name);
      const mode = await ensureSharedFileLinkOrCopy(target, source, { preferSymlink: true });
      if (mode === "copy") {
        await onLog(
          "stdout",
          `[paperclip] Mirroring Codex auth into "${target}" because this Windows session cannot create file symlinks.\n`,
        );
      }
    }

    for (const name of COPIED_SHARED_FILES) {
      const source = path.join(sourceHome, name);
      if (!(await pathExists(source))) continue;
      await ensureCopiedFile(path.join(targetHome, name), source);
    }

    for (const name of MIRRORED_SHARED_DIRS) {
      const source = path.join(sourceHome, name);
      if (!(await pathExists(source))) continue;
      await mirrorDirectory(path.join(targetHome, name), source);
    }

    await ensureCodexConfigBaseUrl(targetHome, env);
  });

  await onLog(
    "stdout",
    `[paperclip] Using ${isWorktreeMode(env) ? "worktree-isolated" : "Paperclip-managed"} Codex home "${targetHome}" (seeded from "${sourceHome}").\n`,
  );
  return targetHome;
}
