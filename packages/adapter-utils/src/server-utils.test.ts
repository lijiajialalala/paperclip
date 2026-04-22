import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensurePaperclipSkillSymlink,
  readInstalledSkillTargets,
  renderPaperclipWakePrompt,
  runningProcesses,
  runChildProcess,
} from "./server-utils.js";

function makeSymlinkPermissionError(): NodeJS.ErrnoException {
  return Object.assign(new Error("EPERM: operation not permitted, symlink"), {
    code: "EPERM",
    errno: -4048,
    syscall: "symlink",
  });
}

function isPidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPidAlive(pid);
}

async function waitForTextMatch(read: () => string, pattern: RegExp, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    const match = value.match(pattern);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return read().match(pattern);
}

describe("runChildProcess", () => {
  it.skipIf(process.platform === "win32")("cleans up a lingering process group after terminal output and child exit", async () => {
    let spawnedMeta: { pid: number; processGroupId?: number | null; startedAt: string } | null = null;
    const result = await runChildProcess(
      randomUUID(),
      process.execPath,
      [
        "-e",
        [
          "const { spawn } = require('node:child_process');",
          "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'ignore'] });",
          "process.stdout.write(`descendant:${child.pid}\\n`);",
          "process.stdout.write(`${JSON.stringify({ type: 'result', result: 'done' })}\\n`);",
          "setTimeout(() => process.exit(0), 25);",
        ].join(" "),
      ],
      {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 0,
        graceSec: 1,
        onLog: async () => {},
        onSpawn: async (meta) => {
          spawnedMeta = meta;
        },
        terminalResultCleanup: {
          graceMs: 100,
          hasTerminalResult: ({ stdout }) => stdout.includes('"type":"result"'),
        },
      },
    );

    const descendantPid = Number.parseInt(result.stdout.match(/descendant:(\d+)/)?.[1] ?? "", 10);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    if (!spawnedMeta) {
      throw new Error("Expected spawned process metadata");
    }
    const meta: { pid: number; processGroupId?: number | null; startedAt: string } = spawnedMeta;
    expect(meta.processGroupId).toBe(meta.pid);
    expect(Number.isInteger(descendantPid) && descendantPid > 0).toBe(true);
    expect(await waitForPidExit(descendantPid, 2_000)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("does not clean up noisy runs that have no terminal output", async () => {
    const runId = randomUUID();
    let observed = "";
    const resultPromise = runChildProcess(
      runId,
      process.execPath,
      [
        "-e",
        [
          "const { spawn } = require('node:child_process');",
          "const child = spawn(process.execPath, ['-e', \"setInterval(() => process.stdout.write('noise\\\\n'), 50)\"], { stdio: ['ignore', 'inherit', 'ignore'] });",
          "process.stdout.write(`descendant:${child.pid}\\n`);",
          "setTimeout(() => process.exit(0), 25);",
        ].join(" "),
      ],
      {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 0,
        graceSec: 1,
        onLog: async (_stream, chunk) => {
          observed += chunk;
        },
        terminalResultCleanup: {
          graceMs: 50,
          hasTerminalResult: ({ stdout }) => stdout.includes('"type":"result"'),
        },
      },
    );

    const pidMatch = await waitForTextMatch(() => observed, /descendant:(\d+)/);
    const descendantPid = Number.parseInt(pidMatch?.[1] ?? "", 10);
    expect(Number.isInteger(descendantPid) && descendantPid > 0).toBe(true);

    const race = await Promise.race([
      resultPromise.then(() => "settled" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 300)),
    ]);
    expect(race).toBe("pending");
    expect(isPidAlive(descendantPid)).toBe(true);

    const running = runningProcesses.get(runId);
    try {
      if (running?.processGroupId) {
        process.kill(-running.processGroupId, "SIGKILL");
      } else {
        running?.child.kill("SIGKILL");
      }
      await resultPromise;
    } finally {
      runningProcesses.delete(runId);
      if (isPidAlive(descendantPid)) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // Ignore cleanup races.
        }
      }
    }
  });
});

describe("ensurePaperclipSkillSymlink", () => {
  const tempRoots = new Set<string>();

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      [...tempRoots].map(async (root) => {
        await fs.rm(root, { recursive: true, force: true });
        tempRoots.delete(root);
      }),
    );
  });

  it("falls back to a Windows-safe managed link strategy when symlink creation is blocked", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skill-link-"));
    tempRoots.add(root);

    const source = path.join(root, "paperclip-skill");
    const target = path.join(root, "managed-home", "skills", "paperclip-skill");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "SKILL.md"), "# Paperclip Skill\n", "utf8");

    const result = await ensurePaperclipSkillSymlink(
      source,
      target,
      async () => {
        throw makeSymlinkPermissionError();
      },
    );

    const stats = await fs.lstat(target);
    const content = await fs.readFile(path.join(target, "SKILL.md"), "utf8");

    expect(result).toBe("created");
    expect(content).toBe("# Paperclip Skill\n");
    if (process.platform === "win32") {
      expect(stats.isSymbolicLink()).toBe(true);
      expect(await fs.realpath(target)).toBe(await fs.realpath(source));
    } else {
      expect(stats.isSymbolicLink()).toBe(false);
      expect(stats.isDirectory()).toBe(true);
    }
  });

  it("keeps mirrored fallback directories marked as Paperclip-managed", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skill-mirror-"));
    tempRoots.add(root);

    const source = path.join(root, "paperclip-skill");
    const skillsHome = path.join(root, "managed-home", "skills");
    const target = path.join(skillsHome, "paperclip-skill");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "SKILL.md"), "# Paperclip Skill\n", "utf8");

    vi.spyOn(fs, "symlink").mockRejectedValue(makeSymlinkPermissionError());

    const result = await ensurePaperclipSkillSymlink(
      source,
      target,
      async () => {
        throw makeSymlinkPermissionError();
      },
    );

    const stats = await fs.lstat(target);
    const installed = await readInstalledSkillTargets(skillsHome);

    expect(result).toBe("created");
    expect(stats.isDirectory()).toBe(true);
    expect(installed.get("paperclip-skill")).toEqual({
      targetPath: source,
      kind: "managed_directory",
    });
  });

  it("does not replace an unmanaged directory that only happens to share the same SKILL.md", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skill-unmanaged-"));
    tempRoots.add(root);

    const source = path.join(root, "paperclip-skill");
    const target = path.join(root, "managed-home", "skills", "paperclip-skill");
    await fs.mkdir(source, { recursive: true });
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(source, "SKILL.md"), "# Paperclip Skill\n", "utf8");
    await fs.writeFile(path.join(target, "SKILL.md"), "# Paperclip Skill\n", "utf8");
    await fs.writeFile(path.join(target, "notes.txt"), "keep me\n", "utf8");

    const linkSkill = vi.fn(async () => {});
    const result = await ensurePaperclipSkillSymlink(source, target, linkSkill);

    expect(result).toBe("skipped");
    expect(linkSkill).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(target, "notes.txt"), "utf8")).toBe("keep me\n");
  });
});

describe("renderPaperclipWakePrompt", () => {
  it("renders task root guidance when the wake payload includes task namespace metadata", () => {
    const prompt = renderPaperclipWakePrompt({
      reason: "issue_assigned",
      issue: {
        id: "issue-1",
        identifier: "PAP-101",
        title: "Prepare research report",
        status: "todo",
        priority: "medium",
        workspaceCwd: "/workspace/project",
        taskRootIssueId: "task-root-1",
        taskRootDir: "/workspace/.paperclip/tasks/task-root-1",
        deliverableRoot: "/workspace/.paperclip/tasks/task-root-1/deliverables",
      },
      commentIds: ["comment-1"],
      latestCommentId: "comment-1",
      comments: [
        {
          id: "comment-1",
          issueId: "issue-1",
          body: "继续在任务命名空间下产出报告。",
          bodyTruncated: false,
          createdAt: "2026-04-18T09:00:00.000Z",
          author: {
            type: "user",
            id: "board-user",
          },
        },
      ],
      commentWindow: {
        requestedCount: 1,
        includedCount: 1,
        missingCount: 0,
      },
      truncated: false,
      fallbackFetchNeeded: false,
    });

    expect(prompt).toContain("task root issue: task-root-1");
    expect(prompt).toContain("working directory: /workspace/project");
    expect(prompt).toContain("task root dir: /workspace/.paperclip/tasks/task-root-1");
    expect(prompt).toContain("deliverable root: /workspace/.paperclip/tasks/task-root-1/deliverables");
    expect(prompt).toContain("use the working directory for project files");
  });

  it("renders issue-scoped guidance even when an assignment wake has no inline comments", () => {
    const prompt = renderPaperclipWakePrompt({
      reason: "issue_assigned",
      issue: {
        id: "issue-1",
        identifier: "PAP-102",
        title: "Recover quality routine",
        status: "todo",
        priority: "high",
      },
      commentIds: [],
      latestCommentId: null,
      comments: [],
      commentWindow: {
        requestedCount: 0,
        includedCount: 0,
        missingCount: 0,
      },
      truncated: false,
      fallbackFetchNeeded: false,
    });

    expect(prompt).toContain("issue: PAP-102 Recover quality routine");
    expect(prompt).toContain("issue status: todo");
    expect(prompt).toContain("issue priority: high");
    expect(prompt).toContain("No inline comments accompanied this wake");
  });
});
