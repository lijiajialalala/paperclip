import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
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
const timerAdapterExecute = vi.hoisted(() => vi.fn());

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
    `Skipping embedded Postgres idle timer heartbeat tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const timerTestAdapter: ServerAdapterModule = {
  type: "codex_local",
  execute: async (ctx) => {
    timerAdapterExecute(ctx);
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      resultJson: {
        summary: "adapter executed",
        timeoutSec: typeof ctx.config.timeoutSec === "number" ? ctx.config.timeoutSec : null,
      },
    };
  },
  testEnvironment: async () => ({
    adapterType: "codex_local",
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

async function waitForRuntimeState(
  db: ReturnType<typeof createDb>,
  agentId: string,
  expectedRunId: string,
  timeoutMs = 10_000,
  intervalMs = 50,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const runtime = await db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    if (runtime?.lastRunId === expectedRunId) {
      return runtime;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out waiting for runtime state to record run ${expectedRunId}`);
}

describeEmbeddedPostgres("heartbeat idle timer preflight", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-idle-timer-");
    db = createDb(tempDb.connectionString);
    registerServerAdapter(timerTestAdapter);
  }, embeddedPostgresSuiteTimeoutMs);

  afterEach(async () => {
    vi.clearAllMocks();
    await db.delete(heartbeatRunEvents);
    await db.delete(agentTaskSessions);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    unregisterServerAdapter("codex_local");
    await tempDb?.cleanup();
  });

  async function seedAgentFixture(input?: {
    withIssue?: boolean;
    issueStatus?: "todo" | "in_progress" | "blocked";
    globalRuntimeSessionId?: string;
    heartbeatTaskSessionDisplayId?: string;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
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
      name: "Research Lead",
      role: "researcher",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    if (input?.globalRuntimeSessionId) {
      await db.insert(agentRuntimeState).values({
        agentId,
        companyId,
        adapterType: "codex_local",
        sessionId: input.globalRuntimeSessionId,
      });
    }

    if (input?.heartbeatTaskSessionDisplayId) {
      await db.insert(agentTaskSessions).values({
        companyId,
        agentId,
        adapterType: "codex_local",
        taskKey: "__heartbeat__",
        sessionDisplayId: input.heartbeatTaskSessionDisplayId,
      });
    }

    if (input?.withIssue) {
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Investigate target persona",
        status: input.issueStatus ?? "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      });
    }

    return { companyId, agentId, issueId };
  }

  it("skips synthetic timer runs when the agent has no actionable assigned issues", async () => {
    const { agentId } = await seedAgentFixture();
    const heartbeat = heartbeatService(db);

    const queuedRun = await heartbeat.invoke(
      agentId,
      "timer",
      {
        source: "scheduler",
        reason: "interval_elapsed",
      },
      "system",
      { actorType: "system", actorId: "heartbeat_scheduler" },
    );

    expect(queuedRun).not.toBeNull();
    const finalizedRun = await waitForRunStatus(heartbeat, queuedRun!.id, ["succeeded"]);

    expect(timerAdapterExecute).not.toHaveBeenCalled();
    expect(finalizedRun.resultJson).toMatchObject({
      state: "idle_timer_skipped",
      reason: "no_actionable_assigned_issues",
      actionableAssignedIssueCount: 0,
    });

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, queuedRun!.wakeupRequestId!))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("completed");

    const runtime = await waitForRuntimeState(db, agentId, queuedRun!.id);
    expect(runtime?.lastRunId).toBe(queuedRun!.id);
    expect(runtime?.lastRunStatus).toBe("succeeded");
  });

  it("still skips issue-less synthetic timer runs when only a global runtime session exists", async () => {
    const { agentId } = await seedAgentFixture({
      globalRuntimeSessionId: "issue-session-1",
    });
    const heartbeat = heartbeatService(db);

    const queuedRun = await heartbeat.invoke(
      agentId,
      "timer",
      {
        source: "scheduler",
        reason: "interval_elapsed",
      },
      "system",
      { actorType: "system", actorId: "heartbeat_scheduler" },
    );

    expect(queuedRun).not.toBeNull();
    const finalizedRun = await waitForRunStatus(heartbeat, queuedRun!.id, ["succeeded"]);

    expect(timerAdapterExecute).not.toHaveBeenCalled();
    expect(finalizedRun.resultJson).toMatchObject({
      state: "idle_timer_skipped",
      reason: "no_actionable_assigned_issues",
    });
    const runtime = await waitForRuntimeState(db, agentId, queuedRun!.id);
    expect(runtime?.sessionId).toBe("issue-session-1");
  });

  it("skips issue-less synthetic timer runs even when a stale heartbeat task session exists", async () => {
    const { agentId } = await seedAgentFixture({
      heartbeatTaskSessionDisplayId: "heartbeat-session-1",
    });
    const heartbeat = heartbeatService(db);

    const queuedRun = await heartbeat.invoke(
      agentId,
      "timer",
      {
        source: "scheduler",
        reason: "interval_elapsed",
      },
      "system",
      { actorType: "system", actorId: "heartbeat_scheduler" },
    );

    expect(queuedRun).not.toBeNull();
    const finalizedRun = await waitForRunStatus(heartbeat, queuedRun!.id, ["succeeded"]);
    const runtime = await waitForRuntimeState(db, agentId, queuedRun!.id);

    expect(timerAdapterExecute).not.toHaveBeenCalled();
    expect(finalizedRun.resultJson).toMatchObject({
      state: "idle_timer_skipped",
      reason: "no_actionable_assigned_issues",
    });
    expect(runtime?.sessionId).toBeNull();

    const heartbeatTaskSession = await db
      .select()
      .from(agentTaskSessions)
      .where(eq(agentTaskSessions.agentId, agentId))
      .then((rows) => rows.find((row) => row.taskKey === "__heartbeat__") ?? null);
    expect(heartbeatTaskSession).toBeNull();
  });

  it("continues into the adapter for synthetic timer runs when actionable work exists and injects a timeout", async () => {
    const { agentId } = await seedAgentFixture({
      withIssue: true,
      issueStatus: "todo",
    });
    const heartbeat = heartbeatService(db);

    const queuedRun = await heartbeat.invoke(
      agentId,
      "timer",
      {
        source: "scheduler",
        reason: "interval_elapsed",
      },
      "system",
      { actorType: "system", actorId: "heartbeat_scheduler" },
    );

    expect(queuedRun).not.toBeNull();
    const finalizedRun = await waitForRunStatus(heartbeat, queuedRun!.id, ["succeeded"]);
    await waitForRuntimeState(db, agentId, queuedRun!.id);

    expect(timerAdapterExecute).toHaveBeenCalledTimes(1);
    expect(timerAdapterExecute.mock.calls[0]?.[0]?.config?.timeoutSec).toBe(900);
    expect(finalizedRun.resultJson).toMatchObject({
      summary: "adapter executed",
      timeoutSec: 900,
    });
  });
});
