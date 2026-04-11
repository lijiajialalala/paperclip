import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issueInboxArchives,
  issues,
  projectWorkspaces,
  projects,
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

    it("blocks agent-driven done transitions when status truth is drifted", async () => {
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
          persistedStatus: "in_progress",
          authoritativeStatus: "blocked",
          consistency: "drifted",
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

    it("blocks agent-driven done transitions when a runtime platform unblock is active", async () => {
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
      ).rejects.toMatchObject({
        status: 422,
        details: expect.objectContaining({
          code: "issue_done_blocked_by_platform_unblock",
          primaryCategory: "runtime_process",
          canRetryEngineering: false,
        }),
      });
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

    it("recomputes blocked ancestors back to in_progress when a child resumes execution", async () => {
      const { agentId, rootId, parentId, childId } = await seedAncestorFixture();

      await svc.checkout(childId, agentId, ["todo"], null);

      const parent = await svc.getById(parentId);
      const root = await svc.getById(rootId);

      expect(parent?.status).toBe("in_progress");
      expect(root?.status).toBe("in_progress");
    });

    it("marks ancestors done when their only child branch is completed", async () => {
      const { rootId, parentId, childId } = await seedAncestorFixture({
        rootStatus: "in_progress",
        parentStatus: "in_progress",
        childStatus: "in_review",
      });

      await svc.update(childId, { status: "done" });

      const parent = await svc.getById(parentId);
      const root = await svc.getById(rootId);

      expect(parent?.status).toBe("done");
      expect(root?.status).toBe("done");
    });

    it("records status activity for recomputed ancestors so status truth stays consistent", async () => {
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
        effectiveStatus: "done",
        persistedStatus: "done",
        authoritativeStatus: "done",
        consistency: "consistent",
      }));
      expect(rootSummary).toEqual(expect.objectContaining({
        effectiveStatus: "done",
        persistedStatus: "done",
        authoritativeStatus: "done",
        consistency: "consistent",
      }));
      expect(
        recomputeActivities.filter((entry) => {
          const details = entry.status as Record<string, unknown> | null;
          return (entry.entityId === parentId || entry.entityId === rootId)
            && details?.source === "ancestor_recompute"
            && details?.status === "done";
        }),
      ).toHaveLength(2);
    });
  });
});

// ---------------------------------------------------------------------------
// Fix #1 — status drift self-repair
// ---------------------------------------------------------------------------
describeEmbeddedPostgres("issueService.markDone — status drift self-repair", () => {
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

  it("allows markDone when authoritativeStatus is done even if DB row is still in_progress (positive drift)", async () => {
    // Fix #1 regression:
    // Before the fix, canClose required consistency === "consistent". With a positive drift
    // (event log says done, DB row still says in_progress), markDone was incorrectly blocked.
    // After the fix, canClose is based on authoritativeStatus, and markDone also repairs the DB row.
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

    // Event log authoritatively says done (agent marked it done already)
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
        status: "done",
        _previous: { status: "in_progress" },
      },
    });

    // markDone must succeed (not throw "issue_done_blocked_by_status_truth")
    await expect(
      svc.assertCanTransitionIssueToDone({
        issueId,
        companyId,
        actorType: "agent",
        actorAgentId: agentId,
        actorRunId: runId,
      }),
    ).resolves.not.toThrow();

    // After assertCanTransitionIssueToDone, the DB row must be repaired to 'done' (repairDrift)
    const updatedIssue = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId)).then((r) => r[0]!);
    expect(updatedIssue.status).toBe("done");
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

  it("posts a system comment on the parent when all child lanes are done", async () => {
    // Fix #7: when a child lane transitions to done and causes the parent to recompute
    // to 'done', a summary comment must appear on the parent recording that change.
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

    // Parent should now be done
    const parentRow = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, parentId)).then((r) => r[0]!);
    expect(parentRow.status).toBe("done");

    // A system comment must have been written to the parent (Fix #7)
    const parentComments = await db.select({ body: issueComments.body }).from(issueComments).where(eq(issueComments.issueId, parentId));
    expect(parentComments.length).toBeGreaterThanOrEqual(1);
    const batchComment = parentComments.find((c) => c.body.includes("Batch status updated"));
    expect(batchComment).toBeDefined();
    expect(batchComment?.body).toContain("`done`");
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
});

