import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ISSUE_BLACKBOARD_MANIFEST_KEY } from "@paperclipai/shared";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockDocumentsService = vi.hoisted(() => ({
  getIssueDocumentByKey: vi.fn(),
  listIssueDocuments: vi.fn(),
  listIssueDocumentRevisions: vi.fn(),
  restoreIssueDocumentRevision: vi.fn(),
  upsertIssueDocument: vi.fn(),
  deleteIssueDocument: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentService: () => mockDocumentsService,
  executionWorkspaceService: () => ({}),
  feedbackService: () => ({}),
  goalService: () => ({}),
  heartbeatService: () => ({
    wakeup: vi.fn(async () => undefined),
    reportRunActivity: vi.fn(async () => undefined),
  }),
  instanceSettingsService: () => ({
    getExperimental: vi.fn(async () => ({})),
    getGeneral: vi.fn(async () => ({ feedbackDataSharingPreference: "prompt" })),
  }),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue document revision routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue({
      id: issueId,
      companyId,
      identifier: "PAP-881",
      title: "Document revisions",
      status: "in_progress",
    });
    mockDocumentsService.listIssueDocumentRevisions.mockResolvedValue([
      {
        id: "revision-2",
        companyId,
        documentId: "document-1",
        issueId,
        key: "plan",
        revisionNumber: 2,
        title: "Plan v2",
        format: "markdown",
        body: "# Two",
        changeSummary: null,
        createdByAgentId: null,
        createdByUserId: "board-user",
        createdAt: new Date("2026-03-26T12:00:00.000Z"),
      },
    ]);
    mockDocumentsService.listIssueDocuments.mockResolvedValue([
      {
        id: "document-1",
        companyId,
        issueId,
        key: "plan",
        title: "Plan",
        format: "markdown",
        body: "# Plan",
        latestRevisionId: "revision-2",
        latestRevisionNumber: 2,
        createdByAgentId: null,
        createdByUserId: "board-user",
        updatedByAgentId: null,
        updatedByUserId: "board-user",
        createdAt: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T12:10:00.000Z"),
      },
      {
        id: "document-2",
        companyId,
        issueId,
        key: ISSUE_BLACKBOARD_MANIFEST_KEY,
        title: "Blackboard manifest",
        format: "json",
        body: "{\"template\":\"research_v1\"}",
        latestRevisionId: "revision-3",
        latestRevisionNumber: 1,
        createdByAgentId: null,
        createdByUserId: "board-user",
        updatedByAgentId: null,
        updatedByUserId: "board-user",
        createdAt: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T12:10:00.000Z"),
      },
    ]);
    mockDocumentsService.restoreIssueDocumentRevision.mockResolvedValue({
      restoredFromRevisionId: "revision-1",
      restoredFromRevisionNumber: 1,
      document: {
        id: "document-1",
        companyId,
        issueId,
        key: "plan",
        title: "Plan v1",
        format: "markdown",
        body: "# One",
        latestRevisionId: "revision-3",
        latestRevisionNumber: 3,
        createdByAgentId: null,
        createdByUserId: "board-user",
        updatedByAgentId: null,
        updatedByUserId: "board-user",
        createdAt: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T12:10:00.000Z"),
      },
    });
  });

  it("returns revision snapshots including title and format", async () => {
    const res = await request(createApp()).get(`/api/issues/${issueId}/documents/plan/revisions`);

    expect(res.status).toBe(200);
    expect(mockDocumentsService.listIssueDocumentRevisions).toHaveBeenCalledWith(issueId, "plan");
    expect(res.body).toEqual([
      expect.objectContaining({
        revisionNumber: 2,
        title: "Plan v2",
        format: "markdown",
        body: "# Two",
      }),
    ]);
  });

  it("filters reserved blackboard docs out of the generic documents list", async () => {
    const res = await request(createApp()).get(`/api/issues/${issueId}/documents`);

    expect(res.status).toBe(200);
    expect(mockDocumentsService.listIssueDocuments).toHaveBeenCalledWith(issueId);
    expect(res.body).toEqual([
      expect.objectContaining({
        key: "plan",
        format: "markdown",
      }),
    ]);
    expect(res.body).toHaveLength(1);
  });

  it("restores a revision through the append-only route and logs the action", async () => {
    const res = await request(createApp())
      .post(`/api/issues/${issueId}/documents/plan/revisions/revision-1/restore`)
      .send({});

    expect(res.status).toBe(200);
    expect(mockDocumentsService.restoreIssueDocumentRevision).toHaveBeenCalledWith({
      issueId,
      key: "plan",
      revisionId: "revision-1",
      createdByAgentId: null,
      createdByUserId: "board-user",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.document_restored",
        details: expect.objectContaining({
          key: "plan",
          restoredFromRevisionId: "revision-1",
          restoredFromRevisionNumber: 1,
          revisionNumber: 3,
        }),
      }),
    );
    expect(res.body).toEqual(expect.objectContaining({
      key: "plan",
      title: "Plan v1",
      latestRevisionNumber: 3,
    }));
  });

  it("rejects invalid document keys before attempting restore", async () => {
    const res = await request(createApp())
      .post(`/api/issues/${issueId}/documents/INVALID KEY/revisions/revision-1/restore`)
      .send({});

    expect(res.status).toBe(400);
    expect(mockDocumentsService.restoreIssueDocumentRevision).not.toHaveBeenCalled();
  });

  it("rejects reserved blackboard keys on generic document writes", async () => {
    const res = await request(createApp())
      .put(`/api/issues/${issueId}/documents/${ISSUE_BLACKBOARD_MANIFEST_KEY}`)
      .send({
        title: "Manifest",
        format: "markdown",
        body: "{\"status\":\"ready\"}",
      });

    expect(res.status).toBe(422);
    expect(res.body).toEqual(expect.objectContaining({
      error: expect.stringContaining("/blackboard"),
    }));
    expect(mockDocumentsService.upsertIssueDocument).not.toHaveBeenCalled();
  });

  it("rejects reserved blackboard keys across the generic document detail routes", async () => {
    const requests = [
      () => request(createApp()).get(`/api/issues/${issueId}/documents/${ISSUE_BLACKBOARD_MANIFEST_KEY}`),
      () => request(createApp()).get(`/api/issues/${issueId}/documents/${ISSUE_BLACKBOARD_MANIFEST_KEY}/revisions`),
      () => request(createApp())
        .post(`/api/issues/${issueId}/documents/${ISSUE_BLACKBOARD_MANIFEST_KEY}/revisions/revision-1/restore`)
        .send({}),
      () => request(createApp()).delete(`/api/issues/${issueId}/documents/${ISSUE_BLACKBOARD_MANIFEST_KEY}`),
    ];

    for (const invoke of requests) {
      const res = await invoke();
      expect(res.status).toBe(422);
      expect(res.body).toEqual(expect.objectContaining({
        error: expect.stringContaining("/blackboard"),
      }));
    }

    expect(mockDocumentsService.getIssueDocumentByKey).not.toHaveBeenCalled();
    expect(mockDocumentsService.listIssueDocumentRevisions).not.toHaveBeenCalled();
    expect(mockDocumentsService.restoreIssueDocumentRevision).not.toHaveBeenCalled();
    expect(mockDocumentsService.deleteIssueDocument).not.toHaveBeenCalled();
  });
});
