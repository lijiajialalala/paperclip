import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants, promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import type {
  AdapterSkillEntry,
  AdapterSkillSnapshot,
} from "./types.js";

export interface RunProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  pid: number | null;
  startedAt: string | null;
  completionReason?: string | null;
}

export interface TerminalResultCleanupOptions {
  hasTerminalResult: (output: { stdout: string; stderr: string }) => boolean;
  graceMs?: number;
}

interface RunningProcess {
  child: ChildProcess;
  graceSec: number;
  processGroupId: number | null;
}

interface SpawnTarget {
  command: string;
  args: string[];
}

type ChildProcessWithEvents = ChildProcess & {
  on(event: "error", listener: (err: Error) => void): ChildProcess;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): ChildProcess;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): ChildProcess;
};

function resolveProcessGroupId(child: ChildProcess) {
  if (process.platform === "win32") return null;
  return typeof child.pid === "number" && child.pid > 0 ? child.pid : null;
}

function shouldSpawnDetachedProcessGroup(input: {
  terminalResultCleanup?: TerminalResultCleanupOptions;
}) {
  return process.platform !== "win32" && Boolean(input.terminalResultCleanup);
}

function signalRunningProcess(
  running: Pick<RunningProcess, "child" | "processGroupId">,
  signal: NodeJS.Signals,
) {
  if (process.platform !== "win32" && running.processGroupId && running.processGroupId > 0) {
    try {
      process.kill(-running.processGroupId, signal);
      return;
    } catch {
      // Fall back to the direct child signal if group signaling fails.
    }
  }
  if (!running.child.killed) {
    running.child.kill(signal);
  }
}

export const runningProcesses = new Map<string, RunningProcess>();
export const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
export const MAX_EXCERPT_BYTES = 32 * 1024;
const TERMINAL_RESULT_SCAN_OVERLAP_CHARS = 64 * 1024;
const SENSITIVE_ENV_KEY = /(key|token|secret|password|passwd|authorization|cookie)/i;
const PAPERCLIP_SKILL_ROOT_RELATIVE_CANDIDATES = [
  "../../skills",
  "../../../../../skills",
];
const PAPERCLIP_MANAGED_SKILL_METADATA_FILE = ".paperclip-skill-link.json";

export interface PaperclipSkillEntry {
  key: string;
  runtimeName: string;
  source: string;
  required?: boolean;
  requiredReason?: string | null;
}

export interface InstalledSkillTarget {
  targetPath: string | null;
  kind: "symlink" | "managed_directory" | "directory" | "file";
}

interface PersistentSkillSnapshotOptions {
  adapterType: string;
  availableEntries: PaperclipSkillEntry[];
  desiredSkills: string[];
  installed: Map<string, InstalledSkillTarget>;
  skillsHome: string;
  locationLabel?: string | null;
  installedDetail?: string | null;
  missingDetail: string;
  externalConflictDetail: string;
  externalDetail: string;
  warnings?: string[];
}

function normalizePathSlashes(value: string): string {
  return value.replaceAll("\\", "/");
}

function isMaintainerOnlySkillTarget(candidate: string): boolean {
  return normalizePathSlashes(candidate).includes("/.agents/skills/");
}

function skillLocationLabel(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isSymlinkPermissionError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "EPERM" || code === "EACCES" || code === "ENOTSUP";
}

async function mirrorSkillDirectory(source: string, target: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rm(target, { recursive: true, force: true });
  await fs.cp(source, target, { recursive: true });
}

async function writeManagedSkillMetadata(target: string, source: string): Promise<void> {
  await fs.writeFile(
    path.join(target, PAPERCLIP_MANAGED_SKILL_METADATA_FILE),
    `${JSON.stringify({ source: path.resolve(source) }, null, 2)}\n`,
    "utf8",
  );
}

async function readManagedSkillMetadata(target: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(target, PAPERCLIP_MANAGED_SKILL_METADATA_FILE), "utf8");
    const parsed = parseJson(raw);
    const source = typeof parsed?.source === "string" ? parsed.source.trim() : "";
    return source ? path.resolve(source) : null;
  } catch {
    return null;
  }
}

async function looksLikeManagedMirroredSkill(source: string, target: string): Promise<boolean> {
  const metadataSource = await readManagedSkillMetadata(target);
  return metadataSource === path.resolve(source);
}

async function tryCreateWindowsSkillJunction(source: string, target: string): Promise<boolean> {
  if (process.platform !== "win32") return false;
  try {
    await fs.symlink(source, target, "junction");
    return true;
  } catch (err) {
    if (!isSymlinkPermissionError(err)) throw err;
    return false;
  }
}

async function createManagedSkillLink(
  source: string,
  target: string,
  linkSkill: (source: string, target: string) => Promise<void>,
): Promise<void> {
  try {
    await linkSkill(source, target);
    return;
  } catch (err) {
    if (!isSymlinkPermissionError(err)) throw err;
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  if (await tryCreateWindowsSkillJunction(source, target)) {
    return;
  }

  await mirrorSkillDirectory(source, target);
  await writeManagedSkillMetadata(target, source);
}

function buildManagedSkillOrigin(entry: { required?: boolean }): Pick<
  AdapterSkillEntry,
  "origin" | "originLabel" | "readOnly"
> {
  if (entry.required) {
    return {
      origin: "paperclip_required",
      originLabel: "Required by Paperclip",
      readOnly: false,
    };
  }
  return {
    origin: "company_managed",
    originLabel: "Managed by Paperclip",
    readOnly: false,
  };
}

function resolveInstalledEntryTarget(
  skillsHome: string,
  entryName: string,
  dirent: Dirent,
  linkedPath: string | null,
): InstalledSkillTarget {
  const fullPath = path.join(skillsHome, entryName);
  if (dirent.isSymbolicLink()) {
    return {
      targetPath: linkedPath ? path.resolve(path.dirname(fullPath), linkedPath) : null,
      kind: "symlink",
    };
  }
  if (dirent.isDirectory()) {
    return { targetPath: fullPath, kind: "directory" };
  }
  return { targetPath: fullPath, kind: "file" };
}

export function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function parseJson(value: string): Record<string, unknown> | null {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function appendWithCap(prev: string, chunk: string, cap = MAX_CAPTURE_BYTES) {
  const combined = prev + chunk;
  return combined.length > cap ? combined.slice(combined.length - cap) : combined;
}

export function resolvePathValue(obj: Record<string, unknown>, dottedPath: string) {
  const parts = dottedPath.split(".");
  let cursor: unknown = obj;

  for (const part of parts) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
      return "";
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }

  if (cursor === null || cursor === undefined) return "";
  if (typeof cursor === "string") return cursor;
  if (typeof cursor === "number" || typeof cursor === "boolean") return String(cursor);

  try {
    return JSON.stringify(cursor);
  } catch {
    return "";
  }
}

export function renderTemplate(template: string, data: Record<string, unknown>) {
  return template.replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_, path) => resolvePathValue(data, path));
}

export function joinPromptSections(
  sections: Array<string | null | undefined>,
  separator = "\n\n",
) {
  return sections
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean)
    .join(separator);
}

type PaperclipWakeIssue = {
  id: string | null;
  identifier: string | null;
  title: string | null;
  status: string | null;
  priority: string | null;
  workspaceCwd: string | null;
  taskRootIssueId: string | null;
  taskRootDir: string | null;
  deliverableRoot: string | null;
  blackboard: {
    template: string | null;
    manifestStatus: string | null;
    isComplete: boolean;
    requiredReadyCount: number;
    requiredTotalCount: number;
    missingKeys: string[];
    invalidKeys: string[];
  } | null;
};

type PaperclipWakeComment = {
  id: string | null;
  issueId: string | null;
  body: string;
  bodyTruncated: boolean;
  createdAt: string | null;
  authorType: string | null;
  authorId: string | null;
};

type PaperclipWakePayload = {
  reason: string | null;
  issue: PaperclipWakeIssue | null;
  commentIds: string[];
  latestCommentId: string | null;
  comments: PaperclipWakeComment[];
  requestedCount: number;
  includedCount: number;
  missingCount: number;
  truncated: boolean;
  fallbackFetchNeeded: boolean;
};

function normalizePaperclipWakeIssue(value: unknown): PaperclipWakeIssue | null {
  const issue = parseObject(value);
  const blackboard = parseObject(issue.blackboard);
  const id = asString(issue.id, "").trim() || null;
  const identifier = asString(issue.identifier, "").trim() || null;
  const title = asString(issue.title, "").trim() || null;
  const status = asString(issue.status, "").trim() || null;
  const priority = asString(issue.priority, "").trim() || null;
  const workspaceCwd = asString(issue.workspaceCwd, "").trim() || null;
  const taskRootIssueId = asString(issue.taskRootIssueId, "").trim() || null;
  const taskRootDir = asString(issue.taskRootDir, "").trim() || null;
  const deliverableRoot = asString(issue.deliverableRoot, "").trim() || null;
  const blackboardSummary =
    Object.keys(blackboard).length > 0
      ? {
          template: asString(blackboard.template, "").trim() || null,
          manifestStatus: asString(blackboard.manifestStatus, "").trim() || null,
          isComplete: asBoolean(blackboard.isComplete, false),
          requiredReadyCount: asNumber(blackboard.requiredReadyCount, 0),
          requiredTotalCount: asNumber(blackboard.requiredTotalCount, 0),
          missingKeys: asStringArray(blackboard.missingKeys)
            .map((entry) => entry.trim())
            .filter(Boolean),
          invalidKeys: asStringArray(blackboard.invalidKeys)
            .map((entry) => entry.trim())
            .filter(Boolean),
        }
      : null;
  if (!id && !identifier && !title) return null;
  return {
    id,
    identifier,
    title,
    status,
    priority,
    workspaceCwd,
    taskRootIssueId,
    taskRootDir,
    deliverableRoot,
    blackboard: blackboardSummary,
  };
}

function normalizePaperclipWakeComment(value: unknown): PaperclipWakeComment | null {
  const comment = parseObject(value);
  const author = parseObject(comment.author);
  const body = asString(comment.body, "");
  if (!body.trim()) return null;
  return {
    id: asString(comment.id, "").trim() || null,
    issueId: asString(comment.issueId, "").trim() || null,
    body,
    bodyTruncated: asBoolean(comment.bodyTruncated, false),
    createdAt: asString(comment.createdAt, "").trim() || null,
    authorType: asString(author.type, "").trim() || null,
    authorId: asString(author.id, "").trim() || null,
  };
}

export function normalizePaperclipWakePayload(value: unknown): PaperclipWakePayload | null {
  const payload = parseObject(value);
  const issue = normalizePaperclipWakeIssue(payload.issue);
  const comments = Array.isArray(payload.comments)
    ? payload.comments
        .map((entry) => normalizePaperclipWakeComment(entry))
        .filter((entry): entry is PaperclipWakeComment => Boolean(entry))
    : [];
  const commentWindow = parseObject(payload.commentWindow);
  const commentIds = Array.isArray(payload.commentIds)
    ? payload.commentIds
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => entry.trim())
    : [];

  if (comments.length === 0 && commentIds.length === 0 && !issue) return null;

  return {
    reason: asString(payload.reason, "").trim() || null,
    issue,
    commentIds,
    latestCommentId: asString(payload.latestCommentId, "").trim() || null,
    comments,
    requestedCount: asNumber(commentWindow.requestedCount, comments.length || commentIds.length),
    includedCount: asNumber(commentWindow.includedCount, comments.length),
    missingCount: asNumber(commentWindow.missingCount, 0),
    truncated: asBoolean(payload.truncated, false),
    fallbackFetchNeeded: asBoolean(payload.fallbackFetchNeeded, false),
  };
}

export function stringifyPaperclipWakePayload(value: unknown): string | null {
  const normalized = normalizePaperclipWakePayload(value);
  if (!normalized) return null;
  return JSON.stringify(normalized);
}

export function renderPaperclipWakePrompt(
  value: unknown,
  options: { resumedSession?: boolean } = {},
): string {
  const normalized = normalizePaperclipWakePayload(value);
  if (!normalized) return "";
  const resumedSession = options.resumedSession === true;
  const hasInlineComments = normalized.comments.length > 0 || normalized.commentIds.length > 0;
  const activeBlackboard =
    normalized.issue?.blackboard && normalized.issue.blackboard.manifestStatus !== "missing"
      ? normalized.issue.blackboard
      : null;

  const lines = (() => {
    if (hasInlineComments) {
      if (resumedSession) {
        return [
          "## Paperclip Resume Delta",
          "",
          "You are resuming an existing Paperclip session.",
          "This heartbeat is scoped to the issue below. Do not switch to another issue until you have handled this wake.",
          "Focus on the new wake delta below and continue the current task without restating the full heartbeat boilerplate.",
          "Fetch the API thread only when `fallbackFetchNeeded` is true or you need broader history than this batch.",
          "",
          `- reason: ${normalized.reason ?? "unknown"}`,
          `- issue: ${normalized.issue?.identifier ?? normalized.issue?.id ?? "unknown"}${normalized.issue?.title ? ` ${normalized.issue.title}` : ""}`,
          `- pending comments: ${normalized.includedCount}/${normalized.requestedCount}`,
          `- latest comment id: ${normalized.latestCommentId ?? "unknown"}`,
          `- fallback fetch needed: ${normalized.fallbackFetchNeeded ? "yes" : "no"}`,
        ];
      }
      return [
        "## Paperclip Wake Payload",
        "",
        "Treat this wake payload as the highest-priority change for the current heartbeat.",
        "This heartbeat is scoped to the issue below. Do not switch to another issue until you have handled this wake.",
        "Before generic repo exploration or boilerplate heartbeat updates, acknowledge the latest comment and explain how it changes your next action.",
        "Use this inline wake data first before refetching the issue thread.",
        "Only fetch the API thread when `fallbackFetchNeeded` is true or you need broader history than this batch.",
        "",
        `- reason: ${normalized.reason ?? "unknown"}`,
        `- issue: ${normalized.issue?.identifier ?? normalized.issue?.id ?? "unknown"}${normalized.issue?.title ? ` ${normalized.issue.title}` : ""}`,
        `- pending comments: ${normalized.includedCount}/${normalized.requestedCount}`,
        `- latest comment id: ${normalized.latestCommentId ?? "unknown"}`,
        `- fallback fetch needed: ${normalized.fallbackFetchNeeded ? "yes" : "no"}`,
      ];
    }

    if (resumedSession) {
      return [
        "## Paperclip Resume Scope",
        "",
        "You are resuming an existing Paperclip session.",
        "This heartbeat is scoped to the issue below. Do not switch to another issue until you have handled this wake.",
        "No inline comments accompanied this wake, so continue from the issue scope below instead of stale local session context.",
        "",
        `- reason: ${normalized.reason ?? "unknown"}`,
        `- issue: ${normalized.issue?.identifier ?? normalized.issue?.id ?? "unknown"}${normalized.issue?.title ? ` ${normalized.issue.title}` : ""}`,
        `- pending comments: ${normalized.includedCount}/${normalized.requestedCount}`,
        `- latest comment id: ${normalized.latestCommentId ?? "none"}`,
        `- fallback fetch needed: ${normalized.fallbackFetchNeeded ? "yes" : "no"}`,
      ];
    }

    return [
      "## Paperclip Wake Payload",
      "",
      "Treat this wake payload as the highest-priority scope for the current heartbeat.",
      "This heartbeat is scoped to the issue below. Do not switch to another issue until you have handled this wake.",
      "No inline comments accompanied this wake, so start from the issue scope below instead of stale local session context.",
      "",
      `- reason: ${normalized.reason ?? "unknown"}`,
      `- issue: ${normalized.issue?.identifier ?? normalized.issue?.id ?? "unknown"}${normalized.issue?.title ? ` ${normalized.issue.title}` : ""}`,
      `- pending comments: ${normalized.includedCount}/${normalized.requestedCount}`,
      `- latest comment id: ${normalized.latestCommentId ?? "none"}`,
      `- fallback fetch needed: ${normalized.fallbackFetchNeeded ? "yes" : "no"}`,
    ];
  })();

  if (normalized.issue?.status) {
    lines.push(`- issue status: ${normalized.issue.status}`);
  }
  if (normalized.issue?.priority) {
    lines.push(`- issue priority: ${normalized.issue.priority}`);
  }
  if (normalized.issue?.workspaceCwd) {
    lines.push(`- working directory: ${normalized.issue.workspaceCwd}`);
  }
  if (normalized.issue?.taskRootIssueId) {
    lines.push(`- task root issue: ${normalized.issue.taskRootIssueId}`);
  }
  if (normalized.issue?.taskRootDir) {
    lines.push(`- task root dir: ${normalized.issue.taskRootDir}`);
  }
  if (normalized.issue?.deliverableRoot) {
    lines.push(`- deliverable root: ${normalized.issue.deliverableRoot}`);
  }
  if (normalized.issue?.workspaceCwd && normalized.issue?.taskRootDir) {
    lines.push(
      "- use the working directory for project files such as docs/, src/, package.json, and tests.",
      "- use the task root only for task-scoped artifacts under .paperclip/tasks/.",
    );
  }
  if (activeBlackboard?.template) {
    lines.push(`- blackboard template: ${activeBlackboard.template}`);
  }
  if (activeBlackboard && normalized.issue) {
    lines.push(
      `- blackboard progress: ${activeBlackboard.requiredReadyCount}/${activeBlackboard.requiredTotalCount} required entries ready`,
    );
    if (activeBlackboard.manifestStatus && activeBlackboard.manifestStatus !== "ready") {
      lines.push(`- blackboard manifest status: ${activeBlackboard.manifestStatus}`);
    }
    if (activeBlackboard.isComplete) {
      lines.push("- blackboard state: complete");
    }
    if (activeBlackboard.missingKeys.length > 0) {
      lines.push(`- blackboard missing keys: ${activeBlackboard.missingKeys.join(", ")}`);
    }
    if (activeBlackboard.invalidKeys.length > 0) {
      lines.push(`- blackboard invalid keys: ${activeBlackboard.invalidKeys.join(", ")}`);
    }
    if (normalized.issue.id) {
      lines.push(
        `- blackboard next step: fetch /api/issues/${normalized.issue.id}/blackboard or the specific /blackboard/:key entry before broad repo exploration when you need the working state`,
      );
    }
    if (activeBlackboard.template === "research_v1") {
      lines.push(
        "- research workflow: keep original-request, brief, clarification-log, source-matrix, skeleton, evidence-ledger, final-report, and action-memo aligned in the issue blackboard",
      );
      lines.push(
        "- research gate: do not draft final-report until brief, source-matrix, and skeleton are current",
      );
      lines.push(
        "- evidence rule: every cited conclusion should keep Source_ID and acquisition method in evidence-ledger",
      );
      lines.push(
        "- frontstage/backstage: final-report and action-memo are user-facing; challenge and audit notes stay in blackboard docs",
      );
    }
  }
  if (normalized.missingCount > 0) {
    lines.push(`- omitted comments: ${normalized.missingCount}`);
  }

  if (!hasInlineComments) {
    return lines.join("\n").trim();
  }

  lines.push("", "New comments in order:");

  for (const [index, comment] of normalized.comments.entries()) {
    const authorLabel = comment.authorId
      ? `${comment.authorType ?? "unknown"} ${comment.authorId}`
      : comment.authorType ?? "unknown";
    lines.push(
      `${index + 1}. comment ${comment.id ?? "unknown"} at ${comment.createdAt ?? "unknown"} by ${authorLabel}`,
      comment.body,
    );
    if (comment.bodyTruncated) {
      lines.push("[comment body truncated]");
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

export function redactEnvForLogs(env: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    redacted[key] = SENSITIVE_ENV_KEY.test(key) ? "***REDACTED***" : value;
  }
  return redacted;
}

export function buildInvocationEnvForLogs(
  env: Record<string, string>,
  options: {
    runtimeEnv?: NodeJS.ProcessEnv | Record<string, string>;
    includeRuntimeKeys?: string[];
    resolvedCommand?: string | null;
    resolvedCommandEnvKey?: string;
  } = {},
): Record<string, string> {
  const merged: Record<string, string> = { ...env };
  const runtimeEnv = options.runtimeEnv ?? {};

  for (const key of options.includeRuntimeKeys ?? []) {
    if (key in merged) continue;
    const value = runtimeEnv[key];
    if (typeof value !== "string" || value.length === 0) continue;
    merged[key] = value;
  }

  const resolvedCommand = options.resolvedCommand?.trim();
  if (resolvedCommand) {
    merged[options.resolvedCommandEnvKey ?? "PAPERCLIP_RESOLVED_COMMAND"] = resolvedCommand;
  }

  return redactEnvForLogs(merged);
}

export function buildPaperclipEnv(agent: { id: string; companyId: string }): Record<string, string> {
  const resolveHostForUrl = (rawHost: string): string => {
    const host = rawHost.trim();
    if (!host || host === "0.0.0.0" || host === "::") return "localhost";
    if (host.includes(":") && !host.startsWith("[") && !host.endsWith("]")) return `[${host}]`;
    return host;
  };
  const vars: Record<string, string> = {
    PAPERCLIP_AGENT_ID: agent.id,
    PAPERCLIP_COMPANY_ID: agent.companyId,
  };
  const runtimeHost = resolveHostForUrl(
    process.env.PAPERCLIP_LISTEN_HOST ?? process.env.HOST ?? "localhost",
  );
  const runtimePort = process.env.PAPERCLIP_LISTEN_PORT ?? process.env.PORT ?? "3100";
  const apiUrl = process.env.PAPERCLIP_API_URL ?? `http://${runtimeHost}:${runtimePort}`;
  vars.PAPERCLIP_API_URL = apiUrl;
  return vars;
}

export function defaultPathForPlatform() {
  if (process.platform === "win32") {
    return "C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem";
  }
  return "/usr/local/bin:/opt/homebrew/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin";
}

function windowsPathExts(env: NodeJS.ProcessEnv): string[] {
  return (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
}

function windowsCommandCandidates(commandPath: string, env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== "win32") return [commandPath];
  if (path.extname(commandPath).length > 0) return [commandPath];
  return [commandPath, ...windowsPathExts(env).map((ext) => `${commandPath}${ext}`)];
}

async function pathExists(candidate: string) {
  try {
    await fs.access(candidate, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveCommandPath(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const hasPathSeparator = command.includes("/") || command.includes("\\");
  if (hasPathSeparator) {
    const absolute = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    for (const candidate of windowsCommandCandidates(absolute, env)) {
      if (await pathExists(candidate)) return candidate;
    }
    return null;
  }

  const pathValue = env.PATH ?? env.Path ?? "";
  const delimiter = process.platform === "win32" ? ";" : ":";
  const dirs = pathValue.split(delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? windowsPathExts(env) : [""];
  const hasExtension = process.platform === "win32" && path.extname(command).length > 0;

  for (const dir of dirs) {
    const candidates =
      process.platform === "win32"
        ? hasExtension
          ? [path.join(dir, command)]
          : exts.map((ext) => path.join(dir, `${command}${ext}`))
        : [path.join(dir, command)];
    for (const candidate of candidates) {
      if (await pathExists(candidate)) return candidate;
    }
  }

  return null;
}

export async function resolveCommandForLogs(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return (await resolveCommandPath(command, cwd, env)) ?? command;
}

function quoteForCmd(arg: string) {
  if (!arg.length) return '""';
  const escaped = arg.replace(/"/g, '""');
  return /[\s"&<>|^()]/.test(escaped) ? `"${escaped}"` : escaped;
}

function resolveWindowsCmdShimCandidate(rawPath: string, executableDir: string): string {
  const shimDirWithSeparator = `${executableDir}${path.sep}`;
  const expanded = rawPath
    .replace(/%~dp0/gi, shimDirWithSeparator)
    .replace(/%dp0%/gi, shimDirWithSeparator)
    .replace(/%dp0/gi, shimDirWithSeparator)
    .replace(/[\\/]+/g, path.sep);
  return path.isAbsolute(expanded) ? expanded : path.resolve(executableDir, expanded);
}

async function resolveNodeScriptFromWindowsCmdShim(executable: string): Promise<string | null> {
  const executableDir = path.dirname(executable);
  const executableBase = path.basename(executable, path.extname(executable));

  for (const ext of [".js", ".cjs", ".mjs"]) {
    const sibling = path.join(executableDir, `${executableBase}${ext}`);
    if (await pathExists(sibling)) return sibling;
  }

  const contents = await fs.readFile(executable, "utf8").catch(() => null);
  if (!contents) return null;

  const matches = contents.matchAll(/"([^"]+\.(?:cjs|mjs|js))"/gi);
  for (const match of matches) {
    const rawPath = match[1];
    if (/node(?:\.exe)?$/i.test(rawPath.replace(/\\/g, "/"))) continue;
    const candidate = resolveWindowsCmdShimCandidate(rawPath, executableDir);
    if (await pathExists(candidate)) return candidate;
  }

  return null;
}

async function resolveSpawnTarget(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<SpawnTarget> {
  const resolved = await resolveCommandPath(command, cwd, env);
  const executable = resolved ?? command;

  if (process.platform !== "win32") {
    return { command: executable, args };
  }

  if (/\.(cmd|bat)$/i.test(executable)) {
    const shimScript = await resolveNodeScriptFromWindowsCmdShim(executable);
    if (shimScript) {
      return {
        command: process.execPath,
        args: [shimScript, ...args],
      };
    }
    const shell = env.ComSpec || process.env.ComSpec || "cmd.exe";
    const commandLine = [quoteForCmd(executable), ...args.map(quoteForCmd)].join(" ");
    return {
      command: shell,
      args: ["/d", "/s", "/c", `chcp 65001 >nul && ${commandLine}`],
    };
  }

  return { command: executable, args };
}

export function ensurePathInEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (typeof env.PATH === "string" && env.PATH.length > 0) return env;
  if (typeof env.Path === "string" && env.Path.length > 0) return env;
  return { ...env, PATH: defaultPathForPlatform() };
}

export async function ensureAbsoluteDirectory(
  cwd: string,
  opts: { createIfMissing?: boolean } = {},
) {
  if (!path.isAbsolute(cwd)) {
    throw new Error(`Working directory must be an absolute path: "${cwd}"`);
  }

  const assertDirectory = async () => {
    const stats = await fs.stat(cwd);
    if (!stats.isDirectory()) {
      throw new Error(`Working directory is not a directory: "${cwd}"`);
    }
  };

  try {
    await assertDirectory();
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!opts.createIfMissing || code !== "ENOENT") {
      if (code === "ENOENT") {
        throw new Error(`Working directory does not exist: "${cwd}"`);
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  try {
    await fs.mkdir(cwd, { recursive: true });
    await assertDirectory();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not create working directory "${cwd}": ${reason}`);
  }
}

export async function resolvePaperclipSkillsDir(
  moduleDir: string,
  additionalCandidates: string[] = [],
): Promise<string | null> {
  const candidates = [
    ...PAPERCLIP_SKILL_ROOT_RELATIVE_CANDIDATES.map((relativePath) => path.resolve(moduleDir, relativePath)),
    ...additionalCandidates.map((candidate) => path.resolve(candidate)),
  ];
  const seenRoots = new Set<string>();

  for (const root of candidates) {
    if (seenRoots.has(root)) continue;
    seenRoots.add(root);
    const isDirectory = await fs.stat(root).then((stats) => stats.isDirectory()).catch(() => false);
    if (isDirectory) return root;
  }

  return null;
}

export async function listPaperclipSkillEntries(
  moduleDir: string,
  additionalCandidates: string[] = [],
): Promise<PaperclipSkillEntry[]> {
  const root = await resolvePaperclipSkillsDir(moduleDir, additionalCandidates);
  if (!root) return [];

  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        key: `paperclipai/paperclip/${entry.name}`,
        runtimeName: entry.name,
        source: path.join(root, entry.name),
        required: true,
        requiredReason: "Bundled Paperclip skills are always available for local adapters.",
      }));
  } catch {
    return [];
  }
}

export async function readInstalledSkillTargets(skillsHome: string): Promise<Map<string, InstalledSkillTarget>> {
  const entries = await fs.readdir(skillsHome, { withFileTypes: true }).catch(() => []);
  const out = new Map<string, InstalledSkillTarget>();
  for (const entry of entries) {
    const fullPath = path.join(skillsHome, entry.name);
    if (entry.isDirectory()) {
      const managedSource = await readManagedSkillMetadata(fullPath);
      if (managedSource) {
        out.set(entry.name, { targetPath: managedSource, kind: "managed_directory" });
        continue;
      }
    }
    const linkedPath = entry.isSymbolicLink() ? await fs.readlink(fullPath).catch(() => null) : null;
    out.set(entry.name, resolveInstalledEntryTarget(skillsHome, entry.name, entry, linkedPath));
  }
  return out;
}

export function buildPersistentSkillSnapshot(
  options: PersistentSkillSnapshotOptions,
): AdapterSkillSnapshot {
  const {
    adapterType,
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel,
    installedDetail,
    missingDetail,
    externalConflictDetail,
    externalDetail,
  } = options;
  const availableByKey = new Map(availableEntries.map((entry) => [entry.key, entry]));
  const desiredSet = new Set(desiredSkills);
  const entries: AdapterSkillEntry[] = [];
  const warnings = [...(options.warnings ?? [])];

  for (const available of availableEntries) {
    const installedEntry = installed.get(available.runtimeName) ?? null;
    const desired = desiredSet.has(available.key);
    let state: AdapterSkillEntry["state"] = "available";
    let managed = false;
    let detail: string | null = null;

    if (installedEntry?.targetPath === available.source) {
      managed = true;
      state = desired ? "installed" : "stale";
      detail = installedDetail ?? null;
    } else if (installedEntry) {
      state = "external";
      detail = desired ? externalConflictDetail : externalDetail;
    } else if (desired) {
      state = "missing";
      detail = missingDetail;
    }

    entries.push({
      key: available.key,
      runtimeName: available.runtimeName,
      desired,
      managed,
      state,
      sourcePath: available.source,
      targetPath: path.join(skillsHome, available.runtimeName),
      detail,
      required: Boolean(available.required),
      requiredReason: available.requiredReason ?? null,
      ...buildManagedSkillOrigin(available),
    });
  }

  for (const desiredSkill of desiredSkills) {
    if (availableByKey.has(desiredSkill)) continue;
    warnings.push(`Desired skill "${desiredSkill}" is not available from the Paperclip skills directory.`);
    entries.push({
      key: desiredSkill,
      runtimeName: null,
      desired: true,
      managed: true,
      state: "missing",
      sourcePath: null,
      targetPath: null,
      detail: "Paperclip cannot find this skill in the local runtime skills directory.",
      origin: "external_unknown",
      originLabel: "External or unavailable",
      readOnly: false,
    });
  }

  for (const [name, installedEntry] of installed.entries()) {
    if (availableEntries.some((entry) => entry.runtimeName === name)) continue;
    entries.push({
      key: name,
      runtimeName: name,
      desired: false,
      managed: false,
      state: "external",
      origin: "user_installed",
      originLabel: "User-installed",
      locationLabel: skillLocationLabel(locationLabel),
      readOnly: true,
      sourcePath: null,
      targetPath: installedEntry.targetPath ?? path.join(skillsHome, name),
      detail: externalDetail,
    });
  }

  entries.sort((left, right) => left.key.localeCompare(right.key));

  return {
    adapterType,
    supported: true,
    mode: "persistent",
    desiredSkills,
    entries,
    warnings,
  };
}

function normalizeConfiguredPaperclipRuntimeSkills(value: unknown): PaperclipSkillEntry[] {
  if (!Array.isArray(value)) return [];
  const out: PaperclipSkillEntry[] = [];
  for (const rawEntry of value) {
    const entry = parseObject(rawEntry);
    const key = asString(entry.key, asString(entry.name, "")).trim();
    const runtimeName = asString(entry.runtimeName, asString(entry.name, "")).trim();
    const source = asString(entry.source, "").trim();
    if (!key || !runtimeName || !source) continue;
    out.push({
      key,
      runtimeName,
      source,
      required: asBoolean(entry.required, false),
      requiredReason:
        typeof entry.requiredReason === "string" && entry.requiredReason.trim().length > 0
          ? entry.requiredReason.trim()
          : null,
    });
  }
  return out;
}

export async function readPaperclipRuntimeSkillEntries(
  config: Record<string, unknown>,
  moduleDir: string,
  additionalCandidates: string[] = [],
): Promise<PaperclipSkillEntry[]> {
  const configuredEntries = normalizeConfiguredPaperclipRuntimeSkills(config.paperclipRuntimeSkills);
  if (configuredEntries.length > 0) return configuredEntries;
  return listPaperclipSkillEntries(moduleDir, additionalCandidates);
}

export async function readPaperclipSkillMarkdown(
  moduleDir: string,
  skillKey: string,
): Promise<string | null> {
  const normalized = skillKey.trim().toLowerCase();
  if (!normalized) return null;

  const entries = await listPaperclipSkillEntries(moduleDir);
  const match = entries.find((entry) => entry.key === normalized);
  if (!match) return null;

  try {
    return await fs.readFile(path.join(match.source, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
}

export function readPaperclipSkillSyncPreference(config: Record<string, unknown>): {
  explicit: boolean;
  desiredSkills: string[];
} {
  const raw = config.paperclipSkillSync;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { explicit: false, desiredSkills: [] };
  }
  const syncConfig = raw as Record<string, unknown>;
  const desiredValues = syncConfig.desiredSkills;
  const desired = Array.isArray(desiredValues)
    ? desiredValues
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
  return {
    explicit: Object.prototype.hasOwnProperty.call(raw, "desiredSkills"),
    desiredSkills: Array.from(new Set(desired)),
  };
}

function canonicalizeDesiredPaperclipSkillReference(
  reference: string,
  availableEntries: Array<{ key: string; runtimeName?: string | null }>,
): string {
  const normalizedReference = reference.trim().toLowerCase();
  if (!normalizedReference) return "";

  const exactKey = availableEntries.find((entry) => entry.key.trim().toLowerCase() === normalizedReference);
  if (exactKey) return exactKey.key;

  const byRuntimeName = availableEntries.filter((entry) =>
    typeof entry.runtimeName === "string" && entry.runtimeName.trim().toLowerCase() === normalizedReference,
  );
  if (byRuntimeName.length === 1) return byRuntimeName[0]!.key;

  const slugMatches = availableEntries.filter((entry) =>
    entry.key.trim().toLowerCase().split("/").pop() === normalizedReference,
  );
  if (slugMatches.length === 1) return slugMatches[0]!.key;

  return normalizedReference;
}

export function resolvePaperclipDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string; runtimeName?: string | null; required?: boolean }>,
): string[] {
  const preference = readPaperclipSkillSyncPreference(config);
  const requiredSkills = availableEntries
    .filter((entry) => entry.required)
    .map((entry) => entry.key);
  if (!preference.explicit) {
    return Array.from(new Set(requiredSkills));
  }
  const desiredSkills = preference.desiredSkills
    .map((reference) => canonicalizeDesiredPaperclipSkillReference(reference, availableEntries))
    .filter(Boolean);
  return Array.from(new Set([...requiredSkills, ...desiredSkills]));
}

export function writePaperclipSkillSyncPreference(
  config: Record<string, unknown>,
  desiredSkills: string[],
): Record<string, unknown> {
  const next = { ...config };
  const raw = next.paperclipSkillSync;
  const current =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};
  current.desiredSkills = Array.from(
    new Set(
      desiredSkills
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
  next.paperclipSkillSync = current;
  return next;
}

export async function ensurePaperclipSkillSymlink(
  source: string,
  target: string,
  linkSkill: (source: string, target: string) => Promise<void> = (linkSource, linkTarget) =>
    process.platform === "win32"
      ? fs.symlink(linkSource, linkTarget, "junction")
      : fs.symlink(linkSource, linkTarget),
): Promise<"created" | "repaired" | "skipped"> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing) {
    await createManagedSkillLink(source, target, linkSkill);
    return "created";
  }

  if (!existing.isSymbolicLink()) {
    if (existing.isDirectory() && (await looksLikeManagedMirroredSkill(source, target))) {
      await fs.rm(target, { recursive: true, force: true });
      await createManagedSkillLink(source, target, linkSkill);
      return "repaired";
    }
    return "skipped";
  }

  const linkedPath = await fs.readlink(target).catch(() => null);
  if (!linkedPath) return "skipped";

  const resolvedLinkedPath = path.resolve(path.dirname(target), linkedPath);
  if (resolvedLinkedPath === source) {
    return "skipped";
  }

  const linkedPathExists = await fs.stat(resolvedLinkedPath).then(() => true).catch(() => false);
  if (linkedPathExists) {
    return "skipped";
  }

  await fs.unlink(target);
  await createManagedSkillLink(source, target, linkSkill);
  return "repaired";
}

export async function removeMaintainerOnlySkillSymlinks(
  skillsHome: string,
  allowedSkillNames: Iterable<string>,
): Promise<string[]> {
  const allowed = new Set(Array.from(allowedSkillNames));
  try {
    const entries = await fs.readdir(skillsHome, { withFileTypes: true });
    const removed: string[] = [];
    for (const entry of entries) {
      if (allowed.has(entry.name)) continue;

      const target = path.join(skillsHome, entry.name);
      const existing = await fs.lstat(target).catch(() => null);
      if (!existing?.isSymbolicLink()) continue;

      const linkedPath = await fs.readlink(target).catch(() => null);
      if (!linkedPath) continue;

      const resolvedLinkedPath = path.isAbsolute(linkedPath)
        ? linkedPath
        : path.resolve(path.dirname(target), linkedPath);
      if (
        !isMaintainerOnlySkillTarget(linkedPath) &&
        !isMaintainerOnlySkillTarget(resolvedLinkedPath)
      ) {
        continue;
      }

      await fs.unlink(target);
      removed.push(entry.name);
    }

    return removed;
  } catch {
    return [];
  }
}

export async function ensureCommandResolvable(command: string, cwd: string, env: NodeJS.ProcessEnv) {
  const resolved = await resolveCommandPath(command, cwd, env);
  if (resolved) return;
  if (command.includes("/") || command.includes("\\")) {
    const absolute = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    throw new Error(`Command is not executable: "${command}" (resolved: "${absolute}")`);
  }
  throw new Error(`Command not found in PATH: "${command}"`);
}

export async function runChildProcess(
  runId: string,
  command: string,
  args: string[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    timeoutSec: number;
    graceSec: number;
    onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
    detectCompletionReason?: (stream: "stdout" | "stderr", chunk: string) => string | null;
    onLogError?: (err: unknown, runId: string, message: string) => void;
    onSpawn?: (meta: { pid: number; processGroupId?: number | null; startedAt: string }) => Promise<void>;
    terminalResultCleanup?: TerminalResultCleanupOptions;
    stdin?: string;
  },
): Promise<RunProcessResult> {
  const onLogError = opts.onLogError ?? ((err, id, msg) => console.warn({ err, runId: id }, msg));

  return new Promise<RunProcessResult>((resolve, reject) => {
    const rawMerged: NodeJS.ProcessEnv = {
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
      ...process.env,
      ...opts.env,
    };

    // Strip Claude Code nesting-guard env vars so spawned `claude` processes
    // don't refuse to start with "cannot be launched inside another session".
    // These vars leak in when the Paperclip server itself is started from
    // within a Claude Code session (e.g. `npx paperclipai run` in a terminal
    // owned by Claude Code) or when cron inherits a contaminated shell env.
    const CLAUDE_CODE_NESTING_VARS = [
      "CLAUDECODE",
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDE_CODE_SESSION",
      "CLAUDE_CODE_PARENT_SESSION",
    ] as const;
    for (const key of CLAUDE_CODE_NESTING_VARS) {
      delete rawMerged[key];
    }

    const mergedEnv = ensurePathInEnv(rawMerged);
    void resolveSpawnTarget(command, args, opts.cwd, mergedEnv)
      .then((target) => {
        const spawnDetachedProcessGroup = shouldSpawnDetachedProcessGroup({
          terminalResultCleanup: opts.terminalResultCleanup,
        });
        const child = spawn(target.command, target.args, {
          cwd: opts.cwd,
          env: mergedEnv,
          detached: spawnDetachedProcessGroup,
          shell: false,
          stdio: [opts.stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
        }) as ChildProcessWithEvents;
        const startedAt = new Date().toISOString();
        const processGroupId = spawnDetachedProcessGroup ? resolveProcessGroupId(child) : null;

        if (opts.stdin != null && child.stdin) {
          child.stdin.write(opts.stdin);
          child.stdin.end();
        }

        if (typeof child.pid === "number" && child.pid > 0 && opts.onSpawn) {
          void opts.onSpawn({ pid: child.pid, processGroupId, startedAt }).catch((err) => {
            onLogError(err, runId, "failed to record child process metadata");
          });
        }

        runningProcesses.set(runId, { child, graceSec: opts.graceSec, processGroupId });

        let timedOut = false;
        let stdout = "";
        let stderr = "";
        let logChain: Promise<void> = Promise.resolve();
        let completionReason: string | null = null;
        let childExited = false;
        let closed = false;
        let terminalResultSeen = false;
        let terminalCleanupStarted = false;
        let terminalCleanupTimer: NodeJS.Timeout | null = null;
        let terminalResultStdoutScanOffset = 0;
        let terminalResultStderrScanOffset = 0;
        let forceKillTimer: NodeJS.Timeout | null = null;
        let timeout: NodeJS.Timeout | null = null;

        const clearForceKillTimer = () => {
          if (forceKillTimer) {
            clearTimeout(forceKillTimer);
            forceKillTimer = null;
          }
        };

        const clearTerminalCleanupTimer = () => {
          if (terminalCleanupTimer) {
            clearTimeout(terminalCleanupTimer);
            terminalCleanupTimer = null;
          }
        };

        const requestTermination = (reason?: string | null) => {
          if (reason && completionReason) return;
          if (reason) completionReason = reason;

          if (timeout) {
            clearTimeout(timeout);
            timeout = null;
          }

          clearTerminalCleanupTimer();

          try {
            signalRunningProcess({ child, processGroupId }, "SIGTERM");
          } catch {
            return;
          }

          clearForceKillTimer();
          forceKillTimer = setTimeout(() => {
            if (closed) return;
            try {
              signalRunningProcess({ child, processGroupId }, "SIGKILL");
            } catch {
              // Ignore late cleanup failures once the child is already gone.
            }
          }, Math.max(1, opts.graceSec) * 1000);
        };

        const maybeArmTerminalResultCleanup = () => {
          const terminalCleanup = opts.terminalResultCleanup;
          if (!terminalCleanup || terminalCleanupStarted || timedOut || closed) return;
          if (!terminalResultSeen) {
            const stdoutStart = Math.max(0, terminalResultStdoutScanOffset - TERMINAL_RESULT_SCAN_OVERLAP_CHARS);
            const stderrStart = Math.max(0, terminalResultStderrScanOffset - TERMINAL_RESULT_SCAN_OVERLAP_CHARS);
            const scanOutput = {
              stdout: stdout.slice(stdoutStart),
              stderr: stderr.slice(stderrStart),
            };
            terminalResultStdoutScanOffset = stdout.length;
            terminalResultStderrScanOffset = stderr.length;
            if (scanOutput.stdout.length === 0 && scanOutput.stderr.length === 0) return;
            try {
              terminalResultSeen = terminalCleanup.hasTerminalResult(scanOutput);
            } catch (err) {
              onLogError(err, runId, "failed to inspect terminal adapter output");
            }
          }
          if (!terminalResultSeen || !childExited || terminalCleanupTimer) return;

          const graceMs = Math.max(0, terminalCleanup.graceMs ?? 5_000);
          terminalCleanupTimer = setTimeout(() => {
            terminalCleanupTimer = null;
            if (terminalCleanupStarted || timedOut || closed) return;
            terminalCleanupStarted = true;
            requestTermination();
          }, graceMs);
        };

        if (opts.timeoutSec > 0) {
          timeout = setTimeout(() => {
            timedOut = true;
            requestTermination();
          }, opts.timeoutSec * 1000);
        }

        child.stdout?.on("data", (chunk: unknown) => {
          const text = String(chunk);
          stdout = appendWithCap(stdout, text);
          maybeArmTerminalResultCleanup();
          logChain = logChain
            .then(() => opts.onLog("stdout", text))
            .catch((err) => onLogError(err, runId, "failed to append stdout log chunk"))
            .finally(() => {
              maybeArmTerminalResultCleanup();
            });
          const detectedReason = opts.detectCompletionReason?.("stdout", text);
          if (detectedReason) requestTermination(detectedReason);
        });

        child.stderr?.on("data", (chunk: unknown) => {
          const text = String(chunk);
          stderr = appendWithCap(stderr, text);
          maybeArmTerminalResultCleanup();
          logChain = logChain
            .then(() => opts.onLog("stderr", text))
            .catch((err) => onLogError(err, runId, "failed to append stderr log chunk"))
            .finally(() => {
              maybeArmTerminalResultCleanup();
            });
          const detectedReason = opts.detectCompletionReason?.("stderr", text);
          if (detectedReason) requestTermination(detectedReason);
        });

        child.on("error", (err: Error) => {
          if (timeout) clearTimeout(timeout);
          clearTerminalCleanupTimer();
          clearForceKillTimer();
          runningProcesses.delete(runId);
          const errno = (err as NodeJS.ErrnoException).code;
          const pathValue = mergedEnv.PATH ?? mergedEnv.Path ?? "";
          const msg =
            errno === "ENOENT"
              ? `Failed to start command "${command}" in "${opts.cwd}". Verify adapter command, working directory, and PATH (${pathValue}).`
              : `Failed to start command "${command}" in "${opts.cwd}": ${err.message}`;
          reject(new Error(msg));
        });

        child.on("exit", () => {
          childExited = true;
          maybeArmTerminalResultCleanup();
        });

        child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
          closed = true;
          if (timeout) clearTimeout(timeout);
          clearTerminalCleanupTimer();
          clearForceKillTimer();
          runningProcesses.delete(runId);
          void logChain.finally(() => {
            resolve({
              exitCode: code,
              signal,
              timedOut,
              stdout,
              stderr,
              pid: child.pid ?? null,
              startedAt,
              completionReason,
            });
          });
        });
      })
      .catch(reject);
  });
}
