import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routineRoutes } from "../routes/routines.js";
import { errorHandler } from "../middleware/index.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const routineId = "22222222-2222-4222-8222-222222222222";

const mockRoutineService = vi.hoisted(() => ({
  get: vi.fn(),
  runRoutine: vi.fn(),
  firePublicTrigger: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(),
  }),
  logActivity: mockLogActivity,
  routineService: () => mockRoutineService,
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
  app.use("/api", routineRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("routine run routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRoutineService.get.mockResolvedValue({
      id: routineId,
      companyId,
      assigneeAgentId: null,
      status: "active",
    });
  });

  it("returns 202 for successful manual routine runs", async () => {
    mockRoutineService.runRoutine.mockResolvedValue({
      id: "run-1",
      routineId,
      companyId,
      source: "manual",
      status: "issue_created",
      linkedIssueId: "issue-1",
    });

    const res = await request(createApp()).post(`/api/routines/${routineId}/run`).send({});

    expect(res.status).toBe(202);
    expect(res.body).toEqual(expect.objectContaining({
      id: "run-1",
      status: "issue_created",
      linkedIssueId: "issue-1",
    }));
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId,
        action: "routine.run_triggered",
        entityId: "run-1",
        details: expect.objectContaining({
          routineId,
          status: "issue_created",
        }),
      }),
    );
  });

  it("returns 500 when a manual routine run fails after dispatch", async () => {
    mockRoutineService.runRoutine.mockResolvedValue({
      id: "run-failed",
      routineId,
      companyId,
      source: "manual",
      status: "failed",
      failureReason: "Routine assignee wakeup did not queue a heartbeat run",
      linkedIssueId: null,
    });

    const res = await request(createApp()).post(`/api/routines/${routineId}/run`).send({});

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: "Routine assignee wakeup did not queue a heartbeat run",
      run: expect.objectContaining({
        id: "run-failed",
        status: "failed",
        failureReason: "Routine assignee wakeup did not queue a heartbeat run",
      }),
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId,
        action: "routine.run_triggered",
        entityId: "run-failed",
        details: expect.objectContaining({
          routineId,
          status: "failed",
        }),
      }),
    );
  });

  it("returns 500 when a public webhook trigger dispatch fails", async () => {
    mockRoutineService.firePublicTrigger.mockResolvedValue({
      id: "run-webhook-failed",
      routineId,
      companyId,
      source: "webhook",
      status: "failed",
      failureReason: "queue unavailable",
      linkedIssueId: null,
    });

    const res = await request(createApp())
      .post("/api/routine-triggers/public/public-trigger-id/fire")
      .send({ origin: "test" });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: "queue unavailable",
      run: expect.objectContaining({
        id: "run-webhook-failed",
        status: "failed",
        failureReason: "queue unavailable",
      }),
    });
  });
});
