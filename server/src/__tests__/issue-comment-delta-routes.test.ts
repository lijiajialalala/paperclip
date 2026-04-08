import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const afterCommentId = "33333333-3333-4333-8333-333333333333";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  listComments: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  documentService: () => ({}),
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
  logActivity: mockLogActivity,
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

function createActivityDb(previousDeltaActivity: { action: string; createdAt: Date } | null) {
  return {
    select: vi.fn(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn(() => ({
        then: (cb: (rows: Array<{ action: string; createdAt: Date }>) => unknown) =>
          Promise.resolve(cb(previousDeltaActivity ? [previousDeltaActivity] : [])),
      })),
    })),
  };
}

function createApp(db: Record<string, unknown>) {
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
  app.use("/api", issueRoutes(db as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue comment delta routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue({
      id: issueId,
      companyId,
      identifier: "CMPA-39",
      title: "Comment delta health",
      status: "in_progress",
      priority: "high",
    });
  });

  it("logs delta success and recovery when the previous read failed", async () => {
    mockIssueService.listComments.mockResolvedValue([
      {
        id: "44444444-4444-4444-8444-444444444444",
        issueId,
        body: "Recovered comment",
      },
    ]);

    const res = await request(createApp(createActivityDb({
      action: "issue.comment_delta_read_failed",
      createdAt: new Date("2026-04-08T01:00:00.000Z"),
    })))
      .get(`/api/issues/${issueId}/comments?after=${afterCommentId}&order=asc`);

    expect(res.status).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.comment_delta_read_succeeded",
        entityId: issueId,
        details: expect.objectContaining({
          afterCommentId,
          returnedCount: 1,
          latestReturnedCommentId: "44444444-4444-4444-8444-444444444444",
        }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.platform_recovered",
        entityId: issueId,
        details: expect.objectContaining({
          recoveryKind: "comment_visibility_recovered",
          afterCommentId,
        }),
      }),
    );
  });

  it("logs delta failure when comment listing throws", async () => {
    mockIssueService.listComments.mockRejectedValue(new Error("delta exploded"));

    const res = await request(createApp(createActivityDb(null)))
      .get(`/api/issues/${issueId}/comments?after=${afterCommentId}&order=asc`);

    expect(res.status).toBe(500);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.comment_delta_read_failed",
        entityId: issueId,
        details: expect.objectContaining({
          afterCommentId,
          error: "delta exploded",
        }),
      }),
    );
  });
});
