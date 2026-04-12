import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  getAncestors: vi.fn(),
  findMentionedProjectIds: vi.fn(),
}));

const mockStatusTruth = vi.hoisted(() => ({
  getIssueStatusTruthSummaries: vi.fn(),
  getIssueStatusTruthSummary: vi.fn(),
}));

const mockPlatformUnblock = vi.hoisted(() => ({
  listIssuePlatformUnblockSummaries: vi.fn(),
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
    listCompanyIds: vi.fn(async () => ["company-1"]),
  }),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({
    getById: vi.fn(),
    listByIds: vi.fn(),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
}));

vi.mock("../services/issue-status-truth.js", () => ({
  applyEffectiveStatus: <T extends { status: string }>(issue: T, summary: any) => summary
    ? { ...issue, status: summary.effectiveStatus, statusTruthSummary: summary }
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
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({ select: vi.fn() } as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue list routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.list.mockResolvedValue([
      {
        id: "issue-1",
        companyId: "company-1",
        identifier: "CMPA-120",
        title: "Drifted issue",
        status: "in_progress",
        priority: "medium",
      },
    ]);
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "CMPA-120",
      title: "Drifted issue",
      status: "in_progress",
      priority: "medium",
      projectId: null,
      goalId: null,
      executionWorkspaceId: null,
      executionRunId: null,
    });
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.findMentionedProjectIds.mockResolvedValue([]);

    const driftedBlockedSummary = {
      effectiveStatus: "blocked",
      persistedStatus: "in_progress",
      authoritativeStatus: "blocked",
      consistency: "drifted",
      authoritativeAt: "2026-04-12T02:00:00.000Z",
      authoritativeSource: "status_activity",
      authoritativeActorType: "system",
      authoritativeActorId: "paperclip",
      reasonSummary: "Latest explicit status activity moved the issue from in_progress to blocked.",
      canExecute: false,
      canClose: false,
      executionState: "idle",
      executionDiagnosis: null,
      lastExecutionSignalAt: "2026-04-12T01:55:00.000Z",
      stalledSince: null,
      stalledThresholdMs: 300000,
      driftCode: "blocked_checkout_reopen",
      evidence: [],
    };

    mockStatusTruth.getIssueStatusTruthSummaries.mockResolvedValue(new Map([
      ["issue-1", driftedBlockedSummary],
    ]));
    mockStatusTruth.getIssueStatusTruthSummary.mockResolvedValue(driftedBlockedSummary);
    mockPlatformUnblock.listIssuePlatformUnblockSummaries.mockResolvedValue(new Map());
  });

  it("filters company issue lists by effective status, not just persisted row status", async () => {
    const res = await request(createApp())
      .get("/api/companies/company-1/issues")
      .query({ status: "blocked" });

    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledWith("company-1", expect.objectContaining({
      status: undefined,
    }));
    expect(mockStatusTruth.getIssueStatusTruthSummaries).toHaveBeenCalledWith(["issue-1"]);
    expect(res.body).toEqual([
      expect.objectContaining({
        id: "issue-1",
        status: "blocked",
        statusTruthSummary: expect.objectContaining({
          effectiveStatus: "blocked",
          persistedStatus: "in_progress",
          executionState: "idle",
          lastExecutionSignalAt: "2026-04-12T01:55:00.000Z",
        }),
      }),
    ]);
  });

  it("serializes stalled execution diagnostics on list responses", async () => {
    mockStatusTruth.getIssueStatusTruthSummaries.mockResolvedValue(new Map([
      ["issue-1", {
        effectiveStatus: "in_progress",
        persistedStatus: "in_progress",
        authoritativeStatus: "in_progress",
        consistency: "consistent",
        authoritativeAt: "2026-04-12T02:00:00.000Z",
        authoritativeSource: "issue_row",
        authoritativeActorType: "system",
        authoritativeActorId: "paperclip",
        reasonSummary: "Using the persisted issue row because no explicit status activity exists.",
        canExecute: true,
        canClose: true,
        executionState: "stalled",
        executionDiagnosis: "no_active_run",
        lastExecutionSignalAt: "2026-04-12T01:40:00.000Z",
        stalledSince: "2026-04-12T01:40:00.000Z",
        stalledThresholdMs: 300000,
        driftCode: null,
        evidence: [],
      }],
    ]));

    const res = await request(createApp()).get("/api/companies/company-1/issues");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({
        id: "issue-1",
        status: "in_progress",
        statusTruthSummary: expect.objectContaining({
          executionState: "stalled",
          executionDiagnosis: "no_active_run",
          lastExecutionSignalAt: "2026-04-12T01:40:00.000Z",
          stalledSince: "2026-04-12T01:40:00.000Z",
        }),
      }),
    ]);
  });

  it("includes stalled execution diagnostics on issue detail responses", async () => {
    mockStatusTruth.getIssueStatusTruthSummary.mockResolvedValue({
      effectiveStatus: "in_progress",
      persistedStatus: "in_progress",
      authoritativeStatus: "in_progress",
      consistency: "consistent",
      authoritativeAt: "2026-04-12T02:00:00.000Z",
      authoritativeSource: "issue_row",
      authoritativeActorType: "system",
      authoritativeActorId: "paperclip",
      reasonSummary: "Using the persisted issue row because no explicit status activity exists.",
      canExecute: true,
      canClose: true,
      executionState: "stalled",
      executionDiagnosis: "no_active_run",
      lastExecutionSignalAt: "2026-04-12T01:40:00.000Z",
      stalledSince: "2026-04-12T01:40:00.000Z",
      stalledThresholdMs: 300000,
      driftCode: null,
      evidence: [],
    });

    const res = await request(createApp()).get("/api/issues/issue-1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      id: "issue-1",
      status: "in_progress",
      statusTruthSummary: expect.objectContaining({
        executionState: "stalled",
        executionDiagnosis: "no_active_run",
        lastExecutionSignalAt: "2026-04-12T01:40:00.000Z",
        stalledSince: "2026-04-12T01:40:00.000Z",
      }),
    }));
  });
});
