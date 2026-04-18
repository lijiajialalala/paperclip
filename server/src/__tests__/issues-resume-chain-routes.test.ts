import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const mockIssueSvc = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  getAncestors: vi.fn(),
}));

const mockHeartbeat = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockRoutineSvc = vi.hoisted(() => ({
  get: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

const mockStatusTruth = vi.hoisted(() => ({
  getIssueStatusTruthSummaries: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueSvc,
  accessService: () => ({}),
  agentService: () => ({}),
  approvalDecisionActor: vi.fn(),
  approvalService: () => ({}),
  canActorResolveApproval: vi.fn(),
  executionWorkspaceService: () => ({}),
  feedbackService: () => ({}),
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeat,
  instanceSettingsService: () => ({}),
  issueApprovalService: () => ({}),
  documentService: () => ({}),
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => mockRoutineSvc,
  workProductService: () => ({}),
}));

vi.mock("../services/issue-status-truth.js", () => ({
  issueStatusTruthService: () => mockStatusTruth,
  applyEffectiveStatus: (issue: unknown) => issue,
}));

vi.mock("../services/issue-runtime-state.js", () => ({
  attachIssueRuntimeState: (issue: any) => ({
    ...issue,
    runtimeState: issue.runtimeState ?? {
      lifecycle: { isTerminal: issue.status === "done" },
      execution: { canStart: Boolean(issue.canStart) },
    },
  }),
}));

vi.mock("../services/platform-unblock.js", () => ({
  platformUnblockService: () => ({}),
}));

vi.mock("../services/qa-issue-state.js", () => ({
  qaIssueStateService: () => ({}),
}));

const COMPANY_ID = "00000000-0000-0000-0000-000000000001";
const ROUTINE_ID = randomUUID();

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    companyId: COMPANY_ID,
    identifier: "CMPA-TEST",
    title: "Test issue",
    status: "todo",
    assigneeAgentId: randomUUID(),
    parentId: null,
    originKind: null,
    originId: null,
    planProposedAt: null,
    planApprovedAt: null,
    canStart: true,
    ...overrides,
  };
}

function boardActor() {
  return {
    type: "board",
    actorType: "board",
    actorId: "user-board-1",
    userId: "user-board-1",
    companyIds: [COMPANY_ID],
    source: "local_implicit",
    isInstanceAdmin: false,
  };
}

function makeApp(actor: Record<string, unknown>) {
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

describe("issue resume-chain routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockStatusTruth.getIssueStatusTruthSummaries.mockResolvedValue(new Map());
    mockHeartbeat.wakeup.mockResolvedValue({ id: randomUUID() });
    mockRoutineSvc.get.mockResolvedValue(null);
    mockIssueSvc.getAncestors.mockResolvedValue([]);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("wakes the parent owner for event-driven batches when multiple child lanes are actionable", async () => {
    const parent = makeIssue({
      identifier: "CMPA-200",
      title: "Parent batch",
      originKind: "routine_execution",
      originId: ROUTINE_ID,
      canStart: true,
    });
    const childA = makeIssue({
      parentId: parent.id,
      identifier: "CMPA-201",
      title: "Lane A",
      canStart: true,
    });
    const childB = makeIssue({
      parentId: parent.id,
      identifier: "CMPA-202",
      title: "Lane B",
      canStart: true,
    });

    mockIssueSvc.getById.mockResolvedValue(parent);
    mockIssueSvc.list.mockResolvedValue([childA, childB]);
    mockRoutineSvc.get.mockResolvedValue({ id: ROUTINE_ID, dispatchMode: "event_driven" });

    const app = makeApp(boardActor());
    const res = await request(app).post(`/api/issues/${parent.id}/resume-chain`).send({});

    expect(res.status).toBe(200);
    expect(res.body.dispatchMode).toBe("event_driven");
    expect(res.body.decision).toBe("woke_parent_owner");
    expect(res.body.targets).toHaveLength(1);
    expect(res.body.targets[0]).toMatchObject({
      issueId: parent.id,
      assigneeAgentId: parent.assigneeAgentId,
      action: "woken",
    });
    expect(mockHeartbeat.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeat.wakeup).toHaveBeenCalledWith(
      parent.assigneeAgentId,
      expect.objectContaining({
        reason: "issue_chain_resumed",
        payload: expect.objectContaining({
          issueId: parent.id,
          sourceIssueId: parent.id,
          dispatchMode: "event_driven",
        }),
      }),
    );
  });

  it("wakes actionable child lanes in parallel for fixed_parallel_lanes dispatch", async () => {
    const parent = makeIssue({
      identifier: "CMPA-210",
      title: "Quality batch",
      originKind: "routine_execution",
      originId: ROUTINE_ID,
      canStart: true,
    });
    const childA = makeIssue({
      parentId: parent.id,
      identifier: "CMPA-211",
      title: "Lane A",
      assigneeAgentId: randomUUID(),
      canStart: true,
    });
    const childB = makeIssue({
      parentId: parent.id,
      identifier: "CMPA-212",
      title: "Lane B",
      assigneeAgentId: randomUUID(),
      canStart: true,
    });

    mockIssueSvc.getById.mockResolvedValue(parent);
    mockIssueSvc.list.mockResolvedValue([childA, childB]);
    mockRoutineSvc.get.mockResolvedValue({ id: ROUTINE_ID, dispatchMode: "fixed_parallel_lanes" });
    mockHeartbeat.wakeup
      .mockResolvedValueOnce({ id: randomUUID() })
      .mockResolvedValueOnce({ id: randomUUID() });

    const app = makeApp(boardActor());
    const res = await request(app).post(`/api/issues/${parent.id}/resume-chain`).send({});

    expect(res.status).toBe(200);
    expect(res.body.dispatchMode).toBe("fixed_parallel_lanes");
    expect(res.body.decision).toBe("woke_child_lanes");
    expect(res.body.targets).toHaveLength(2);
    expect(mockHeartbeat.wakeup).toHaveBeenCalledTimes(2);
    expect(mockHeartbeat.wakeup).toHaveBeenNthCalledWith(
      1,
      childA.assigneeAgentId,
      expect.objectContaining({
        payload: expect.objectContaining({ issueId: childA.id, dispatchMode: "fixed_parallel_lanes" }),
      }),
    );
    expect(mockHeartbeat.wakeup).toHaveBeenNthCalledWith(
      2,
      childB.assigneeAgentId,
      expect.objectContaining({
        payload: expect.objectContaining({ issueId: childB.id, dispatchMode: "fixed_parallel_lanes" }),
      }),
    );
  });

  it("derives fixed-parent routine dispatch from child routine executions", async () => {
    const fixedParent = makeIssue({
      identifier: "CMPA-213",
      title: "Fixed parent batch",
      originKind: null,
      originId: null,
      canStart: true,
    });
    const childA = makeIssue({
      parentId: fixedParent.id,
      identifier: "CMPA-214",
      title: "Lane A",
      assigneeAgentId: randomUUID(),
      originKind: "routine_execution",
      originId: ROUTINE_ID,
      canStart: true,
    });
    const childB = makeIssue({
      parentId: fixedParent.id,
      identifier: "CMPA-215",
      title: "Lane B",
      assigneeAgentId: randomUUID(),
      originKind: "routine_execution",
      originId: ROUTINE_ID,
      canStart: true,
    });

    mockIssueSvc.getById.mockResolvedValue(fixedParent);
    mockIssueSvc.list.mockResolvedValue([childA, childB]);
    mockRoutineSvc.get.mockResolvedValue({
      id: ROUTINE_ID,
      dispatchMode: "fixed_parallel_lanes",
      parentIssueId: fixedParent.id,
      runIssueMode: "child_of_fixed_parent",
    });
    mockHeartbeat.wakeup
      .mockResolvedValueOnce({ id: randomUUID() })
      .mockResolvedValueOnce({ id: randomUUID() });

    const app = makeApp(boardActor());
    const res = await request(app).post(`/api/issues/${fixedParent.id}/resume-chain`).send({});

    expect(res.status).toBe(200);
    expect(res.body.dispatchMode).toBe("fixed_parallel_lanes");
    expect(res.body.dispatchSource).toBe("child_origin_routine");
    expect(res.body.decision).toBe("woke_child_lanes");
    expect(res.body.targets).toHaveLength(2);
    expect(mockHeartbeat.wakeup).toHaveBeenCalledTimes(2);
    expect(mockHeartbeat.wakeup).toHaveBeenNthCalledWith(
      1,
      childA.assigneeAgentId,
      expect.objectContaining({
        payload: expect.objectContaining({ issueId: childA.id, dispatchMode: "fixed_parallel_lanes" }),
      }),
    );
    expect(mockHeartbeat.wakeup).toHaveBeenNthCalledWith(
      2,
      childB.assigneeAgentId,
      expect.objectContaining({
        payload: expect.objectContaining({ issueId: childB.id, dispatchMode: "fixed_parallel_lanes" }),
      }),
    );
  });

  it("returns no actionable target without waking anyone when nothing runnable remains", async () => {
    const parent = makeIssue({
      identifier: "CMPA-220",
      title: "Blocked batch",
      status: "blocked",
      assigneeAgentId: randomUUID(),
      canStart: false,
    });
    const child = makeIssue({
      parentId: parent.id,
      identifier: "CMPA-221",
      title: "Blocked lane",
      status: "blocked",
      assigneeAgentId: randomUUID(),
      canStart: false,
    });

    mockIssueSvc.getById.mockResolvedValue(parent);
    mockIssueSvc.list.mockResolvedValue([child]);

    const app = makeApp(boardActor());
    const res = await request(app).post(`/api/issues/${parent.id}/resume-chain`).send({});

    expect(res.status).toBe(200);
    expect(res.body.dispatchMode).toBe("event_driven");
    expect(res.body.decision).toBe("no_actionable_target");
    expect(res.body.targets).toEqual([]);
    expect(res.body.diagnostics).toMatchObject({
      issueActionable: false,
      issueBlocker: "issue_blocked",
      openChildCount: 1,
      actionableChildCount: 0,
    });
    expect(mockHeartbeat.wakeup).not.toHaveBeenCalled();
  });
});
