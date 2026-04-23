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
  getAncestors: vi.fn(),
  findMentionedProjectIds: vi.fn(),
}));

const mockDocumentService = vi.hoisted(() => ({
  getIssueDocumentPayload: vi.fn(),
}));

const mockGoalService = vi.hoisted(() => ({
  getById: vi.fn(),
  getDefaultCompanyGoal: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
  listByIds: vi.fn(),
}));

const mockWorkProductsService = vi.hoisted(() => ({
  listForIssue: vi.fn(),
}));

const mockStatusTruth = vi.hoisted(() => ({
  getIssueStatusTruthSummary: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  documentService: () => mockDocumentService,
  executionWorkspaceService: () => ({
    getById: vi.fn(),
  }),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => mockGoalService,
  heartbeatService: () => ({
    wakeup: vi.fn(async () => undefined),
    reportRunActivity: vi.fn(async () => undefined),
  }),
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    })),
    listCompanyIds: vi.fn(async () => [companyId]),
  }),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => mockProjectService,
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => mockWorkProductsService,
}));

vi.mock("../services/issue-status-truth.js", () => ({
  applyEffectiveStatus: <T extends { status: string }>(issue: T) => issue,
  issueStatusTruthService: () => mockStatusTruth,
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
  app.use("/api", issueRoutes({ select: vi.fn() } as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue detail routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue({
      id: issueId,
      companyId,
      identifier: "CMPA-400",
      title: "Blackboard detail",
      description: null,
      status: "in_progress",
      priority: "medium",
      projectId: null,
      goalId: null,
      parentId: null,
      assigneeAgentId: null,
      assigneeUserId: null,
      executionWorkspaceId: null,
      executionRunId: null,
      checkoutRunId: null,
      executionLockedAt: null,
      planProposedAt: null,
      planApprovedAt: null,
      updatedAt: new Date("2026-04-23T12:00:00.000Z"),
    });
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.findMentionedProjectIds.mockResolvedValue([]);
    mockGoalService.getDefaultCompanyGoal.mockResolvedValue(null);
    mockProjectService.listByIds.mockResolvedValue([]);
    mockWorkProductsService.listForIssue.mockResolvedValue([]);
    mockStatusTruth.getIssueStatusTruthSummary.mockResolvedValue(null);
    mockDocumentService.getIssueDocumentPayload.mockResolvedValue({
      planDocument: null,
      legacyPlanDocument: null,
      documentSummaries: [
        {
          id: "document-plan",
          companyId,
          issueId,
          key: "plan",
          title: "Plan",
          format: "markdown",
          latestRevisionId: "revision-plan",
          latestRevisionNumber: 1,
          createdByAgentId: null,
          createdByUserId: "board-user",
          updatedByAgentId: null,
          updatedByUserId: "board-user",
          createdAt: new Date("2026-04-23T12:00:00.000Z"),
          updatedAt: new Date("2026-04-23T12:00:00.000Z"),
        },
        {
          id: "document-blackboard",
          companyId,
          issueId,
          key: ISSUE_BLACKBOARD_MANIFEST_KEY,
          title: "Blackboard manifest",
          format: "json",
          latestRevisionId: "revision-blackboard",
          latestRevisionNumber: 1,
          createdByAgentId: null,
          createdByUserId: "board-user",
          updatedByAgentId: null,
          updatedByUserId: "board-user",
          createdAt: new Date("2026-04-23T12:00:00.000Z"),
          updatedAt: new Date("2026-04-23T12:00:00.000Z"),
        },
      ],
    });
  });

  it("filters reserved blackboard document summaries out of issue detail payloads", async () => {
    const res = await request(createApp()).get(`/api/issues/${issueId}`);

    expect(res.status).toBe(200);
    expect(mockDocumentService.getIssueDocumentPayload).toHaveBeenCalledWith(
      expect.objectContaining({ id: issueId }),
    );
    expect(res.body.documentSummaries).toEqual([
      expect.objectContaining({
        key: "plan",
        format: "markdown",
      }),
    ]);
    expect(res.body.documentSummaries).toHaveLength(1);
  });
});
