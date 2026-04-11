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
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { qaWritebackService, readQaIssueWriteback } from "../services/qa-writeback.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const embeddedPostgresSuiteTimeoutMs = 60_000;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres QA writeback tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("qaWritebackService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-qa-writeback-");
    db = createDb(tempDb.connectionString);
  }, embeddedPostgresSuiteTimeoutMs);

  afterEach(async () => {
    await db.delete(issueComments);
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
      issueNumber: 39,
      identifier: "CMPA-39",
      title: "Verify release candidate",
      status: "in_review",
      priority: "high",
      assigneeAgentId: qaAgentId,
    });

    return { companyId, qaAgentId, issueId };
  }

  async function getRun(runId: string) {
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]!);
  }

  async function getIssue(issueId: string) {
    return db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
  }

  async function getAgent(agentId: string) {
    return db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]!);
  }

  it("writes a durable pass verdict to the issue and run", async () => {
    const { companyId, qaAgentId, issueId } = await seedFixture();
    const createdAt = new Date("2026-04-08T00:00:00.000Z");

    await db.insert(heartbeatRuns).values({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId,
      agentId: qaAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "succeeded",
      contextSnapshot: { issueId },
      resultJson: {
        verdict: "pass",
        summary: "Verdict: pass\nAll checks green.",
      },
      startedAt: new Date(createdAt.getTime() - 60_000),
      finishedAt: createdAt,
      createdAt,
      updatedAt: createdAt,
    });

    const run = await getRun("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const agent = await getAgent(qaAgentId);
    const settlement = await qaWritebackService(db).settleTerminalQaRun({
      run,
      runAgent: agent,
      issueId,
    });

    const updatedRun = await getRun(run.id);
    const updatedIssue = await getIssue(issueId);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));

    expect(settlement.issueWriteback.status).toBe("platform_written");
    expect(readQaIssueWriteback(updatedRun.resultJson)?.verdict).toBe("pass");
    expect(updatedIssue.status).toBe("done");
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("## QA Verdict");
    expect(comments[0]?.body).toContain("Verdict: pass");
  });

  it("uses platform_interrupted (not alerted_missing) when the run failed with process_lost", async () => {
    // Fix #2 regression: process_lost must NOT block canCloseUpstream.
    // The status must be platform_interrupted so the close gate treats it as neutral.
    const { companyId, qaAgentId, issueId } = await seedFixture();
    const agent = await getAgent(qaAgentId);

    await db.insert(heartbeatRuns).values({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      companyId,
      agentId: qaAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      contextSnapshot: { issueId },
      resultJson: {},
      errorCode: "process_lost",
      error: "Child process disappeared",
      startedAt: new Date("2026-04-08T00:09:00.000Z"),
      finishedAt: new Date("2026-04-08T00:10:00.000Z"),
      createdAt: new Date("2026-04-08T00:10:00.000Z"),
      updatedAt: new Date("2026-04-08T00:10:00.000Z"),
    });

    const run = await getRun("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const settlement = await qaWritebackService(db).settleTerminalQaRun({
      run,
      runAgent: agent,
      issueId,
    });

    const updatedIssue = await getIssue(issueId);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));

    // Fix #2: must be platform_interrupted, NOT alerted_missing
    expect(settlement.issueWriteback.status).toBe("platform_interrupted");
    // canCloseUpstream must be null (neutral), NOT false (blocking)
    expect(settlement.issueWriteback.canCloseUpstream).toBeNull();
    // Issue status unchanged — platform interruption must not flip issue state
    expect(updatedIssue.status).toBe("in_review");
    // No automated comment from a process_lost run
    expect(comments).toHaveLength(0);
  });

  it("is idempotent: calling settleTerminalQaRun twice does not write extra comments", async () => {
    // Fix #3: concurrent / retry invocations must not produce duplicate verdict comments.
    const { companyId, qaAgentId, issueId } = await seedFixture();
    const createdAt = new Date("2026-04-08T00:00:00.000Z");

    await db.insert(heartbeatRuns).values({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      companyId,
      agentId: qaAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "succeeded",
      contextSnapshot: { issueId },
      resultJson: { verdict: "pass", summary: "All checks green." },
      startedAt: new Date(createdAt.getTime() - 60_000),
      finishedAt: createdAt,
      createdAt,
      updatedAt: createdAt,
    });

    const run = await getRun("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    const agent = await getAgent(qaAgentId);
    const svc = qaWritebackService(db);

    // First call — does the real work
    const first = await svc.settleTerminalQaRun({ run, runAgent: agent, issueId });

    // Reload the run from DB (now has resultJson.issueWriteback)
    const runAfterFirst = await getRun(run.id);

    // Second call (simulates retry / concurrent invocation)
    const second = await svc.settleTerminalQaRun({ run: runAfterFirst, runAgent: agent, issueId });

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));

    // Both calls return same status
    expect(first.issueWriteback.status).toBe(second.issueWriteback.status);
    // Exactly one verdict comment, not two
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("## QA Verdict");
  });
});
