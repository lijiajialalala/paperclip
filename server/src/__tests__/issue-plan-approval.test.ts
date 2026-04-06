import { randomUUID } from "node:crypto";
import { describe, expect, it, beforeAll, afterEach, afterAll } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  issues,
  issueComments,
  activityLog,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import express from "express";
import request from "supertest";
import { issueRoutes } from "../routes/issues.ts";
import { errorHandler } from "../middleware/index.js";
import { assert } from "node:console";
import { vi } from "vitest";

vi.mock("../services/index.js", async (importOriginal) => {
  const mod = await importOriginal<any>();
  return {
    ...mod,
    heartbeatService: (db: any) => ({
      ...mod.heartbeatService(db),
      wakeup: vi.fn().mockResolvedValue(undefined),
      reportRunActivity: vi.fn().mockResolvedValue(undefined),
    }),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const embeddedPostgresSuiteTimeoutMs = 60_000;

if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping embedded Postgres tests: ${embeddedPostgresSupport.reason}`);
}

describeEmbeddedPostgres("Propose-Plan & Checkout Gate Workflow", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: import("express").Application;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("plan-approval-tests-");
    db = createDb(tempDb.connectionString);
    
    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      const auth = req.header("x-paperclip-auth");
      if (!auth) {
        (req as any).actor = { type: "none", source: "none" };
        return next();
      }
      const parts = auth.split(":");
      if (parts[0] === "agent") {
        (req as any).actor = { type: "agent", companyId: parts[1], agentId: parts[2], source: "agent_key" };
      } else if (parts[0] === "user") {
        (req as any).actor = { type: "board", userId: parts[2], companyIds: [parts[1]], source: "local_implicit", isInstanceAdmin: false };
      }
      const runId = req.header("x-paperclip-run-id");
      if (runId) (req as any).actor.runId = runId;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, {}));
    app.use((err: any, req: any, res: any, next: any) => {
      console.error("TEST ERROR HANDLER", err.stack);
      res.status(500).json({ error: err.stack });
    });

  }, embeddedPostgresSuiteTimeoutMs);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedBasicTopology() {
    const companyId = randomUUID();
    const boardUserId = "board_user_1";
    
    const prefix = companyId.split("-")[0].toUpperCase().slice(0, 4);
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });

    const managerAgentId = randomUUID();
    const assigneeAgentId = randomUUID();
    const siblingAgentId = randomUUID();

    await db.insert(agents).values([
      {
        id: managerAgentId,
        companyId,
        name: "ManagerAgent",
        role: "manager",
        status: "active",
        adapterType: "process",
        permissions: { "canCreateAgents": true },
      },
      {
        id: assigneeAgentId,
        companyId,
        name: "AssigneeAgent",
        role: "engineer",
        status: "active",
        adapterType: "process",
        permissions: {},
      },
      {
        id: siblingAgentId,
        companyId,
        name: "SiblingAgent",
        role: "engineer",
        status: "active",
        adapterType: "process",
        permissions: {},
      },
    ]);

    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: assigneeAgentId,
      status: "running",
      invocationSource: "scheduler",
      createdAt: new Date(),
    });

    const siblingRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: siblingRunId,
      companyId,
      agentId: siblingAgentId,
      status: "running",
      invocationSource: "scheduler",
      createdAt: new Date(),
    });

    return { companyId, boardUserId, managerAgentId, assigneeAgentId, siblingAgentId, runId, siblingRunId };
  }

  // 1. 未 propose 的 issue，agent checkout 仍然成功
  it("allows checkout if issue has not explicitly proposed a plan yet (legacy / opt-in)", async () => {
    const { companyId, assigneeAgentId, runId } = await seedBasicTopology();
    
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "No plan proposed issue",
      status: "todo",
      priority: "medium",
      assigneeAgentId: assigneeAgentId,
    });

    const res = await request(app)
      .post(`/api/issues/${issueId}/checkout`)
      .set("x-paperclip-auth", `agent:${companyId}:${assigneeAgentId}`)
      .set("x-paperclip-run-id", runId)
      .send({ agentId: assigneeAgentId, expectedStatuses: ["todo"] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("in_progress");
  });

  // 2. 非 assignee agent 不能随便 propose
  it("forbids non-assignee agents from proposing a plan on another's issue", async () => {
    const { companyId, assigneeAgentId, siblingAgentId, siblingRunId } = await seedBasicTopology();

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Issue assigned to someone else",
      status: "todo",
      priority: "medium",
      assigneeAgentId: assigneeAgentId, // Sibling is NOT assignee
    });

    const res = await request(app)
      .post(`/api/issues/${issueId}/propose-plan`)
      .set("x-paperclip-auth", `agent:${companyId}:${siblingAgentId}`)
      .set("x-paperclip-run-id", siblingRunId)
      .send({ plan: "I propose this plan instead." });

    expect(res.status).toBe(403);
    // It should hit the error from assertAgentRunCheckoutOwnership
  });

  it("allows the assignee to propose a plan, transitioning issue to in_review", async () => {
    const { companyId, assigneeAgentId, runId } = await seedBasicTopology();

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Issue ready for plan",
      status: "todo",
      priority: "medium",
      assigneeAgentId: assigneeAgentId,
    });

    const res = await request(app)
      .post(`/api/issues/${issueId}/propose-plan`)
      .set("x-paperclip-auth", `agent:${companyId}:${assigneeAgentId}`)
      .set("x-paperclip-run-id", runId)
      .send({ plan: "My brilliant plan." });

    if (res.status === 500) console.error("PROPOSE PLAN ERROR:", res.body);
    expect(res.status).toBe(201);
    expect(res.body.issue.status).toBe("in_review");
    expect(res.body.issue.planProposedAt).toBeDefined();
    expect(res.body.issue.planApprovedAt).toBeNull();
  });

  // 3. 已 propose 未 approve 的 issue，agent checkout 返回 409
  it("blocks checkout if a plan has been proposed but not approved (in_review)", async () => {
    const { companyId, assigneeAgentId, runId } = await seedBasicTopology();

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Pending approval issue",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: assigneeAgentId,
      planProposedAt: new Date(),
    });

    const res = await request(app)
      .post(`/api/issues/${issueId}/checkout`)
      .set("x-paperclip-auth", `agent:${companyId}:${assigneeAgentId}`)
      .set("x-paperclip-run-id", runId)
      .send({ agentId: assigneeAgentId, expectedStatuses: ["in_review", "todo"] });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/must be approved before checkout/);
  });

  // 4. assignee 不能 self-approve
  it("forbids an assignee from self-approving their own plan", async () => {
    const { companyId, assigneeAgentId, runId } = await seedBasicTopology();

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Pending approval issue",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: assigneeAgentId,
      planProposedAt: new Date(),
    });

    const res = await request(app)
      .post(`/api/issues/${issueId}/approve-plan`)
      .set("x-paperclip-auth", `agent:${companyId}:${assigneeAgentId}`)
      .set("x-paperclip-run-id", runId)
      .send();

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/self-approval forbidden/);
  });

  // 5. board 或 manager agent 可以 approve
  it("allows a manager agent (tasks:assign) to approve a plan", async () => {
    const { companyId, managerAgentId, assigneeAgentId } = await seedBasicTopology();

    const managerRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: managerRunId,
      companyId,
      agentId: managerAgentId,
      status: "running",
      invocationSource: "scheduler",
      createdAt: new Date(),
    });

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Pending approval issue",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: assigneeAgentId,
      planProposedAt: new Date(),
    });

    const res = await request(app)
      .post(`/api/issues/${issueId}/approve-plan`)
      .set("x-paperclip-auth", `agent:${companyId}:${managerAgentId}`)
      .set("x-paperclip-run-id", managerRunId)
      .send();

    expect(res.status).toBe(200); // Approve endpoint returns 201 by standard or 200
    // Actually the code does res.status(201).json({ issue: updated, comment })
    expect(res.body.issue.status).toBe("todo");
    expect(res.body.issue.planApprovedAt).toBeDefined();
  });

  it("allows parent issue assignee to approve a plan", async () => {
    const { companyId, assigneeAgentId, siblingAgentId, siblingRunId } = await seedBasicTopology();
    // Use siblingAgent as parent assignee

    const parentId = randomUUID();
    await db.insert(issues).values({
      id: parentId,
      companyId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: siblingAgentId,
    });

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      parentId,
      title: "Pending approval issue",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: assigneeAgentId,
      planProposedAt: new Date(),
    });

    const res = await request(app)
      .post(`/api/issues/${issueId}/approve-plan`)
      .set("x-paperclip-auth", `agent:${companyId}:${siblingAgentId}`)
      .set("x-paperclip-run-id", siblingRunId)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.issue.status).toBe("todo");
  });

  it("allows Board (implicit company access) to approve a plan", async () => {
    const { companyId, assigneeAgentId, boardUserId } = await seedBasicTopology();

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Pending approval issue",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: assigneeAgentId,
      planProposedAt: new Date(),
    });

    const res = await request(app)
      .post(`/api/issues/${issueId}/approve-plan`)
      .set("x-paperclip-auth", `user:${companyId}:${boardUserId}`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.issue.status).toBe("todo");
  });
});
