import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const mockIssueService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
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

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockGetIssueCreateDisposition = vi.hoisted(() => vi.fn(() => "created" as "created" | "reused"));
const mockQueueIssueAssignmentWakeup = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  getIssueCreateDisposition: mockGetIssueCreateDisposition,
  goalService: () => ({}),
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
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: mockQueueIssueAssignmentWakeup,
}));

function createApp(
  actor: Record<string, unknown> = {
    type: "board",
    userId: "local-board",
    companyIds: ["company-1"],
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

function makeIssue() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    title: "AI 视频研究主线",
    identifier: "CMPA-199",
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
  };
}

describe("issue create routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetIssueCreateDisposition.mockReturnValue("created");
    mockIssueService.create.mockResolvedValue(makeIssue());
  });

  it("records create activity and create wakeups for newly created issues", async () => {
    const res = await request(createApp())
      .post("/api/companies/company-1/issues")
      .send({ title: "AI 视频研究主线" });

    expect(res.status).toBe(201);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.created",
        details: expect.objectContaining({ createDisposition: "created" }),
      }),
    );
    expect(mockQueueIssueAssignmentWakeup).toHaveBeenCalledWith(
      expect.objectContaining({
        mutation: "create",
      }),
    );
  });

  it("treats reused issues as updates instead of fresh creates", async () => {
    mockGetIssueCreateDisposition.mockReturnValue("reused");

    const res = await request(createApp())
      .post("/api/companies/company-1/issues")
      .send({ title: "AI 视频研究主线" });

    expect(res.status).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        details: expect.objectContaining({ createDisposition: "reused" }),
      }),
    );
    expect(mockQueueIssueAssignmentWakeup).toHaveBeenCalledWith(
      expect.objectContaining({
        mutation: "update",
      }),
    );
  });
});
