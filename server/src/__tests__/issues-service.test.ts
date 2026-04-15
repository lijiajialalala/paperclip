import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  approvalComments,
  approvals,
  activityLog,
  agents,
  companies,
  costEvents,
  createDb,
  executionWorkspaces,
  feedbackVotes,
  financeEvents,
  heartbeatRuns,
  instanceSettings,
  issueApprovals,
  issueComments,
  issueInboxArchives,
  issueReadStates,
  issues,
  projectWorkspaces,
  projects,
  routines,
  routineRuns,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { issueStatusTruthService } from "../services/issue-status-truth.ts";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const embeddedPostgresSuiteTimeoutMs = 60_000;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueService.list participantAgentId", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-service-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, embeddedPostgresSuiteTimeoutMs);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns issues an agent participated in across the supported signals", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "OtherAgent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const assignedIssueId = randomUUID();
    const createdIssueId = randomUUID();
    const commentedIssueId = randomUUID();
    const activityIssueId = randomUUID();
    const excludedIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: assignedIssueId,
        companyId,
        title: "Assigned issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        createdByAgentId: otherAgentId,
      },
      {
        id: createdIssueId,
        companyId,
        title: "Created issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: agentId,
      },
      {
        id: commentedIssueId,
        companyId,
        title: "Commented issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: otherAgentId,
      },
      {
        id: activityIssueId,
        companyId,
        title: "Activity issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: otherAgentId,
      },
      {
        id: excludedIssueId,
        companyId,
        title: "Excluded issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: otherAgentId,
        assigneeAgentId: otherAgentId,
      },
    ]);

    await db.insert(issueComments).values({
      companyId,
      issueId: commentedIssueId,
      authorAgentId: agentId,
      body: "Investigating this issue.",
    });

    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "issue.updated",
      entityType: "issue",
      entityId: activityIssueId,
      agentId,
      details: { changed: true },
    });

    const result = await svc.list(companyId, { participantAgentId: agentId });
    const resultIds = new Set(result.map((issue) => issue.id));

    expect(resultIds).toEqual(new Set([
      assignedIssueId,
      createdIssueId,
      commentedIssueId,
      activityIssueId,
    ]));
    expect(resultIds.has(excludedIssueId)).toBe(false);
  });

  it("combines participation filtering with search", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

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
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const matchedIssueId = randomUUID();
    const otherIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: matchedIssueId,
        companyId,
        title: "Invoice reconciliation",
        status: "todo",
        priority: "medium",
        createdByAgentId: agentId,
      },
      {
        id: otherIssueId,
        companyId,
        title: "Weekly planning",
        status: "todo",
        priority: "medium",
        createdByAgentId: agentId,
      },
    ]);

    const result = await svc.list(companyId, {
      participantAgentId: agentId,
      q: "invoice",
    });

    expect(result.map((issue) => issue.id)).toEqual([matchedIssueId]);
  });

  it("accepts issue identifiers through getById", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 1064,
      identifier: "PAP-1064",
      title: "Feedback votes error",
      status: "todo",
      priority: "medium",
      createdByUserId: "user-1",
    });

    const issue = await svc.getById("PAP-1064");

    expect(issue).toEqual(
      expect.objectContaining({
        id: issueId,
        identifier: "PAP-1064",
      }),
    );
  });

  it("removes issue rows even when non-cascading comments and inbox metadata exist", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Disposable smoke issue",
      status: "todo",
      priority: "medium",
    });

    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorUserId: "user-1",
      body: "Comment that used to block deletion.",
    });
    await db.insert(issueInboxArchives).values({
      companyId,
      issueId,
      userId: "user-1",
    });
    await db.insert(issueReadStates).values({
      companyId,
      issueId,
      userId: "user-1",
    });

    await expect(svc.remove(issueId)).resolves.toEqual(
      expect.objectContaining({ id: issueId }),
    );
    await expect(svc.getById(issueId)).resolves.toBeNull();
    await expect(
      db.select({ id: issueComments.id }).from(issueComments).where(eq(issueComments.issueId, issueId)),
    ).resolves.toHaveLength(0);
    await expect(
      db.select({ id: issueInboxArchives.id }).from(issueInboxArchives).where(eq(issueInboxArchives.issueId, issueId)),
    ).resolves.toHaveLength(0);
    await expect(
      db.select({ id: issueReadStates.id }).from(issueReadStates).where(eq(issueReadStates.issueId, issueId)),
    ).resolves.toHaveLength(0);
  });

  it("returns null instead of throwing for malformed non-uuid issue refs", async () => {
    await expect(svc.getById("not-a-uuid")).resolves.toBeNull();
  });

  it("filters issues by execution workspace id", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const targetWorkspaceId = randomUUID();
    const otherWorkspaceId = randomUUID();
    const linkedIssueId = randomUUID();
    const otherLinkedIssueId = randomUUID();
    const unlinkedIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(executionWorkspaces).values([
      {
        id: targetWorkspaceId,
        companyId,
        projectId,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: "Target workspace",
        status: "active",
        providerType: "local_fs",
      },
      {
        id: otherWorkspaceId,
        companyId,
        projectId,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: "Other workspace",
        status: "active",
        providerType: "local_fs",
      },
    ]);

    await db.insert(issues).values([
      {
        id: linkedIssueId,
        companyId,
        projectId,
        title: "Linked issue",
        status: "todo",
        priority: "medium",
        executionWorkspaceId: targetWorkspaceId,
      },
      {
        id: otherLinkedIssueId,
        companyId,
        projectId,
        title: "Other linked issue",
        status: "todo",
        priority: "medium",
        executionWorkspaceId: otherWorkspaceId,
      },
      {
        id: unlinkedIssueId,
        companyId,
        projectId,
        title: "Unlinked issue",
        status: "todo",
        priority: "medium",
      },
    ]);

    const result = await svc.list(companyId, { executionWorkspaceId: targetWorkspaceId });

    expect(result.map((issue) => issue.id)).toEqual([linkedIssueId]);
  });

  it("hides archived inbox issues until new external activity arrives", async () => {
    const companyId = randomUUID();
    const userId = "user-1";
    const otherUserId = "user-2";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const visibleIssueId = randomUUID();
    const archivedIssueId = randomUUID();
    const resurfacedIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: visibleIssueId,
        companyId,
        title: "Visible issue",
        status: "todo",
        priority: "medium",
        createdByUserId: userId,
        createdAt: new Date("2026-03-26T10:00:00.000Z"),
        updatedAt: new Date("2026-03-26T10:00:00.000Z"),
      },
      {
        id: archivedIssueId,
        companyId,
        title: "Archived issue",
        status: "todo",
        priority: "medium",
        createdByUserId: userId,
        createdAt: new Date("2026-03-26T11:00:00.000Z"),
        updatedAt: new Date("2026-03-26T11:00:00.000Z"),
      },
      {
        id: resurfacedIssueId,
        companyId,
        title: "Resurfaced issue",
        status: "todo",
        priority: "medium",
        createdByUserId: userId,
        createdAt: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T12:00:00.000Z"),
      },
    ]);

    await svc.archiveInbox(companyId, archivedIssueId, userId, new Date("2026-03-26T12:30:00.000Z"));
    await svc.archiveInbox(companyId, resurfacedIssueId, userId, new Date("2026-03-26T13:00:00.000Z"));

    await db.insert(issueComments).values({
      companyId,
      issueId: resurfacedIssueId,
      authorUserId: otherUserId,
      body: "This should bring the issue back into Mine.",
      createdAt: new Date("2026-03-26T13:30:00.000Z"),
      updatedAt: new Date("2026-03-26T13:30:00.000Z"),
    });

    const archivedFiltered = await svc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
    });

    expect(archivedFiltered.map((issue) => issue.id)).toEqual([
      resurfacedIssueId,
      visibleIssueId,
    ]);

    await svc.unarchiveInbox(companyId, archivedIssueId, userId);

    const afterUnarchive = await svc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
    });

    expect(new Set(afterUnarchive.map((issue) => issue.id))).toEqual(new Set([
      visibleIssueId,
      archivedIssueId,
      resurfacedIssueId,
    ]));
  });

  it("resurfaces archived issue when status/updatedAt changes after archiving", async () => {
    const companyId = randomUUID();
    const userId = "user-1";
    const otherUserId = "user-2";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const issueId = randomUUID();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Issue with old comment then status change",
      status: "todo",
      priority: "medium",
      createdByUserId: userId,
      createdAt: new Date("2026-03-26T10:00:00.000Z"),
      updatedAt: new Date("2026-03-26T10:00:00.000Z"),
    });

    // Old external comment before archiving
    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorUserId: otherUserId,
      body: "Old comment before archive",
      createdAt: new Date("2026-03-26T11:00:00.000Z"),
      updatedAt: new Date("2026-03-26T11:00:00.000Z"),
    });

    // Archive after seeing the comment
    await svc.archiveInbox(
      companyId,
      issueId,
      userId,
      new Date("2026-03-26T12:00:00.000Z"),
    );

    // Verify it's archived
    const afterArchive = await svc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
    });
    expect(afterArchive.map((i) => i.id)).not.toContain(issueId);

    // Status/work update changes updatedAt (no new comment)
    await db
      .update(issues)
      .set({
        status: "in_progress",
        updatedAt: new Date("2026-03-26T13:00:00.000Z"),
      })
      .where(eq(issues.id, issueId));

    // Should resurface because updatedAt > archivedAt
    const afterUpdate = await svc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
    });
    expect(afterUpdate.map((i) => i.id)).toContain(issueId);
  });

  it("sorts and exposes last activity from comments and non-local issue activity logs", async () => {
    const companyId = randomUUID();
    const olderIssueId = randomUUID();
    const commentIssueId = randomUUID();
    const activityIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: olderIssueId,
        companyId,
        title: "Older issue",
        status: "todo",
        priority: "medium",
        updatedAt: new Date("2026-03-26T10:00:00.000Z"),
      },
      {
        id: commentIssueId,
        companyId,
        title: "Comment activity issue",
        status: "todo",
        priority: "medium",
        updatedAt: new Date("2026-03-26T10:00:00.000Z"),
      },
      {
        id: activityIssueId,
        companyId,
        title: "Logged activity issue",
        status: "todo",
        priority: "medium",
        updatedAt: new Date("2026-03-26T10:00:00.000Z"),
      },
    ]);

    await db.insert(issueComments).values({
      companyId,
      issueId: commentIssueId,
      body: "New comment without touching issue.updatedAt",
      createdAt: new Date("2026-03-26T11:00:00.000Z"),
      updatedAt: new Date("2026-03-26T11:00:00.000Z"),
    });

    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "system",
        actorId: "system",
        action: "issue.document_updated",
        entityType: "issue",
        entityId: activityIssueId,
        createdAt: new Date("2026-03-26T12:00:00.000Z"),
      },
      {
        companyId,
        actorType: "user",
        actorId: "user-1",
        action: "issue.read_marked",
        entityType: "issue",
        entityId: olderIssueId,
        createdAt: new Date("2026-03-26T13:00:00.000Z"),
      },
    ]);

    const result = await svc.list(companyId, {});

    expect(result.map((issue) => issue.id)).toEqual([
      activityIssueId,
      commentIssueId,
      olderIssueId,
    ]);
    expect(result.find((issue) => issue.id === activityIssueId)?.lastActivityAt?.toISOString()).toBe(
      "2026-03-26T12:00:00.000Z",
    );
    expect(result.find((issue) => issue.id === commentIssueId)?.lastActivityAt?.toISOString()).toBe(
      "2026-03-26T11:00:00.000Z",
    );
    expect(result.find((issue) => issue.id === olderIssueId)?.lastActivityAt?.toISOString()).toBe(
      "2026-03-26T10:00:00.000Z",
    );
  });
});

describeEmbeddedPostgres("issueService.create workspace inheritance", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-create-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, embeddedPostgresSuiteTimeoutMs);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("inherits the parent issue workspace linkage when child workspace fields are omitted", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const parentIssueId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
      sharedWorkspaceKey: "workspace-key",
    });

    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Issue worktree",
      status: "active",
      providerType: "git_worktree",
      providerRef: `/tmp/${executionWorkspaceId}`,
    });

    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
        workspaceRuntime: { profile: "agent" },
      },
    });

    const child = await svc.create(companyId, {
      parentId: parentIssueId,
      projectId,
      title: "Child issue",
    });

    expect(child.parentId).toBe(parentIssueId);
    expect(child.projectWorkspaceId).toBe(projectWorkspaceId);
    expect(child.executionWorkspaceId).toBe(executionWorkspaceId);
    expect(child.executionWorkspacePreference).toBe("reuse_existing");
    expect(child.executionWorkspaceSettings).toEqual({
      mode: "isolated_workspace",
      workspaceRuntime: { profile: "agent" },
    });
  });

  it("keeps explicit workspace fields instead of inheriting the parent linkage", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const parentIssueId = randomUUID();
    const parentProjectWorkspaceId = randomUUID();
    const parentExecutionWorkspaceId = randomUUID();
    const explicitProjectWorkspaceId = randomUUID();
    const explicitExecutionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values([
      {
        id: parentProjectWorkspaceId,
        companyId,
        projectId,
        name: "Parent workspace",
      },
      {
        id: explicitProjectWorkspaceId,
        companyId,
        projectId,
        name: "Explicit workspace",
      },
    ]);

    await db.insert(executionWorkspaces).values([
      {
        id: parentExecutionWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId: parentProjectWorkspaceId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Parent worktree",
        status: "active",
        providerType: "git_worktree",
      },
      {
        id: explicitExecutionWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId: explicitProjectWorkspaceId,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: "Explicit shared workspace",
        status: "active",
        providerType: "local_fs",
      },
    ]);

    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      projectId,
      projectWorkspaceId: parentProjectWorkspaceId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
      executionWorkspaceId: parentExecutionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
      },
    });

    const child = await svc.create(companyId, {
      parentId: parentIssueId,
      projectId,
      title: "Child issue",
      projectWorkspaceId: explicitProjectWorkspaceId,
      executionWorkspaceId: explicitExecutionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "shared_workspace",
      },
    });

    expect(child.projectWorkspaceId).toBe(explicitProjectWorkspaceId);
    expect(child.executionWorkspaceId).toBe(explicitExecutionWorkspaceId);
    expect(child.executionWorkspacePreference).toBe("reuse_existing");
    expect(child.executionWorkspaceSettings).toEqual({
      mode: "shared_workspace",
    });
  });

  it("inherits workspace linkage from an explicit source issue without creating a parent-child relationship", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const sourceIssueId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
    });

    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "operator_branch",
      strategyType: "git_worktree",
      name: "Operator branch",
      status: "active",
      providerType: "git_worktree",
    });

    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Source issue",
      status: "todo",
      priority: "medium",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "operator_branch",
      },
    });

    const followUp = await svc.create(companyId, {
      projectId,
      title: "Follow-up issue",
      inheritExecutionWorkspaceFromIssueId: sourceIssueId,
    });

    expect(followUp.parentId).toBeNull();
    expect(followUp.projectWorkspaceId).toBe(projectWorkspaceId);
    expect(followUp.executionWorkspaceId).toBe(executionWorkspaceId);
    expect(followUp.executionWorkspacePreference).toBe("reuse_existing");
    expect(followUp.executionWorkspaceSettings).toEqual({
      mode: "operator_branch",
    });
  });

  describe("assertCanTransitionIssueToDone", () => {
    async function seedDoneGuardFixture() {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issueId = randomUUID();

      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });

      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "DoneGuardAgent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });

      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Guard done transitions",
        status: "in_review",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-1`,
      });

      return { companyId, agentId, issueId };
    }

    async function insertIssueRun(input: {
      companyId: string;
      agentId: string;
      issueId: string;
      runId?: string;
      status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
      verdict?: string | null;
      errorCode?: string | null;
      error?: string | null;
      processLossRetryCount?: number;
      finishedAt?: Date | null;
      createdAt?: Date;
    }) {
      const createdAt = input.createdAt ?? new Date("2026-04-05T16:00:00.000Z");
      const finishedAt = input.finishedAt ?? (
        input.status === "queued" || input.status === "running" ? null : createdAt
      );
      const runId = input.runId ?? randomUUID();

      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: input.companyId,
        agentId: input.agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: input.status,
        contextSnapshot: { issueId: input.issueId },
        resultJson: input.verdict ? { verdict: input.verdict } : {},
        errorCode: input.errorCode ?? null,
        error: input.error ?? null,
        processLossRetryCount: input.processLossRetryCount ?? 0,
        startedAt: new Date(createdAt.getTime() - 60_000),
        finishedAt,
        createdAt,
        updatedAt: createdAt,
      });

      return runId;
    }

    it("allows board-driven done transitions even when the latest terminal run requested changes", async () => {
      const { companyId, agentId, issueId } = await seedDoneGuardFixture();

      await insertIssueRun({
        companyId,
        agentId,
        issueId,
        status: "succeeded",
        verdict: "changes_requested",
      });

      await expect(
        svc.assertCanTransitionIssueToDone({
          issueId,
          companyId,
          actorType: "board",
          actorAgentId: null,
          actorRunId: null,
        }),
      ).resolves.toBeUndefined();
    });

    it("allows board-driven done transitions when the latest terminal run has no explicit verdict", async () => {
      const { companyId, agentId, issueId } = await seedDoneGuardFixture();

      await insertIssueRun({
        companyId,
        agentId,
        issueId,
        status: "succeeded",
        verdict: null,
      });

      await expect(
        svc.assertCanTransitionIssueToDone({
          issueId,
          companyId,
          actorType: "board",
          actorAgentId: null,
          actorRunId: null,
        }),
      ).resolves.toBeUndefined();
    });

    it("blocks agent-driven done transitions when the latest terminal run has a negative verdict", async () => {
      const { companyId, agentId, issueId } = await seedDoneGuardFixture();

      await insertIssueRun({
        companyId,
        agentId,
        issueId,
        status: "succeeded",
        verdict: "changes_requested",
      });

      await expect(
        svc.assertCanTransitionIssueToDone({
          issueId,
          companyId,
          actorType: "agent",
          actorAgentId: agentId,
          actorRunId: null,
        }),
      ).rejects.toMatchObject({
        status: 422,
        details: expect.objectContaining({
          code: "issue_done_blocked_by_negative_run_verdict",
          verdict: "changes_requested",
        }),
      });
    });

    it("allows agent-driven done transitions when the latest terminal run failed without an explicit verdict", async () => {
      const { companyId, agentId, issueId } = await seedDoneGuardFixture();

      await insertIssueRun({
        companyId,
        agentId,
        issueId,
        status: "failed",
        errorCode: "adapter_failed",
        error: "Too Many Requests",
        createdAt: new Date("2026-04-05T16:05:00.000Z"),
      });

      await expect(
        svc.assertCanTransitionIssueToDone({
          issueId,
          companyId,
          actorType: "agent",
          actorAgentId: agentId,
          actorRunId: null,
        }),
      ).resolves.toBeUndefined();
    });

    it("keeps blocking done when the latest authoritative verdict still requests changes", async () => {
      const { companyId, agentId, issueId } = await seedDoneGuardFixture();

      const reviewRunId = await insertIssueRun({
        companyId,
        agentId,
        issueId,
        status: "succeeded",
        verdict: "changes_requested",
        createdAt: new Date("2026-04-05T16:00:00.000Z"),
      });
      await insertIssueRun({
        companyId,
        agentId,
        issueId,
        status: "failed",
        errorCode: "adapter_failed",
        error: "Too Many Requests",
        createdAt: new Date("2026-04-05T16:05:00.000Z"),
      });

      await expect(
        svc.assertCanTransitionIssueToDone({
          issueId,
          companyId,
          actorType: "agent",
          actorAgentId: agentId,
          actorRunId: null,
        }),
      ).rejects.toMatchObject({
        status: 422,
        details: expect.objectContaining({
          code: "issue_done_blocked_by_negative_run_verdict",
          runId: reviewRunId,
          verdict: "changes_requested",
        }),
      });
    });

    it("allows agent-driven done transitions without a runId when no negative verdict exists", async () => {
      const { companyId, agentId, issueId } = await seedDoneGuardFixture();

      await insertIssueRun({
        companyId,
        agentId,
        issueId,
        status: "succeeded",
        verdict: null,
      });

      await expect(
        svc.assertCanTransitionIssueToDone({
          issueId,
          companyId,
          actorType: "agent",
          actorAgentId: agentId,
          actorRunId: null,
        }),
      ).resolves.toBeUndefined();
    });

    it("allows agent-driven done transitions when the actor run is still active", async () => {
      const { companyId, agentId, issueId } = await seedDoneGuardFixture();
      const actorRunId = randomUUID();

      await insertIssueRun({
        companyId,
        agentId,
        issueId,
        runId: actorRunId,
        status: "running",
        finishedAt: null,
      });

      await expect(
        svc.assertCanTransitionIssueToDone({
          issueId,
          companyId,
          actorType: "agent",
          actorAgentId: agentId,
          actorRunId,
        }),
      ).resolves.toBeUndefined();
    });

    it("blocks agent-driven done transitions when the actor's own terminal run has a negative verdict", async () => {
      const { companyId, agentId, issueId } = await seedDoneGuardFixture();
      const actorRunId = randomUUID();

      await insertIssueRun({
        companyId,
        agentId,
        issueId,
        runId: actorRunId,
        status: "succeeded",
        verdict: "changes_requested",
      });

      await expect(
        svc.assertCanTransitionIssueToDone({
          issueId,
          companyId,
          actorType: "agent",
          actorAgentId: agentId,
          actorRunId,
        }),
      ).rejects.toMatchObject({
        status: 422,
        details: expect.objectContaining({
          code: "issue_done_blocked_by_negative_run_verdict",
          verdict: "changes_requested",
        }),
      });
    });

    it("allows agent-driven done transitions when the actor run explicitly passed", async () => {
      const { companyId, agentId, issueId } = await seedDoneGuardFixture();
      const actorRunId = randomUUID();

      await insertIssueRun({
        companyId,
        agentId,
        issueId,
        runId: actorRunId,
        status: "succeeded",
        verdict: "passed",
      });

      await expect(
        svc.assertCanTransitionIssueToDone({
          issueId,
          companyId,
          actorType: "agent",
          actorAgentId: agentId,
          actorRunId,
        }),
      ).resolves.toBeUndefined();
    });

    it("allows a newer explicit pass to clear an older changes_requested verdict", async () => {
      const { companyId, agentId, issueId } = await seedDoneGuardFixture();

      await insertIssueRun({
        companyId,
        agentId,
        issueId,
        status: "succeeded",
        verdict: "changes_requested",
        createdAt: new Date("2026-04-05T16:00:00.000Z"),
      });
      await insertIssueRun({
        companyId,
        agentId,
        issueId,
        status: "succeeded",
        verdict: "passed",
        createdAt: new Date("2026-04-05T16:05:00.000Z"),
      });

      await expect(
        svc.assertCanTransitionIssueToDone({
          issueId,
          companyId,
          actorType: "agent",
          actorAgentId: agentId,
          actorRunId: null,
        }),
      ).resolves.toBeUndefined();
    });

    it("blocks markDone when status truth still says the issue is blocked", async () => {
      const { companyId, agentId, issueId } = await seedDoneGuardFixture();

      await db
        .update(issues)
        .set({
          status: "in_progress",
          updatedAt: new Date("2026-04-05T16:10:00.000Z"),
        })
        .where(eq(issues.id, issueId));

      await db.insert(activityLog).values({
        companyId,
        actorType: "system",
        actorId: "paperclip",
        action: "issue.updated",
        entityType: "issue",
        entityId: issueId,
        createdAt: new Date("2026-04-05T16:05:00.000Z"),
        details: {
          status: "blocked",
          _previous: { status: "todo" },
        },
      });

      await expect(
        svc.assertCanTransitionIssueToDone({
          issueId,
          companyId,
          actorType: "agent",
          actorAgentId: agentId,
          actorRunId: null,
        }),
      ).rejects.toMatchObject({
        status: 422,
        details: expect.objectContaining({
          code: "issue_done_blocked_by_status_truth",
          effectiveStatus: "blocked",
          authoritativeStatus: "blocked",
          driftCode: "blocked_checkout_reopen",
        }),
      });
    });

    it("blocks agent-driven done transitions when QA writeback still forbids close-out", async () => {
      const { companyId, agentId, issueId } = await seedDoneGuardFixture();
      const qaAgentId = randomUUID();
      const qaRunId = randomUUID();

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
      });

      await insertIssueRun({
        companyId,
        agentId: qaAgentId,
        issueId,
        runId: qaRunId,
        status: "failed",
        errorCode: null,
        error: "qa fail",
        verdict: "fail",
        createdAt: new Date("2026-04-05T16:05:00.000Z"),
      });

      await expect(
        svc.assertCanTransitionIssueToDone({
          issueId,
          companyId,
          actorType: "agent",
          actorAgentId: agentId,
          actorRunId: null,
        }),
      ).rejects.toMatchObject({
        status: 422,
        details: expect.objectContaining({
          code: "issue_done_blocked_by_qa_writeback",
          latestRunId: qaRunId,
          verdict: "fail",
          canCloseUpstream: false,
        }),
      });
    });

    it("allows done when the only active platform blocker is runtime process loss", async () => {
      const { companyId, agentId, issueId } = await seedDoneGuardFixture();
      const actorRunId = randomUUID();

      await insertIssueRun({
        companyId,
        agentId,
        issueId,
        runId: actorRunId,
        status: "failed",
        errorCode: "process_lost",
        error: "process lost",
        processLossRetryCount: 1,
        createdAt: new Date("2026-04-05T16:05:00.000Z"),
      });

      await expect(
        svc.assertCanTransitionIssueToDone({
          issueId,
          companyId,
          actorType: "agent",
          actorAgentId: agentId,
          actorRunId,
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe("ancestor status recomputation", () => {
    async function seedAncestorFixture(input?: {
      rootStatus?: "backlog" | "todo" | "in_progress" | "blocked" | "done";
      parentStatus?: "backlog" | "todo" | "in_progress" | "blocked" | "done";
      childStatus?: "todo" | "in_progress" | "in_review" | "blocked" | "done";
    }) {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const rootId = randomUUID();
      const parentId = randomUUID();
      const childId = randomUUID();
      const prefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: prefix,
        requireBoardApprovalForNewAgents: false,
      });

      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "TreeWorker",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });

      await db.insert(issues).values([
        {
          id: rootId,
          companyId,
          title: "Root issue",
          status: input?.rootStatus ?? "blocked",
          priority: "medium",
          issueNumber: 1,
          identifier: `${prefix}-1`,
        },
        {
          id: parentId,
          companyId,
          parentId: rootId,
          title: "Parent issue",
          status: input?.parentStatus ?? "blocked",
          priority: "medium",
          issueNumber: 2,
          identifier: `${prefix}-2`,
        },
        {
          id: childId,
          companyId,
          parentId,
          title: "Child issue",
          status: input?.childStatus ?? "todo",
          priority: "medium",
          assigneeAgentId: agentId,
          issueNumber: 3,
          identifier: `${prefix}-3`,
        },
      ]);

      return { companyId, agentId, rootId, parentId, childId };
    }

    it("leaves blocked ancestors blocked when a child resumes execution", async () => {
      const { agentId, rootId, parentId, childId } = await seedAncestorFixture();

      await svc.checkout(childId, agentId, ["todo"], null);

      const parent = await svc.getById(parentId);
      const root = await svc.getById(rootId);

      expect(parent?.status).toBe("blocked");
      expect(root?.status).toBe("blocked");
    });

    it("reopens done ancestors when a child branch resumes execution", async () => {
      const { agentId, rootId, parentId, childId } = await seedAncestorFixture({
        rootStatus: "done",
        parentStatus: "done",
        childStatus: "todo",
      });

      await svc.checkout(childId, agentId, ["todo"], null);

      const parent = await svc.getById(parentId);
      const root = await svc.getById(rootId);

      expect(parent?.status).toBe("in_progress");
      expect(root?.status).toBe("in_progress");
    });

    it("records an in_progress status activity when a blocked issue is checked out again", async () => {
      const { companyId, agentId, childId } = await seedAncestorFixture({
        childStatus: "blocked",
      });
      const checkoutRunId = randomUUID();

      await db.insert(activityLog).values({
        companyId,
        actorType: "system",
        actorId: "paperclip",
        action: "issue.updated",
        entityType: "issue",
        entityId: childId,
        createdAt: new Date("2026-04-05T16:00:00.000Z"),
        details: {
          status: "blocked",
          _previous: { status: "todo" },
        },
      });
      await db.insert(heartbeatRuns).values({
        id: checkoutRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: { issueId: childId },
        resultJson: {},
        startedAt: new Date("2026-04-05T16:04:00.000Z"),
        finishedAt: null,
        createdAt: new Date("2026-04-05T16:04:00.000Z"),
        updatedAt: new Date("2026-04-05T16:04:00.000Z"),
      });

      await svc.checkout(childId, agentId, ["blocked"], checkoutRunId);

      const statusSummary = await issueStatusTruthService(db).getIssueStatusTruthSummary(childId);
      const checkoutStatusActivities = await db
        .select({
          details: activityLog.details,
        })
        .from(activityLog)
        .where(eq(activityLog.entityId, childId));

      expect(statusSummary).toEqual(expect.objectContaining({
        effectiveStatus: "in_progress",
        persistedStatus: "blocked",
        authoritativeStatus: "in_progress",
        consistency: "drifted",
        driftCode: "status_mismatch",
        executionState: "active",
        canExecute: false,
      }));
      expect(
        checkoutStatusActivities.filter((entry) => {
          const details = entry.details as Record<string, unknown> | null;
          return details?.status === "in_progress" && details?.source === "checkout";
        }),
      ).toHaveLength(1);

      await expect(
        svc.assertCanTransitionIssueToDone({
          issueId: childId,
          companyId,
          actorType: "agent",
          actorAgentId: agentId,
          actorRunId: checkoutRunId,
        }),
      ).resolves.toBeUndefined();
    });

    it("clears execution metadata when an issue leaves in_progress through a status update", async () => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issueId = randomUUID();
      const runId = randomUUID();

      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: "CMPA",
        requireBoardApprovalForNewAgents: false,
      });

      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Engineer",
        role: "engineer",
        status: "active",
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
        triggerDetail: "system",
        status: "running",
        contextSnapshot: { issueId },
        resultJson: {},
        errorCode: null,
        error: null,
        processLossRetryCount: 0,
        startedAt: new Date("2026-04-08T00:00:00.000Z"),
        finishedAt: null,
        createdAt: new Date("2026-04-08T00:00:00.000Z"),
        updatedAt: new Date("2026-04-08T00:00:00.000Z"),
      });

      await db.insert(issues).values({
        id: issueId,
        companyId,
        issueNumber: 78,
        identifier: "CMPA-78",
        title: "Execution cleanup issue",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        checkoutRunId: runId,
        executionRunId: runId,
        executionLockedAt: new Date("2026-04-08T00:00:00.000Z"),
      });

      const updated = await svc.update(issueId, { status: "todo" });

      expect(updated?.status).toBe("todo");
      expect(updated?.checkoutRunId).toBeNull();
      expect(updated?.executionRunId).toBeNull();
      expect(updated?.executionLockedAt).toBeNull();

      const persisted = await db
        .select({
          status: issues.status,
          checkoutRunId: issues.checkoutRunId,
          executionRunId: issues.executionRunId,
          executionLockedAt: issues.executionLockedAt,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0]!);

      expect(persisted.status).toBe("todo");
      expect(persisted.checkoutRunId).toBeNull();
      expect(persisted.executionRunId).toBeNull();
      expect(persisted.executionLockedAt).toBeNull();
    });

    it("records a single todo status activity when an in_progress issue is released", async () => {
      const { companyId, agentId, childId } = await seedAncestorFixture({
        childStatus: "in_progress",
      });

      await db.insert(activityLog).values({
        companyId,
        actorType: "agent",
        actorId: agentId,
        agentId,
        action: "issue.updated",
        entityType: "issue",
        entityId: childId,
        createdAt: new Date("2026-04-05T16:00:00.000Z"),
        details: {
          status: "in_progress",
          source: "checkout",
          _previous: { status: "todo" },
        },
      });

      const released = await svc.release(childId, agentId, null, {
        actorType: "agent",
        actorId: agentId,
      });
      const statusSummary = await issueStatusTruthService(db).getIssueStatusTruthSummary(childId);
      const releaseStatusActivities = await db
        .select({
          details: activityLog.details,
        })
        .from(activityLog)
        .where(eq(activityLog.entityId, childId));

      expect(released?.status).toBe("todo");
      expect(statusSummary).toEqual(expect.objectContaining({
        effectiveStatus: "todo",
        persistedStatus: "todo",
        authoritativeStatus: "todo",
        consistency: "consistent",
        driftCode: null,
      }));
      expect(
        releaseStatusActivities.filter((entry) => {
          const details = entry.details as Record<string, unknown> | null;
          return details?.status === "todo" && details?.source === "release";
        }),
      ).toHaveLength(1);
    });

    it("keeps ancestors open for explicit closeout when their only child branch is completed", async () => {
      const { rootId, parentId, childId } = await seedAncestorFixture({
        rootStatus: "in_progress",
        parentStatus: "in_progress",
        childStatus: "in_review",
      });

      await svc.update(childId, { status: "done" });

      const parent = await svc.getById(parentId);
      const root = await svc.getById(rootId);

      expect(parent?.status).toBe("in_progress");
      expect(root?.status).toBe("in_progress");
    });

    it("does not reopen blocked ancestors for closeout-pending when their child branch completes", async () => {
      const { companyId, rootId, parentId, childId } = await seedAncestorFixture({
        rootStatus: "blocked",
        parentStatus: "blocked",
        childStatus: "in_review",
      });

      await db.insert(activityLog).values([
        {
          companyId,
          actorType: "system",
          actorId: "paperclip",
          action: "issue.updated",
          entityType: "issue",
          entityId: rootId,
          createdAt: new Date("2026-04-05T16:00:00.000Z"),
          details: {
            status: "blocked",
            _previous: { status: "todo" },
          },
        },
        {
          companyId,
          actorType: "system",
          actorId: "paperclip",
          action: "issue.updated",
          entityType: "issue",
          entityId: parentId,
          createdAt: new Date("2026-04-05T16:00:00.000Z"),
          details: {
            status: "blocked",
            _previous: { status: "todo" },
          },
        },
      ]);

      await svc.update(childId, { status: "done" });

      const parentSummary = await issueStatusTruthService(db).getIssueStatusTruthSummary(parentId);
      const rootSummary = await issueStatusTruthService(db).getIssueStatusTruthSummary(rootId);
      const recomputeActivities = await db
        .select({
          entityId: activityLog.entityId,
          status: activityLog.details,
        })
        .from(activityLog)
        .where(eq(activityLog.action, "issue.updated"));

      expect(parentSummary).toEqual(expect.objectContaining({
        effectiveStatus: "blocked",
        persistedStatus: "blocked",
        authoritativeStatus: "blocked",
        consistency: "consistent",
      }));
      expect(rootSummary).toEqual(expect.objectContaining({
        effectiveStatus: "blocked",
        persistedStatus: "blocked",
        authoritativeStatus: "blocked",
        consistency: "consistent",
      }));
      expect(
        recomputeActivities.filter((entry) => {
          const details = entry.status as Record<string, unknown> | null;
          return entry.entityId === parentId
            && details?.source === "ancestor_recompute"
            && details?.status === "in_progress"
            && details?.closeoutPending === true;
        }),
      ).toHaveLength(0);
      expect(
        recomputeActivities.filter((entry) => {
          const details = entry.status as Record<string, unknown> | null;
          return entry.entityId === rootId
            && details?.source === "ancestor_recompute"
            && details?.status === "in_progress";
        }),
      ).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Fix #1 — status drift self-repair
// ---------------------------------------------------------------------------
describeEmbeddedPostgres("issueService.markDone — status truth close gate", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-drift-repair-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
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

  it("blocks markDone when drifted status truth still says the issue is blocked", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "CMPA",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    // DB row says in_progress (stale)
    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 77,
      identifier: "CMPA-77",
      title: "Drifted issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    // Event log authoritatively says blocked while the persisted row drifted back
    // to in_progress.
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      createdAt: new Date("2026-04-08T00:05:00.000Z"),
      details: {
        status: "blocked",
        _previous: { status: "todo" },
      },
    });

    await expect(
      svc.assertCanTransitionIssueToDone({
        issueId,
        companyId,
        actorType: "agent",
        actorAgentId: agentId,
        actorRunId: runId,
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: expect.objectContaining({
        code: "issue_done_blocked_by_status_truth",
        effectiveStatus: "blocked",
        authoritativeStatus: "blocked",
      }),
    });

    const updatedIssue = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((r) => r[0]!);
    expect(updatedIssue.status).toBe("in_progress");
  });
});

// ---------------------------------------------------------------------------
// Fix #7 — parent batch auto-comment on child lane status change
// ---------------------------------------------------------------------------
describeEmbeddedPostgres("recomputeAncestorStatuses — parent batch auto-comment", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-ancestor-comment-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
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

  it("posts a system closeout comment on the parent when all child lanes are done", async () => {
    // When a child lane transitions to done and completes the batch, the parent
    // must stay open until its assignee explicitly closes it. Paperclip should
    // leave an audit comment explaining that closeout is now manual.
    const companyId = randomUUID();
    const parentId = randomUUID();
    const childId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "CMPA",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: parentId,
        companyId,
        issueNumber: 80,
        identifier: "CMPA-80",
        title: "Batch issue",
        status: "in_progress",
        priority: "medium",
      },
      {
        id: childId,
        companyId,
        issueNumber: 81,
        identifier: "CMPA-81",
        title: "Child lane",
        status: "in_progress",
        priority: "medium",
        parentId,
      },
    ]);

    // Transition child to done — this triggers recomputeAncestorStatuses
    await svc.update(childId, { status: "done" });

    // Parent stays open pending explicit closeout
    const parentRow = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, parentId)).then((r) => r[0]!);
    expect(parentRow.status).toBe("in_progress");

    // A system comment must have been written to the parent
    const parentComments = await db.select({ body: issueComments.body }).from(issueComments).where(eq(issueComments.issueId, parentId));
    expect(parentComments.length).toBeGreaterThanOrEqual(1);
    const batchComment = parentComments.find((c) => c.body.includes("explicit parent closeout required"));
    expect(batchComment).toBeDefined();
    expect(batchComment?.body).toContain("1/1 lanes done");
  });

  it("posts a comment even when only some child lanes are done (partial progress)", async () => {
    const companyId = randomUUID();
    const parentId = randomUUID();
    const child1Id = randomUUID();
    const child2Id = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "CMPA",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: parentId,
        companyId,
        issueNumber: 90,
        identifier: "CMPA-90",
        title: "Batch 2",
        status: "todo",
        priority: "medium",
      },
      {
        id: child1Id,
        companyId,
        issueNumber: 91,
        identifier: "CMPA-91",
        title: "Lane 1",
        status: "todo",
        priority: "medium",
        parentId,
      },
      {
        id: child2Id,
        companyId,
        issueNumber: 92,
        identifier: "CMPA-92",
        title: "Lane 2",
        status: "todo",
        priority: "medium",
        parentId,
      },
    ]);

    // Only one child done — parent should transition to in_progress
    await svc.update(child1Id, { status: "done" });

    const parentComments = await db.select({ body: issueComments.body }).from(issueComments).where(eq(issueComments.issueId, parentId));
    expect(parentComments.length).toBeGreaterThanOrEqual(1);
    const batchComment = parentComments.find((c) => c.body.includes("Batch status updated"));
    expect(batchComment).toBeDefined();
    // Should show 1 out of 2 lanes (not cancelled count)
    expect(batchComment?.body).toContain("1/2 lanes done");
  });

  it("posts the closeout comment when the final child finishes even if parent status remains in_progress", async () => {
    const companyId = randomUUID();
    const parentId = randomUUID();
    const child1Id = randomUUID();
    const child2Id = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "CMPA",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: parentId,
        companyId,
        issueNumber: 95,
        identifier: "CMPA-95",
        title: "Batch 3",
        status: "in_progress",
        priority: "medium",
      },
      {
        id: child1Id,
        companyId,
        issueNumber: 96,
        identifier: "CMPA-96",
        title: "Lane 1",
        status: "done",
        priority: "medium",
        parentId,
      },
      {
        id: child2Id,
        companyId,
        issueNumber: 97,
        identifier: "CMPA-97",
        title: "Lane 2",
        status: "in_progress",
        priority: "medium",
        parentId,
      },
    ]);

    await svc.update(child2Id, { status: "done" });

    const parentRow = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, parentId)).then((r) => r[0]!);
    expect(parentRow.status).toBe("in_progress");

    const parentComments = await db.select({ body: issueComments.body }).from(issueComments).where(eq(issueComments.issueId, parentId));
    const closeoutComment = parentComments.find((c) => c.body.includes("explicit parent closeout required"));
    expect(closeoutComment).toBeDefined();
    expect(closeoutComment?.body).toContain("2/2 lanes done");
  });
});

describeEmbeddedPostgres("issueService.remove cleanup", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-remove-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, embeddedPostgresSuiteTimeoutMs);

  afterEach(async () => {
    await db.delete(approvalComments);
    await db.delete(approvals);
    await db.delete(activityLog);
    await db.delete(financeEvents);
    await db.delete(costEvents);
    await db.delete(feedbackVotes);
    await db.delete(issueApprovals);
    await db.delete(issueReadStates);
    await db.delete(issueInboxArchives);
    await db.delete(issueComments);
    await db.delete(routineRuns);
    await db.delete(routines);
    await db.delete(workspaceRuntimeServices);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("deletes non-cascading issue rows and removes orphan approvals", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();
    const approvalId = randomUUID();
    const costEventId = randomUUID();
    const runtimeServiceId = randomUUID();
    const routineId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "CMPA",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Cleanup agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Cleanup project",
      status: "in_progress",
    });

    await db.insert(routines).values({
      id: routineId,
      companyId,
      projectId,
      title: "Cleanup routine",
      assigneeAgentId: agentId,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Cleanup target",
      status: "todo",
      priority: "medium",
    });

    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorUserId: "board-user",
      body: "comment",
    });
    await db.insert(issueInboxArchives).values({
      companyId,
      issueId,
      userId: "board-user",
    });
    await db.insert(issueReadStates).values({
      companyId,
      issueId,
      userId: "board-user",
    });
    await db.insert(feedbackVotes).values({
      companyId,
      issueId,
      targetType: "issue",
      targetId: issueId,
      authorUserId: "board-user",
      vote: "up",
    });
    await db.insert(costEvents).values({
      id: costEventId,
      companyId,
      agentId,
      issueId,
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
      companyId,
      agentId: null,
      issueId,
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
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "board-user",
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      details: {},
    });
    await db.insert(workspaceRuntimeServices).values({
      id: runtimeServiceId,
      companyId,
      projectId,
      projectWorkspaceId: null,
      executionWorkspaceId: null,
      issueId,
      scopeType: "issue",
      scopeId: issueId,
      serviceName: "vite",
      status: "running",
      lifecycle: "ephemeral",
      reuseKey: null,
      command: "pnpm dev",
      cwd: "D:\\\\projects\\\\cleanup",
      port: 4173,
      url: "http://127.0.0.1:4173",
      provider: "local_process",
      providerRef: null,
      ownerAgentId: agentId,
      startedByRunId: null,
      healthStatus: "healthy",
    });
    await db.insert(routineRuns).values({
      companyId,
      routineId,
      triggerId: null,
      source: "manual",
      status: "received",
      linkedIssueId: issueId,
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
      body: "approved",
    });

    const removed = await svc.remove(issueId);

    expect(removed?.id).toBe(issueId);
    await expect(db.select({ id: issues.id }).from(issues).where(eq(issues.companyId, companyId))).resolves.toEqual([]);
    await expect(db.select({ id: issueComments.id }).from(issueComments).where(eq(issueComments.companyId, companyId))).resolves.toEqual([]);
    await expect(db.select({ id: issueInboxArchives.id }).from(issueInboxArchives).where(eq(issueInboxArchives.companyId, companyId))).resolves.toEqual([]);
    await expect(db.select({ id: issueReadStates.id }).from(issueReadStates).where(eq(issueReadStates.companyId, companyId))).resolves.toEqual([]);
    await expect(db.select({ id: feedbackVotes.id }).from(feedbackVotes).where(eq(feedbackVotes.companyId, companyId))).resolves.toEqual([]);
    await expect(db.select({ id: costEvents.id }).from(costEvents).where(eq(costEvents.companyId, companyId))).resolves.toEqual([]);
    await expect(db.select({ id: financeEvents.id }).from(financeEvents).where(eq(financeEvents.companyId, companyId))).resolves.toEqual([]);
    await expect(db.select({ id: approvals.id }).from(approvals).where(eq(approvals.companyId, companyId))).resolves.toEqual([]);
    await expect(db.select({ id: approvalComments.id }).from(approvalComments).where(eq(approvalComments.companyId, companyId))).resolves.toEqual([]);

    const runtimeRows = await db
      .select({ issueId: workspaceRuntimeServices.issueId })
      .from(workspaceRuntimeServices)
      .where(eq(workspaceRuntimeServices.companyId, companyId));
    expect(runtimeRows).toEqual([{ issueId: null }]);

    const routineRows = await db
      .select({ linkedIssueId: routineRuns.linkedIssueId })
      .from(routineRuns)
      .where(eq(routineRuns.companyId, companyId));
    expect(routineRows).toEqual([{ linkedIssueId: null }]);
  });
});

