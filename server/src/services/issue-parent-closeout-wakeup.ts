import { logger } from "../middleware/logger.js";

type WakeupTriggerDetail = "manual" | "ping" | "callback" | "system";
type WakeupSource = "timer" | "assignment" | "on_demand" | "automation";

export interface IssueParentCloseoutWakeDeps {
  wakeup: (
    agentId: string,
    opts: {
      source?: WakeupSource;
      triggerDetail?: WakeupTriggerDetail;
      reason?: string | null;
      payload?: Record<string, unknown> | null;
      requestedByActorType?: "user" | "agent" | "system";
      requestedByActorId?: string | null;
      contextSnapshot?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
}

export interface ParentIssueCloseoutWakeReason {
  reason: "child_issue_completed" | "child_issue_blocked";
  mutation: "child_done" | "child_blocked";
  source: "issue.child_completed" | "issue.child_blocked";
  logMessage: string;
}

export function resolveParentIssueCloseoutWakeReason(input: {
  previousStatus: string | null | undefined;
  nextStatus: string | null | undefined;
}): ParentIssueCloseoutWakeReason | null {
  if (input.nextStatus === "done" && input.previousStatus !== "done") {
    return {
      reason: "child_issue_completed",
      mutation: "child_done",
      source: "issue.child_completed",
      logMessage: "failed to wake parent issue assignee on child completion",
    };
  }

  if (input.nextStatus === "blocked" && input.previousStatus !== "blocked") {
    return {
      reason: "child_issue_blocked",
      mutation: "child_blocked",
      source: "issue.child_blocked",
      logMessage: "failed to wake parent issue assignee on child blocked update",
    };
  }

  return null;
}

export function buildParentIssueCloseoutWake(input: {
  parentIssue: { id: string; assigneeAgentId: string | null } | null;
  childIssue: { id: string };
  closeoutReason: ParentIssueCloseoutWakeReason;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
}) {
  if (!input.parentIssue?.assigneeAgentId) return null;

  return {
    agentId: input.parentIssue.assigneeAgentId,
    logMessage: input.closeoutReason.logMessage,
    wakeup: {
      source: "automation" as const,
      triggerDetail: "system" as const,
      reason: input.closeoutReason.reason,
      payload: {
        issueId: input.parentIssue.id,
        childIssueId: input.childIssue.id,
        mutation: input.closeoutReason.mutation,
      },
      requestedByActorType: input.requestedByActorType,
      requestedByActorId: input.requestedByActorId ?? null,
      contextSnapshot: {
        issueId: input.parentIssue.id,
        childIssueId: input.childIssue.id,
        source: input.closeoutReason.source,
        wakeReason: input.closeoutReason.reason,
      },
    },
  };
}

export function queueParentIssueCloseoutWake(input: {
  heartbeat: IssueParentCloseoutWakeDeps;
  parentIssue: { id: string; assigneeAgentId: string | null } | null;
  childIssue: { id: string };
  closeoutReason: ParentIssueCloseoutWakeReason;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  rethrowOnError?: boolean;
}) {
  const wake = buildParentIssueCloseoutWake(input);
  if (!wake) return;

  return input.heartbeat.wakeup(wake.agentId, wake.wakeup).catch((err) => {
    logger.warn(
      {
        err,
        parentIssueId: input.parentIssue?.id ?? null,
        childIssueId: input.childIssue.id,
      },
      wake.logMessage,
    );
    if (input.rethrowOnError) throw err;
    return null;
  });
}
