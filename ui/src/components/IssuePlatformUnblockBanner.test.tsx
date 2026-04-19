// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Agent, Issue } from "@paperclipai/shared";

vi.mock("@/lib/router", () => ({
  Link: ({ children, className, ...props }: React.ComponentProps<"a">) => (
    <a className={className} {...props}>{children}</a>
  ),
}));

import { IssuePlatformUnblockBanner } from "./IssuePlatformUnblockBanner";

type IssuePlatformUnblockSummary = NonNullable<Issue["platformUnblockSummary"]>;

function createSummary(overrides: Partial<IssuePlatformUnblockSummary> = {}): IssuePlatformUnblockSummary {
  return {
    mode: "platform",
    primaryCategory: "qa_writeback_gate",
    secondaryCategories: [],
    primaryOwnerRole: "qa_writeback_owner",
    primaryOwnerAgentId: "agent-qa",
    escalationOwnerRole: "tech_lead",
    escalationOwnerAgentId: "agent-tech-lead",
    authoritativeSignalSource: "close_gate_block",
    authoritativeSignalAt: "2026-04-20T10:00:00.000Z",
    authoritativeRunId: "run-123",
    recommendedNextAction: "Repair QA writeback settlement before asking engineering to retry.",
    recoveryCriteria: "Record one settled non-alerting QA state.",
    nextCheckpointAt: "2026-04-20T10:30:00.000Z",
    blocksExecutionRetry: true,
    blocksCloseOut: true,
    canRetryEngineering: false,
    canCloseUpstream: false,
    recoveryKind: null,
    commentVisibility: null,
    evidence: [
      {
        kind: "run",
        label: "Latest terminal run",
        href: "/PAP/agents/quality-lead/runs/run-123",
        at: "2026-04-20T10:00:00.000Z",
      },
      {
        kind: "activity",
        label: "Close gate blocked",
        href: "/PAP/issues/CMPA-170",
        at: "2026-04-20T10:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

function createAgent(id: string, name: string): Agent {
  return {
    id,
    companyId: "company-1",
    name,
    role: "engineer",
    title: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    lastHeartbeatAt: null,
    icon: "code",
    metadata: null,
    createdAt: new Date("2026-04-20T00:00:00.000Z"),
    updatedAt: new Date("2026-04-20T00:00:00.000Z"),
    urlKey: name.toLowerCase().replace(/\s+/g, "-"),
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
  };
}

describe("IssuePlatformUnblockBanner", () => {
  it("renders the owner, next action, and authoritative run for platform blockers", () => {
    const summary = createSummary();
    const agentMap = new Map<string, Agent>([
      ["agent-qa", createAgent("agent-qa", "QA Owner")],
      ["agent-tech-lead", createAgent("agent-tech-lead", "Tech Lead")],
    ]);

    const html = renderToStaticMarkup(
      <IssuePlatformUnblockBanner
        summary={summary}
        agentMap={agentMap}
      />,
    );

    expect(html).toContain("Platform blocker");
    expect(html).toContain("QA Owner");
    expect(html).toContain("Tech Lead");
    expect(html).toContain("Repair QA writeback settlement before asking engineering to retry.");
    expect(html).toContain("Record one settled non-alerting QA state.");
    expect(html).toContain("/PAP/agents/quality-lead/runs/run-123");
    expect(html).toContain("Latest terminal run");
  });

  it("stays hidden for product-mode issues without an active platform blocker", () => {
    const html = renderToStaticMarkup(
      <IssuePlatformUnblockBanner
        summary={createSummary({
          mode: "product",
          primaryCategory: null,
          primaryOwnerRole: null,
          primaryOwnerAgentId: null,
          escalationOwnerRole: null,
          escalationOwnerAgentId: null,
          authoritativeSignalSource: null,
          authoritativeSignalAt: null,
          authoritativeRunId: null,
          recommendedNextAction: null,
          recoveryCriteria: null,
          blocksExecutionRetry: false,
          blocksCloseOut: false,
          canRetryEngineering: true,
          canCloseUpstream: true,
          evidence: [],
        })}
        agentMap={new Map()}
      />,
    );

    expect(html).toBe("");
  });
});
