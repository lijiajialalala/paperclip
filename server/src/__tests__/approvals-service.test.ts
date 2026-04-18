import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  approvals,
  companies,
  createDb,
  issueApprovals,
  issues,
} from "@paperclipai/db";
import { approvalService } from "../services/approvals.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAgentService = vi.hoisted(() => ({
  activatePendingApproval: vi.fn(),
  create: vi.fn(),
  terminate: vi.fn(),
}));

const mockNotifyHireApproved = vi.hoisted(() => vi.fn());

vi.mock("../services/agents.js", () => ({
  agentService: vi.fn(() => mockAgentService),
}));

vi.mock("../services/hire-hook.js", () => ({
  notifyHireApproved: mockNotifyHireApproved,
}));

type ApprovalRecord = {
  id: string;
  companyId: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  requestedByAgentId: string | null;
  requestedByUserId?: string | null;
  targetAgentId?: string | null;
  targetUserId?: string | null;
  routingMode?: string | null;
  decidedByUserId?: string | null;
  decidedByAgentId?: string | null;
};

function createApproval(status: string): ApprovalRecord {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "hire_agent",
    status,
    payload: { agentId: "agent-1" },
    requestedByAgentId: "requester-1",
    requestedByUserId: null,
    targetAgentId: null,
    targetUserId: null,
    routingMode: "board_pool",
    decidedByUserId: null,
    decidedByAgentId: null,
  };
}

function createDbStub(selectResults: ApprovalRecord[][], updateResults: ApprovalRecord[]) {
  const pendingSelectResults = [...selectResults];
  const selectWhere = vi.fn(async () => pendingSelectResults.shift() ?? []);
  const from = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from }));

  const returning = vi.fn(async () => updateResults);
  const updateWhere = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));

  return {
    db: { select, update },
    selectWhere,
    returning,
  };
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const embeddedPostgresSuiteTimeoutMs = 60_000;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres approvals service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("approvalService resolution idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.activatePendingApproval.mockResolvedValue(undefined);
    mockAgentService.create.mockResolvedValue({ id: "agent-1" });
    mockAgentService.terminate.mockResolvedValue(undefined);
    mockNotifyHireApproved.mockResolvedValue(undefined);
  });

  it("treats repeated approve retries as no-ops after another worker resolves the approval", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("approved")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("approved");
    expect(mockAgentService.activatePendingApproval).not.toHaveBeenCalled();
    expect(mockNotifyHireApproved).not.toHaveBeenCalled();
  });

  it("treats repeated reject retries as no-ops after another worker resolves the approval", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("rejected")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.reject("approval-1", "board", "not now");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("rejected");
    expect(mockAgentService.terminate).not.toHaveBeenCalled();
  });

  it("still performs side effects when the resolution update is newly applied", async () => {
    const approved = createApproval("approved");
    const dbStub = createDbStub([[createApproval("pending")]], [approved]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", {
      decidedByUserId: "board",
      decidedByAgentId: null,
      decisionNote: "ship it",
    });

    expect(result.applied).toBe(true);
    expect(mockAgentService.activatePendingApproval).toHaveBeenCalledWith("agent-1");
    expect(mockNotifyHireApproved).toHaveBeenCalledTimes(1);
  });

  it("records agent decisions without pretending they were made by board", async () => {
    const approved = {
      ...createApproval("approved"),
      type: "work_plan",
      payload: {},
      requestedByAgentId: "requester-1",
      decidedByUserId: null,
      decidedByAgentId: "lead-agent",
    };
    const dbStub = createDbStub([[{ ...createApproval("pending"), type: "work_plan", payload: {} }]], [approved]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", {
      decidedByUserId: null,
      decidedByAgentId: "lead-agent",
      decisionNote: "looks good",
    });

    expect(result.applied).toBe(true);
    expect(dbStub.returning).toHaveBeenCalled();
    expect(mockAgentService.activatePendingApproval).not.toHaveBeenCalled();
  });
});

describeEmbeddedPostgres("approvalService linked work_plan sync", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof approvalService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-approvals-service-");
    db = createDb(tempDb.connectionString);
    svc = approvalService(db);
  }, embeddedPostgresSuiteTimeoutMs);

  afterEach(async () => {
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("approveWithLinkedIssueSync marks the approval approved and mirrors planApprovedAt to linked issues", async () => {
    const companyId = randomUUID();
    const requesterAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const approvalId = randomUUID();
    const issueId = randomUUID();
    const proposedAt = new Date("2026-04-16T10:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: requesterAgentId,
        companyId,
        name: "Requester",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: reviewerAgentId,
        companyId,
        name: "Reviewer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Child issue",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: requesterAgentId,
      planProposedAt: proposedAt,
      planApprovedAt: null,
    });
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "work_plan",
      status: "pending",
      payload: { issueId },
      requestedByAgentId: requesterAgentId,
      targetAgentId: reviewerAgentId,
      routingMode: "parent_assignee_agent",
    });
    await db.insert(issueApprovals).values({
      companyId,
      issueId,
      approvalId,
      linkedByAgentId: requesterAgentId,
    });

    const result = await svc.approveWithLinkedIssueSync(approvalId, {
      decidedByUserId: null,
      decidedByAgentId: reviewerAgentId,
      decisionNote: "looks good",
    });

    expect(result.applied).toBe(true);
    expect(result.approval.status).toBe("approved");
    expect(result.linkedIssues).toEqual([
      expect.objectContaining({
        id: issueId,
        planProposedAt: proposedAt,
        planApprovedAt: null,
      }),
    ]);

    const [issueRow] = await db
      .select({
        status: issues.status,
        planProposedAt: issues.planProposedAt,
        planApprovedAt: issues.planApprovedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(issueRow?.status).toBe("todo");
    expect(issueRow?.planProposedAt?.toISOString()).toBe(proposedAt.toISOString());
    expect(issueRow?.planApprovedAt).toBeTruthy();

    const [approvalRow] = await db
      .select({
        status: approvals.status,
        decidedByAgentId: approvals.decidedByAgentId,
        decisionNote: approvals.decisionNote,
      })
      .from(approvals)
      .where(eq(approvals.id, approvalId));
    expect(approvalRow).toEqual({
      status: "approved",
      decidedByAgentId: reviewerAgentId,
      decisionNote: "looks good",
    });
  });

  it("rejectWithLinkedIssueSync resets linked issue plan mirrors when the work_plan is rejected", async () => {
    const companyId = randomUUID();
    const requesterAgentId = randomUUID();
    const approvalId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: requesterAgentId,
      companyId,
      name: "Requester",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Child issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: requesterAgentId,
      planProposedAt: new Date("2026-04-16T10:00:00.000Z"),
      planApprovedAt: new Date("2026-04-16T11:00:00.000Z"),
    });
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "work_plan",
      status: "pending",
      payload: { issueId },
      requestedByAgentId: requesterAgentId,
      targetUserId: "board-user",
      routingMode: "board_pool",
    });
    await db.insert(issueApprovals).values({
      companyId,
      issueId,
      approvalId,
      linkedByAgentId: requesterAgentId,
    });

    const result = await svc.rejectWithLinkedIssueSync(approvalId, {
      decidedByUserId: "board-user",
      decidedByAgentId: null,
      decisionNote: "redo the plan",
    });

    expect(result.applied).toBe(true);
    expect(result.approval.status).toBe("rejected");
    expect(result.linkedIssues).toEqual([
      expect.objectContaining({
        id: issueId,
      }),
    ]);

    const [issueRow] = await db
      .select({
        planProposedAt: issues.planProposedAt,
        planApprovedAt: issues.planApprovedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(issueRow).toEqual({
      planProposedAt: null,
      planApprovedAt: null,
    });

    const [approvalRow] = await db
      .select({
        status: approvals.status,
        decidedByUserId: approvals.decidedByUserId,
        decisionNote: approvals.decisionNote,
      })
      .from(approvals)
      .where(eq(approvals.id, approvalId));
    expect(approvalRow).toEqual({
      status: "rejected",
      decidedByUserId: "board-user",
      decisionNote: "redo the plan",
    });
  });

  it("rejectWithLinkedIssueSync returns an in_review issue to todo when the work_plan is rejected", async () => {
    const companyId = randomUUID();
    const requesterAgentId = randomUUID();
    const approvalId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: requesterAgentId,
      companyId,
      name: "Requester",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Child issue",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: requesterAgentId,
      planProposedAt: new Date("2026-04-16T10:00:00.000Z"),
      planApprovedAt: null,
    });
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "work_plan",
      status: "pending",
      payload: { issueId },
      requestedByAgentId: requesterAgentId,
      targetUserId: "board-user",
      routingMode: "board_pool",
    });
    await db.insert(issueApprovals).values({
      companyId,
      issueId,
      approvalId,
      linkedByAgentId: requesterAgentId,
    });

    const result = await svc.rejectWithLinkedIssueSync(approvalId, {
      decidedByUserId: "board-user",
      decidedByAgentId: null,
      decisionNote: "redo the plan",
    });

    expect(result.applied).toBe(true);
    expect(result.approval.status).toBe("rejected");

    const [issueRow] = await db
      .select({
        status: issues.status,
        planProposedAt: issues.planProposedAt,
        planApprovedAt: issues.planApprovedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(issueRow).toEqual({
      status: "todo",
      planProposedAt: null,
      planApprovedAt: null,
    });
  });

  it("fails closed when approving a work plan after linked issue execution has started", async () => {
    const companyId = randomUUID();
    const requesterAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const approvalId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: requesterAgentId,
        companyId,
        name: "Requester",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: reviewerAgentId,
        companyId,
        name: "Reviewer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Child issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: requesterAgentId,
      planProposedAt: new Date("2026-04-16T10:00:00.000Z"),
      planApprovedAt: null,
    });
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "work_plan",
      status: "pending",
      payload: { issueId },
      requestedByAgentId: requesterAgentId,
      targetAgentId: reviewerAgentId,
      routingMode: "parent_assignee_agent",
    });
    await db.insert(issueApprovals).values({
      companyId,
      issueId,
      approvalId,
      linkedByAgentId: requesterAgentId,
    });

    await expect(
      svc.approveWithLinkedIssueSync(approvalId, {
        decidedByUserId: null,
        decidedByAgentId: reviewerAgentId,
        decisionNote: "looks good",
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/cannot approve a plan after execution has already started/i),
    });

    const [approvalRow] = await db
      .select({ status: approvals.status })
      .from(approvals)
      .where(eq(approvals.id, approvalId));
    expect(approvalRow?.status).toBe("pending");
  });

  it("fails closed when approving an orphaned work plan approval with zero linked issues", async () => {
    const companyId = randomUUID();
    const requesterAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const approvalId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: requesterAgentId,
        companyId,
        name: "Requester",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: reviewerAgentId,
        companyId,
        name: "Reviewer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "work_plan",
      status: "pending",
      payload: {},
      requestedByAgentId: requesterAgentId,
      targetAgentId: reviewerAgentId,
      routingMode: "parent_assignee_agent",
    });

    await expect(
      svc.approveWithLinkedIssueSync(approvalId, {
        decidedByUserId: null,
        decidedByAgentId: reviewerAgentId,
        decisionNote: "looks good",
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/has no linked issues; manual repair required/i),
    });

    const [approvalRow] = await db
      .select({ status: approvals.status })
      .from(approvals)
      .where(eq(approvals.id, approvalId));
    expect(approvalRow?.status).toBe("pending");
  });

  it("fails closed when rejecting a work plan while the linked issue has multiple live approvals", async () => {
    const companyId = randomUUID();
    const requesterAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const firstApprovalId = randomUUID();
    const secondApprovalId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: requesterAgentId,
        companyId,
        name: "Requester",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: reviewerAgentId,
        companyId,
        name: "Reviewer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Child issue",
      status: "todo",
      priority: "medium",
      assigneeAgentId: requesterAgentId,
      planProposedAt: new Date("2026-04-16T10:00:00.000Z"),
      planApprovedAt: null,
    });
    await db.insert(approvals).values([
      {
        id: firstApprovalId,
        companyId,
        type: "work_plan",
        status: "pending",
        payload: { issueId },
        requestedByAgentId: requesterAgentId,
        targetAgentId: reviewerAgentId,
        routingMode: "parent_assignee_agent",
      },
      {
        id: secondApprovalId,
        companyId,
        type: "work_plan",
        status: "pending",
        payload: { issueId },
        requestedByAgentId: requesterAgentId,
        targetAgentId: reviewerAgentId,
        routingMode: "parent_assignee_agent",
      },
    ]);
    await db.insert(issueApprovals).values([
      {
        companyId,
        issueId,
        approvalId: firstApprovalId,
        linkedByAgentId: requesterAgentId,
      },
      {
        companyId,
        issueId,
        approvalId: secondApprovalId,
        linkedByAgentId: requesterAgentId,
      },
    ]);

    await expect(
      svc.rejectWithLinkedIssueSync(firstApprovalId, {
        decidedByUserId: null,
        decidedByAgentId: reviewerAgentId,
        decisionNote: "manual repair first",
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/multiple live work plan approvals; manual repair required/i),
    });

    const approvalRows = await db
      .select({
        id: approvals.id,
        status: approvals.status,
      })
      .from(approvals)
      .where(eq(approvals.companyId, companyId));
    expect(approvalRows).toEqual(
      expect.arrayContaining([
        { id: firstApprovalId, status: "pending" },
        { id: secondApprovalId, status: "pending" },
      ]),
    );
  });
});
