import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ISSUE_BLACKBOARD_MANIFEST_KEY } from "@paperclipai/shared";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const sourceIssueId = "11111111-1111-4111-8111-111111111111";
const targetIssueId = "22222222-2222-4222-8222-222222222222";
const siblingIssueId = "33333333-3333-4333-8333-333333333333";
const parentIssueId = "44444444-4444-4444-8444-444444444444";
const companyId = "55555555-5555-4555-8555-555555555555";
const projectId = "66666666-6666-4666-8666-666666666666";
const projectWorkspaceId = "77777777-7777-4777-8777-777777777777";
const sourceWorkProductId = "88888888-8888-4888-8888-888888888888";
const unrelatedIssueId = "99999999-9999-4999-8999-999999999999";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getAncestors: vi.fn(),
  list: vi.fn(),
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
}));

const mockDocumentsService = vi.hoisted(() => ({
  getIssueDocumentByKey: vi.fn(),
  upsertIssueDocument: vi.fn(),
}));

const mockWorkProductsService = vi.hoisted(() => ({
  getById: vi.fn(),
  listForIssue: vi.fn(),
  createForIssue: vi.fn(),
  update: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentService: () => mockDocumentsService,
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  feedbackService: () => ({}),
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => ({
    getExperimental: vi.fn(async () => ({})),
    getGeneral: vi.fn(async () => ({ feedbackDataSharingPreference: "prompt" })),
  }),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => mockWorkProductsService,
}));

function createApp(
  actor: Record<string, unknown> = {
    type: "board",
    userId: "board-user",
    companyIds: [companyId],
    source: "local_implicit",
    isInstanceAdmin: false,
  },
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue artifact publication routes", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-doc-sync-"));

    mockIssueService.getById.mockImplementation(async (id: string) => {
      if (id === sourceIssueId) {
        return {
          id: sourceIssueId,
          companyId,
          projectId,
          projectWorkspaceId,
          executionWorkspaceId: null,
          parentId: parentIssueId,
          identifier: "CMPA-49",
          title: "Source task",
          status: "in_progress",
          assigneeAgentId: "agent-source",
          planApprovedAt: new Date("2026-04-10T00:00:00.000Z"),
        };
      }
      if (id === targetIssueId) {
        return {
          id: targetIssueId,
          companyId,
          projectId,
          projectWorkspaceId,
          executionWorkspaceId: null,
          parentId: parentIssueId,
          identifier: "CMPA-50",
          title: "Lead task",
          status: "todo",
          assigneeAgentId: "agent-target",
        };
      }
      if (id === siblingIssueId) {
        return {
          id: siblingIssueId,
          companyId,
          projectId,
          projectWorkspaceId,
          executionWorkspaceId: null,
          parentId: parentIssueId,
          identifier: "CMPA-51",
          title: "QA task",
          status: "todo",
          assigneeAgentId: "agent-sibling",
        };
      }
      if (id === parentIssueId) {
        return {
          id: parentIssueId,
          companyId,
          projectId,
          projectWorkspaceId,
          executionWorkspaceId: null,
          parentId: null,
          identifier: "CMPA-48",
          title: "Parent task",
          status: "in_progress",
          assigneeAgentId: "agent-parent",
        };
      }
      if (id === unrelatedIssueId) {
        return {
          id: unrelatedIssueId,
          companyId,
          projectId,
          projectWorkspaceId,
          executionWorkspaceId: null,
          parentId: null,
          identifier: "CMPA-99",
          title: "Unrelated task",
          status: "todo",
          assigneeAgentId: "agent-unrelated",
        };
      }
      return null;
    });

    mockIssueService.getAncestors.mockResolvedValue([
      {
        id: parentIssueId,
        companyId,
        projectId,
        projectWorkspaceId,
        executionWorkspaceId: null,
        parentId: null,
        identifier: "CMPA-48",
        title: "Parent task",
        status: "in_progress",
        assigneeAgentId: "agent-parent",
      },
    ]);

    mockIssueService.list.mockResolvedValue([
      {
        id: sourceIssueId,
        companyId,
        projectId,
        projectWorkspaceId,
        executionWorkspaceId: null,
        parentId: parentIssueId,
        identifier: "CMPA-49",
        title: "Source task",
        status: "in_progress",
        assigneeAgentId: "agent-source",
        planApprovedAt: new Date("2026-04-10T00:00:00.000Z"),
      },
      {
        id: targetIssueId,
        companyId,
        projectId,
        projectWorkspaceId,
        executionWorkspaceId: null,
        parentId: parentIssueId,
        identifier: "CMPA-50",
        title: "Lead task",
        status: "todo",
        assigneeAgentId: "agent-target",
      },
      {
        id: siblingIssueId,
        companyId,
        projectId,
        projectWorkspaceId,
        executionWorkspaceId: null,
        parentId: parentIssueId,
        identifier: "CMPA-51",
        title: "QA task",
        status: "todo",
        assigneeAgentId: "agent-sibling",
      },
    ]);

    mockIssueService.addComment.mockImplementation(async (issueId: string, body: string) => ({
      id: `${issueId}-comment`,
      issueId,
      companyId,
      body,
      authorAgentId: null,
      authorUserId: "board-user",
      createdAt: new Date("2026-04-08T00:00:00.000Z"),
      updatedAt: new Date("2026-04-08T00:00:00.000Z"),
    }));

    mockWorkProductsService.listForIssue.mockResolvedValue([]);
    mockWorkProductsService.createForIssue.mockImplementation(async (issueId: string, _companyId: string, input: any) => ({
      id: `${issueId}-handoff`,
      companyId,
      projectId: input.projectId ?? projectId,
      issueId,
      executionWorkspaceId: null,
      runtimeServiceId: null,
      type: input.type,
      provider: input.provider,
      externalId: input.externalId ?? null,
      title: input.title,
      url: input.url ?? null,
      status: input.status,
      reviewState: input.reviewState,
      isPrimary: Boolean(input.isPrimary),
      healthStatus: input.healthStatus,
      summary: input.summary ?? null,
      metadata: input.metadata ?? null,
      createdByRunId: input.createdByRunId ?? null,
      createdAt: new Date("2026-04-08T00:00:00.000Z"),
      updatedAt: new Date("2026-04-08T00:00:00.000Z"),
    }));
    mockIssueService.assertCheckoutOwner.mockResolvedValue({
      id: sourceIssueId,
      status: "in_progress",
      assigneeAgentId: "agent-source",
      checkoutRunId: "run-1",
      adoptedFromRunId: null,
    });

    mockProjectService.getById.mockResolvedValue({
      id: projectId,
      companyId,
      name: "Demo project",
      workspaces: [
        {
          id: projectWorkspaceId,
          projectId,
          companyId,
          name: "primary",
          cwd: workspaceRoot,
          isPrimary: true,
        },
      ],
    });

    mockExecutionWorkspaceService.getById.mockResolvedValue(null);
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("publishes a document handoff to target issues and syncs it into project docs", async () => {
    mockDocumentsService.getIssueDocumentByKey.mockResolvedValue({
      id: "source-doc",
      issueId: sourceIssueId,
      companyId,
      key: "prd",
      title: "PRD: Tetris MVP",
      format: "markdown",
      body: "# PRD\n\nBuild the MVP.",
      latestRevisionId: "rev-1",
      latestRevisionNumber: 1,
      createdByAgentId: null,
      createdByUserId: "board-user",
      updatedByAgentId: null,
      updatedByUserId: "board-user",
      createdAt: new Date("2026-04-08T00:00:00.000Z"),
      updatedAt: new Date("2026-04-08T00:00:00.000Z"),
    });

    const res = await request(createApp())
      .post(`/api/issues/${sourceIssueId}/publish-artifact`)
      .send({
        artifact: { kind: "document", key: "prd" },
        target: { mode: "issues", issueIds: [targetIssueId] },
        summary: "PRD ready for implementation planning.",
        requiredAction: "Review and break into implementation tasks.",
        syncToProjectDocs: { path: "docs/PRD.md" },
      });

    expect(res.status).toBe(200);
    expect(await fs.readFile(path.join(workspaceRoot, "docs", "PRD.md"), "utf8")).toBe("# PRD\n\nBuild the MVP.\n");

    expect(mockWorkProductsService.createForIssue).toHaveBeenCalledWith(
      targetIssueId,
      companyId,
      expect.objectContaining({
        type: "artifact",
        provider: "paperclip",
        title: "Handoff: PRD: Tetris MVP",
        status: "ready_for_review",
        summary: "PRD ready for implementation planning.",
        metadata: expect.objectContaining({
          handoff: expect.objectContaining({
            sourceIssueId,
            sourceIssueIdentifier: "CMPA-49",
            artifactKind: "document",
            documentKey: "prd",
            syncedProjectDocsPath: "docs/PRD.md",
            requiredAction: "Review and break into implementation tasks.",
          }),
        }),
      }),
    );
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      targetIssueId,
      expect.stringContaining("Artifact handoff"),
      expect.objectContaining({ userId: "board-user" }),
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "agent-target",
      expect.objectContaining({
        reason: "artifact_published",
        payload: expect.objectContaining({ issueId: targetIssueId }),
      }),
    );
  });

  it("rejects reserved blackboard keys for document artifact publication", async () => {
    const res = await request(createApp())
      .post(`/api/issues/${sourceIssueId}/publish-artifact`)
      .send({
        artifact: { kind: "document", key: ISSUE_BLACKBOARD_MANIFEST_KEY },
        target: { mode: "issues", issueIds: [targetIssueId] },
      });

    expect(res.status).toBe(422);
    expect(res.body).toEqual(expect.objectContaining({
      error: expect.stringContaining("/blackboard"),
    }));
    expect(mockDocumentsService.getIssueDocumentByKey).not.toHaveBeenCalled();
    expect(mockWorkProductsService.createForIssue).not.toHaveBeenCalled();
  });

  it("publishes a work product handoff to sibling issues", async () => {
    mockWorkProductsService.getById.mockResolvedValue({
      id: sourceWorkProductId,
      issueId: sourceIssueId,
      companyId,
      projectId,
      executionWorkspaceId: null,
      runtimeServiceId: null,
      type: "preview_url",
      provider: "vercel",
      externalId: "vercel-preview-1",
      title: "Preview deployment",
      url: "https://preview.example.com",
      status: "active",
      reviewState: "none",
      isPrimary: true,
      healthStatus: "healthy",
      summary: "Preview build is ready.",
      metadata: null,
      createdByRunId: null,
      createdAt: new Date("2026-04-08T00:00:00.000Z"),
      updatedAt: new Date("2026-04-08T00:00:00.000Z"),
    });

    const res = await request(createApp())
      .post(`/api/issues/${sourceIssueId}/publish-artifact`)
      .send({
        artifact: { kind: "work_product", workProductId: sourceWorkProductId },
        target: { mode: "siblings" },
        summary: "Use this preview build for validation.",
        requiredAction: "Run QA against the preview URL.",
      });

    expect(res.status).toBe(200);
    expect(mockWorkProductsService.createForIssue).toHaveBeenCalledTimes(2);
    expect(mockWorkProductsService.createForIssue).toHaveBeenNthCalledWith(
      1,
      targetIssueId,
      companyId,
      expect.objectContaining({
        title: "Handoff: Preview deployment",
        metadata: expect.objectContaining({
          handoff: expect.objectContaining({
            artifactKind: "work_product",
            sourceWorkProductId,
          }),
        }),
      }),
    );
    expect(mockWorkProductsService.createForIssue).toHaveBeenNthCalledWith(
      2,
      siblingIssueId,
      companyId,
      expect.objectContaining({
        title: "Handoff: Preview deployment",
      }),
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "agent-sibling",
      expect.objectContaining({
        reason: "artifact_published",
        payload: expect.objectContaining({ issueId: siblingIssueId }),
      }),
    );
  });

  it("allows the assigned agent to publish a document handoff to the parent issue", async () => {
    mockDocumentsService.getIssueDocumentByKey.mockResolvedValue({
      id: "source-doc",
      issueId: sourceIssueId,
      companyId,
      key: "architecture",
      title: "Architecture overview",
      format: "markdown",
      body: "# Architecture\n\nCore boundaries.",
      latestRevisionId: "rev-2",
      latestRevisionNumber: 2,
      createdByAgentId: "agent-source",
      createdByUserId: null,
      updatedByAgentId: "agent-source",
      updatedByUserId: null,
      createdAt: new Date("2026-04-08T00:00:00.000Z"),
      updatedAt: new Date("2026-04-08T00:00:00.000Z"),
    });

    const res = await request(createApp({
      type: "agent",
      agentId: "agent-source",
      companyId,
      runId: "run-1",
      source: "api_key",
    }))
      .post(`/api/issues/${sourceIssueId}/publish-artifact`)
      .send({
        artifact: { kind: "document", key: "architecture" },
        target: { mode: "parent" },
        requiredAction: "Review the design and approve task breakdown.",
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.assertCheckoutOwner).toHaveBeenCalledWith(sourceIssueId, "agent-source", "run-1");
    expect(mockWorkProductsService.createForIssue).toHaveBeenCalledWith(
      parentIssueId,
      companyId,
      expect.objectContaining({
        title: "Handoff: Architecture overview",
      }),
    );
  });

  it("rejects agent publication to unrelated explicit target issues", async () => {
    mockDocumentsService.getIssueDocumentByKey.mockResolvedValue({
      id: "source-doc",
      issueId: sourceIssueId,
      companyId,
      key: "prd",
      title: "PRD: Tetris MVP",
      format: "markdown",
      body: "# PRD\n\nBuild the MVP.",
      latestRevisionId: "rev-1",
      latestRevisionNumber: 1,
      createdByAgentId: "agent-source",
      createdByUserId: null,
      updatedByAgentId: "agent-source",
      updatedByUserId: null,
      createdAt: new Date("2026-04-08T00:00:00.000Z"),
      updatedAt: new Date("2026-04-08T00:00:00.000Z"),
    });

    const res = await request(createApp({
      type: "agent",
      agentId: "agent-source",
      companyId,
      runId: "run-1",
      source: "api_key",
    }))
      .post(`/api/issues/${sourceIssueId}/publish-artifact`)
      .send({
        artifact: { kind: "document", key: "prd" },
        target: { mode: "issues", issueIds: [unrelatedIssueId] },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("parent, ancestor, or sibling");
    expect(mockWorkProductsService.createForIssue).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("rejects project docs sync paths outside docs/", async () => {
    mockDocumentsService.getIssueDocumentByKey.mockResolvedValue({
      id: "source-doc",
      issueId: sourceIssueId,
      companyId,
      key: "architecture",
      title: "Architecture",
      format: "markdown",
      body: "# Architecture",
      latestRevisionId: "rev-1",
      latestRevisionNumber: 1,
      createdByAgentId: null,
      createdByUserId: "board-user",
      updatedByAgentId: null,
      updatedByUserId: "board-user",
      createdAt: new Date("2026-04-08T00:00:00.000Z"),
      updatedAt: new Date("2026-04-08T00:00:00.000Z"),
    });

    const res = await request(createApp())
      .post(`/api/issues/${sourceIssueId}/publish-artifact`)
      .send({
        artifact: { kind: "document", key: "architecture" },
        target: { mode: "issues", issueIds: [targetIssueId] },
        syncToProjectDocs: { path: "../Architecture.md" },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("docs/");
    expect(mockWorkProductsService.createForIssue).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });
});
