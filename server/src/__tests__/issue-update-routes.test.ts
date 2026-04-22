import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "company-1";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  assertCanTransitionIssueToDone: vi.fn(),
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
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(async () => null),
  }),
  approvalService: () => ({}),
  canActorResolveApproval: vi.fn(),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(async () => null),
  }),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({
    getById: vi.fn(async () => null),
    getDefaultCompanyGoal: vi.fn(async () => null),
  }),
  getIssueCreateDisposition: vi.fn(),
  heartbeatService: () => mockHeartbeatService,
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

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: vi.fn(),
}));

vi.mock("../services/issue-parent-closeout-wakeup.js", () => ({
  buildParentIssueCloseoutWake: vi.fn(),
  resolveParentIssueCloseoutWakeReason: vi.fn(),
}));

vi.mock("../services/issue-status-truth.js", () => ({
  applyEffectiveStatus: <T,>(issue: T) => issue,
  issueStatusTruthService: () => ({
    getIssueStatusTruthSummary: vi.fn(),
    getIssueStatusTruthSummaries: vi.fn(),
  }),
}));

vi.mock("../services/issue-runtime-state.js", () => ({
  attachIssueRuntimeState: vi.fn(async (_db, issue) => issue),
}));

vi.mock("../services/platform-unblock.js", () => ({
  platformUnblockService: () => ({
    getIssuePlatformUnblockSummary: vi.fn(async () => null),
    getRunPlatformHint: vi.fn(async () => null),
  }),
}));

vi.mock("../services/qa-issue-state.js", () => ({
  qaIssueStateService: () => ({
    getIssueQaSummary: vi.fn(async () => null),
    getRunIssueWriteback: vi.fn(async () => null),
  }),
}));

vi.mock("../services/issue-plan-side-effects.js", () => ({
  runPlanProposalSideEffects: vi.fn(async () => undefined),
  runPlanReviewSideEffects: vi.fn(async () => undefined),
}));

vi.mock("../services/issue-plan-policy.js", () => ({
  describeIssueExecutionPlanGateError: vi.fn(),
  getIssueExecutionPlanGateReason: vi.fn(() => null),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
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

function makeIssue() {
  return {
    id: issueId,
    companyId,
    identifier: "CMPA-201",
    title: "Research chain child",
    status: "todo",
    priority: "medium",
    goalId: null,
    parentId: null,
    projectId: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByUserId: "local-board",
    createdByAgentId: "agent-manager",
    originKind: "research_stage",
    originId: "45-review-verdict",
    updatedAt: new Date("2026-04-22T00:00:00.000Z"),
    executionRunId: null,
    checkoutRunId: null,
    executionWorkspaceId: null,
    planProposedAt: null,
    planApprovedAt: null,
  };
}

describe("issue update routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.update.mockImplementation(async (_id, patch) => ({
      ...makeIssue(),
      ...patch,
    }));
  });

  it("does not pass origin lineage fields through generic patch updates", async () => {
    const res = await request(createApp())
      .patch(`/api/issues/${issueId}`)
      .send({
        title: "Retitled child issue",
        originKind: "routine_execution",
        originId: "routine-123",
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      issueId,
      expect.objectContaining({
        title: "Retitled child issue",
      }),
    );
    const patch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(patch.originKind).toBeUndefined();
    expect(patch.originId).toBeUndefined();
    expect(res.body.originKind).toBe("research_stage");
    expect(res.body.originId).toBe("45-review-verdict");
  });
});
