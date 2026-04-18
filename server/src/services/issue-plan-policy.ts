export type IssuePlanPolicyRecord = {
  originKind?: string | null;
  parentId?: string | null;
  assigneeAgentId?: string | null;
  planProposedAt?: Date | string | null;
  planApprovedAt?: Date | string | null;
  status?: string | null;
};

export type IssueExecutionPlanGateReason =
  | "missing_plan_approval"
  | "plan_pending_review";

function readDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function issueRequiresApprovedPlan(issue: IssuePlanPolicyRecord): boolean {
  if (issue.originKind === "routine_execution") return false;
  return Boolean(issue.parentId && issue.assigneeAgentId);
}

export function getIssueExecutionPlanGateReason(
  issue: IssuePlanPolicyRecord,
  opts?: {
    executionStartedAt?: Date | string | null;
  },
): IssueExecutionPlanGateReason | null {
  const requiresApprovedPlan = issueRequiresApprovedPlan(issue);
  const planProposedAt = readDate(issue.planProposedAt);
  const planApprovedAt = readDate(issue.planApprovedAt);
  const executionStartedAt = readDate(opts?.executionStartedAt);

  if (executionStartedAt) {
    if (!planProposedAt) {
      return requiresApprovedPlan ? "missing_plan_approval" : null;
    }
    if (requiresApprovedPlan && executionStartedAt < planProposedAt) {
      return "missing_plan_approval";
    }
    if (!planApprovedAt || executionStartedAt < planApprovedAt) {
      return "plan_pending_review";
    }
    return null;
  }

  if (planProposedAt) {
    if (!planApprovedAt) return "plan_pending_review";
    return null;
  }
  if (planApprovedAt) return null;
  return requiresApprovedPlan ? "missing_plan_approval" : null;
}

export function describeIssueExecutionPlanGateError(
  reason: IssueExecutionPlanGateReason,
  action: string,
): string {
  if (reason === "plan_pending_review") {
    return `Plan is pending review and must be approved before ${action}`;
  }
  return `Assigned child issue must propose a plan and get it approved before ${action}`;
}
