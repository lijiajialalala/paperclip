import { describe, expect, it } from "vitest";
import {
  getIssueExecutionPlanGateReason,
  issueIsInRoutineExecutionLane,
} from "../services/issue-plan-policy.ts";

describe("issue-plan-policy", () => {
  it("treats execution before proposal as missing_plan_approval even if a plan was approved later", () => {
    const reason = getIssueExecutionPlanGateReason(
      {
        parentId: "parent-1",
        assigneeAgentId: "agent-1",
        planProposedAt: "2026-04-08T00:10:00.000Z",
        planApprovedAt: "2026-04-08T00:20:00.000Z",
      },
      { executionStartedAt: "2026-04-08T00:05:00.000Z" },
    );

    expect(reason).toBe("missing_plan_approval");
  });

  it("treats execution before approval as plan_pending_review even if approval arrived before settlement", () => {
    const reason = getIssueExecutionPlanGateReason(
      {
        parentId: "parent-1",
        assigneeAgentId: "agent-1",
        planProposedAt: "2026-04-08T00:10:00.000Z",
        planApprovedAt: "2026-04-08T00:20:00.000Z",
      },
      { executionStartedAt: "2026-04-08T00:15:00.000Z" },
    );

    expect(reason).toBe("plan_pending_review");
  });

  it("allows execution only when it starts after plan approval", () => {
    const reason = getIssueExecutionPlanGateReason(
      {
        parentId: "parent-1",
        assigneeAgentId: "agent-1",
        planProposedAt: "2026-04-08T00:10:00.000Z",
        planApprovedAt: "2026-04-08T00:20:00.000Z",
      },
      { executionStartedAt: "2026-04-08T00:21:00.000Z" },
    );

    expect(reason).toBeNull();
  });

  it("does not require a work plan for routine execution child issues", () => {
    const reason = getIssueExecutionPlanGateReason(
      {
        originKind: "routine_execution",
        parentId: "parent-1",
        assigneeAgentId: "agent-1",
        planProposedAt: null,
        planApprovedAt: null,
      },
      { executionStartedAt: "2026-04-08T00:05:00.000Z" },
    );

    expect(reason).toBeNull();
  });

  it("treats descendant issues under a routine_execution ancestor as part of the routine lane", () => {
    expect(
      issueIsInRoutineExecutionLane(
        {
          originKind: "manual",
          inRoutineExecutionLane: null,
        },
        [
          { originKind: "manual" },
          { originKind: "routine_execution" },
        ],
      ),
    ).toBe(true);
  });
});
