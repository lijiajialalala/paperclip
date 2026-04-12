import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueStatusTruthService } from "../services/issue-status-truth.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const embeddedPostgresSuiteTimeoutMs = 60_000;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue status truth tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueStatusTruthService activity signals", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-status-truth-");
    db = createDb(tempDb.connectionString);
  }, embeddedPostgresSuiteTimeoutMs);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue(initialStatus: "todo" | "in_progress" | "blocked") {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const issueNumber = Math.floor(Math.random() * 10_000) + 1;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Status truth fixture",
      status: initialStatus,
      priority: "medium",
      issueNumber,
      identifier: `STAT-${issueNumber}`,
    });

    return { companyId, issueId };
  }

  async function seedAgent(companyId: string) {
    const agentId = randomUUID();

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Status Truth Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    return agentId;
  }

  it("treats issue.checked_out as the latest in_progress status signal after a prior blocked update", async () => {
    const { companyId, issueId } = await seedIssue("in_progress");

    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "agent",
        actorId: "agent-blocker",
        action: "issue.updated",
        entityType: "issue",
        entityId: issueId,
        createdAt: new Date("2026-04-12T01:00:00.000Z"),
        details: {
          status: "blocked",
          _previous: { status: "todo" },
        },
      },
      {
        companyId,
        actorType: "agent",
        actorId: "agent-worker",
        action: "issue.checked_out",
        entityType: "issue",
        entityId: issueId,
        createdAt: new Date("2026-04-12T01:05:00.000Z"),
        details: {
          agentId: "agent-worker",
        },
      },
    ]);

    const summary = await issueStatusTruthService(db).getIssueStatusTruthSummary(issueId);

    expect(summary).toEqual(expect.objectContaining({
      effectiveStatus: "in_progress",
      persistedStatus: "in_progress",
      authoritativeStatus: "in_progress",
      consistency: "consistent",
    }));
    expect(summary?.reasonSummary).toMatch(/in_progress/);
  });

  it("treats issue.released as the latest todo status signal after a prior in_progress update", async () => {
    const { companyId, issueId } = await seedIssue("todo");

    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "agent",
        actorId: "agent-worker",
        action: "issue.updated",
        entityType: "issue",
        entityId: issueId,
        createdAt: new Date("2026-04-12T02:00:00.000Z"),
        details: {
          status: "in_progress",
          _previous: { status: "todo" },
        },
      },
      {
        companyId,
        actorType: "agent",
        actorId: "agent-worker",
        action: "issue.released",
        entityType: "issue",
        entityId: issueId,
        createdAt: new Date("2026-04-12T02:07:00.000Z"),
        details: {},
      },
    ]);

    const summary = await issueStatusTruthService(db).getIssueStatusTruthSummary(issueId);

    expect(summary).toEqual(expect.objectContaining({
      effectiveStatus: "todo",
      persistedStatus: "todo",
      authoritativeStatus: "todo",
      consistency: "consistent",
    }));
    expect(summary?.reasonSummary).toMatch(/todo/);
  });

  it("lets a later issue.updated in_review signal override an older checkout activity", async () => {
    const { companyId, issueId } = await seedIssue("in_review");

    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "agent",
        actorId: "agent-worker",
        action: "issue.checked_out",
        entityType: "issue",
        entityId: issueId,
        createdAt: new Date("2026-04-12T03:00:00.000Z"),
        details: {
          agentId: "agent-worker",
        },
      },
      {
        companyId,
        actorType: "agent",
        actorId: "agent-worker",
        action: "issue.updated",
        entityType: "issue",
        entityId: issueId,
        createdAt: new Date("2026-04-12T03:05:00.000Z"),
        details: {
          status: "in_review",
          source: "plan_proposed",
          _previous: { status: "in_progress" },
        },
      },
    ]);

    const summary = await issueStatusTruthService(db).getIssueStatusTruthSummary(issueId);

    expect(summary).toEqual(expect.objectContaining({
      effectiveStatus: "in_review",
      persistedStatus: "in_review",
      authoritativeStatus: "in_review",
      consistency: "consistent",
    }));
  });

  it("lets a later issue.updated todo signal override an older checkout activity", async () => {
    const { companyId, issueId } = await seedIssue("todo");

    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "agent",
        actorId: "agent-worker",
        action: "issue.checked_out",
        entityType: "issue",
        entityId: issueId,
        createdAt: new Date("2026-04-12T04:00:00.000Z"),
        details: {
          agentId: "agent-worker",
        },
      },
      {
        companyId,
        actorType: "user",
        actorId: "board-user",
        action: "issue.updated",
        entityType: "issue",
        entityId: issueId,
        createdAt: new Date("2026-04-12T04:05:00.000Z"),
        details: {
          status: "todo",
          source: "plan_rejected",
          _previous: { status: "in_review" },
        },
      },
    ]);

    const summary = await issueStatusTruthService(db).getIssueStatusTruthSummary(issueId);

    expect(summary).toEqual(expect.objectContaining({
      effectiveStatus: "todo",
      persistedStatus: "todo",
      authoritativeStatus: "todo",
      consistency: "consistent",
    }));
  });

  it("handles aggregated heartbeat timestamps when computing execution state", async () => {
    const { companyId, issueId } = await seedIssue("in_progress");
    const agentId = await seedAgent(companyId);
    const runId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "issue_comment",
      contextSnapshot: {
        issueId,
      },
      updatedAt: new Date("2026-04-12T05:03:00.000Z"),
    });

    await db.update(issues).set({
      executionRunId: runId,
    }).where(eq(issues.id, issueId));

    await db.insert(heartbeatRunEvents).values({
      companyId,
      runId,
      agentId,
      seq: 1,
      eventType: "stdout",
      message: "still running",
      createdAt: new Date("2026-04-12T05:02:00.000Z"),
    });

    const summary = await issueStatusTruthService(db).getIssueStatusTruthSummary(issueId);

    expect(summary).toEqual(expect.objectContaining({
      effectiveStatus: "in_progress",
      executionState: "active",
      executionDiagnosis: null,
    }));
  });
});
