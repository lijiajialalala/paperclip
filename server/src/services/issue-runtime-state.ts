import type { Issue } from "@paperclipai/shared";

import { getIssueExecutionPlanGateReason } from "./issue-plan-policy.js";

type IssueRuntimeExecutionState = "idle" | "active" | "stalled";
type IssueRuntimeActivationState =
  | "runnable"
  | "awaiting_review"
  | "awaiting_human"
  | "blocked"
  | "closed";
type IssueRuntimeExecutionDiagnosis =
  | "plan_review_pending"
  | "waiting_for_human_reply"
  | "no_active_run"
  | null;
type IssueRuntimeState = {
  lifecycle: {
    status: string;
    isTerminal: boolean;
    isBlocked: boolean;
  };
  review: {
    state: "none" | "pending" | "approved";
    kind: "work_plan" | null;
    requestedAt: Date | string | null;
    approvedAt: Date | string | null;
  };
  humanWait: {
    state: "none" | "reply_needed";
    requestedAt: Date | string | null;
    commentId: string | null;
  };
  execution: {
    state: IssueRuntimeExecutionState;
    activation: IssueRuntimeActivationState;
    diagnosis: IssueRuntimeExecutionDiagnosis;
    canStart: boolean;
    checkoutRunId: string | null;
    executionRunId: string | null;
    executionLockedAt: Date | string | null;
    lastExecutionSignalAt: string | null;
    stalledSince: string | null;
  };
};

type RuntimeIssueStatusTruthLike = {
  executionDiagnosis?: string | null;
  executionState?: string | null;
  lastExecutionSignalAt?: string | null;
  stalledSince?: string | null;
} | null | undefined;

type RuntimeIssueInput = {
  originKind?: string | null;
  parentId?: string | null;
  assigneeAgentId?: string | null;
  status: string;
  statusTruthSummary?: RuntimeIssueStatusTruthLike;
  planProposedAt?: Date | string | null;
  planApprovedAt?: Date | string | null;
  replyNeededForMe?: boolean | null;
  replyNeededAt?: Date | string | null;
  replyNeededCommentId?: string | null;
  checkoutRunId?: string | null;
  executionRunId?: string | null;
  executionLockedAt?: Date | string | null;
};

function hasPendingPlanReview(issue: RuntimeIssueInput) {
  return Boolean(issue.planProposedAt) && !issue.planApprovedAt;
}

function hasHumanReplyWait(issue: RuntimeIssueInput) {
  return Boolean(issue.replyNeededForMe || issue.replyNeededAt || issue.replyNeededCommentId);
}

function coerceExecutionState(value: string | null | undefined): IssueRuntimeExecutionState | null {
  return value === "idle" || value === "active" || value === "stalled" ? value : null;
}

function coerceExecutionDiagnosis(value: string | null | undefined): IssueRuntimeExecutionDiagnosis {
  if (
    value === "plan_review_pending"
    || value === "waiting_for_human_reply"
    || value === "no_active_run"
  ) {
    return value;
  }
  return null;
}

export function buildIssueRuntimeState(issue: RuntimeIssueInput): IssueRuntimeState {
  const reviewPending = hasPendingPlanReview(issue);
  const planGateReason = getIssueExecutionPlanGateReason(issue);
  const humanReplyWait = hasHumanReplyWait(issue);
  const statusSummary = issue.statusTruthSummary ?? null;
  const lifecycle = {
    status: issue.status,
    isTerminal: issue.status === "done" || issue.status === "cancelled",
    isBlocked: issue.status === "blocked",
  } as const;

  const review: IssueRuntimeState["review"] = reviewPending
    ? {
        state: "pending",
        kind: "work_plan",
        requestedAt: issue.planProposedAt ?? null,
        approvedAt: null,
      }
    : issue.planApprovedAt
      ? {
          state: "approved",
          kind: "work_plan",
          requestedAt: issue.planProposedAt ?? null,
          approvedAt: issue.planApprovedAt ?? null,
        }
      : {
          state: "none",
          kind: null,
          requestedAt: null,
          approvedAt: null,
        };

  const humanWait: IssueRuntimeState["humanWait"] = humanReplyWait
    ? {
        state: "reply_needed",
        requestedAt: issue.replyNeededAt ?? null,
        commentId: issue.replyNeededCommentId ?? null,
      }
    : {
        state: "none",
        requestedAt: null,
        commentId: null,
      };

  let activation: IssueRuntimeState["execution"]["activation"] = "runnable";
  if (lifecycle.isTerminal) activation = "closed";
  else if (lifecycle.isBlocked) activation = "blocked";
  else if (planGateReason) activation = "awaiting_review";
  else if (humanWait.state === "reply_needed") activation = "awaiting_human";

  let diagnosis = coerceExecutionDiagnosis(statusSummary?.executionDiagnosis);
  let state: IssueRuntimeState["execution"]["state"] =
    coerceExecutionState(statusSummary?.executionState) ?? (issue.executionRunId ? "active" : "idle");

  if (activation === "awaiting_review") {
    state = "idle";
    diagnosis = "plan_review_pending";
  } else if (activation === "awaiting_human") {
    state = "idle";
    diagnosis = "waiting_for_human_reply";
  } else if (activation === "closed" || activation === "blocked") {
    if (state !== "active") state = "idle";
  }

  return {
    lifecycle,
    review,
    humanWait,
    execution: {
      state,
      activation,
      diagnosis,
      canStart: activation === "runnable",
      checkoutRunId: issue.checkoutRunId ?? null,
      executionRunId: issue.executionRunId ?? null,
      executionLockedAt: issue.executionLockedAt ?? null,
      lastExecutionSignalAt: statusSummary?.lastExecutionSignalAt ?? null,
      stalledSince: statusSummary?.stalledSince ?? null,
    },
  };
}

export function attachIssueRuntimeState<T extends RuntimeIssueInput>(issue: T): T & { runtimeState: IssueRuntimeState } {
  return {
    ...issue,
    runtimeState: buildIssueRuntimeState(issue),
  };
}
