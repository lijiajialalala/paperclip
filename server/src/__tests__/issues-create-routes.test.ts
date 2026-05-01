import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const runId = "33333333-3333-4333-8333-333333333333";

const mockIssueService = vi.hoisted(() => ({
  create: vi.fn(),
  getAncestors: vi.fn(),
  getById: vi.fn(),
  list: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockQueueIssueAssignmentWakeup = vi.hoisted(() => vi.fn(async () => undefined));
const mockRoutineService = vi.hoisted(() => ({
  get: vi.fn(),
  syncRunStatusForIssue: vi.fn(async () => undefined),
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
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({
    getById: vi.fn(),
    getDefaultCompanyGoal: vi.fn(),
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
  getIssueCreateDisposition: () => "created",
  logActivity: mockLogActivity,
  projectService: () => ({
    getById: vi.fn(),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => mockRoutineService,
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
}));

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: mockQueueIssueAssignmentWakeup,
}));

vi.mock("../services/issue-status-truth.js", () => ({
  applyEffectiveStatus: <T extends { status: string }>(issue: T) => issue,
  issueStatusTruthService: () => ({
    getIssueStatusTruthSummary: vi.fn(async () => null),
  }),
}));

vi.mock("../services/issue-blackboard.js", () => ({
  issueBlackboardService: () => ({
    getIssueBlackboardSummary: vi.fn(async () => null),
  }),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      runId,
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

describe("issue create routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.getById.mockResolvedValue(null);
    mockIssueService.list.mockResolvedValue([]);
    mockRoutineService.get.mockResolvedValue(null);
    mockIssueService.create.mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      companyId,
      identifier: "CMPA-501",
      title: "AI 视频商业调研",
      status: "todo",
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: null,
      projectId: null,
      goalId: null,
      parentId: null,
      labelIds: [],
      labels: [],
    });
  });

  it("passes blackboardTemplate and board actor context into issue creation without stale run attribution", async () => {
    const res = await request(createApp())
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "AI 视频商业调研",
        status: "todo",
        priority: "medium",
        blackboardTemplate: "research_v1",
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith(companyId, expect.objectContaining({
      title: "AI 视频商业调研",
      blackboardTemplate: "research_v1",
      createdByAgentId: null,
      createdByUserId: "board-user",
      createdByRunId: null,
    }));
    expect(mockQueueIssueAssignmentWakeup).toHaveBeenCalled();
  });

  it("rejects plan-exempt reserved lineage through generic issue creation", async () => {
    const res = await request(createApp())
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "QA stage should not use generic create",
        status: "todo",
        priority: "medium",
        originKind: "qa_stage",
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Reserved issue lineage cannot be set through generic issue creation");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("rejects a second assigned child issue under event-driven flow", async () => {
    const parentIssueId = "44444444-4444-4444-8444-444444444444";
    const existingChildIssueId = "55555555-5555-4555-8555-555555555555";
    const assigneeAgentId = "66666666-6666-4666-8666-666666666666";

    mockIssueService.getById.mockResolvedValue({
      id: parentIssueId,
      companyId,
      identifier: "CMPA-500",
      title: "Parent event-driven task",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: "77777777-7777-4777-8777-777777777777",
      assigneeUserId: null,
      parentId: null,
      originKind: null,
      originId: null,
    });
    mockIssueService.list.mockResolvedValue([
      {
        id: existingChildIssueId,
        companyId,
        identifier: "CMPA-502",
        title: "Existing child lane",
        status: "todo",
        priority: "medium",
        assigneeAgentId,
        assigneeUserId: null,
        parentId: parentIssueId,
        originKind: null,
        originId: null,
      },
    ]);

    const res = await request(createApp())
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Second child lane",
        status: "todo",
        priority: "medium",
        parentId: parentIssueId,
        assigneeAgentId: "88888888-8888-4888-8888-888888888888",
      });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: "event_driven_single_child_lane_conflict",
      parentIssueId,
      dispatchMode: "event_driven",
      existingChildIssueIds: [existingChildIssueId],
    });
    expect(mockIssueService.create).not.toHaveBeenCalled();
    expect(mockQueueIssueAssignmentWakeup).not.toHaveBeenCalled();
  });

  it("allows multiple assigned child issues when the parent routine explicitly uses fixed parallel lanes", async () => {
    const parentIssueId = "44444444-4444-4444-8444-444444444444";
    const routineId = "99999999-9999-4999-8999-999999999999";

    mockIssueService.getById.mockResolvedValue({
      id: parentIssueId,
      companyId,
      identifier: "CMPA-500",
      title: "Parent fixed lane task",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: "77777777-7777-4777-8777-777777777777",
      assigneeUserId: null,
      parentId: null,
      originKind: "routine_execution",
      originId: routineId,
    });
    mockIssueService.list.mockResolvedValue([
      {
        id: "55555555-5555-4555-8555-555555555555",
        companyId,
        identifier: "CMPA-502",
        title: "Existing child lane",
        status: "todo",
        priority: "medium",
        assigneeAgentId: "66666666-6666-4666-8666-666666666666",
        assigneeUserId: null,
        parentId: parentIssueId,
        originKind: null,
        originId: null,
      },
    ]);
    mockRoutineService.get.mockResolvedValue({
      id: routineId,
      dispatchMode: "fixed_parallel_lanes",
    });

    const res = await request(createApp())
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Second fixed lane",
        status: "todo",
        priority: "medium",
        parentId: parentIssueId,
        assigneeAgentId: "88888888-8888-4888-8888-888888888888",
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith(companyId, expect.objectContaining({
      title: "Second fixed lane",
      parentId: parentIssueId,
      assigneeAgentId: "88888888-8888-4888-8888-888888888888",
    }));
    expect(mockQueueIssueAssignmentWakeup).toHaveBeenCalled();
  });
});
