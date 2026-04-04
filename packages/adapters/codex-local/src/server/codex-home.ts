import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const TRUTHY_ENV_RE = /^(1|true|yes|on)$/i;
const COPIED_SHARED_FILES = ["config.json", "config.toml", "instructions.md"] as const;
const MIRRORED_SHARED_DIRS = ["agents"] as const;
const SYMLINKED_SHARED_FILES = ["auth.json"] as const;
const DEFAULT_PAPERCLIP_INSTANCE_ID = "default";

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
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

async function mirrorDirectory(target: string, source: string): Promise<void> {
  const existing = await fs.lstat(target).catch(() => null);
  if (existing && !existing.isDirectory()) {
    await fs.rm(target, { recursive: true, force: true });
  }
  await ensureParentDir(target);
  await fs.cp(source, target, { recursive: true, force: true });
}

export async function prepareManagedCodexHome(
  env: NodeJS.ProcessEnv,
  onLog: AdapterExecutionContext["onLog"],
  companyId?: string,
): Promise<string> {
  const targetHome = resolveManagedCodexHomeDir(env, companyId);

  const sourceHome = resolveSharedCodexHomeDir(env);
  if (path.resolve(sourceHome) === path.resolve(targetHome)) return targetHome;

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

  await onLog(
    "stdout",
    `[paperclip] Using ${isWorktreeMode(env) ? "worktree-isolated" : "Paperclip-managed"} Codex home "${targetHome}" (seeded from "${sourceHome}").\n`,
  );
  return targetHome;
}
