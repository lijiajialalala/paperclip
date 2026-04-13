import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvalRoutes } from "../routes/approvals.js";
import { errorHandler } from "../middleware/index.js";

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
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

const mockIssueService = vi.hoisted(() => ({
  update: vi.fn(),
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
  issueService: () => mockIssueService,
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
    mockIssueService.update.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({
      id,
      ...patch,
    }));
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
  });

  it("does not emit duplicate approval side effects when approve is already resolved", async () => {
    mockApprovalService.approve.mockResolvedValue({
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
    expect(mockIssueApprovalService.listIssuesForApproval).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("does not emit duplicate rejection logs when reject is already resolved", async () => {
    mockApprovalService.reject.mockResolvedValue({
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

  it("syncs linked work-plan issues when an approval is approved from the inbox", async () => {
    const decidedAt = new Date("2026-04-10T05:00:00.000Z");
    mockApprovalService.approve.mockResolvedValue({
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
    });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([
      {
        id: "issue-1",
        status: "in_progress",
        planProposedAt: new Date("2026-04-10T04:55:00.000Z"),
        planApprovedAt: null,
      },
    ]);

    const res = await request(createApp())
      .post("/api/approvals/approval-1/approve")
      .send({});

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "issue-1",
      expect.objectContaining({
        planApprovedAt: decidedAt,
      }),
    );
    expect(mockIssueService.update.mock.calls[0]?.[1]).not.toHaveProperty("status");
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        reason: "approval_approved",
      }),
    );
  });

  it("clears linked work-plan review state when an approval is rejected from the inbox", async () => {
    mockApprovalService.reject.mockResolvedValue({
      approval: {
        id: "approval-1",
        companyId: "company-1",
        type: "work_plan",
        status: "rejected",
        payload: {},
        requestedByAgentId: "agent-1",
      },
      applied: true,
    });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([
      {
        id: "issue-1",
        status: "in_progress",
        planProposedAt: new Date("2026-04-10T04:55:00.000Z"),
        planApprovedAt: null,
      },
    ]);

    const res = await request(createApp())
      .post("/api/approvals/approval-1/reject")
      .send({});

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "issue-1",
      expect.objectContaining({
        planProposedAt: null,
        planApprovedAt: null,
      }),
    );
    expect(mockIssueService.update.mock.calls[0]?.[1]).not.toHaveProperty("status");
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
    mockApprovalService.approve.mockResolvedValue({
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
    expect(mockApprovalService.approve).toHaveBeenCalledWith(
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
    expect(mockApprovalService.approve).not.toHaveBeenCalled();
  });
});
