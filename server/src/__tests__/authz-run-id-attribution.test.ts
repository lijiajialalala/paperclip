import { describe, expect, it } from "vitest";
import { getActorInfo } from "../routes/authz.js";

describe("actor run id attribution", () => {
  it("does not trust board request run ids for FK-backed writes", () => {
    const actor = getActorInfo({
      actor: {
        type: "board",
        userId: "board-user",
        runId: "99999999-9999-4999-8999-999999999999",
        source: "local_implicit",
      },
    } as any);

    expect(actor).toEqual({
      actorType: "user",
      actorId: "board-user",
      agentId: null,
      runId: null,
    });
  });

  it("preserves agent run ids after auth middleware validation", () => {
    const actor = getActorInfo({
      actor: {
        type: "agent",
        agentId: "22222222-2222-4222-8222-222222222222",
        companyId: "11111111-1111-4111-8111-111111111111",
        runId: "33333333-3333-4333-8333-333333333333",
        source: "agent_jwt",
      },
    } as any);

    expect(actor).toEqual({
      actorType: "agent",
      actorId: "22222222-2222-4222-8222-222222222222",
      agentId: "22222222-2222-4222-8222-222222222222",
      runId: "33333333-3333-4333-8333-333333333333",
    });
  });
});
