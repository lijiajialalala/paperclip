import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat list summary tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat list summary", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-list-summary-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns compact context and result summaries for run lists", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      contextSnapshot: {
        issueId: "issue-1",
        taskId: "task-1",
        taskKey: "PAP-1",
        wakeReason: "retry_failed_run",
        wakeSource: "on_demand",
        wakeTriggerDetail: "manual",
        paperclipWake: {
          comments: [{ body: "x".repeat(20_000) }],
        },
        nested: {
          ignored: true,
        },
      },
      resultJson: {
        summary: "Completed the task",
        result: "Updated three files",
        message: "done",
        error: null,
        total_cost_usd: 1.25,
        cost_usd: 0.75,
        costUsd: 0.5,
        nested: {
          ignored: true,
        },
      },
    });

    const runs = await heartbeatService(db).list(companyId, agentId, 5);

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: runId,
      contextSnapshot: {
        issueId: "issue-1",
        taskId: "task-1",
        taskKey: "PAP-1",
        wakeReason: "retry_failed_run",
        wakeSource: "on_demand",
        wakeTriggerDetail: "manual",
      },
      resultJson: {
        summary: "Completed the task",
        result: "Updated three files",
        message: "done",
        total_cost_usd: 1.25,
        cost_usd: 0.75,
        costUsd: 0.5,
      },
    });
    expect((runs[0]?.contextSnapshot as Record<string, unknown>)?.paperclipWake).toBeUndefined();
    expect((runs[0]?.resultJson as Record<string, unknown>)?.nested).toBeUndefined();
  });
});
