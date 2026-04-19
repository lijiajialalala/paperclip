import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { qaIssueStateService } from "../services/qa-issue-state.ts";
import { buildQaIssueWriteback } from "../services/qa-writeback.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const embeddedPostgresSuiteTimeoutMs = 60_000;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres QA issue state tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("qaIssueStateService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-qa-issue-state-");
    db = createDb(tempDb.connectionString);
  }, embeddedPostgresSuiteTimeoutMs);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture() {
    const companyId = randomUUID();
    const qaAgentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "CMPA",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: qaAgentId,
      companyId,
      name: "QA Reviewer",
      role: "qa",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 51,
      identifier: "CMPA-51",
      title: "QA verification",
      status: "blocked",
      priority: "high",
      assigneeAgentId: qaAgentId,
    });

    await db.insert(heartbeatRuns).values({
      id: "51515151-5151-4515-8515-515151515151",
      companyId,
      agentId: qaAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      contextSnapshot: { issueId },
      resultJson: {
        issueWriteback: buildQaIssueWriteback({
          status: "alerted_missing",
          verdict: null,
          source: "alert",
          canCloseUpstream: false,
          commentId: null,
          writebackAt: "2026-04-08T01:00:00.000Z",
          alertType: "missing_writeback",
        }),
      },
      errorCode: "adapter_failed",
      error: "run failed before durable verdict writeback",
      startedAt: new Date("2026-04-08T00:55:00.000Z"),
      finishedAt: new Date("2026-04-08T01:00:00.000Z"),
      createdAt: new Date("2026-04-08T01:00:00.000Z"),
      updatedAt: new Date("2026-04-08T01:00:00.000Z"),
    });

    return { companyId, qaAgentId, issueId };
  }

  it("does not clear a QA alert just because a later comment contains a verdict", async () => {
    const { issueId } = await seedFixture();

    await db.insert(issueComments).values({
      companyId: (await db.select({ companyId: issues.companyId }).from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!)).companyId,
      issueId,
      authorUserId: "board-user",
      body: "## QA Verdict\n\n- Verdict: pass\n- Note: board pasted a summary manually.",
      createdAt: new Date("2026-04-08T01:05:00.000Z"),
    });

    const summary = await qaIssueStateService(db).getIssueQaSummary(issueId);

    expect(summary).toEqual(expect.objectContaining({
      source: "alert",
      canCloseUpstream: false,
      alertOpen: true,
      alertType: "missing_writeback",
    }));
  });

  it("does not clear a QA alert just because the issue row later moved to done", async () => {
    const { companyId, issueId } = await seedFixture();

    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "board-user",
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      details: {
        identifier: "CMPA-51",
        status: "done",
        source: "manual_board_patch",
      },
      createdAt: new Date("2026-04-08T01:06:00.000Z"),
    });

    const summary = await qaIssueStateService(db).getIssueQaSummary(issueId);

    expect(summary).toEqual(expect.objectContaining({
      source: "alert",
      canCloseUpstream: false,
      alertOpen: true,
      alertType: "missing_writeback",
    }));
  });
});
