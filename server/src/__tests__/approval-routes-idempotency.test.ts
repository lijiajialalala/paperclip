import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import { approvalRoutes } from "../routes/approvals.js";
import { errorHandler } from "../middleware/index.js";

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  approveWithLinkedIssueSync: vi.fn(),
  reject: vi.fn(),
  rejectWithLinkedIssueSync: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

const mockApprovalRouting = vi.hoisted(() => ({
  canActorResolveApproval: vi.fn((approval: any, actor: any) => {
    if (actor.actorType === "agent") {
      return approval.targetAgentId === actor.agentId;
    }
    if (approval.targetUserId && approval.targetUserId === actor.userId) {
      return true;
    }
    return [
      null,
      undefined,
      "board_pool",
      "escalated_to_board",
      "timeout_escalated_to_board",
    ].includes(approval.routingMode);
  }),
  approvalDecisionActor: vi.fn((actor: any) =>
    actor.actorType === "agent"
      ? { decidedByUserId: null, decidedByAgentId: actor.agentId }
      : { decidedByUserId: actor.userId ?? "board", decidedByAgentId: null }),
}));

vi.mock("../services/index.js", () => ({
  approvalService: () => mockApprovalService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  canActorResolveApproval: mockApprovalRouting.canActorResolveApproval,
  approvalDecisionActor: mockApprovalRouting.approvalDecisionActor,
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", approvalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function createAgentApp(agentId = "agent-reviewer") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId,
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    };
    next();
  });
  app.use("/api", approvalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("approval routes idempotent retries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-1" }]);
    mockLogActivity.mockResolvedValue(undefined);
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "work_plan",
      status: "pending",
      payload: {},
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      targetAgentId: null,
      targetUserId: null,
      routingMode: "board_pool",
      decidedByUserId: null,
      decidedByAgentId: null,
      decidedAt: null,
      createdAt: new Date("2026-04-10T04:00:00.000Z"),
      updatedAt: new Date("2026-04-10T04:00:00.000Z"),
    });
    mockApprovalService.approveWithLinkedIssueSync.mockResolvedValue({
      approval: {
        id: "approval-1",
        companyId: "company-1",
        type: "work_plan",
        status: "approved",
        payload: {},
        requestedByAgentId: "agent-1",
        decidedAt: new Date("2026-04-10T05:00:00.000Z"),
      },
      applied: true,
      linkedIssues: [{ id: "issue-1" }],
    });
    mockApprovalService.rejectWithLinkedIssueSync.mockResolvedValue({
      approval: {
        id: "approval-1",
        companyId: "company-1",
        type: "work_plan",
        status: "rejected",
        payload: {},
        requestedByAgentId: "agent-1",
      },
      applied: true,
      linkedIssues: [{ id: "issue-1" }],
    });
  });

  it("does not emit duplicate approval side effects when approve is already resolved", async () => {
    mockApprovalService.approveWithLinkedIssueSync.mockResolvedValue({
      approval: {
        id: "approval-1",
        companyId: "company-1",
        type: "hire_agent",
        status: "approved",
        payload: {},
        requestedByAgentId: "agent-1",
      },
      applied: false,
    });

    const res = await request(createApp())
      .post("/api/approvals/approval-1/approve")
      .send({});

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("does not emit duplicate rejection logs when reject is already resolved", async () => {
    mockApprovalService.rejectWithLinkedIssueSync.mockResolvedValue({
      approval: {
        id: "approval-1",
        companyId: "company-1",
        type: "hire_agent",
        status: "rejected",
        payload: {},
      },
      applied: false,
    });

    const res = await request(createApp())
      .post("/api/approvals/approval-1/reject")
      .send({});

    expect(res.status).toBe(200);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("routes work-plan approval through the atomic linked-issue settlement path", async () => {
    const decidedAt = new Date("2026-04-10T05:00:00.000Z");
    mockApprovalService.approveWithLinkedIssueSync.mockResolvedValue({
      approval: {
        id: "approval-1",
        companyId: "company-1",
        type: "work_plan",
        status: "approved",
        payload: {},
        requestedByAgentId: "agent-1",
        decidedAt,
      },
      applied: true,
      linkedIssues: [{ id: "issue-1" }],
    });

    const res = await request(createApp())
      .post("/api/approvals/approval-1/approve")
      .send({});

    expect(res.status).toBe(200);
    expect(mockApprovalService.approveWithLinkedIssueSync).toHaveBeenCalledWith(
      "approval-1",
      expect.objectContaining({
        decidedByUserId: "user-1",
      }),
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        reason: "approval_approved",
      }),
    );
  });

  it("propagates work-plan settlement conflicts from the approval service", async () => {
    mockApprovalService.approveWithLinkedIssueSync.mockRejectedValue(
      new HttpError(
        409,
        "Cannot approve a plan after execution has already started. Return the issue to review and rerun after approval.",
      ),
    );

    const res = await request(createApp())
      .post("/api/approvals/approval-1/approve")
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/cannot approve a plan after execution has already started/i);
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("routes work-plan rejection through the atomic linked-issue settlement path", async () => {
    mockApprovalService.rejectWithLinkedIssueSync.mockResolvedValue({
      approval: {
        id: "approval-1",
        companyId: "company-1",
        type: "work_plan",
        status: "rejected",
        payload: {},
        requestedByAgentId: "agent-1",
      },
      applied: true,
      linkedIssues: [{ id: "issue-1" }],
    });

    const res = await request(createApp())
      .post("/api/approvals/approval-1/reject")
      .send({});

    expect(res.status).toBe(200);
    expect(mockApprovalService.rejectWithLinkedIssueSync).toHaveBeenCalledWith(
      "approval-1",
      expect.objectContaining({
        decidedByUserId: "user-1",
      }),
    );
  });

  it("allows the targeted lead agent to approve a routed work-plan approval", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "work_plan",
      status: "pending",
      payload: {},
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      targetAgentId: "agent-reviewer",
      targetUserId: null,
      routingMode: "parent_assignee_agent",
      decidedByUserId: null,
      decidedByAgentId: null,
      decidedAt: null,
      createdAt: new Date("2026-04-10T04:00:00.000Z"),
      updatedAt: new Date("2026-04-10T04:00:00.000Z"),
    });
    mockApprovalService.approveWithLinkedIssueSync.mockResolvedValue({
      approval: {
        id: "approval-1",
        companyId: "company-1",
        type: "work_plan",
        status: "approved",
        payload: {},
        requestedByAgentId: "agent-1",
        targetAgentId: "agent-reviewer",
        targetUserId: null,
        routingMode: "parent_assignee_agent",
        decidedByUserId: null,
        decidedByAgentId: "agent-reviewer",
        decidedAt: new Date("2026-04-10T05:00:00.000Z"),
      },
      applied: true,
    });

    const res = await request(createAgentApp("agent-reviewer"))
      .post("/api/approvals/approval-1/approve")
      .send({});

    expect(res.status).toBe(200);
    expect(mockApprovalService.approveWithLinkedIssueSync).toHaveBeenCalledWith(
      "approval-1",
      expect.objectContaining({
        decidedByAgentId: "agent-reviewer",
        decidedByUserId: null,
      }),
    );
  });

  it("forbids Board from directly approving a work-plan routed to a lead agent", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "work_plan",
      status: "pending",
      payload: {},
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      targetAgentId: "agent-reviewer",
      targetUserId: null,
      routingMode: "parent_assignee_agent",
      decidedByUserId: null,
      decidedByAgentId: null,
      decidedAt: null,
      createdAt: new Date("2026-04-10T04:00:00.000Z"),
      updatedAt: new Date("2026-04-10T04:00:00.000Z"),
    });
    const res = await request(createApp())
      .post("/api/approvals/approval-1/approve")
      .send({});

    expect(res.status).toBe(403);
    expect(mockApprovalService.approveWithLinkedIssueSync).not.toHaveBeenCalled();
  });
});
