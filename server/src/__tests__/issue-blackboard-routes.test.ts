import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

const mockBlackboardService = vi.hoisted(() => ({
  getIssueBlackboard: vi.fn(),
  getIssueBlackboardEntry: vi.fn(),
  bootstrapIssueBlackboard: vi.fn(),
  upsertIssueBlackboardEntry: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentService: () => ({}),
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

vi.mock("../services/issue-blackboard.js", () => ({
  issueBlackboardService: () => mockBlackboardService,
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

describe("issue blackboard routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue({
      id: issueId,
      companyId,
      identifier: "CMPA-300",
      title: "Blackboard issue",
      status: "in_progress",
    });
    mockBlackboardService.getIssueBlackboard.mockResolvedValue({
      manifest: { status: "missing" },
      entries: [],
      missingKeys: ["original-request"],
      isComplete: false,
    });
    mockBlackboardService.getIssueBlackboardEntry.mockResolvedValue({
      key: "evidence-ledger",
      status: "ready",
      content: { version: 1, entries: [] },
    });
    mockBlackboardService.bootstrapIssueBlackboard.mockResolvedValue({
      manifest: { status: "ready" },
      entries: [],
      missingKeys: [],
      isComplete: true,
    });
    mockBlackboardService.upsertIssueBlackboardEntry.mockResolvedValue({
      key: "evidence-ledger",
      status: "ready",
      content: { version: 1, entries: [] },
      document: {
        id: "doc-1",
        key: "evidence-ledger",
        format: "json",
        latestRevisionNumber: 1,
      },
    });
  });

  it("returns the current issue blackboard state", async () => {
    const res = await request(createApp()).get(`/api/issues/${issueId}/blackboard`);

    expect(res.status).toBe(200);
    expect(mockBlackboardService.getIssueBlackboard).toHaveBeenCalledWith(issueId);
    expect(res.body).toEqual(expect.objectContaining({
      isComplete: false,
      missingKeys: ["original-request"],
    }));
  });

  it("bootstraps missing blackboard docs for an issue", async () => {
    const res = await request(createApp())
      .post(`/api/issues/${issueId}/blackboard/bootstrap`)
      .send({});

    expect(res.status).toBe(200);
    expect(mockBlackboardService.bootstrapIssueBlackboard).toHaveBeenCalledWith({
      issueId,
      template: "research_v1",
      createdByAgentId: null,
      createdByUserId: "board-user",
      createdByRunId: null,
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.blackboard_bootstrapped",
        entityId: issueId,
      }),
    );
  });

  it("updates a blackboard entry through the dedicated route", async () => {
    const res = await request(createApp())
      .put(`/api/issues/${issueId}/blackboard/evidence-ledger`)
      .send({
        content: {
          version: 1,
          entries: [],
        },
      });

    expect(res.status).toBe(200);
    expect(mockBlackboardService.upsertIssueBlackboardEntry).toHaveBeenCalledWith({
      issueId,
      key: "evidence-ledger",
      content: {
        version: 1,
        entries: [],
      },
      changeSummary: null,
      baseRevisionId: null,
      createdByAgentId: null,
      createdByUserId: "board-user",
      createdByRunId: null,
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.blackboard_entry_updated",
        entityId: issueId,
        details: expect.objectContaining({
          key: "evidence-ledger",
        }),
      }),
    );
  });

  it("rejects invalid blackboard keys before reaching the service", async () => {
    const res = await request(createApp())
      .put(`/api/issues/${issueId}/blackboard/not-a-real-key`)
      .send({ content: "nope" });

    expect(res.status).toBe(400);
    expect(mockBlackboardService.upsertIssueBlackboardEntry).not.toHaveBeenCalled();
  });
});
