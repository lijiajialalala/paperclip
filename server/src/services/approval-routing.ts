import { eq, isNull, or } from "drizzle-orm";
import { approvals } from "@paperclipai/db";
import {
  APPROVAL_ESCALATION_REASONS,
  APPROVAL_ROUTING_MODES,
} from "@paperclipai/shared";

type ApprovalRoutingMode = (typeof APPROVAL_ROUTING_MODES)[number];
type ApprovalEscalationReason = (typeof APPROVAL_ESCALATION_REASONS)[number];

export type ApprovalActor =
  | {
      actorType: "board";
      userId: string | null;
    }
  | {
      actorType: "agent";
      agentId: string;
    };

export interface ApprovalRoutingFields {
  targetAgentId: string | null;
  targetUserId: string | null;
  routingMode: ApprovalRoutingMode;
  escalatedAt: Date | null;
  escalationReason: ApprovalEscalationReason | null;
}

export interface ApprovalRoutingRecord extends ApprovalRoutingFields {
  type?: string | null;
}

export interface WorkPlanRoutingIssue {
  parentId: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

export interface WorkPlanRoutingParent {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

const BOARD_ROUTING_MODES = new Set<ApprovalRoutingMode>([
  "board_pool",
  "escalated_to_board",
  "timeout_escalated_to_board",
]);

export function defaultWorkPlanApprovalRouting(
  issue: WorkPlanRoutingIssue,
  parent: WorkPlanRoutingParent | null | undefined,
): ApprovalRoutingFields {
  if (issue.parentId && parent) {
    if (parent.assigneeAgentId && parent.assigneeAgentId !== issue.assigneeAgentId) {
      return {
        targetAgentId: parent.assigneeAgentId,
        targetUserId: null,
        routingMode: "parent_assignee_agent",
        escalatedAt: null,
        escalationReason: null,
      };
    }

    if (parent.assigneeUserId && parent.assigneeUserId !== issue.assigneeUserId) {
      return {
        targetAgentId: null,
        targetUserId: parent.assigneeUserId,
        routingMode: "parent_assignee_user",
        escalatedAt: null,
        escalationReason: null,
      };
    }
  }

  return {
    targetAgentId: null,
    targetUserId: null,
    routingMode: "board_pool",
    escalatedAt: null,
    escalationReason: null,
  };
}

export function canActorResolveApproval(
  approval: ApprovalRoutingRecord,
  actor: ApprovalActor,
): boolean {
  if (actor.actorType === "agent") {
    return approval.targetAgentId === actor.agentId;
  }

  if (approval.targetUserId && approval.targetUserId === actor.userId) {
    return true;
  }

  if (BOARD_ROUTING_MODES.has(approval.routingMode)) {
    return true;
  }

  return !approval.targetAgentId && !approval.targetUserId && !approval.routingMode;
}

export function approvalMineCondition(actor: ApprovalActor) {
  if (actor.actorType === "agent") {
    return eq(approvals.targetAgentId, actor.agentId);
  }

  const boardPoolCondition = or(
    eq(approvals.routingMode, "board_pool"),
    eq(approvals.routingMode, "escalated_to_board"),
    eq(approvals.routingMode, "timeout_escalated_to_board"),
  )!;

  if (!actor.userId) {
    return or(boardPoolCondition, isNull(approvals.routingMode))!;
  }

  return or(
    eq(approvals.targetUserId, actor.userId),
    boardPoolCondition,
    isNull(approvals.routingMode),
  )!;
}

export function approvalDecisionActor(actor: ApprovalActor) {
  if (actor.actorType === "agent") {
    return {
      decidedByUserId: null,
      decidedByAgentId: actor.agentId,
    };
  }

  return {
    decidedByUserId: actor.userId ?? "board",
    decidedByAgentId: null,
  };
}
