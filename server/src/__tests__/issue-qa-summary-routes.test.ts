import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  getAncestors: vi.fn(),
  getCommentCursor: vi.fn(),
  getComment: vi.fn(),
  findMentionedProjectIds: vi.fn(),
}));

const mockStatusTruth = vi.hoisted(() => ({
  getIssueStatusTruthSummaries: vi.fn(),
  getIssueStatusTruthSummary: vi.fn(),
}));

const mockQaIssueState = vi.hoisted(() => ({
  getIssueQaSummary: vi.fn(),
}));

const mockPlatformUnblock = vi.hoisted(() => ({
  getIssuePlatformUnblockSummary: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(),
  }),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
  }),
  goalService: () => ({
    getById: vi.fn(async () => null),
    getDefaultCompanyGoal: vi.fn(async () => null),
  }),
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
  projectService: () => ({
    getById: vi.fn(async () => null),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
}));

vi.mock("../services/qa-issue-state.js", () => ({
  qaIssueStateService: () => mockQaIssueState,
}));

vi.mock("../services/issue-status-truth.js", () => ({
  applyEffectiveStatus: <T extends { status: string }>(issue: T, summary: any) => summary
    ? { ...issue, statusTruthSummary: summary }
    : issue,
  issueStatusTruthService: () => mockStatusTruth,
}));

vi.mock("../services/platform-unblock.js", () => ({
  platformUnblockService: () => mockPlatformUnblock,
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

describe("issue QA summary routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue({
      id: issueId,
      companyId,
      identifier: "CMPA-39",
      title: "QA verification",
      status: "in_progress",
      priority: "high",
      goalId: null,
      parentId: null,
      projectId: null,
      assigneeAgentId: null,
      assigneeUserId: null,
      updatedAt: new Date("2026-04-08T00:00:00.000Z"),
    });
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.findMentionedProjectIds.mockResolvedValue([]);
    mockIssueService.list.mockResolvedValue([
      {
        id: issueId,
        companyId,
        identifier: "CMPA-39",
        title: "QA verification",
        status: "in_progress",
        priority: "high",
        goalId: null,
        parentId: null,
        projectId: null,
        assigneeAgentId: null,
        assigneeUserId: null,
        updatedAt: new Date("2026-04-08T00:00:00.000Z"),
      },
    ]);
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockIssueService.getComment.mockResolvedValue(null);
    mockStatusTruth.getIssueStatusTruthSummaries.mockResolvedValue(new Map([
      [issueId, {
        effectiveStatus: "blocked",
        persistedStatus: "in_progress",
        authoritativeStatus: "blocked",
        consistency: "drifted",
        authoritativeAt: "2026-04-08T01:01:00.000Z",
        authoritativeSource: "status_activity",
        authoritativeActorType: "system",
        authoritativeActorId: "paperclip",
        reasonSummary: "Latest explicit status activity set the issue to blocked.",
        canExecute: false,
        canClose: false,
        driftCode: "blocked_checkout_reopen",
        evidence: [],
      }],
    ]));
    mockStatusTruth.getIssueStatusTruthSummary.mockResolvedValue({
      effectiveStatus: "blocked",
      persistedStatus: "in_progress",
      authoritativeStatus: "blocked",
      consistency: "drifted",
      authoritativeAt: "2026-04-08T01:01:00.000Z",
      authoritativeSource: "status_activity",
      authoritativeActorType: "system",
      authoritativeActorId: "paperclip",
      reasonSummary: "Latest explicit status activity set the issue to blocked.",
      canExecute: false,
      canClose: false,
      driftCode: "blocked_checkout_reopen",
      evidence: [],
    });
    mockQaIssueState.getIssueQaSummary.mockResolvedValue({
      verdict: "fail",
      source: "platform",
      canCloseUpstream: false,
      latestRunId: "run-qa-1",
      latestRunFinishedAt: "2026-04-08T01:00:00.000Z",
      writebackAt: "2026-04-08T01:01:00.000Z",
      alertOpen: false,
      alertType: null,
      alertMessage: null,
      latestLabel: "latest",
    });
    mockPlatformUnblock.getIssuePlatformUnblockSummary.mockResolvedValue({
      mode: "platform",
      primaryCategory: "qa_writeback_gate",
      secondaryCategories: [],
      primaryOwnerRole: "qa_writeback_owner",
      primaryOwnerAgentId: "agent-1",
      escalationOwnerRole: "tech_lead",
      escalationOwnerAgentId: "agent-2",
      authoritativeSignalSource: "qa_summary",
      authoritativeSignalAt: "2026-04-08T01:01:00.000Z",
      authoritativeRunId: "run-qa-1",
      recommendedNextAction: "Repair writeback",
      recoveryCriteria: "Stable verdict",
      nextCheckpointAt: "2026-04-08T01:31:00.000Z",
      blocksExecutionRetry: true,
      blocksCloseOut: true,
      canRetryEngineering: false,
      canCloseUpstream: false,
      recoveryKind: null,
      commentVisibility: null,
      evidence: [],
    });
  });

  it("returns qa summary plus platform unblock summary", async () => {
    const res = await request(createApp()).get(`/api/issues/${issueId}/qa-summary`);

    expect(res.status).toBe(200);
    expect(mockQaIssueState.getIssueQaSummary).toHaveBeenCalledWith(issueId);
    expect(mockPlatformUnblock.getIssuePlatformUnblockSummary).toHaveBeenCalledWith(issueId);
    expect(res.body).toEqual({
      issueId,
      qaSummary: expect.objectContaining({
        verdict: "fail",
        latestRunId: "run-qa-1",
      }),
      platformUnblockSummary: expect.objectContaining({
        primaryCategory: "qa_writeback_gate",
        canRetryEngineering: false,
      }),
    });
  });

  it("surfaces qa summary and platform summary in heartbeat context", async () => {
    const res = await request(createApp()).get(`/api/issues/${issueId}/heartbeat-context`);

    expect(res.status).toBe(200);
    expect(res.body.issue).toEqual(expect.objectContaining({
      id: issueId,
      status: "in_progress",
      statusTruthSummary: expect.objectContaining({
        effectiveStatus: "blocked",
        consistency: "drifted",
      }),
    }));
    expect(res.body.qaSummary).toEqual(expect.objectContaining({
      verdict: "fail",
      latestRunId: "run-qa-1",
    }));
    expect(res.body.platformUnblockSummary).toEqual(expect.objectContaining({
      primaryCategory: "qa_writeback_gate",
    }));
  });

  it("surfaces effective status and truth summary in issue detail", async () => {
    const res = await request(createApp()).get(`/api/issues/${issueId}`);

    expect(res.status).toBe(200);
    expect(mockStatusTruth.getIssueStatusTruthSummary).toHaveBeenCalledWith(issueId);
    expect(res.body).toEqual(expect.objectContaining({
      id: issueId,
      status: "in_progress",
      statusTruthSummary: expect.objectContaining({
        effectiveStatus: "blocked",
        consistency: "drifted",
      }),
    }));
  });

  it("passes persisted status filters through to the issue service", async () => {
    mockIssueService.list.mockResolvedValueOnce([
      {
        id: issueId,
        companyId,
        identifier: "CMPA-39",
        title: "QA verification",
        status: "in_progress",
        priority: "high",
        goalId: null,
        parentId: null,
        projectId: null,
        assigneeAgentId: null,
        assigneeUserId: null,
        updatedAt: new Date("2026-04-08T00:00:00.000Z"),
      },
    ]);

    const res = await request(createApp()).get(`/api/companies/${companyId}/issues?status=blocked`);

    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledWith(companyId, expect.objectContaining({
      status: "blocked",
    }));
    expect(res.body).toEqual([
      expect.objectContaining({
        id: issueId,
        status: "in_progress",
        statusTruthSummary: expect.objectContaining({
          effectiveStatus: "blocked",
          consistency: "drifted",
        }),
      }),
    ]);
  });
});
