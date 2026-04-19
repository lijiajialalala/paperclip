import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const childIssueId = "11111111-1111-4111-8111-111111111111";
const parentIssueId = "33333333-3333-4333-8333-333333333333";
const parentAssigneeAgentId = "44444444-4444-4444-8444-444444444444";

const mockIssueService = vi.hoisted(() => ({
  assertCanTransitionIssueToDone: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => ({
    getById: vi.fn(async () => null),
  }),
  approvalService: () => ({}),
  documentService: () => ({}),
  executionWorkspaceService: () => ({
    getById: vi.fn(async () => null),
  }),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({
    getDefaultCompanyGoal: vi.fn(async () => null),
    getById: vi.fn(async () => null),
  }),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    })),
    listCompanyIds: vi.fn(async () => ["company-1"]),
  }),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({
    getById: vi.fn(async () => null),
  }),
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
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeChildIssue(status: string) {
  return {
    id: childIssueId,
    companyId: "company-1",
    status,
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-175",
    title: "Child lane",
    parentId: parentIssueId,
    projectId: null,
    executionRunId: null,
    checkoutRunId: null,
    executionWorkspaceId: null,
  };
}

function makeParentIssue() {
  return {
    id: parentIssueId,
    companyId: "company-1",
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: parentAssigneeAgentId,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-174",
    title: "Parent lane",
    parentId: null,
    projectId: null,
    executionRunId: null,
    checkoutRunId: null,
    executionWorkspaceId: null,
  };
}

describe("issue parent wakeup routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.assertCanTransitionIssueToDone.mockResolvedValue(undefined);
  });

  it("wakes the parent assignee when a child issue is completed", async () => {
    mockIssueService.getById.mockResolvedValueOnce(makeChildIssue("in_progress")).mockResolvedValueOnce(makeParentIssue());
    mockIssueService.update.mockResolvedValue(makeChildIssue("done"));

    const res = await request(createApp())
      .patch(`/api/issues/${childIssueId}`)
      .send({ status: "done" });

    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      parentAssigneeAgentId,
      expect.objectContaining({
        reason: "child_issue_completed",
        payload: expect.objectContaining({
          issueId: parentIssueId,
          childIssueId,
          mutation: "child_done",
        }),
        contextSnapshot: expect.objectContaining({
          issueId: parentIssueId,
          childIssueId,
          source: "issue.child_completed",
          wakeReason: "child_issue_completed",
        }),
      }),
    );
  });

  it("wakes the parent assignee when a child issue becomes blocked", async () => {
    mockIssueService.getById.mockResolvedValueOnce(makeChildIssue("in_progress")).mockResolvedValueOnce(makeParentIssue());
    mockIssueService.update.mockResolvedValue(makeChildIssue("blocked"));

    const res = await request(createApp())
      .patch(`/api/issues/${childIssueId}`)
      .send({ status: "blocked" });

    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      parentAssigneeAgentId,
      expect.objectContaining({
        reason: "child_issue_blocked",
        payload: expect.objectContaining({
          issueId: parentIssueId,
          childIssueId,
          mutation: "child_blocked",
        }),
        contextSnapshot: expect.objectContaining({
          issueId: parentIssueId,
          childIssueId,
          source: "issue.child_blocked",
          wakeReason: "child_issue_blocked",
        }),
      }),
    );
  });
});
