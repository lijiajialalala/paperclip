import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  invoke: vi.fn(),
  wakeup: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => ({
    getBundle: vi.fn(),
  }),
  accessService: () => ({
    canUser: vi.fn(),
    getMembership: vi.fn(),
    hasPermission: vi.fn(),
    listPrincipalGrants: vi.fn(),
  }),
  approvalService: () => ({}),
  companySkillService: () => ({
    listRuntimeSkillEntries: vi.fn(async () => []),
  }),
  budgetService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  secretService: () => ({
    resolveAdapterConfigForRuntime: vi.fn(),
    normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
  }),
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({
    listForRun: vi.fn(async () => []),
    getById: vi.fn(async () => null),
  }),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: vi.fn(async () => ({
      censorUsernameInLogs: false,
    })),
  }),
}));

vi.mock("../services/qa-issue-state.js", () => ({
  qaIssueStateService: () => ({
    getRunIssueWriteback: vi.fn(),
  }),
}));

vi.mock("../services/platform-unblock.js", () => ({
  platformUnblockService: () => ({
    getRunPlatformHint: vi.fn(),
  }),
}));

vi.mock("../services/issue-status-truth.js", () => ({
  issueStatusTruthService: () => ({}),
  applyEffectiveStatus: vi.fn((issue) => issue),
}));

vi.mock("../adapters/index.js", () => ({
  detectAdapterModel: vi.fn(),
  findActiveServerAdapter: vi.fn(),
  findServerAdapter: vi.fn(),
  listAdapterModels: vi.fn(async () => []),
  requireServerAdapter: vi.fn(),
}));

function createApp(dbOverride?: { select?: ReturnType<typeof vi.fn> }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", agentRoutes(({ select: vi.fn(), ...dbOverride } as unknown) as any));
  app.use(errorHandler);
  return app;
}

describe("agent manual invoke routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.getById.mockResolvedValue({
      id: agentId,
      companyId,
      name: "技术负责人",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    mockIssueService.list.mockResolvedValue([]);
    mockHeartbeatService.invoke.mockResolvedValue({
      id: "run-invoke",
      agentId,
      companyId,
      status: "queued",
    });
    mockHeartbeatService.wakeup.mockResolvedValue({
      id: "run-wakeup",
      agentId,
      companyId,
      status: "queued",
    });
  });

  it("attaches the unique checked-out issue when invoking an agent manually", async () => {
    mockIssueService.list.mockResolvedValue([
      {
        id: "issue-1",
        status: "in_progress",
        checkoutRunId: "run-old",
        executionRunId: null,
      },
    ]);

    const res = await request(createApp()).post(`/api/agents/${agentId}/heartbeat/invoke`).send({});

    expect(res.status).toBe(202);
    expect(mockHeartbeatService.invoke).toHaveBeenCalledWith(
      agentId,
      "on_demand",
      expect.objectContaining({
        triggeredBy: "board",
        actorId: "board-user",
        issueId: "issue-1",
        taskId: "issue-1",
      }),
      "manual",
      {
        actorType: "user",
        actorId: "board-user",
      },
    );
  });

  it("attaches the unique checked-out issue when retrying through the generic wakeup route", async () => {
    mockIssueService.list.mockResolvedValue([
      {
        id: "issue-1",
        status: "in_progress",
        checkoutRunId: "run-old",
        executionRunId: null,
      },
    ]);

    const res = await request(createApp()).post(`/api/agents/${agentId}/wakeup`).send({
      source: "on_demand",
      triggerDetail: "manual",
      reason: "retry_failed_run",
    });

    expect(res.status).toBe(202);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({
        source: "on_demand",
        triggerDetail: "manual",
        reason: "retry_failed_run",
        contextSnapshot: expect.objectContaining({
          triggeredBy: "board",
          actorId: "board-user",
          issueId: "issue-1",
          taskId: "issue-1",
        }),
      }),
    );
  });

  it("attributes generic manual wake activity to the queued run instead of a stale actor run", async () => {
    const staleRunId = "99999999-9999-4999-8999-999999999999";
    const res = await request(createApp())
      .post(`/api/agents/${agentId}/wakeup`)
      .set("x-paperclip-run-id", staleRunId)
      .send({
        source: "on_demand",
        triggerDetail: "manual",
        reason: "retry_failed_run",
      });

    expect(res.status).toBe(202);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "heartbeat.invoked",
        entityType: "heartbeat_run",
        entityId: "run-wakeup",
        runId: "run-wakeup",
      }),
    );
  });

  it("attributes direct manual invoke activity to the queued run instead of a stale actor run", async () => {
    const staleRunId = "99999999-9999-4999-8999-999999999999";
    const res = await request(createApp())
      .post(`/api/agents/${agentId}/heartbeat/invoke`)
      .set("x-paperclip-run-id", staleRunId)
      .send({});

    expect(res.status).toBe(202);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "heartbeat.invoked",
        entityType: "heartbeat_run",
        entityId: "run-invoke",
        runId: "run-invoke",
      }),
    );
  });

  it("does not guess a task target when multiple in-progress issues are assigned", async () => {
    mockIssueService.list.mockResolvedValue([
      {
        id: "issue-1",
        status: "in_progress",
        checkoutRunId: null,
        executionRunId: null,
      },
      {
        id: "issue-2",
        status: "in_progress",
        checkoutRunId: null,
        executionRunId: null,
      },
    ]);

    const res = await request(createApp()).post(`/api/agents/${agentId}/heartbeat/invoke`).send({});

    expect(res.status).toBe(202);
    const invokeContext = mockHeartbeatService.invoke.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(invokeContext).toEqual(
      expect.objectContaining({
        triggeredBy: "board",
        actorId: "board-user",
      }),
    );
    expect(invokeContext.issueId).toBeUndefined();
    expect(invokeContext.taskId).toBeUndefined();
  });

  it("preserves inferred issue context when a manual wake is skipped", async () => {
    mockIssueService.list.mockResolvedValue([
      {
        id: "issue-1",
        status: "in_progress",
        checkoutRunId: "run-old",
        executionRunId: null,
      },
    ]);
    mockHeartbeatService.wakeup.mockResolvedValue(null);

    const select = vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [
          {
            id: "issue-1",
            executionRunId: null,
          },
        ]),
      })),
    }));

    const res = await request(createApp({ select })).post(`/api/agents/${agentId}/wakeup`).send({
      source: "on_demand",
      triggerDetail: "manual",
      reason: "retry_failed_run",
    });

    expect(res.status).toBe(202);
    expect(res.body).toEqual(
      expect.objectContaining({
        status: "skipped",
        reason: "wakeup_skipped",
        issueId: "issue-1",
        executionRunId: null,
        executionAgentId: null,
        executionAgentName: null,
      }),
    );
  });
});
