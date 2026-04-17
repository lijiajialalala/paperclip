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
  logActivity: vi.fn(async () => undefined),
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

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "user",
      userId: "board-user",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", agentRoutes({ select: vi.fn() } as any));
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
        triggeredBy: "user",
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
          triggeredBy: "user",
          actorId: "board-user",
          issueId: "issue-1",
          taskId: "issue-1",
        }),
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
        triggeredBy: "user",
        actorId: "board-user",
      }),
    );
    expect(invokeContext.issueId).toBeUndefined();
    expect(invokeContext.taskId).toBeUndefined();
  });
});
