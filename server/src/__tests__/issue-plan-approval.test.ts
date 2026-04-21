import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { HttpError } from "../errors.js";

// ── Hoisted stubs (registered before any module loads) ─────────────────────
const mockIssueSvc = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  checkout: vi.fn(),
  release: vi.fn(),
  addComment: vi.fn(),
  proposePlan: vi.fn(),
  approvePlan: vi.fn(),
  rejectPlan: vi.fn(),
  getAncestors: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  createAttachment: vi.fn(),
  getAttachmentById: vi.fn(),
  removeAttachment: vi.fn(),
}));

const mockAgentSvc = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessSvc = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockHeartbeat = vi.hoisted(() => ({
  wakeup: vi.fn(),
  reportRunActivity: vi.fn(),
}));

const mockApprovalSvc = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  resubmit: vi.fn(),
}));

const mockIssueApprovalSvc = vi.hoisted(() => ({
  listApprovalsForIssue: vi.fn(),
  linkManyForApproval: vi.fn(),
  getLiveWorkPlanApprovalForIssue: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

const mockInstanceSettings = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

const mockProjectSvc = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockApprovalRouting = vi.hoisted(() => ({
  defaultWorkPlanApprovalRouting: vi.fn((issue: any, parent: any) => {
    if (issue?.parentId && parent) {
      if (parent.assigneeAgentId && parent.assigneeAgentId !== issue.assigneeAgentId) {
        return {
          targetAgentId: parent.assigneeAgentId,
          targetUserId: null,
          routingMode: "parent_assignee_agent",
          escalatedAt: null,
          escalationReason: null,
        };
      }

      if (parent.assigneeUserId && parent.assigneeUserId !== issue.assigneeUserId) {
        return {
          targetAgentId: null,
          targetUserId: parent.assigneeUserId,
          routingMode: "parent_assignee_user",
          escalatedAt: null,
          escalationReason: null,
        };
      }
    }

    return {
      targetAgentId: null,
      targetUserId: null,
      routingMode: "board_pool",
      escalatedAt: null,
      escalationReason: null,
    };
  }),
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

const mockDocumentSvc = vi.hoisted(() => ({
  upsertIssueDocument: vi.fn(),
}));

const mockWorkProductSvc = vi.hoisted(() => ({
  createForIssue: vi.fn(),
}));

const mockRoutineSvc = vi.hoisted(() => ({
  syncRunStatusForIssue: vi.fn(),
}));

const mockStorage = vi.hoisted(() => ({
  provider: "local",
  putFile: vi.fn(),
  getObject: vi.fn(),
  headObject: vi.fn(),
  deleteObject: vi.fn(),
}));

// ── Flat mock of services barrel — no importOriginal, no drizzle loaded ─────
vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueSvc,
  agentService: () => mockAgentSvc,
  accessService: () => mockAccessSvc,
  heartbeatService: () => mockHeartbeat,
  logActivity: mockLogActivity,
  instanceSettingsService: () => mockInstanceSettings,
  projectService: () => mockProjectSvc,
  approvalService: () => mockApprovalSvc,
  executionWorkspaceService: () => ({}),
  feedbackService: () => ({}),
  goalService: () => ({}),
  issueApprovalService: () => mockIssueApprovalSvc,
  documentService: () => mockDocumentSvc,
  routineService: () => mockRoutineSvc,
  workProductService: () => mockWorkProductSvc,
  defaultWorkPlanApprovalRouting: mockApprovalRouting.defaultWorkPlanApprovalRouting,
  canActorResolveApproval: mockApprovalRouting.canActorResolveApproval,
  approvalDecisionActor: mockApprovalRouting.approvalDecisionActor,
}));

// ── Stable UUIDs for the test run ───────────────────────────────────────────
const AGENT_ASSIGNEE = randomUUID();
const AGENT_MANAGER  = randomUUID();
const AGENT_PARENT   = randomUUID();
const ISSUE_ID       = randomUUID();
const PARENT_ID      = randomUUID();
const COMPANY_ID     = "00000000-0000-0000-0000-000000000001";

// ── Shared issue fixture ────────────────────────────────────────────────────
function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE_ID,
    companyId: COMPANY_ID,
    status: "todo",
    assigneeAgentId: AGENT_ASSIGNEE,
    parentId: null as string | null,
    planProposedAt: null as Date | null,
    planApprovedAt: null as Date | null,
    identifier: "PC-1",
    originKind: "manual",
    projectId: null,
    goalId: null,
    checkoutRunId: null,
    labels: [],
    ...overrides,
  };
}

// ── Actor factories ─────────────────────────────────────────────────────────
function agentActor(agentId: string, runId = randomUUID()) {
  return {
    type: "agent",
    actorType: "agent",
    actorId: agentId,
    agentId,
    companyId: COMPANY_ID,
    companyIds: [COMPANY_ID],
    runId,
    source: "agent_key",
    isInstanceAdmin: false,
  };
}

// local_implicit Board actor — assertCanAssignTasks returns immediately, no DB calls
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

// ── App factory ─────────────────────────────────────────────────────────────
function makeApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes({} as any, mockStorage as any, {}));
  app.use(errorHandler);
  return app;
}

// ── Tests ───────────────────────────────────────────────────────────────────
describe("Propose-Plan & Checkout Gate Workflow", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Restore defaults after clearAllMocks
    mockHeartbeat.wakeup.mockResolvedValue(undefined);
    mockHeartbeat.reportRunActivity.mockResolvedValue(undefined);
    mockApprovalSvc.create.mockResolvedValue({
      id: randomUUID(),
      companyId: COMPANY_ID,
      type: "work_plan",
      status: "pending",
      payload: {},
    });
    mockApprovalSvc.getById.mockResolvedValue({
      id: randomUUID(),
      companyId: COMPANY_ID,
      type: "work_plan",
      status: "pending",
      payload: {},
    });
    mockApprovalSvc.approve.mockResolvedValue({ approval: { id: randomUUID(), status: "approved" }, applied: true });
    mockApprovalSvc.reject.mockResolvedValue({ approval: { id: randomUUID(), status: "rejected" }, applied: true });
    mockApprovalSvc.resubmit.mockResolvedValue(undefined);
    mockIssueApprovalSvc.listApprovalsForIssue.mockResolvedValue([]);
    mockIssueApprovalSvc.linkManyForApproval.mockResolvedValue(undefined);
    mockIssueApprovalSvc.getLiveWorkPlanApprovalForIssue.mockResolvedValue({
      id: randomUUID(),
      type: "work_plan",
      status: "pending",
      targetAgentId: null,
      targetUserId: null,
      routingMode: "board_pool",
    });
    mockLogActivity.mockResolvedValue(undefined);
    mockInstanceSettings.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
    mockProjectSvc.getById.mockResolvedValue(null);
    mockIssueSvc.getAncestors.mockResolvedValue([]);
    mockIssueSvc.addComment.mockResolvedValue({ id: randomUUID() });
    mockIssueSvc.proposePlan.mockResolvedValue({
      issue: makeIssue({
        planProposedAt: new Date("2026-04-12T12:00:00.000Z"),
      }),
      comment: { id: randomUUID() },
      approval: {
        id: randomUUID(),
        companyId: COMPANY_ID,
        type: "work_plan",
        status: "pending",
        payload: {},
      },
    });
    mockIssueSvc.approvePlan.mockResolvedValue({
      issue: makeIssue({
        planApprovedAt: new Date("2026-04-12T12:00:00.000Z"),
      }),
      approval: {
        id: randomUUID(),
        companyId: COMPANY_ID,
        type: "work_plan",
        status: "approved",
        payload: {},
      },
    });
    mockIssueSvc.rejectPlan.mockResolvedValue({
      issue: makeIssue({
        planProposedAt: null,
        planApprovedAt: null,
      }),
      approval: {
        id: randomUUID(),
        companyId: COMPANY_ID,
        type: "work_plan",
        status: "rejected",
        payload: {},
      },
    });
    mockAccessSvc.hasPermission.mockResolvedValue(false);
    mockAccessSvc.canUser.mockResolvedValue(false);
    mockApprovalSvc.create.mockResolvedValue({
      id: randomUUID(),
      companyId: COMPANY_ID,
      type: "work_plan",
      status: "pending",
      payload: {},
      targetAgentId: null,
      targetUserId: null,
      routingMode: "board_pool",
    });
    mockApprovalSvc.approve.mockResolvedValue({
      approval: { id: randomUUID(), status: "approved" },
      applied: true,
    });
    mockApprovalSvc.reject.mockResolvedValue({
      approval: { id: randomUUID(), status: "rejected" },
      applied: true,
    });
    mockIssueApprovalSvc.listApprovalsForIssue.mockResolvedValue([]);
    mockIssueApprovalSvc.linkManyForApproval.mockResolvedValue(undefined);
    mockDocumentSvc.upsertIssueDocument.mockResolvedValue({
      document: {
        id: randomUUID(),
        issueId: ISSUE_ID,
        key: "requirements",
        title: "Requirements",
        format: "markdown",
        latestRevisionNumber: 1,
      },
      created: true,
    });
    mockWorkProductSvc.createForIssue.mockResolvedValue({
      id: randomUUID(),
      issueId: ISSUE_ID,
      type: "document",
      provider: "paperclip",
    });
    mockStorage.putFile.mockResolvedValue({
      provider: "local",
      objectKey: `issues/${ISSUE_ID}/notes.txt`,
      contentType: "text/plain",
      byteSize: 5,
      sha256: "abc123",
      originalFilename: "notes.txt",
    });
    mockStorage.getObject.mockResolvedValue({
      stream: null,
      contentType: "text/plain",
      contentLength: 5,
    });
    mockStorage.headObject.mockResolvedValue({ exists: true, contentType: "text/plain", contentLength: 5 });
    mockStorage.deleteObject.mockResolvedValue(undefined);
    mockIssueSvc.createAttachment.mockResolvedValue({
      id: randomUUID(),
      issueId: ISSUE_ID,
      companyId: COMPANY_ID,
      provider: "local",
      objectKey: `issues/${ISSUE_ID}/notes.txt`,
      contentType: "text/plain",
      byteSize: 5,
      sha256: "abc123",
      originalFilename: "notes.txt",
    });
    mockIssueSvc.getAttachmentById.mockResolvedValue({
      id: randomUUID(),
      issueId: ISSUE_ID,
      companyId: COMPANY_ID,
      objectKey: `issues/${ISSUE_ID}/notes.txt`,
      contentType: "text/plain",
      byteSize: 5,
      originalFilename: "notes.txt",
    });
    mockIssueSvc.removeAttachment.mockResolvedValue({
      id: randomUUID(),
      issueId: ISSUE_ID,
      companyId: COMPANY_ID,
    });
    mockRoutineSvc.syncRunStatusForIssue.mockResolvedValue(undefined);
  });

  // 1. No planProposedAt → checkout is not blocked
  it("allows checkout if issue has not explicitly proposed a plan yet (legacy / opt-in)", async () => {
    const issue = makeIssue({ assigneeAgentId: AGENT_ASSIGNEE });
    mockIssueSvc.getById.mockResolvedValue(issue);
    mockIssueSvc.checkout.mockResolvedValue({ ...issue, status: "in_progress" });
    mockIssueSvc.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });

    const res = await request(makeApp(agentActor(AGENT_ASSIGNEE)))
      .post(`/api/issues/${ISSUE_ID}/checkout`)
      .send({ agentId: AGENT_ASSIGNEE, expectedStatuses: ["todo"] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("in_progress");
  });

  it("records an explicit status activity when checkout resumes a blocked issue", async () => {
    const issue = makeIssue({ assigneeAgentId: AGENT_ASSIGNEE, status: "blocked" });
    const updated = makeIssue({ ...issue, status: "in_progress" });
    mockIssueSvc.getById.mockResolvedValue(issue);
    mockIssueSvc.checkout.mockResolvedValue(updated);

    const res = await request(makeApp(agentActor(AGENT_ASSIGNEE)))
      .post(`/api/issues/${ISSUE_ID}/checkout`)
      .send({ agentId: AGENT_ASSIGNEE, expectedStatuses: ["blocked"] });

    expect(res.status).toBe(200);
    expect(mockLogActivity).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        action: "issue.checked_out",
        entityId: ISSUE_ID,
        details: expect.objectContaining({
          status: "in_progress",
          source: "checkout",
          _previous: { status: "blocked" },
        }),
      }),
    );
  });

  it("records an explicit status activity when release moves an issue back to todo", async () => {
    const issue = makeIssue({
      assigneeAgentId: AGENT_ASSIGNEE,
      status: "in_progress",
      checkoutRunId: "run-1",
    });
    const updated = makeIssue({
      ...issue,
      status: "todo",
      assigneeAgentId: null,
      checkoutRunId: null,
    });
    mockIssueSvc.getById.mockResolvedValue(issue);
    mockIssueSvc.release.mockResolvedValue(updated);
    mockIssueSvc.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });

    const res = await request(makeApp(agentActor(AGENT_ASSIGNEE, "run-1")))
      .post(`/api/issues/${ISSUE_ID}/release`)
      .send({});

    expect(res.status).toBe(200);
    expect(mockLogActivity).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        action: "issue.released",
        entityId: ISSUE_ID,
        details: expect.objectContaining({
          status: "todo",
          source: "release",
          _previous: { status: "in_progress" },
        }),
      }),
    );
  });

  it("blocks checkout for an assigned child issue until its plan is approved", async () => {
    const issue = makeIssue({
      assigneeAgentId: AGENT_ASSIGNEE,
      parentId: PARENT_ID,
      status: "todo",
      planProposedAt: null,
      planApprovedAt: null,
    });
    mockIssueSvc.getById.mockResolvedValue(issue);

    const res = await request(makeApp(agentActor(AGENT_ASSIGNEE)))
      .post(`/api/issues/${ISSUE_ID}/checkout`)
      .send({ agentId: AGENT_ASSIGNEE, expectedStatuses: ["todo"] });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/must propose a plan and get it approved before checkout/i);
    expect(mockIssueSvc.checkout).not.toHaveBeenCalled();
  });

  it("allows checkout for a routine_execution child issue without a work plan", async () => {
    const issue = makeIssue({
      assigneeAgentId: AGENT_ASSIGNEE,
      parentId: PARENT_ID,
      originKind: "routine_execution",
      status: "todo",
      planProposedAt: null,
      planApprovedAt: null,
    });
    mockIssueSvc.getById.mockResolvedValue(issue);
    mockIssueSvc.checkout.mockResolvedValue(makeIssue({
      ...issue,
      status: "in_progress",
      checkoutRunId: "run-1",
    }));

    const res = await request(makeApp(agentActor(AGENT_ASSIGNEE)))
      .post(`/api/issues/${ISSUE_ID}/checkout`)
      .send({ agentId: AGENT_ASSIGNEE, expectedStatuses: ["todo"] });

    expect(res.status).toBe(200);
    expect(mockIssueSvc.checkout).toHaveBeenCalled();
  });

  it("allows checkout for a child issue inside a routine_execution ancestor lane without a work plan", async () => {
    const issue = makeIssue({
      assigneeAgentId: AGENT_ASSIGNEE,
      parentId: PARENT_ID,
      originKind: "manual",
      status: "todo",
      planProposedAt: null,
      planApprovedAt: null,
    });
    mockIssueSvc.getById.mockResolvedValue(issue);
    mockIssueSvc.getAncestors.mockResolvedValue([
      makeIssue({
        id: PARENT_ID,
        originKind: "routine_execution",
        originId: "routine-1",
      }),
    ]);
    mockIssueSvc.checkout.mockResolvedValue(makeIssue({
      ...issue,
      status: "in_progress",
      checkoutRunId: "run-1",
    }));

    const res = await request(makeApp(agentActor(AGENT_ASSIGNEE)))
      .post(`/api/issues/${ISSUE_ID}/checkout`)
      .send({ agentId: AGENT_ASSIGNEE, expectedStatuses: ["todo"] });

    expect(res.status).toBe(200);
    expect(mockIssueSvc.checkout).toHaveBeenCalled();
  });

  it("blocks child issue document writes until the plan is approved", async () => {
    const issue = makeIssue({
      assigneeAgentId: AGENT_ASSIGNEE,
      parentId: PARENT_ID,
      status: "todo",
      planProposedAt: null,
      planApprovedAt: null,
    });
    mockIssueSvc.getById.mockResolvedValue(issue);

    const res = await request(makeApp(agentActor(AGENT_ASSIGNEE)))
      .put(`/api/issues/${ISSUE_ID}/documents/requirements`)
      .send({
        title: "Requirements",
        format: "markdown",
        body: "# Draft",
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/must propose a plan and get it approved before writing issue documents/i);
    expect(mockDocumentSvc.upsertIssueDocument).not.toHaveBeenCalled();
  });

  it("blocks child issue work-product creation until the plan is approved", async () => {
    const issue = makeIssue({
      assigneeAgentId: AGENT_ASSIGNEE,
      parentId: PARENT_ID,
      status: "todo",
      planProposedAt: null,
      planApprovedAt: null,
    });
    mockIssueSvc.getById.mockResolvedValue(issue);

    const res = await request(makeApp(agentActor(AGENT_ASSIGNEE)))
      .post(`/api/issues/${ISSUE_ID}/work-products`)
      .send({
        type: "document",
        provider: "paperclip",
        title: "Execution Notes",
        status: "active",
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/must propose a plan and get it approved before creating work products/i);
    expect(mockWorkProductSvc.createForIssue).not.toHaveBeenCalled();
  });

  it("blocks child issue attachment uploads until the plan is approved", async () => {
    const issue = makeIssue({
      assigneeAgentId: AGENT_ASSIGNEE,
      parentId: PARENT_ID,
      status: "todo",
      planProposedAt: null,
      planApprovedAt: null,
    });
    mockIssueSvc.getById.mockResolvedValue(issue);

    const res = await request(makeApp(agentActor(AGENT_ASSIGNEE)))
      .post(`/api/companies/${COMPANY_ID}/issues/${ISSUE_ID}/attachments`)
      .attach("file", Buffer.from("hello"), { filename: "notes.txt", contentType: "text/plain" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/must propose a plan and get it approved before uploading attachments/i);
    expect(mockStorage.putFile).not.toHaveBeenCalled();
    expect(mockIssueSvc.createAttachment).not.toHaveBeenCalled();
  });

  it("blocks child issue attachment deletes until the plan is approved", async () => {
    const issue = makeIssue({
      assigneeAgentId: AGENT_ASSIGNEE,
      parentId: PARENT_ID,
      status: "todo",
      planProposedAt: null,
      planApprovedAt: null,
    });
    mockIssueSvc.getAttachmentById.mockResolvedValue({
      id: randomUUID(),
      issueId: ISSUE_ID,
      companyId: COMPANY_ID,
      objectKey: `issues/${ISSUE_ID}/notes.txt`,
      contentType: "text/plain",
      byteSize: 5,
      originalFilename: "notes.txt",
    });
    mockIssueSvc.getById.mockResolvedValue(issue);

    const res = await request(makeApp(agentActor(AGENT_ASSIGNEE)))
      .delete(`/api/attachments/${randomUUID()}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/must propose a plan and get it approved before deleting attachments/i);
    expect(mockStorage.deleteObject).not.toHaveBeenCalled();
    expect(mockIssueSvc.removeAttachment).not.toHaveBeenCalled();
  });

  it("allows attachment uploads after a child issue plan is approved", async () => {
    const issue = makeIssue({
      assigneeAgentId: AGENT_ASSIGNEE,
      parentId: PARENT_ID,
      status: "todo",
      planProposedAt: new Date(),
      planApprovedAt: new Date(),
    });
    const attachmentId = randomUUID();
    mockIssueSvc.getById.mockResolvedValue(issue);
    mockIssueSvc.createAttachment.mockResolvedValue({
      id: attachmentId,
      issueId: ISSUE_ID,
      companyId: COMPANY_ID,
      provider: "local",
      objectKey: `issues/${ISSUE_ID}/notes.txt`,
      contentType: "text/plain",
      byteSize: 5,
      sha256: "abc123",
      originalFilename: "notes.txt",
    });

    const res = await request(makeApp(agentActor(AGENT_ASSIGNEE)))
      .post(`/api/companies/${COMPANY_ID}/issues/${ISSUE_ID}/attachments`)
      .attach("file", Buffer.from("hello"), { filename: "notes.txt", contentType: "text/plain" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(attachmentId);
    expect(mockStorage.putFile).toHaveBeenCalled();
    expect(mockIssueSvc.createAttachment).toHaveBeenCalled();
  });

  it("blocks agent hiddenAt updates on child issues until the plan is approved", async () => {
    const issue = makeIssue({
      assigneeAgentId: AGENT_ASSIGNEE,
      parentId: PARENT_ID,
      status: "todo",
      planProposedAt: null,
      planApprovedAt: null,
    });
    mockIssueSvc.getById.mockResolvedValue(issue);

    const res = await request(makeApp(agentActor(AGENT_ASSIGNEE)))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ hiddenAt: "2026-04-08T01:00:00.000Z" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/must propose a plan and get it approved before updating issue fields/i);
    expect(mockIssueSvc.update).not.toHaveBeenCalled();
  });

  it("blocks agent reopen-via-patch when that reopen would mutate fields before plan approval", async () => {
    const issue = makeIssue({
      assigneeAgentId: AGENT_ASSIGNEE,
      parentId: PARENT_ID,
      status: "done",
      planProposedAt: null,
      planApprovedAt: null,
    });
    mockIssueSvc.getById.mockResolvedValue(issue);

    const res = await request(makeApp(agentActor(AGENT_ASSIGNEE)))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({
        comment: "Need to reopen this.",
        reopen: true,
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/must propose a plan and get it approved before updating issue fields/i);
    expect(mockIssueSvc.update).not.toHaveBeenCalled();
    expect(mockIssueSvc.addComment).not.toHaveBeenCalled();
  });

  // 2. Non-assignee agent cannot propose
  it("forbids non-assignee agents from proposing a plan on another's issue", async () => {
    const issue = makeIssue({ assigneeAgentId: AGENT_ASSIGNEE });
    mockIssueSvc.getById.mockResolvedValue(issue);

    const res = await request(makeApp(agentActor(AGENT_MANAGER)))
      .post(`/api/issues/${ISSUE_ID}/propose-plan`)
      .send({ plan: "I will steal this task." });

    expect(res.status).toBe(403);
  });

  it("moves the issue into in_review lifecycle when proposing a plan, and exposes pending review runtime state", async () => {
    const issue = makeIssue({ assigneeAgentId: AGENT_ASSIGNEE });
    const commentId = randomUUID();
    const approvalId = randomUUID();
    const updated = makeIssue({
      ...issue,
      status: "in_review",
      planProposedAt: new Date("2026-04-12T12:00:00.000Z"),
    });

    mockIssueSvc.getById.mockResolvedValue(issue);
    mockIssueSvc.proposePlan.mockResolvedValue({
      issue: updated,
      comment: { id: commentId },
      approval: {
        id: approvalId,
        companyId: COMPANY_ID,
        type: "work_plan",
        status: "pending",
        payload: {},
      },
    });

    const res = await request(makeApp(agentActor(AGENT_ASSIGNEE)))
      .post(`/api/issues/${ISSUE_ID}/propose-plan`)
      .send({ plan: "Ship the implementation in three checkpoints." });

    expect(res.status).toBe(201);
    expect(res.body.issue.status).toBe("in_review");
    expect(res.body.issue.runtimeState).toEqual(expect.objectContaining({
      lifecycle: expect.objectContaining({ status: "in_review" }),
      review: expect.objectContaining({
        state: "pending",
        kind: "work_plan",
      }),
      execution: expect.objectContaining({
        state: "idle",
        activation: "awaiting_review",
        diagnosis: "plan_review_pending",
        canStart: false,
      }),
    }));
    expect(res.body.comment.id).toBe(commentId);
    expect(res.body.approvalId).toBe(approvalId);
    expect(mockIssueSvc.proposePlan).toHaveBeenCalledWith(
      ISSUE_ID,
      expect.objectContaining({
        planText: "Ship the implementation in three checkpoints.",
        actor: expect.objectContaining({
          actorType: "agent",
          actorId: AGENT_ASSIGNEE,
          agentId: AGENT_ASSIGNEE,
        }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.plan_proposed",
        entityId: ISSUE_ID,
      }),
    );
  });

  it("wakes parent and root assignees after a successful child plan proposal", async () => {
    const issue = makeIssue({
      assigneeAgentId: AGENT_ASSIGNEE,
      parentId: PARENT_ID,
      status: "todo",
    });
    const parent = makeIssue({
      id: PARENT_ID,
      assigneeAgentId: AGENT_PARENT,
      assigneeUserId: null,
    });
    const root = makeIssue({
      id: randomUUID(),
      assigneeAgentId: AGENT_MANAGER,
    });

    mockIssueSvc.getById
      .mockResolvedValueOnce(issue)
      .mockResolvedValueOnce(parent);
    mockIssueSvc.getAncestors.mockResolvedValue([parent, root]);

    const res = await request(makeApp(agentActor(AGENT_ASSIGNEE)))
      .post(`/api/issues/${ISSUE_ID}/propose-plan`)
      .send({ plan: "Plan body" });

    expect(res.status).toBe(201);
    await vi.waitFor(() => {
      expect(mockHeartbeat.wakeup).toHaveBeenCalledTimes(2);
    });
    expect(mockHeartbeat.wakeup).toHaveBeenCalledWith(
      AGENT_PARENT,
      expect.objectContaining({
        reason: "child_plan_proposed",
        payload: expect.objectContaining({
          issueId: PARENT_ID,
          childIssueId: ISSUE_ID,
        }),
      }),
    );
    expect(mockHeartbeat.wakeup).toHaveBeenCalledWith(
      AGENT_MANAGER,
      expect.objectContaining({
        reason: "child_plan_proposed",
        payload: expect.objectContaining({
          childIssueId: ISSUE_ID,
        }),
      }),
    );
  });

  it("does not fail the plan proposal when the root summary comment side effect throws", async () => {
    const issue = makeIssue({ assigneeAgentId: AGENT_ASSIGNEE });
    const commentId = randomUUID();
    const approvalId = randomUUID();
    const rootAncestor = makeIssue({ id: PARENT_ID, identifier: "PC-ROOT", assigneeAgentId: AGENT_PARENT });
    const updated = makeIssue({
      ...issue,
      status: "in_review",
      planProposedAt: new Date("2026-04-12T12:05:00.000Z"),
    });

    mockIssueSvc.getById.mockResolvedValue(issue);
    mockIssueSvc.getAncestors.mockResolvedValue([rootAncestor]);
    mockIssueSvc.proposePlan.mockResolvedValue({
      issue: updated,
      comment: { id: commentId },
      approval: {
        id: approvalId,
        companyId: COMPANY_ID,
        type: "work_plan",
        status: "pending",
        payload: {},
      },
    });
    mockIssueSvc.addComment
      .mockRejectedValueOnce(new Error("root summary comment failed"));
    mockAgentSvc.getById.mockResolvedValue({ id: AGENT_ASSIGNEE, name: "Frontend Engineer" });

    const res = await request(makeApp(agentActor(AGENT_ASSIGNEE)))
      .post(`/api/issues/${ISSUE_ID}/propose-plan`)
      .send({ plan: "Checkpoint one, checkpoint two, checkpoint three." });

    expect(res.status).toBe(201);
    expect(res.body.approvalId).toBe(approvalId);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.plan_proposed",
        entityId: ISSUE_ID,
      }),
    );
  });

  it("does not fail the plan proposal when activity logging throws after the core writes succeed", async () => {
    const issue = makeIssue({ assigneeAgentId: AGENT_ASSIGNEE });
    const commentId = randomUUID();
    const approvalId = randomUUID();
    const updated = makeIssue({
      ...issue,
      status: "in_review",
      planProposedAt: new Date("2026-04-12T12:10:00.000Z"),
    });

    mockIssueSvc.getById.mockResolvedValue(issue);
    mockIssueSvc.proposePlan.mockResolvedValue({
      issue: updated,
      comment: { id: commentId },
      approval: {
        id: approvalId,
        companyId: COMPANY_ID,
        type: "work_plan",
        status: "pending",
        payload: {},
      },
    });
    mockLogActivity.mockRejectedValue(new Error("activity log unavailable"));

    const res = await request(makeApp(agentActor(AGENT_ASSIGNEE)))
      .post(`/api/issues/${ISSUE_ID}/propose-plan`)
      .send({ plan: "Capture the plan even if telemetry is degraded." });

    expect(res.status).toBe(201);
    expect(res.body.comment.id).toBe(commentId);
    expect(res.body.approvalId).toBe(approvalId);
  });
  // 3. planProposedAt set → checkout blocked regardless of lifecycle status
  it("blocks checkout if a plan has been proposed but not approved, even without in_review lifecycle", async () => {
    const issue = makeIssue({
      assigneeAgentId: AGENT_ASSIGNEE,
      status: "in_progress",
      planProposedAt: new Date(),
    });
    mockIssueSvc.getById.mockResolvedValue(issue);

    const res = await request(makeApp(agentActor(AGENT_ASSIGNEE)))
      .post(`/api/issues/${ISSUE_ID}/checkout`)
      .send({ agentId: AGENT_ASSIGNEE, expectedStatuses: ["in_progress"] });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/must be approved before checkout/);
  });

  // 4. Assignee cannot self-approve
  it("forbids an assignee from self-approving their own plan", async () => {
    const issue = makeIssue({
      assigneeAgentId: AGENT_ASSIGNEE,
      status: "in_review",
      planProposedAt: new Date(),
    });
    mockIssueSvc.getById.mockResolvedValue(issue);
    mockAgentSvc.getById.mockResolvedValue({
      id: AGENT_ASSIGNEE,
      companyId: COMPANY_ID,
      permissions: {},
    });

    const res = await request(makeApp(agentActor(AGENT_ASSIGNEE)))
      .post(`/api/issues/${ISSUE_ID}/approve-plan`)
      .send();

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/self-approval forbidden/);
  });

  // 5. Legacy manager rights no longer bypass an explicitly routed lead approval
  it("forbids a manager agent from approving a child plan when the approval is routed to the parent assignee", async () => {
    const issue = makeIssue({
      assigneeAgentId: AGENT_ASSIGNEE,
      parentId: PARENT_ID,
      status: "in_review",
      planProposedAt: new Date(),
    });
    const parent = makeIssue({ id: PARENT_ID, assigneeAgentId: AGENT_PARENT });

    mockIssueSvc.getById
      .mockResolvedValueOnce(issue)
      .mockResolvedValueOnce(parent);
    mockAgentSvc.getById.mockResolvedValue({
      id: AGENT_MANAGER,
      companyId: COMPANY_ID,
      name: "ManagerAgent",
      permissions: { canCreateAgents: true },
    });
    mockIssueApprovalSvc.getLiveWorkPlanApprovalForIssue.mockResolvedValue({
      id: randomUUID(),
      type: "work_plan",
      status: "pending",
      targetAgentId: AGENT_PARENT,
      targetUserId: null,
      routingMode: "parent_assignee_agent",
    });

    const res = await request(makeApp(agentActor(AGENT_MANAGER)))
      .post(`/api/issues/${ISSUE_ID}/approve-plan`)
      .send();

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/target approver/i);
  });

  it("includes the approval comment when waking the assignee after plan approval", async () => {
    const issue = makeIssue({
      assigneeAgentId: AGENT_ASSIGNEE,
      status: "in_review",
      planProposedAt: new Date(),
    });
    const updated = makeIssue({ ...issue, status: "todo", planApprovedAt: new Date() });
    const approvalCommentId = randomUUID();

    mockIssueSvc.getById.mockResolvedValue(issue);
    mockIssueSvc.approvePlan.mockResolvedValue({
      issue: updated,
      approval: { id: randomUUID(), status: "approved" },
    });
    mockIssueSvc.addComment.mockResolvedValueOnce({ id: approvalCommentId });

    const res = await request(makeApp(boardActor()))
      .post(`/api/issues/${ISSUE_ID}/approve-plan`)
      .send();

    expect(res.status).toBe(200);
    expect(mockHeartbeat.wakeup).toHaveBeenCalledWith(
      AGENT_ASSIGNEE,
      expect.objectContaining({
        reason: "plan_approved",
        payload: expect.objectContaining({
          issueId: ISSUE_ID,
          commentId: approvalCommentId,
        }),
        contextSnapshot: expect.objectContaining({
          issueId: ISSUE_ID,
          taskId: ISSUE_ID,
          commentId: approvalCommentId,
          wakeCommentId: approvalCommentId,
          wakeReason: "plan_approved",
          source: "issue.plan_approved",
        }),
      }),
    );
  });

  // 6. Parent issue's assignee can approve child plan
  it("allows parent issue assignee to approve a plan", async () => {
    const issue = makeIssue({
      assigneeAgentId: AGENT_ASSIGNEE,
      parentId: PARENT_ID,
      status: "in_review",
      planProposedAt: new Date(),
    });
    const parent = makeIssue({ id: PARENT_ID, assigneeAgentId: AGENT_PARENT });
    const updated = { ...issue, status: "todo", planApprovedAt: new Date() };

    mockIssueSvc.getById
      .mockResolvedValueOnce(issue)   // first call: the issue
      .mockResolvedValueOnce(parent); // second call: the parent issue
    mockIssueSvc.approvePlan.mockResolvedValue({
      issue: updated,
      approval: { id: randomUUID(), status: "approved" },
    });
    mockAgentSvc.getById.mockResolvedValue({
      id: AGENT_PARENT,
      companyId: COMPANY_ID,
      name: "ParentAgent",
      permissions: {},
    });
    mockIssueApprovalSvc.getLiveWorkPlanApprovalForIssue.mockResolvedValue({
      id: randomUUID(),
      type: "work_plan",
      status: "pending",
      targetAgentId: AGENT_PARENT,
      targetUserId: null,
      routingMode: "parent_assignee_agent",
    });

    const res = await request(makeApp(agentActor(AGENT_PARENT)))
      .post(`/api/issues/${ISSUE_ID}/approve-plan`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.issue.status).toBe("todo");
    expect(res.body.issue.runtimeState).toEqual(expect.objectContaining({
      lifecycle: expect.objectContaining({ status: "todo" }),
      review: expect.objectContaining({ state: "approved" }),
      execution: expect.objectContaining({
        activation: "runnable",
        canStart: true,
      }),
    }));
  });

  // 7. Board can no longer short-circuit a child plan that is routed to its lead
  it("forbids Board from approving a child plan that is explicitly routed to the parent assignee", async () => {
    const issue = makeIssue({
      assigneeAgentId: AGENT_ASSIGNEE,
      parentId: PARENT_ID,
      status: "in_review",
      planProposedAt: new Date(),
    });
    const parent = makeIssue({ id: PARENT_ID, assigneeAgentId: AGENT_PARENT });

    mockIssueSvc.getById
      .mockResolvedValueOnce(issue)
      .mockResolvedValueOnce(parent);
    mockIssueApprovalSvc.getLiveWorkPlanApprovalForIssue.mockResolvedValue({
      id: randomUUID(),
      type: "work_plan",
      status: "pending",
      targetAgentId: AGENT_PARENT,
      targetUserId: null,
      routingMode: "parent_assignee_agent",
    });

    const res = await request(makeApp(boardActor()))
      .post(`/api/issues/${ISSUE_ID}/approve-plan`)
      .send();

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/target approver/i);
  });

  it("still allows Board to approve a root issue plan routed to the board pool", async () => {
    const issue = makeIssue({
      assigneeAgentId: AGENT_ASSIGNEE,
      status: "in_review",
      planProposedAt: new Date(),
    });
    const updated = { ...issue, status: "todo", planApprovedAt: new Date() };

    mockIssueSvc.getById.mockResolvedValue(issue);
    mockIssueSvc.approvePlan.mockResolvedValue({
      issue: updated,
      approval: { id: randomUUID(), status: "approved" },
    });
    mockIssueApprovalSvc.getLiveWorkPlanApprovalForIssue.mockResolvedValue({
      id: randomUUID(),
      type: "work_plan",
      status: "pending",
      targetAgentId: null,
      targetUserId: null,
      routingMode: "board_pool",
    });

    const res = await request(makeApp(boardActor()))
      .post(`/api/issues/${ISSUE_ID}/approve-plan`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.issue.status).toBe("todo");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.plan_approved",
        entityId: ISSUE_ID,
      }),
    );
  });

  it("allows approving a pending root issue plan without requiring in_review lifecycle", async () => {
    const issue = makeIssue({
      assigneeAgentId: AGENT_ASSIGNEE,
      status: "todo",
      planProposedAt: new Date(),
    });
    const updated = { ...issue, status: "todo", planApprovedAt: new Date() };
    const liveApprovalId = randomUUID();

    mockIssueSvc.getById.mockResolvedValue(issue);
    mockIssueSvc.approvePlan.mockResolvedValue({
      issue: updated,
      approval: { id: liveApprovalId, status: "approved" },
    });
    mockIssueApprovalSvc.getLiveWorkPlanApprovalForIssue.mockResolvedValue({
      id: liveApprovalId,
      type: "work_plan",
      status: "pending",
      targetAgentId: null,
      targetUserId: null,
      routingMode: "board_pool",
    });

    const res = await request(makeApp(boardActor()))
      .post(`/api/issues/${ISSUE_ID}/approve-plan`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.issue.status).toBe("todo");
    expect(mockIssueSvc.approvePlan).toHaveBeenCalledWith(
      ISSUE_ID,
      expect.objectContaining({
        decisionNote: "Plan approved via issue review",
      }),
    );
  });

  it("fails closed when multiple live work plan approvals are linked", async () => {
    const issue = makeIssue({
      assigneeAgentId: AGENT_ASSIGNEE,
      status: "todo",
      planProposedAt: new Date(),
    });

    mockIssueSvc.getById.mockResolvedValue(issue);
    mockIssueApprovalSvc.getLiveWorkPlanApprovalForIssue.mockRejectedValue(
      new HttpError(422, "Issue has multiple live work plan approvals; manual repair required"),
    );

    const res = await request(makeApp(boardActor()))
      .post(`/api/issues/${ISSUE_ID}/approve-plan`)
      .send();

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/multiple live work plan approvals/i);
    expect(mockIssueSvc.approvePlan).not.toHaveBeenCalled();
  });

  it("fails closed when no live work plan approval exists for an approve request", async () => {
    const issue = makeIssue({
      assigneeAgentId: AGENT_ASSIGNEE,
      status: "todo",
      planProposedAt: new Date(),
    });

    mockIssueSvc.getById.mockResolvedValue(issue);
    mockIssueApprovalSvc.getLiveWorkPlanApprovalForIssue.mockResolvedValue(null);

    const res = await request(makeApp(boardActor()))
      .post(`/api/issues/${ISSUE_ID}/approve-plan`)
      .send();

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no live work plan approval/i);
    expect(mockIssueSvc.approvePlan).not.toHaveBeenCalled();
  });

  it("rejects approving a plan after execution has already started", async () => {
    const issue = makeIssue({
      assigneeAgentId: AGENT_ASSIGNEE,
      status: "in_progress",
      planProposedAt: new Date(),
      checkoutRunId: "run-1",
      executionRunId: "run-1",
    });
    mockIssueSvc.getById.mockResolvedValue(issue);

    const res = await request(makeApp(boardActor()))
      .post(`/api/issues/${ISSUE_ID}/approve-plan`)
      .send();

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/cannot approve a plan after execution has already started/i);
    expect(mockIssueSvc.approvePlan).not.toHaveBeenCalled();
  });


  // 1. Rejection enforces feedback
  it("reject-plan returns 400 when feedback body is missing", async () => {
    const res = await request(makeApp(boardActor()))
      .post(`/api/issues/${ISSUE_ID}/reject-plan`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing or invalid feedback/);
  });

  // 2. Rejection enforces status logic
  it("reject-plan preserves lifecycle status while clearing the pending review request", async () => {
    const issue = makeIssue({
      assigneeAgentId: AGENT_ASSIGNEE,
      status: "in_progress",
      planProposedAt: new Date(),
    });
    const updated = { ...issue, status: "in_progress", planProposedAt: null, planApprovedAt: null };

    mockIssueSvc.getById.mockResolvedValue(issue);
    mockIssueSvc.rejectPlan.mockResolvedValue({
      issue: updated,
      approval: { id: randomUUID(), status: "rejected" },
    });

    const res = await request(makeApp(boardActor()))
      .post(`/api/issues/${ISSUE_ID}/reject-plan`)
      .send({ feedback: "This is terrible, do it again." });

    expect(res.status).toBe(200);
    expect(res.body.issue.status).toBe("in_progress");
    expect(res.body.issue.planProposedAt).toBeNull();
    expect(res.body.issue.runtimeState).toEqual(expect.objectContaining({
      lifecycle: expect.objectContaining({ status: "in_progress" }),
      review: expect.objectContaining({ state: "none" }),
      execution: expect.objectContaining({
        activation: "runnable",
        canStart: true,
      }),
    }));
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.plan_rejected",
        entityId: ISSUE_ID,
      }),
    );
  });

  // 3. Rejection prohibits self-action
  it("forbids an assignee from self-rejecting their own plan", async () => {
    const issue = makeIssue({
      assigneeAgentId: AGENT_ASSIGNEE,
      status: "in_progress",
      planProposedAt: new Date(),
    });
    mockIssueSvc.getById.mockResolvedValue(issue);
    mockAgentSvc.getById.mockResolvedValue({
      id: AGENT_ASSIGNEE,
      companyId: COMPANY_ID,
      permissions: {},
    });

    const res = await request(makeApp(agentActor(AGENT_ASSIGNEE)))
      .post(`/api/issues/${ISSUE_ID}/reject-plan`)
      .send({ feedback: "I hate my own work" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/self-approval forbidden/);
  });

  // 4. Rejection triggers Wakeup Event
  it("reject-plan properly triggers wakeup system with rejection reason", async () => {
    const issue = makeIssue({
      assigneeAgentId: AGENT_ASSIGNEE,
      status: "in_progress",
      planProposedAt: new Date(),
    });
    const updated = { ...issue, status: "in_progress", planProposedAt: null, planApprovedAt: null };
    const rejectionCommentId = randomUUID();

    mockIssueSvc.getById.mockResolvedValue(issue);
    mockIssueSvc.rejectPlan.mockResolvedValue({
      issue: updated,
      approval: { id: randomUUID(), status: "rejected" },
    });
    mockIssueSvc.addComment.mockResolvedValueOnce({ id: rejectionCommentId });

    const res = await request(makeApp(boardActor()))
      .post(`/api/issues/${ISSUE_ID}/reject-plan`)
      .send({ feedback: "Try again" });

    expect(res.status).toBe(200);
    expect(mockHeartbeat.wakeup).toHaveBeenCalledWith(
      AGENT_ASSIGNEE,
      expect.objectContaining({
        reason: "plan_rejected",
        payload: expect.objectContaining({
          issueId: ISSUE_ID,
          commentId: rejectionCommentId,
        }),
        contextSnapshot: expect.objectContaining({
          issueId: ISSUE_ID,
          taskId: ISSUE_ID,
          commentId: rejectionCommentId,
          wakeCommentId: rejectionCommentId,
          wakeReason: "plan_rejected",
          source: "issue.plan_rejected",
        }),
      }),
    );
  });

  it("fails closed when no live work plan approval exists for a reject request", async () => {
    const issue = makeIssue({
      assigneeAgentId: AGENT_ASSIGNEE,
      status: "todo",
      planProposedAt: new Date(),
    });

    mockIssueSvc.getById.mockResolvedValue(issue);
    mockIssueApprovalSvc.getLiveWorkPlanApprovalForIssue.mockResolvedValue(null);

    const res = await request(makeApp(boardActor()))
      .post(`/api/issues/${ISSUE_ID}/reject-plan`)
      .send({ feedback: "repair this first" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no live work plan approval/i);
    expect(mockIssueSvc.rejectPlan).not.toHaveBeenCalled();
  });

  it("approve-plan still returns success when the review comment side effect fails after settlement", async () => {
    const issue = makeIssue({
      assigneeAgentId: AGENT_ASSIGNEE,
      status: "todo",
      planProposedAt: new Date(),
    });
    const updated = { ...issue, planApprovedAt: new Date() };

    mockIssueSvc.getById.mockResolvedValue(issue);
    mockIssueSvc.approvePlan.mockResolvedValue({
      issue: updated,
      approval: { id: randomUUID(), status: "approved" },
    });
    mockIssueSvc.addComment.mockRejectedValueOnce(new Error("comment insert failed"));

    const res = await request(makeApp(boardActor()))
      .post(`/api/issues/${ISSUE_ID}/approve-plan`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.issue.planApprovedAt).toBeTruthy();
    expect(mockHeartbeat.wakeup).toHaveBeenCalledWith(
      AGENT_ASSIGNEE,
      expect.objectContaining({
        reason: "plan_approved",
        payload: expect.not.objectContaining({
          commentId: expect.anything(),
        }),
      }),
    );
  });

  it("reject-plan still returns success when the review comment side effect fails after settlement", async () => {
    const issue = makeIssue({
      assigneeAgentId: AGENT_ASSIGNEE,
      status: "todo",
      planProposedAt: new Date(),
    });
    const updated = { ...issue, planProposedAt: null, planApprovedAt: null };

    mockIssueSvc.getById.mockResolvedValue(issue);
    mockIssueSvc.rejectPlan.mockResolvedValue({
      issue: updated,
      approval: { id: randomUUID(), status: "rejected" },
    });
    mockIssueSvc.addComment.mockRejectedValueOnce(new Error("comment insert failed"));

    const res = await request(makeApp(boardActor()))
      .post(`/api/issues/${ISSUE_ID}/reject-plan`)
      .send({ feedback: "Needs revision" });

    expect(res.status).toBe(200);
    expect(res.body.issue.planProposedAt).toBeNull();
    expect(mockHeartbeat.wakeup).toHaveBeenCalledWith(
      AGENT_ASSIGNEE,
      expect.objectContaining({
        reason: "plan_rejected",
        payload: expect.not.objectContaining({
          commentId: expect.anything(),
        }),
      }),
    );
  });
});

