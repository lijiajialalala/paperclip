import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  registerServerAdapter,
  unregisterServerAdapter,
  type ServerAdapterModule,
} from "../adapters/index.ts";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentFirstHeartbeat = vi.hoisted(() => vi.fn());
const schedulingAdapterExecute = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: mockTrackAgentFirstHeartbeat,
  };
});

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const embeddedPostgresSuiteTimeoutMs = 60_000;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat plan-gate scheduling tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const schedulingTestAdapter: ServerAdapterModule = {
  type: "queue_scheduling_test",
  execute: async (ctx) => {
    schedulingAdapterExecute(ctx);
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      resultJson: {
        summary: "adapter executed",
        issueId:
          typeof ctx.context.issue === "object" &&
          ctx.context.issue !== null &&
          typeof (ctx.context.issue as { id?: unknown }).id === "string"
            ? (ctx.context.issue as { id: string }).id
            : null,
      },
    };
  },
  testEnvironment: async () => ({
    adapterType: "queue_scheduling_test",
    status: "pass",
    checks: [],
    testedAt: new Date(0).toISOString(),
  }),
  models: [],
  supportsLocalAgentJwt: false,
};

async function waitForRunStatus(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  statuses: Array<"queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out">,
  timeoutMs = 10_000,
  intervalMs = 50,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const run = await heartbeat.getRun(runId);
    if (run && statuses.includes(run.status)) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out waiting for run ${runId} to enter one of: ${statuses.join(", ")}`);
}

describeEmbeddedPostgres("heartbeat plan-gate-aware scheduling", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-plan-gate-");
    db = createDb(tempDb.connectionString);
    registerServerAdapter(schedulingTestAdapter);
  }, embeddedPostgresSuiteTimeoutMs);

  afterEach(async () => {
    vi.clearAllMocks();
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    unregisterServerAdapter("queue_scheduling_test");
    await tempDb?.cleanup();
  });

  async function seedSchedulingFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const parentIssueId = randomUUID();
    const gatedIssueId = randomUUID();
    const readyIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Scheduling Lead",
      role: "engineer",
      status: "idle",
      adapterType: "queue_scheduling_test",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    await db.insert(issues).values([
      {
        id: parentIssueId,
        companyId,
        title: "Parent batch",
        status: "todo",
        priority: "medium",
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: gatedIssueId,
        companyId,
        title: "Child lane still needs a plan",
        status: "todo",
        priority: "high",
        parentId: parentIssueId,
        assigneeAgentId: agentId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
      {
        id: readyIssueId,
        companyId,
        title: "Top-level ready work",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: 3,
        identifier: `${issuePrefix}-3`,
      },
    ]);

    return {
      agentId,
      gatedIssueId,
      readyIssueId,
    };
  }

  it("does not let a plan-gated queued run block a later runnable issue run", async () => {
    const { agentId, gatedIssueId, readyIssueId } = await seedSchedulingFixture();
    const heartbeat = heartbeatService(db);

    const gatedRun = await heartbeat.invoke(
      agentId,
      "assignment",
      { issueId: gatedIssueId },
      "system",
      { actorType: "system", actorId: "test" },
    );
    expect(gatedRun).not.toBeNull();

    const readyRun = await heartbeat.invoke(
      agentId,
      "assignment",
      { issueId: readyIssueId },
      "system",
      { actorType: "system", actorId: "test" },
    );
    expect(readyRun).not.toBeNull();

    const finalizedReadyRun = await waitForRunStatus(heartbeat, readyRun!.id, ["succeeded"]);
    const stillQueuedGateRun = await heartbeat.getRun(gatedRun!.id);

    expect(finalizedReadyRun.status).toBe("succeeded");
    expect(stillQueuedGateRun?.status).toBe("queued");
    expect(schedulingAdapterExecute).toHaveBeenCalledTimes(1);

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, gatedRun!.wakeupRequestId!))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("queued");
  });

  it("re-enters scheduling when plan approval wakes an already queued run", async () => {
    const { agentId, gatedIssueId } = await seedSchedulingFixture();
    const heartbeat = heartbeatService(db);

    const gatedRun = await heartbeat.invoke(
      agentId,
      "assignment",
      { issueId: gatedIssueId },
      "system",
      { actorType: "system", actorId: "test" },
    );
    expect(gatedRun).not.toBeNull();

    const queuedRun = await waitForRunStatus(heartbeat, gatedRun!.id, ["queued"]);
    expect(queuedRun.status).toBe("queued");
    expect(schedulingAdapterExecute).not.toHaveBeenCalled();

    const approvedAt = new Date("2026-04-21T09:00:00.000Z");
    await db
      .update(issues)
      .set({
        planProposedAt: new Date("2026-04-21T08:55:00.000Z"),
        planApprovedAt: approvedAt,
        updatedAt: approvedAt,
      })
      .where(eq(issues.id, gatedIssueId));

    const resumedRun = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "plan_approved",
      requestedByActorType: "system",
      requestedByActorId: "test",
      contextSnapshot: {
        issueId: gatedIssueId,
        taskId: gatedIssueId,
        source: "issue.plan_approved",
        wakeReason: "plan_approved",
      },
    });

    expect(resumedRun?.id).toBe(gatedRun!.id);
    const finalizedRun = await waitForRunStatus(heartbeat, gatedRun!.id, ["succeeded"]);

    expect(finalizedRun.status).toBe("succeeded");
    expect(schedulingAdapterExecute).toHaveBeenCalledTimes(1);

    const persistedRuns = await db.select().from(heartbeatRuns);
    expect(persistedRuns).toHaveLength(1);
  }, 15_000);
});
