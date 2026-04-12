import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  approvalComments,
  approvals,
  agents,
  companies,
  costEvents,
  createDb,
  feedbackVotes,
  financeEvents,
  issueApprovals,
  issueComments,
  issueInboxArchives,
  issueReadStates,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import { projectService } from "../services/projects.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const embeddedPostgresSuiteTimeoutMs = 60_000;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres project service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("projectService issue lifecycle", () => {
  let db!: ReturnType<typeof createDb>;
  let issueSvc!: ReturnType<typeof issueService>;
  let projectSvc!: ReturnType<typeof projectService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-lifecycle-");
    db = createDb(tempDb.connectionString);
    issueSvc = issueService(db);
    projectSvc = projectService(db);
  }, embeddedPostgresSuiteTimeoutMs);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueInboxArchives);
    await db.delete(issueReadStates);
    await db.delete(feedbackVotes);
    await db.delete(financeEvents);
    await db.delete(costEvents);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("archives project issues by default and only restores project-hidden issues on unarchive", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const rootIssueId = randomUUID();
    const childIssueId = randomUUID();
    const manualHiddenIssueId = randomUUID();
    const archiveAt = new Date("2026-04-12T01:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "CMPA",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Archived project",
      status: "in_progress",
    });

    await db.insert(issues).values([
      {
        id: rootIssueId,
        companyId,
        projectId,
        title: "Root project issue",
        status: "todo",
        priority: "medium",
      },
      {
        id: childIssueId,
        companyId,
        projectId,
        parentId: rootIssueId,
        title: "Child issue in same project",
        status: "todo",
        priority: "medium",
      },
      {
        id: manualHiddenIssueId,
        companyId,
        projectId,
        title: "Manual hidden issue",
        status: "todo",
        priority: "medium",
        hiddenAt: new Date("2026-04-11T12:00:00.000Z"),
        hiddenReason: "manual",
      },
    ]);

    await projectSvc.update(projectId, { archivedAt: archiveAt });

    const archivedRows = await db
      .select({
        id: issues.id,
        hiddenAt: issues.hiddenAt,
        hiddenReason: issues.hiddenReason,
      })
      .from(issues)
      .where(eq(issues.companyId, companyId));

    expect(archivedRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: rootIssueId,
        hiddenAt: archiveAt,
        hiddenReason: "project_archived",
      }),
      expect.objectContaining({
        id: childIssueId,
        hiddenAt: archiveAt,
        hiddenReason: "project_archived",
      }),
      expect.objectContaining({
        id: manualHiddenIssueId,
        hiddenReason: "manual",
      }),
    ]));

    const defaultVisible = await issueSvc.list(companyId, {});
    expect(defaultVisible.map((issue) => issue.id)).toEqual([]);

    const archivedVisible = await issueSvc.list(companyId, {
      includeArchivedProjectIssues: true,
    });
    expect(new Set(archivedVisible.map((issue) => issue.id))).toEqual(new Set([
      rootIssueId,
      childIssueId,
    ]));

    const allVisible = await issueSvc.list(companyId, {
      includeHidden: true,
      includeArchivedProjectIssues: true,
    });
    expect(new Set(allVisible.map((issue) => issue.id))).toEqual(new Set([
      rootIssueId,
      childIssueId,
      manualHiddenIssueId,
    ]));

    await projectSvc.update(projectId, { archivedAt: null });

    const restoredRows = await db
      .select({
        id: issues.id,
        hiddenAt: issues.hiddenAt,
        hiddenReason: issues.hiddenReason,
      })
      .from(issues)
      .where(eq(issues.companyId, companyId));

    expect(restoredRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: rootIssueId,
        hiddenAt: null,
        hiddenReason: null,
      }),
      expect.objectContaining({
        id: childIssueId,
        hiddenAt: null,
        hiddenReason: null,
      }),
      expect.objectContaining({
        id: manualHiddenIssueId,
        hiddenReason: "manual",
      }),
    ]));
  });

  it("deletes project issues, descendants, and non-cascading dependent rows", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const rootIssueId = randomUUID();
    const childIssueId = randomUUID();
    const agentId = randomUUID();
    const costEventId = randomUUID();
    const financeEventId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "CMPA",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Delete me",
      status: "in_progress",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Cost agent",
      role: "general",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values([
      {
        id: rootIssueId,
        companyId,
        projectId,
        title: "Root project issue",
        status: "todo",
        priority: "medium",
      },
      {
        id: childIssueId,
        companyId,
        projectId,
        parentId: rootIssueId,
        title: "Child issue",
        status: "todo",
        priority: "medium",
      },
    ]);

    await db.insert(issueComments).values({
      companyId,
      issueId: rootIssueId,
      body: "comment",
    });
    await db.insert(issueInboxArchives).values({
      companyId,
      issueId: rootIssueId,
      userId: "board-user",
    });
    await db.insert(issueReadStates).values({
      companyId,
      issueId: childIssueId,
      userId: "board-user",
    });
    await db.insert(feedbackVotes).values({
      companyId,
      issueId: rootIssueId,
      targetType: "issue",
      targetId: rootIssueId,
      authorUserId: "board-user",
      vote: "up",
    });
    await db.insert(costEvents).values({
      id: costEventId,
      companyId,
      agentId,
      issueId: rootIssueId,
      projectId,
      goalId: null,
      heartbeatRunId: null,
      billingCode: null,
      provider: "openai",
      biller: "openai",
      billingType: "token",
      model: "gpt-5.4",
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      costCents: 1,
      occurredAt: new Date("2026-04-12T00:00:00.000Z"),
    });
    await db.insert(financeEvents).values({
      id: financeEventId,
      companyId,
      agentId: null,
      issueId: rootIssueId,
      projectId,
      goalId: null,
      heartbeatRunId: null,
      costEventId,
      billingCode: null,
      description: "charge",
      eventKind: "usage",
      direction: "debit",
      biller: "openai",
      provider: "openai",
      executionAdapterType: null,
      pricingTier: null,
      region: null,
      model: "gpt-5.4",
      quantity: 1,
      unit: "token",
      amountCents: 1,
      currency: "USD",
      estimated: false,
      externalInvoiceId: null,
      metadataJson: null,
      occurredAt: new Date("2026-04-12T00:00:00.000Z"),
    });

    const removed = await projectSvc.remove(projectId);

    expect(removed?.id).toBe(projectId);
    await expect(projectSvc.getById(projectId)).resolves.toBeNull();

    const issueRows = await db.select({ id: issues.id }).from(issues).where(eq(issues.companyId, companyId));
    expect(issueRows).toEqual([]);

    await expect(
      db.select({ id: issueComments.id }).from(issueComments).where(eq(issueComments.companyId, companyId)),
    ).resolves.toEqual([]);
    await expect(
      db.select({ id: issueInboxArchives.id }).from(issueInboxArchives).where(eq(issueInboxArchives.companyId, companyId)),
    ).resolves.toEqual([]);
    await expect(
      db.select({ id: issueReadStates.id }).from(issueReadStates).where(eq(issueReadStates.companyId, companyId)),
    ).resolves.toEqual([]);
    await expect(
      db.select({ id: feedbackVotes.id }).from(feedbackVotes).where(eq(feedbackVotes.companyId, companyId)),
    ).resolves.toEqual([]);
    await expect(
      db.select({ id: costEvents.id }).from(costEvents).where(eq(costEvents.companyId, companyId)),
    ).resolves.toEqual([]);
    await expect(
      db.select({ id: financeEvents.id }).from(financeEvents).where(eq(financeEvents.companyId, companyId)),
    ).resolves.toEqual([]);
  });

  it("removes approvals that become orphaned after project issue deletion", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    const approvalId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "CMPA",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Delete orphan approvals",
      status: "in_progress",
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Issue with linked approval",
      status: "todo",
      priority: "medium",
    });

    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "work_plan",
      requestedByUserId: "board-user",
      status: "approved",
      payload: { summary: "plan" },
    });

    await db.insert(issueApprovals).values({
      companyId,
      issueId,
      approvalId,
      linkedByUserId: "board-user",
    });

    await db.insert(approvalComments).values({
      companyId,
      approvalId,
      authorUserId: "board-user",
      body: "Looks good.",
    });

    await projectSvc.remove(projectId);

    await expect(
      db.select({ id: approvals.id }).from(approvals).where(eq(approvals.companyId, companyId)),
    ).resolves.toEqual([]);
    await expect(
      db.select({ id: approvalComments.id }).from(approvalComments).where(eq(approvalComments.companyId, companyId)),
    ).resolves.toEqual([]);
  });
});
