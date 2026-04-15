import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const issueId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  checkout: vi.fn(),
  release: vi.fn(),
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

function makeIssue(status: string) {
  return {
    id: issueId,
    companyId: "company-1",
    status,
    priority: "medium",
    assigneeAgentId: agentId,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-141",
    title: "Status transition regression",
    projectId: null,
    executionRunId: null,
    checkoutRunId: null,
    executionWorkspaceId: null,
  };
}

describe("issue status transition route logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs checkout as a checkout audit activity without duplicating status activity", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("blocked"));
    mockIssueService.checkout.mockResolvedValue({
      ...makeIssue("in_progress"),
      checkoutRunId: null,
    });

    const res = await request(createApp())
      .post(`/api/issues/${issueId}/checkout`)
      .send({
        agentId,
        expectedStatuses: ["todo", "backlog", "blocked"],
      });

    expect(res.status).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        action: "issue.checked_out",
        details: expect.objectContaining({
          status: "in_progress",
          _previous: { status: "blocked" },
        }),
      }),
    );
  });

  it("logs release as a release audit activity without duplicating status activity", async () => {
    mockIssueService.getById.mockResolvedValue({
      ...makeIssue("in_progress"),
      checkoutRunId: "run-1",
    });
    mockIssueService.release.mockResolvedValue({
      ...makeIssue("todo"),
      checkoutRunId: null,
    });

    const res = await request(createApp()).post(`/api/issues/${issueId}/release`).send({});

    expect(res.status).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        action: "issue.released",
        details: expect.objectContaining({
          status: "todo",
          _previous: { status: "in_progress" },
        }),
      }),
    );
  });
});
