import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@paperclipai/adapter-claude-local/server";

async function writeFakeClaudeCommand(commandBasePath: string): Promise<string> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
  const payload = {
    argv: process.argv.slice(2),
    prompt: fs.readFileSync(0, "utf8"),
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR || null,
    paperclipWakePayloadJson: process.env.PAPERCLIP_WAKE_PAYLOAD_JSON || null,
  };
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }));
console.log(JSON.stringify({ type: "assistant", session_id: "claude-session-1", message: { content: [{ type: "text", text: "hello" }] } }));
console.log(JSON.stringify({ type: "result", session_id: "claude-session-1", result: "hello", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }));
`;
  if (process.platform === "win32") {
    const scriptPath = `${commandBasePath}.js`;
    const wrapperPath = `${commandBasePath}.cmd`;
    const wrapper = `@echo off\r\nnode "%~dp0${path.basename(scriptPath)}" %*\r\n`;
    await fs.writeFile(scriptPath, script, "utf8");
    await fs.writeFile(wrapperPath, wrapper, "utf8");
    return wrapperPath;
  }

  await fs.writeFile(commandBasePath, script, "utf8");
  await fs.chmod(commandBasePath, 0o755);
  return commandBasePath;
}

describe("claude execute", () => {
  it("logs HOME, CLAUDE_CONFIG_DIR, and the resolved executable path in invocation metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-execute-meta-"));
    const workspace = path.join(root, "workspace");
    const binDir = path.join(root, "bin");
    const capturePath = path.join(root, "capture.json");
    const claudeConfigDir = path.join(root, "claude-config");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(claudeConfigDir, { recursive: true });
    const commandPath = await writeFakeClaudeCommand(path.join(binDir, "claude"));

    const previousHome = process.env.HOME;
    const previousPath = process.env.PATH;
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.HOME = root;
    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;

    let loggedCommand: string | null = null;
    let loggedEnv: Record<string, string> = {};
    try {
      const result = await execute({
        runId: "run-meta",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claude Coder",
          adapterType: "claude_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: "claude",
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
            CLAUDE_CONFIG_DIR: claudeConfigDir,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          loggedCommand = meta.command;
          loggedEnv = meta.env ?? {};
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      if (process.platform === "win32") {
        expect(loggedCommand?.toLowerCase()).toBe(commandPath.toLowerCase());
      } else {
        expect(loggedCommand).toBe(commandPath);
      }
      expect(loggedEnv.HOME).toBe(root);
      expect(loggedEnv.CLAUDE_CONFIG_DIR).toBe(claudeConfigDir);
      if (process.platform === "win32") {
        expect(loggedEnv.PAPERCLIP_RESOLVED_COMMAND?.toLowerCase()).toBe(commandPath.toLowerCase());
      } else {
        expect(loggedEnv.PAPERCLIP_RESOLVED_COMMAND).toBe(commandPath);
      }
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uses an agent-isolated CLAUDE_CONFIG_DIR and renders issue-assigned wake prompts without inline comments", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-execute-managed-"));
    const workspace = path.join(root, "workspace");
    const commandPath = await writeFakeClaudeCommand(path.join(root, "claude"));
    const capturePath = path.join(root, "capture.json");
    const sharedClaudeConfigDir = path.join(root, "shared-claude");
    const paperclipHome = path.join(root, "paperclip-home");
    const managedClaudeConfigDir = path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "claude-home",
    );
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sharedClaudeConfigDir, { recursive: true });
    await fs.writeFile(
      path.join(sharedClaudeConfigDir, "settings.json"),
      JSON.stringify({ model: "claude-sonnet-4", outputStyle: "Direct Delivery" }, null, 2),
      "utf8",
    );

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    const previousPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.HOME = root;
    process.env.PAPERCLIP_HOME = paperclipHome;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    process.env.CLAUDE_CONFIG_DIR = sharedClaudeConfigDir;

    try {
      const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
      const result = await execute({
        runId: "run-managed",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claude Coder",
          adapterType: "claude_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: "issue-1",
        },
        config: {
          command: commandPath,
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {
          issueId: "issue-1",
          taskId: "issue-1",
          wakeReason: "issue_assigned",
          paperclipWake: {
            reason: "issue_assigned",
            issue: {
              id: "issue-1",
              identifier: "PAP-220",
              title: "Recover the quality routine",
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
          },
        },
        authToken: "run-jwt-token",
        onLog: async (stream, chunk) => {
          logs.push({ stream, chunk });
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        prompt: string;
        claudeConfigDir: string | null;
        paperclipWakePayloadJson: string | null;
      };
      expect(capture.claudeConfigDir).toBe(managedClaudeConfigDir);
      expect(capture.paperclipWakePayloadJson).not.toBeNull();
      expect(JSON.parse(capture.paperclipWakePayloadJson ?? "{}")).toMatchObject({
        reason: "issue_assigned",
        issue: {
          id: "issue-1",
          identifier: "PAP-220",
          title: "Recover the quality routine",
        },
        commentIds: [],
        comments: [],
      });
      expect(capture.prompt).toContain("## Paperclip Wake Payload");
      expect(capture.prompt).toContain("issue: PAP-220 Recover the quality routine");
      expect(capture.prompt).toContain("No inline comments accompanied this wake");

      const managedSettings = path.join(managedClaudeConfigDir, "settings.json");
      expect(await fs.readFile(managedSettings, "utf8")).toBe(
        await fs.readFile(path.join(sharedClaudeConfigDir, "settings.json"), "utf8"),
      );
      expect(logs).toContainEqual(
        expect.objectContaining({
          stream: "stdout",
          chunk: expect.stringContaining("Using agent-isolated Claude config dir"),
        }),
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousPaperclipInstanceId;
      if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
