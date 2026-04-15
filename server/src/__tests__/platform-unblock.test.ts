import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { platformUnblockService } from "../services/platform-unblock.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const embeddedPostgresSuiteTimeoutMs = 60_000;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres platform unblock tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("platformUnblockService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-platform-unblock-");
    db = createDb(tempDb.connectionString);
  }, embeddedPostgresSuiteTimeoutMs);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const ctoId = randomUUID();
    const techLeadId = randomUUID();
    const backendId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "CMPA",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: ctoId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: techLeadId,
        companyId,
        name: "Tech Lead",
        role: "manager",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: backendId,
        companyId,
        name: "SWE Backend",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 39,
      identifier: "CMPA-39",
      title: "Platform blockage",
      status: "blocked",
      priority: "high",
      updatedAt: new Date("2026-04-08T00:10:00.000Z"),
    });

    return { companyId, issueId, backendId };
  }

  it("classifies repeated process_lost runs as a runtime platform blocker", async () => {
    const { companyId, issueId, backendId } = await seedCompany();

    await db.insert(heartbeatRuns).values([
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        companyId,
        agentId: backendId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "failed",
        contextSnapshot: { issueId },
        resultJson: {},
        errorCode: "process_lost",
        error: "process lost",
        processLossRetryCount: 1,
        startedAt: new Date("2026-04-08T00:00:00.000Z"),
        finishedAt: new Date("2026-04-08T00:01:00.000Z"),
        createdAt: new Date("2026-04-08T00:01:00.000Z"),
        updatedAt: new Date("2026-04-08T00:01:00.000Z"),
      },
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        companyId,
        agentId: backendId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "failed",
        contextSnapshot: { issueId },
        resultJson: {},
        errorCode: "process_lost",
        error: "process lost again",
        processLossRetryCount: 2,
        startedAt: new Date("2026-04-08T00:09:00.000Z"),
        finishedAt: new Date("2026-04-08T00:10:00.000Z"),
        createdAt: new Date("2026-04-08T00:10:00.000Z"),
        updatedAt: new Date("2026-04-08T00:10:00.000Z"),
      },
    ]);

    const summary = await platformUnblockService(db).getIssuePlatformUnblockSummary(issueId);

    expect(summary).toEqual(expect.objectContaining({
      mode: "platform",
      primaryCategory: "runtime_process",
      primaryOwnerRole: "runtime_owner",
      blocksExecutionRetry: true,
      blocksCloseOut: false,
      canRetryEngineering: false,
      canCloseUpstream: null,
    }));
  });

  it("builds run platform hints from close-gate activity and writeback alerts", async () => {
    const { companyId, issueId, backendId } = await seedCompany();
    const runId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: backendId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      contextSnapshot: { issueId },
      resultJson: {
        issueWriteback: {
          status: "alerted_inconclusive",
          verdict: "inconclusive",
          source: "alert",
          canCloseUpstream: false,
          commentId: null,
          writebackAt: "2026-04-08T00:10:00.000Z",
          alertType: "partial_writeback_conflict",
          latest: true,
        },
      },
      errorCode: null,
      error: "conflicting qa verdict",
      processLossRetryCount: 0,
      startedAt: new Date("2026-04-08T00:09:00.000Z"),
      finishedAt: new Date("2026-04-08T00:10:00.000Z"),
      createdAt: new Date("2026-04-08T00:10:00.000Z"),
      updatedAt: new Date("2026-04-08T00:10:00.000Z"),
    });

    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "paperclip",
      action: "issue.close_gate_blocked",
      entityType: "issue",
      entityId: issueId,
      details: { runId },
    });

    const hint = await platformUnblockService(db).getRunPlatformHint(runId);

    expect(hint).toEqual({
      latestForIssue: true,
      processLost: false,
      processLossRetryCount: 0,
      writebackAlertType: "partial_writeback_conflict",
      closeGateBlocked: true,
    });
  });

  it("classifies plan-pending QA writeback alerts as a qa_writeback_gate blocker", async () => {
    const { companyId, issueId, backendId } = await seedCompany();
    const qaAgentId = randomUUID();

    await db.insert(agents).values({
      id: qaAgentId,
      companyId,
      name: "QA Agent",
      role: "qa",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      reportsTo: backendId,
    });

    await db
      .update(issues)
      .set({
        status: "in_review",
        planProposedAt: new Date("2026-04-08T00:05:00.000Z"),
        planApprovedAt: null,
      })
      .where(eq(issues.id, issueId));

    await db.insert(heartbeatRuns).values({
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      companyId,
      agentId: qaAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "succeeded",
      contextSnapshot: { issueId },
      resultJson: {
        issueWriteback: {
          status: "alerted_inconclusive",
          verdict: "pass",
          source: "alert",
          canCloseUpstream: false,
          commentId: null,
          writebackAt: "2026-04-08T00:10:00.000Z",
          alertType: "plan_pending_review",
          latest: true,
        },
      },
      errorCode: null,
      error: null,
      processLossRetryCount: 0,
      startedAt: new Date("2026-04-08T00:09:00.000Z"),
      finishedAt: new Date("2026-04-08T00:10:00.000Z"),
      createdAt: new Date("2026-04-08T00:10:00.000Z"),
      updatedAt: new Date("2026-04-08T00:10:00.000Z"),
    });

    const summary = await platformUnblockService(db).getIssuePlatformUnblockSummary(issueId);

    expect(summary).toEqual(expect.objectContaining({
      mode: "platform",
      primaryCategory: "qa_writeback_gate",
      primaryOwnerRole: "qa_writeback_owner",
      canRetryEngineering: false,
      canCloseUpstream: false,
      authoritativeSignalSource: "qa_summary",
    }));
  });
});
