import { describe, expect, it } from "vitest";
import { buildIssueRuntimeState } from "../services/issue-runtime-state.ts";

describe("issue-runtime-state", () => {
  it("marks assigned child issues without a proposed plan as awaiting review", () => {
    const runtimeState = buildIssueRuntimeState({
      status: "todo",
      parentId: "parent-1",
      assigneeAgentId: "agent-1",
      planProposedAt: null,
      planApprovedAt: null,
    });

    expect(runtimeState.execution).toEqual(expect.objectContaining({
      activation: "awaiting_review",
      diagnosis: "plan_review_pending",
      canStart: false,
    }));
  });

  it("keeps qa_stage child issues runnable without a work plan", () => {
    const runtimeState = buildIssueRuntimeState({
      status: "todo",
      originKind: "qa_stage",
      parentId: "parent-1",
      assigneeAgentId: "agent-1",
      planProposedAt: null,
      planApprovedAt: null,
    });

    expect(runtimeState.execution).toEqual(expect.objectContaining({
      activation: "runnable",
      diagnosis: null,
      canStart: true,
    }));
  });
});
