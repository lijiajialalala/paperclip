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

function createApp(dbOverride: any = { select: vi.fn() }) {
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
  app.use("/api", issueRoutes(dbOverride, {} as any));
  app.use(errorHandler);
  return app;
}

function createRuntimeDiagnosticsDb() {
  const issueRows = [
    {
      id: "issue-blocked",
      identifier: "CMPA-155",
      title: "Blocked issue without active run",
      status: "blocked",
      parentId: null,
      assigneeAgentId: "agent-1",
      originKind: "manual",
      checkoutRunId: null,
      executionRunId: null,
      planProposedAt: null,
      planApprovedAt: null,
      executionRunStatus: null,
      executionRunAgentId: null,
    },
    {
      id: "issue-stale-run",
      identifier: "CMPA-156",
      title: "Issue with terminal execution lock",
      status: "in_progress",
      parentId: null,
      assigneeAgentId: "agent-2",
      originKind: "manual",
      checkoutRunId: null,
      executionRunId: "run-failed",
      planProposedAt: null,
      planApprovedAt: null,
      executionRunStatus: "failed",
      executionRunAgentId: "agent-2",
    },
    {
      id: "issue-missing-plan",
      identifier: "CMPA-157",
      title: "Assigned child issue missing a plan",
      status: "todo",
      parentId: "parent-1",
      assigneeAgentId: "agent-3",
      originKind: "manual",
      checkoutRunId: null,
      executionRunId: null,
      planProposedAt: null,
      planApprovedAt: null,
      executionRunStatus: null,
      executionRunAgentId: null,
    },
    {
      id: "issue-plan-review",
      identifier: "CMPA-158",
      title: "Assigned child issue pending plan review",
      status: "in_review",
      parentId: "parent-1",
      assigneeAgentId: "agent-4",
      originKind: "manual",
      checkoutRunId: null,
      executionRunId: null,
      planProposedAt: new Date("2026-04-25T01:00:00.000Z"),
      planApprovedAt: null,
      executionRunStatus: null,
      executionRunAgentId: null,
    },
  ];

  const deferredWakeRows = [
    {
      id: "wake-1",
      agentId: "agent-5",
      reason: "issue_execution_deferred",
      payload: { issueId: "issue-blocked" },
      requestedAt: new Date("2026-04-25T01:02:00.000Z"),
      updatedAt: new Date("2026-04-25T01:03:00.000Z"),
    },
  ];

  const routineRunRows = [
    {
      id: "routine-run-1",
      routineId: "routine-1",
      status: "issue_created",
      linkedIssueId: "issue-blocked",
      failureReason: null,
      triggeredAt: new Date("2026-04-25T01:04:00.000Z"),
      linkedIssueStatus: "blocked",
      linkedIssueExecutionRunId: null,
      linkedIssueExecutionRunStatus: null,
    },
    {
      id: "routine-run-2",
      routineId: "routine-2",
      status: "failed",
      linkedIssueId: null,
      failureReason: "queue failed",
      triggeredAt: new Date("2026-04-25T01:05:00.000Z"),
      linkedIssueStatus: null,
      linkedIssueExecutionRunId: null,
      linkedIssueExecutionRunStatus: null,
    },
  ];

  const issueChain: any = {};
  issueChain.from = vi.fn(() => issueChain);
  issueChain.leftJoin = vi.fn(() => issueChain);
  issueChain.where = vi.fn(async () => issueRows);

  const deferredChain: any = {};
  deferredChain.from = vi.fn(() => deferredChain);
  deferredChain.where = vi.fn(() => deferredChain);
  deferredChain.orderBy = vi.fn(() => deferredChain);
  deferredChain.limit = vi.fn(async () => deferredWakeRows);

  const routineChain: any = {};
  routineChain.from = vi.fn(() => routineChain);
  routineChain.leftJoin = vi.fn(() => routineChain);
  routineChain.where = vi.fn(() => routineChain);
  routineChain.orderBy = vi.fn(() => routineChain);
  routineChain.limit = vi.fn(async () => routineRunRows);

  return {
    select: vi.fn()
      .mockReturnValueOnce(issueChain)
      .mockReturnValueOnce(deferredChain)
      .mockReturnValueOnce(routineChain),
  };
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
        planProposedAt: "2026-04-12T01:50:00.000Z",
        planApprovedAt: null,
        replyNeededForMe: true,
        replyNeededCommentId: "comment-1",
        replyNeededAt: "2026-04-12T01:58:00.000Z",
        checkoutRunId: null,
        executionLockedAt: null,
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
      checkoutRunId: null,
      executionLockedAt: null,
      planProposedAt: "2026-04-12T01:50:00.000Z",
      planApprovedAt: null,
      replyNeededForMe: true,
      replyNeededCommentId: "comment-1",
      replyNeededAt: "2026-04-12T01:58:00.000Z",
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

  it("reports runtime truth diagnostics for stalled issues, deferred wakes, and routine drift", async () => {
    const res = await request(createApp(createRuntimeDiagnosticsDb() as any))
      .get("/api/companies/company-1/issues/runtime-diagnostics");

    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({
      issueRuntime: 4,
      deferredWakeRequests: 1,
      routineRuns: 2,
    });
    expect(res.body.issueRuntime).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issueId: "issue-blocked",
        findings: ["no_active_run"],
      }),
      expect.objectContaining({
        issueId: "issue-stale-run",
        findings: ["no_active_run", "execution_run_not_active"],
      }),
      expect.objectContaining({
        issueId: "issue-missing-plan",
        planGate: "missing_plan_approval",
        findings: ["missing_plan_approval"],
      }),
      expect.objectContaining({
        issueId: "issue-plan-review",
        planGate: "plan_pending_review",
        findings: ["plan_pending_review"],
      }),
    ]));
    expect(res.body.deferredWakeRequests).toEqual([
      expect.objectContaining({
        wakeupRequestId: "wake-1",
        issueId: "issue-blocked",
        reason: "issue_execution_deferred",
      }),
    ]);
    expect(res.body.routineRuns).toEqual(expect.arrayContaining([
      expect.objectContaining({
        routineRunId: "routine-run-1",
        findings: ["linked_issue_without_active_run"],
      }),
      expect.objectContaining({
        routineRunId: "routine-run-2",
        findings: ["routine_run_failed"],
      }),
    ]));
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
        runtimeState: expect.objectContaining({
          lifecycle: expect.objectContaining({ status: "blocked" }),
          review: expect.objectContaining({
            state: "pending",
            kind: "work_plan",
          }),
          humanWait: expect.objectContaining({
            state: "reply_needed",
            commentId: "comment-1",
          }),
          execution: expect.objectContaining({
            state: "idle",
            activation: "blocked",
            canStart: false,
          }),
        }),
      }),
    ]);
  });

  it("filters pending plan review issues through the derived review_pending display status", async () => {
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
        canExecute: false,
        canClose: true,
        executionState: "idle",
        executionDiagnosis: null,
        lastExecutionSignalAt: "2026-04-12T01:55:00.000Z",
        stalledSince: null,
        stalledThresholdMs: 300000,
        driftCode: null,
        evidence: [],
      }],
    ]));

    const reviewPendingRes = await request(createApp())
      .get("/api/companies/company-1/issues")
      .query({ status: "review_pending" });

    expect(reviewPendingRes.status).toBe(200);
    expect(reviewPendingRes.body).toEqual([
      expect.objectContaining({
        id: "issue-1",
        status: "in_progress",
        runtimeState: expect.objectContaining({
          review: expect.objectContaining({
            state: "pending",
          }),
        }),
      }),
    ]);

    const inProgressRes = await request(createApp())
      .get("/api/companies/company-1/issues")
      .query({ status: "in_progress" });

    expect(inProgressRes.status).toBe(200);
    expect(inProgressRes.body).toEqual([]);
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
        runtimeState: expect.objectContaining({
          review: expect.objectContaining({ state: "pending" }),
          humanWait: expect.objectContaining({ state: "reply_needed" }),
          execution: expect.objectContaining({
            state: "idle",
            activation: "awaiting_review",
            diagnosis: "plan_review_pending",
            canStart: false,
          }),
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
      runtimeState: expect.objectContaining({
        review: expect.objectContaining({ state: "pending" }),
        humanWait: expect.objectContaining({ state: "reply_needed" }),
        execution: expect.objectContaining({
          state: "idle",
          activation: "awaiting_review",
          diagnosis: "plan_review_pending",
          canStart: false,
        }),
      }),
    }));
  });
});
