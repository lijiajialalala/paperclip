import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { actorMiddleware, resolveTrustedAgentRunId } from "../middleware/auth.js";

describe("actor middleware run id attribution", () => {
  it("ignores x-paperclip-run-id for local board requests", async () => {
    const app = express();
    app.use(actorMiddleware({} as any, { deploymentMode: "local_trusted" }));
    app.get("/whoami", (req, res) => res.json(req.actor));

    const res = await request(app)
      .get("/whoami")
      .set("x-paperclip-run-id", "99999999-9999-4999-8999-999999999999");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
    }));
    expect(res.body.runId).toBeUndefined();
  });

  it("accepts only syntactically valid agent run ids that exist in heartbeat_runs", async () => {
    const validRunId = "33333333-3333-4333-8333-333333333333";
    const where = vi.fn(async () => [{ id: validRunId }]);
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));

    const trustedRunId = await resolveTrustedAgentRunId({ select } as any, {
      companyId: "11111111-1111-4111-8111-111111111111",
      agentId: "22222222-2222-4222-8222-222222222222",
      candidateRunIds: ["not-a-uuid", validRunId],
    });

    expect(trustedRunId).toBe(validRunId);
    expect(select).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledTimes(1);
    expect(where).toHaveBeenCalledTimes(1);
  });

  it("drops agent run ids that are not present in heartbeat_runs", async () => {
    const where = vi.fn(async () => []);
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));

    const trustedRunId = await resolveTrustedAgentRunId({ select } as any, {
      companyId: "11111111-1111-4111-8111-111111111111",
      agentId: "22222222-2222-4222-8222-222222222222",
      candidateRunIds: ["33333333-3333-4333-8333-333333333333"],
    });

    expect(trustedRunId).toBeUndefined();
  });
});
