import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

type PlanWorkflowActor = {
  actorType: "agent" | "user";
  actorId: string;
  agentId: string | null;
  runId: string | null;
};

type IssueCommentActor = {
  agentId?: string;
  userId?: string;
  runId?: string | null;
};

type IssueSummary = {
  id: string;
  companyId: string;
  identifier?: string | null;
  assigneeAgentId?: string | null;
};

type AncestorIssue = {
  id: string;
  identifier?: string | null;
  assigneeAgentId?: string | null;
};

type IssueServiceDeps = {
  addComment: (issueId: string, body: string, actor: IssueCommentActor) => Promise<{ id: string }>;
  getAncestors: (issueId: string) => Promise<AncestorIssue[]>;
};

type AgentServiceDeps = {
  getById: (agentId: string) => Promise<{ name?: string | null } | null>;
};

type HeartbeatDeps = {
  wakeup: (
    agentId: string,
    opts: {
      source?: "timer" | "assignment" | "on_demand" | "automation";
      triggerDetail?: "manual" | "ping" | "callback" | "system";
      reason?: string | null;
      payload?: Record<string, unknown> | null;
      requestedByActorType?: "user" | "agent" | "system";
      requestedByActorId?: string | null;
      contextSnapshot?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
};

type LogActivityDeps = (
  ...args: [Db, {
    companyId: string;
    actorType: "user" | "agent" | "system";
    actorId: string;
    agentId?: string | null;
    runId?: string | null;
    action: string;
    entityType: "issue";
    entityId: string;
    details?: Record<string, unknown>;
  }]
) => Promise<unknown>;

function toCommentActor(actor: PlanWorkflowActor): IssueCommentActor {
  return {
    agentId: actor.agentId ?? undefined,
    userId: actor.actorType === "user" ? actor.actorId : undefined,
    runId: actor.runId,
  };
}

async function resolveActorName(input: {
  actor: PlanWorkflowActor;
  agentsSvc: AgentServiceDeps;
  fallbackUserName: string;
}) {
  if (!input.actor.agentId) {
    return input.fallbackUserName;
  }

  try {
    return (await input.agentsSvc.getById(input.actor.agentId))?.name ?? "Agent";
  } catch (err) {
    logger.warn(
      { err, agentId: input.actor.agentId },
      "failed to resolve actor name for issue plan side effect",
    );
    return "Agent";
  }
}

async function safeGetAncestors(issueSvc: IssueServiceDeps, issueId: string) {
  try {
    return await issueSvc.getAncestors(issueId);
  } catch (err) {
    logger.warn({ err, issueId }, "failed to load issue ancestors for plan side effect");
    return [];
  }
}

export async function runPlanProposalSideEffects(input: {
  db: Db;
  issueSvc: IssueServiceDeps;
  agentsSvc: AgentServiceDeps;
  heartbeat: HeartbeatDeps;
  logActivity: LogActivityDeps;
  issue: IssueSummary;
  proposal: { commentId: string; approvalId: string };
  planText: string;
  actor: PlanWorkflowActor;
}) {
  const actorName = await resolveActorName({
    actor: input.actor,
    agentsSvc: input.agentsSvc,
    fallbackUserName: "User",
  });
  const ancestors = await safeGetAncestors(input.issueSvc, input.issue.id);
  const directParent = ancestors[0] ?? null;
  const rootAncestor = ancestors.length > 0 ? ancestors[ancestors.length - 1] : null;

  if (rootAncestor) {
    try {
      const summarySnippet =
        input.planText.length > 1500 ? `${input.planText.slice(0, 1500)}...` : input.planText;
      await input.issueSvc.addComment(
        rootAncestor.id,
        `📋 [${actorName} on ${input.issue.identifier ?? input.issue.id}] **Plan:**\n${summarySnippet}`,
        toCommentActor(input.actor),
      );
    } catch (err) {
      logger.warn(
        { err, issueId: input.issue.id, rootAncestorId: rootAncestor.id },
        "failed to mirror proposed plan summary to root ancestor",
      );
    }
  }

  try {
    await input.logActivity(input.db, {
      companyId: input.issue.companyId,
      actorType: input.actor.actorType,
      actorId: input.actor.actorId,
      agentId: input.actor.agentId,
      runId: input.actor.runId,
      action: "issue.plan_proposed",
      entityType: "issue",
      entityId: input.issue.id,
      details: {
        planSnippet: input.planText.slice(0, 120),
        commentId: input.proposal.commentId,
        approvalId: input.proposal.approvalId,
      },
    });
  } catch (err) {
    logger.warn(
      { err, issueId: input.issue.id, approvalId: input.proposal.approvalId },
      "failed to log proposed plan activity",
    );
  }

  const agentsToWake = new Set<string>();
  if (directParent?.assigneeAgentId && directParent.assigneeAgentId !== input.issue.assigneeAgentId) {
    agentsToWake.add(directParent.assigneeAgentId);
  }
  if (rootAncestor?.assigneeAgentId && rootAncestor.assigneeAgentId !== input.issue.assigneeAgentId) {
    agentsToWake.add(rootAncestor.assigneeAgentId);
  }

  await Promise.all([...agentsToWake].map(async (agentId) => {
    try {
      await input.heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "child_plan_proposed",
        payload: {
          issueId: directParent?.id ?? input.issue.id,
          childIssueId: input.issue.id,
          commentId: input.proposal.commentId,
          approvalId: input.proposal.approvalId,
        },
        requestedByActorType: input.actor.actorType,
        requestedByActorId: input.actor.actorId,
        contextSnapshot: {
          issueId: directParent?.id ?? input.issue.id,
          childIssueId: input.issue.id,
          source: "issue.plan_proposed",
          wakeReason: "child_plan_proposed",
        },
      });
    } catch (err) {
      logger.warn({ err, issueId: input.issue.id, agentId }, "failed to wake agent on plan proposal");
    }
  }));
}

export async function runPlanReviewSideEffects(input: {
  db: Db;
  issueSvc: IssueServiceDeps;
  agentsSvc: AgentServiceDeps;
  heartbeat: HeartbeatDeps;
  logActivity: LogActivityDeps;
  issue: IssueSummary;
  action: "approved" | "rejected";
  actor: PlanWorkflowActor;
  feedback?: string;
}) {
  const actorName = await resolveActorName({
    actor: input.actor,
    agentsSvc: input.agentsSvc,
    fallbackUserName: "Board",
  });

  const icon = input.action === "approved" ? "✅" : "❌";
  const bodyAction = input.action === "approved" ? "approved" : "rejected";
  const bodySuffix =
    input.action === "approved"
      ? "You may proceed."
      : `\n\n**Feedback:**\n${input.feedback ?? ""}`;

  let reviewCommentId: string | null = null;
  try {
    const reviewComment = await input.issueSvc.addComment(
      input.issue.id,
      `${icon} Plan ${bodyAction} by ${actorName}. ${bodySuffix}`,
      toCommentActor(input.actor),
    );
    reviewCommentId = reviewComment.id;
  } catch (err) {
    logger.warn(
      { err, issueId: input.issue.id, action: input.action },
      "failed to add plan review comment",
    );
  }

  const ancestors = await safeGetAncestors(input.issueSvc, input.issue.id);
  const rootAncestor = ancestors.length > 0 ? ancestors[ancestors.length - 1] : null;
  if (rootAncestor) {
    try {
      await input.issueSvc.addComment(
        rootAncestor.id,
        `${icon} [${actorName}] ${input.action === "approved" ? "Approved" : "Rejected"} plan for ${input.issue.identifier ?? input.issue.id}`,
        toCommentActor(input.actor),
      );
    } catch (err) {
      logger.warn(
        { err, issueId: input.issue.id, rootAncestorId: rootAncestor.id, action: input.action },
        "failed to mirror plan review summary to root ancestor",
      );
    }
  }

  try {
    await input.logActivity(input.db, {
      companyId: input.issue.companyId,
      actorType: input.actor.actorType,
      actorId: input.actor.actorId,
      agentId: input.actor.agentId,
      runId: input.actor.runId,
      action: `issue.plan_${input.action}`,
      entityType: "issue",
      entityId: input.issue.id,
    });
  } catch (err) {
    logger.warn(
      { err, issueId: input.issue.id, action: input.action },
      `failed to log plan ${input.action} activity`,
    );
  }

  if (!input.issue.assigneeAgentId) {
    return { commentId: reviewCommentId };
  }

  try {
    await input.heartbeat.wakeup(input.issue.assigneeAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: `plan_${input.action}`,
      payload: {
        issueId: input.issue.id,
        ...(reviewCommentId ? { commentId: reviewCommentId } : {}),
      },
      requestedByActorType: input.actor.actorType,
      requestedByActorId: input.actor.actorId,
      contextSnapshot: {
        issueId: input.issue.id,
        taskId: input.issue.id,
        ...(reviewCommentId ? { commentId: reviewCommentId, wakeCommentId: reviewCommentId } : {}),
        source: `issue.plan_${input.action}`,
        wakeReason: `plan_${input.action}`,
      },
    });
  } catch (err) {
    logger.warn(
      { err, issueId: input.issue.id, action: input.action },
      `failed to wake assignee on plan ${input.action}`,
    );
  }

  return { commentId: reviewCommentId };
}
