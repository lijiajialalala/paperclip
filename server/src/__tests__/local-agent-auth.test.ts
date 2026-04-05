import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LocalAgentAuthUnavailableError,
  resolveLocalAgentAuthToken,
} from "../local-agent-auth.js";

describe("local agent auth token resolution", () => {
  const secretEnv = "PAPERCLIP_AGENT_JWT_SECRET";
  const originalSecret = process.env[secretEnv];

  beforeEach(() => {
    process.env[secretEnv] = "test-secret";
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env[secretEnv];
    else process.env[secretEnv] = originalSecret;
  });

  it("returns null for adapters that do not require local agent JWT auth", () => {
    const token = resolveLocalAgentAuthToken({
      supportsLocalAgentJwt: false,
      agentId: "agent-1",
      companyId: "company-1",
      adapterType: "openclaw_gateway",
      runId: "run-1",
    });

    expect(token).toBeNull();
  });

  it("returns a JWT when local agent auth is configured", () => {
    const token = resolveLocalAgentAuthToken({
      supportsLocalAgentJwt: true,
      agentId: "agent-1",
      companyId: "company-1",
      adapterType: "codex_local",
      runId: "run-1",
    });

    expect(typeof token).toBe("string");
    expect(token).toContain(".");
  });

  it("throws when a local adapter requires JWT auth but the secret is missing", () => {
    delete process.env[secretEnv];

    expect(() =>
      resolveLocalAgentAuthToken({
        supportsLocalAgentJwt: true,
        agentId: "agent-1",
        companyId: "company-1",
        adapterType: "codex_local",
        runId: "run-1",
      }),
    ).toThrowError(LocalAgentAuthUnavailableError);
  });
});
