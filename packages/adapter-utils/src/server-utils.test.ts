import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensurePaperclipSkillSymlink,
  readInstalledSkillTargets,
  renderPaperclipWakePrompt,
} from "./server-utils.js";

function makeSymlinkPermissionError(): NodeJS.ErrnoException {
  return Object.assign(new Error("EPERM: operation not permitted, symlink"), {
    code: "EPERM",
    errno: -4048,
    syscall: "symlink",
  });
}

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
    expect(prompt).toContain("task root dir: /workspace/.paperclip/tasks/task-root-1");
    expect(prompt).toContain("deliverable root: /workspace/.paperclip/tasks/task-root-1/deliverables");
  });
});
