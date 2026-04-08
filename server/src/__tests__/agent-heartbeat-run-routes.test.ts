import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";

const mockHeartbeatService = vi.hoisted(() => ({
  getRun: vi.fn(),
}));

const mockQaIssueState = vi.hoisted(() => ({
  getRunIssueWriteback: vi.fn(),
}));

const mockPlatformUnblock = vi.hoisted(() => ({
  getRunPlatformHint: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  agentService: () => ({
    getById: vi.fn(),
  }),
  agentInstructionsService: () => ({
    getBundle: vi.fn(),
  }),
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  approvalService: () => ({}),
  companySkillService: () => ({
    listRuntimeSkillEntries: vi.fn(async () => []),
  }),
  budgetService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => ({}),
  issueService: () => ({}),
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

vi.mock("../services/qa-issue-state.js", () => ({
  qaIssueStateService: () => mockQaIssueState,
}));

vi.mock("../services/platform-unblock.js", () => ({
  platformUnblockService: () => mockPlatformUnblock,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: vi.fn(async () => ({
      censorUsernameInLogs: false,
    })),
  }),
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
      type: "board",
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

describe("agent heartbeat run routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHeartbeatService.getRun.mockResolvedValue({
      id: runId,
      companyId,
      agentId: "agent-1",
      status: "failed",
      contextSnapshot: { issueId: "issue-1" },
      resultJson: {},
      createdAt: new Date("2026-04-08T00:00:00.000Z"),
      updatedAt: new Date("2026-04-08T00:05:00.000Z"),
    });
    mockQaIssueState.getRunIssueWriteback.mockResolvedValue({
      status: "platform_written",
      verdict: "fail",
      source: "platform",
      canCloseUpstream: false,
      commentId: "comment-1",
      writebackAt: "2026-04-08T00:05:00.000Z",
      alertType: null,
      latest: true,
    });
    mockPlatformUnblock.getRunPlatformHint.mockResolvedValue({
      latestForIssue: true,
      processLost: false,
      processLossRetryCount: 0,
      writebackAlertType: null,
      closeGateBlocked: true,
    });
  });

  it("returns heartbeat run enrichment for writeback and platform hint", async () => {
    const res = await request(createApp()).get(`/api/heartbeat-runs/${runId}`);

    expect(res.status).toBe(200);
    expect(mockQaIssueState.getRunIssueWriteback).toHaveBeenCalledWith(runId);
    expect(mockPlatformUnblock.getRunPlatformHint).toHaveBeenCalledWith(runId);
    expect(res.body).toEqual(expect.objectContaining({
      id: runId,
      issueWriteback: expect.objectContaining({
        verdict: "fail",
        latest: true,
      }),
      platformHint: expect.objectContaining({
        latestForIssue: true,
        closeGateBlocked: true,
      }),
    }));
  });
});
