import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

// ── Hoisted stubs (registered before any module loads) ─────────────────────
const mockIssueSvc = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  checkout: vi.fn(),
  addComment: vi.fn(),
  getAncestors: vi.fn(),
  assertCheckoutOwner: vi.fn(),
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

const mockLogActivity = vi.hoisted(() => vi.fn());

const mockInstanceSettings = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

const mockProjectSvc = vi.hoisted(() => ({
  getById: vi.fn(),
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
  executionWorkspaceService: () => ({}),
  feedbackService: () => ({}),
  goalService: () => ({}),
  issueApprovalService: () => ({}),
  documentService: () => ({}),
  routineService: () => ({}),
  workProductService: () => ({}),
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
  app.use("/api", issueRoutes({} as any, {} as any, {}));
  app.use(errorHandler);
  return app;
}

// ── Tests ───────────────────────────────────────────────────────────────────
describe("Propose-Plan & Checkout Gate Workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore defaults after clearAllMocks
    mockHeartbeat.wakeup.mockResolvedValue(undefined);
    mockHeartbeat.reportRunActivity.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
    mockInstanceSettings.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
    mockProjectSvc.getById.mockResolvedValue(null);
    mockIssueSvc.getAncestors.mockResolvedValue([]);
    mockIssueSvc.addComment.mockResolvedValue({ id: randomUUID() });
    mockAccessSvc.hasPermission.mockResolvedValue(false);
    mockAccessSvc.canUser.mockResolvedValue(false);
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

  // 2. Non-assignee agent cannot propose
  it("forbids non-assignee agents from proposing a plan on another's issue", async () => {
    const issue = makeIssue({ assigneeAgentId: AGENT_ASSIGNEE });
    mockIssueSvc.getById.mockResolvedValue(issue);

    const res = await request(makeApp(agentActor(AGENT_MANAGER)))
      .post(`/api/issues/${ISSUE_ID}/propose-plan`)
      .send({ plan: "I will steal this task." });

    expect(res.status).toBe(403);
  });

  // 3. planProposedAt set + in_review → checkout blocked
  it("blocks checkout if a plan has been proposed but not approved (in_review)", async () => {
    const issue = makeIssue({
      assigneeAgentId: AGENT_ASSIGNEE,
      status: "in_review",
      planProposedAt: new Date(),
    });
    mockIssueSvc.getById.mockResolvedValue(issue);

    const res = await request(makeApp(agentActor(AGENT_ASSIGNEE)))
      .post(`/api/issues/${ISSUE_ID}/checkout`)
      .send({ agentId: AGENT_ASSIGNEE, expectedStatuses: ["in_review"] });

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

  // 5. Manager agent with canCreateAgents (legacy tasks:assign) can approve
  it("allows a manager agent (canCreateAgents) to approve a plan", async () => {
    const issue = makeIssue({
      assigneeAgentId: AGENT_ASSIGNEE,
      status: "in_review",
      planProposedAt: new Date(),
    });
    const updated = makeIssue({ ...issue, status: "todo", planApprovedAt: new Date() });

    mockIssueSvc.getById.mockResolvedValue(issue);
    mockIssueSvc.update.mockResolvedValue(updated);
    mockAgentSvc.getById.mockResolvedValue({
      id: AGENT_MANAGER,
      companyId: COMPANY_ID,
      name: "ManagerAgent",
      permissions: { canCreateAgents: true },
    });

    const res = await request(makeApp(agentActor(AGENT_MANAGER)))
      .post(`/api/issues/${ISSUE_ID}/approve-plan`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.issue.status).toBe("todo");
    expect(res.body.issue.planApprovedAt).toBeDefined();
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
    mockIssueSvc.update.mockResolvedValue(updated);
    mockAgentSvc.getById.mockResolvedValue({
      id: AGENT_PARENT,
      companyId: COMPANY_ID,
      name: "ParentAgent",
      permissions: {},
    });

    const res = await request(makeApp(agentActor(AGENT_PARENT)))
      .post(`/api/issues/${ISSUE_ID}/approve-plan`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.issue.status).toBe("todo");
  });

  // 7. Board user (local_implicit) can always approve without any DB checks
  it("allows Board (implicit company access) to approve a plan", async () => {
    const issue = makeIssue({
      assigneeAgentId: AGENT_ASSIGNEE,
      status: "in_review",
      planProposedAt: new Date(),
    });
    const updated = { ...issue, status: "todo", planApprovedAt: new Date() };

    mockIssueSvc.getById.mockResolvedValue(issue);
    mockIssueSvc.update.mockResolvedValue(updated);

    const res = await request(makeApp(boardActor()))
      .post(`/api/issues/${ISSUE_ID}/approve-plan`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.issue.status).toBe("todo");
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
  it("reject-plan returns todo status and clears planProposedAt timeframe", async () => {
    const issue = makeIssue({
      assigneeAgentId: AGENT_ASSIGNEE,
      status: "in_review",
      planProposedAt: new Date(),
    });
    const updated = { ...issue, status: "todo", planProposedAt: null, planApprovedAt: null };

    mockIssueSvc.getById.mockResolvedValue(issue);
    mockIssueSvc.update.mockResolvedValue(updated);

    const res = await request(makeApp(boardActor()))
      .post(`/api/issues/${ISSUE_ID}/reject-plan`)
      .send({ feedback: "This is terrible, do it again." });

    expect(res.status).toBe(200);
    expect(res.body.issue.status).toBe("todo");
    expect(res.body.issue.planProposedAt).toBeNull();
  });

  // 3. Rejection prohibits self-action
  it("forbids an assignee from self-rejecting their own plan", async () => {
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
      .post(`/api/issues/${ISSUE_ID}/reject-plan`)
      .send({ feedback: "I hate my own work" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/self-approval forbidden/);
  });

  // 4. Rejection triggers Wakeup Event
  it("reject-plan properly triggers wakeup system with rejection reason", async () => {
    const issue = makeIssue({
      assigneeAgentId: AGENT_ASSIGNEE,
      status: "in_review",
      planProposedAt: new Date(),
    });
    const updated = { ...issue, status: "todo", planProposedAt: null, planApprovedAt: null };

    mockIssueSvc.getById.mockResolvedValue(issue);
    mockIssueSvc.update.mockResolvedValue(updated);

    const res = await request(makeApp(boardActor()))
      .post(`/api/issues/${ISSUE_ID}/reject-plan`)
      .send({ feedback: "Try again" });

    expect(res.status).toBe(200);
    expect(mockHeartbeat.wakeup).toHaveBeenCalledWith(AGENT_ASSIGNEE, expect.objectContaining({
      reason: "plan_rejected"
    }));
  });
});

