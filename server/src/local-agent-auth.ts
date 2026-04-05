import { createLocalAgentJwt } from "./agent-auth-jwt.js";

export interface ResolveLocalAgentAuthTokenInput {
  supportsLocalAgentJwt: boolean;
  agentId: string;
  companyId: string;
  adapterType: string;
  runId: string;
}

export class LocalAgentAuthUnavailableError extends Error {
  readonly code = "local_agent_auth_unavailable";

  constructor(adapterType: string) {
    super(
      `Local agent authentication unavailable for adapter "${adapterType}": PAPERCLIP_AGENT_JWT_SECRET is missing or not loaded`,
    );
    this.name = "LocalAgentAuthUnavailableError";
  }
}

export function resolveLocalAgentAuthToken(input: ResolveLocalAgentAuthTokenInput) {
  if (!input.supportsLocalAgentJwt) return null;

  const authToken = createLocalAgentJwt(
    input.agentId,
    input.companyId,
    input.adapterType,
    input.runId,
  );
  if (authToken) return authToken;

  throw new LocalAgentAuthUnavailableError(input.adapterType);
}
