import { and, asc, desc, eq, inArray, notExists, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvalComments, approvals, budgetIncidents, issueApprovals, issues } from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../errors.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { agentService } from "./agents.js";
import { budgetService } from "./budgets.js";
import { notifyHireApproved } from "./hire-hook.js";
import { instanceSettingsService } from "./instance-settings.js";
import {
  approvalMineCondition,
  type ApprovalActor,
} from "./approval-routing.js";

interface ApprovalListOptions {
  status?: string;
  scope?: "mine" | "all";
  actor?: ApprovalActor;
}

interface ApprovalResolutionInput {
  decidedByUserId: string | null;
  decidedByAgentId: string | null;
  decisionNote?: string | null;
}
type LinkedIssuePlanMirrorRecord = {
  id: string;
  status: string;
  planProposedAt: Date | null;
  planApprovedAt: Date | null;
  startedAt: Date | null;
  executionRunId: string | null;
  checkoutRunId: string | null;
};

export function approvalService(db: Db) {
  const agentsSvc = agentService(db);
  const budgets = budgetService(db);
  const instanceSettings = instanceSettingsService(db);
  const canResolveStatuses = new Set(["pending", "revision_requested"]);
  const resolvableStatuses = Array.from(canResolveStatuses);
  type ApprovalRecord = typeof approvals.$inferSelect;
  type ResolutionResult = { approval: ApprovalRecord; applied: boolean };

  function redactApprovalComment<T extends { body: string }>(comment: T, censorUsernameInLogs: boolean): T {
    return {
      ...comment,
      body: redactCurrentUserText(comment.body, { enabled: censorUsernameInLogs }),
    };
  }

  async function getExistingApproval(id: string, database: Db | any = db) {
    const existing = await database
      .select()
      .from(approvals)
      .where(eq(approvals.id, id))
      .then((rows: any[]) => rows[0] ?? null);
    if (!existing) throw notFound("Approval not found");
    return existing;
  }

  async function resolveApproval(
    id: string,
    targetStatus: "approved" | "rejected",
    input: ApprovalResolutionInput,
    database: Db | any = db,
  ): Promise<ResolutionResult> {
    const existing = await getExistingApproval(id, database);
    if (!canResolveStatuses.has(existing.status)) {
      if (existing.status === targetStatus) {
        return { approval: existing, applied: false };
      }
      throw unprocessable(
        `Only pending or revision requested approvals can be ${targetStatus === "approved" ? "approved" : "rejected"}`,
      );
    }

    const now = new Date();
    const updated = await database
      .update(approvals)
      .set({
        status: targetStatus,
        decidedByUserId: input.decidedByUserId,
        decidedByAgentId: input.decidedByAgentId,
        decisionNote: input.decisionNote ?? null,
        decidedAt: now,
        updatedAt: now,
      })
      .where(and(eq(approvals.id, id), inArray(approvals.status, resolvableStatuses)))
      .returning()
      .then((rows: any[]) => rows[0] ?? null);

    if (updated) {
      return { approval: updated, applied: true };
    }

    const latest = await getExistingApproval(id, database);
    if (latest.status === targetStatus) {
      return { approval: latest, applied: false };
    }

    throw unprocessable(
      `Only pending or revision requested approvals can be ${targetStatus === "approved" ? "approved" : "rejected"}`,
    );
  }

  async function listLinkedIssuesForApprovalInternal(
    approvalId: string,
    database: Db | any = db,
  ): Promise<LinkedIssuePlanMirrorRecord[]> {
    const existing = await getExistingApproval(approvalId, database);
    return database
      .select({
        id: issues.id,
        status: issues.status,
        planProposedAt: issues.planProposedAt,
        planApprovedAt: issues.planApprovedAt,
        startedAt: issues.startedAt,
        executionRunId: issues.executionRunId,
        checkoutRunId: issues.checkoutRunId,
      })
      .from(issueApprovals)
      .innerJoin(issues, eq(issueApprovals.issueId, issues.id))
      .where(
        and(
          eq(issueApprovals.approvalId, approvalId),
          eq(issueApprovals.companyId, existing.companyId),
        ),
      )
      .orderBy(desc(issueApprovals.createdAt));
  }

  async function assertWorkPlanSettlementAllowed(
    approval: typeof approvals.$inferSelect,
    targetStatus: "approved" | "rejected",
    database: Db | any = db,
  ): Promise<LinkedIssuePlanMirrorRecord[]> {
    if (approval.type !== "work_plan") return [];

    const linkedIssues = await listLinkedIssuesForApprovalInternal(approval.id, database);
    if (linkedIssues.length === 0) {
      throw conflict("Work plan approval has no linked issues; manual repair required");
    }

    const uniqueIssueIds = Array.from(new Set(linkedIssues.map((issue) => issue.id)));
    const liveWorkPlanLinks = await database
      .select({
        issueId: issueApprovals.issueId,
        approvalId: approvals.id,
      })
      .from(issueApprovals)
      .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
      .where(
        and(
          inArray(issueApprovals.issueId, uniqueIssueIds),
          eq(issueApprovals.companyId, approval.companyId),
          eq(approvals.companyId, approval.companyId),
          eq(approvals.type, "work_plan"),
          inArray(approvals.status, resolvableStatuses),
        ),
      )
      .orderBy(desc(issueApprovals.createdAt));

    const liveApprovalIdsByIssue = new Map<string, Set<string>>();
    for (const liveLink of liveWorkPlanLinks) {
      const issueApprovalIds = liveApprovalIdsByIssue.get(liveLink.issueId) ?? new Set<string>();
      issueApprovalIds.add(liveLink.approvalId);
      liveApprovalIdsByIssue.set(liveLink.issueId, issueApprovalIds);
    }

    for (const issueId of uniqueIssueIds) {
      const liveApprovalIds = Array.from(liveApprovalIdsByIssue.get(issueId) ?? []);
      if (liveApprovalIds.length !== 1 || liveApprovalIds[0] !== approval.id) {
        throw conflict("Issue has multiple live work plan approvals; manual repair required");
      }
    }

    if (targetStatus === "approved") {
      const executionAlreadyStarted = linkedIssues.some((linkedIssue) =>
        linkedIssue.status === "in_progress"
        || linkedIssue.status === "done"
        || linkedIssue.status === "blocked"
        || Boolean(linkedIssue.executionRunId)
        || Boolean(linkedIssue.checkoutRunId)
      );
      if (executionAlreadyStarted) {
        throw conflict(
          "Cannot approve a plan after execution has already started. Return the issue to review and rerun after approval.",
        );
      }
    }

    return linkedIssues;
  }

  async function resolveWithLinkedIssueSync(
    id: string,
    targetStatus: "approved" | "rejected",
    input: ApprovalResolutionInput,
  ) {
    const outcome = await db.transaction(async (tx) => {
      const existing = await getExistingApproval(id, tx as unknown as Db);
      if (!canResolveStatuses.has(existing.status)) {
        if (existing.status === targetStatus) {
          return { approval: existing, applied: false, linkedIssues: [] as LinkedIssuePlanMirrorRecord[] };
        }
        throw unprocessable(
          `Only pending or revision requested approvals can be ${targetStatus === "approved" ? "approved" : "rejected"}`,
        );
      }

      const linkedIssues = await assertWorkPlanSettlementAllowed(
        existing,
        targetStatus,
        tx as unknown as Db,
      );
      const resolution = await resolveApproval(id, targetStatus, input, tx as unknown as Db);
      if (resolution.applied) {
        await syncResolvedWorkPlanIssuesInternal(
          resolution.approval,
          linkedIssues,
          tx as unknown as Db,
        );
      }
      return {
        ...resolution,
        linkedIssues: resolution.applied ? linkedIssues : [],
      };
    });

    await applyPostResolutionSideEffects(outcome.approval, outcome.applied, targetStatus, input);
    return outcome;
  }

  async function syncResolvedWorkPlanIssuesInternal(
    approval: typeof approvals.$inferSelect,
    linkedIssues: LinkedIssuePlanMirrorRecord[],
    database: Db | any = db,
  ) {
    if (approval.type !== "work_plan") return;

    const resolvedAt = approval.decidedAt ?? new Date();
    for (const linkedIssue of linkedIssues) {
      if (approval.status === "approved") {
        const planStillPending =
          !linkedIssue.planApprovedAt
          && Boolean(linkedIssue.planProposedAt);
        if (!planStillPending) continue;

        await database
          .update(issues)
          .set({
            planApprovedAt: resolvedAt,
            updatedAt: new Date(),
          })
          .where(eq(issues.id, linkedIssue.id));
        continue;
      }

      if (approval.status === "rejected") {
        const planNeedsReset =
          Boolean(linkedIssue.planProposedAt)
          || Boolean(linkedIssue.planApprovedAt);
        if (!planNeedsReset) continue;

        await database
          .update(issues)
          .set({
            planProposedAt: null,
            planApprovedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(issues.id, linkedIssue.id));
      }
    }
  }

  async function applyPostResolutionSideEffects(
    updated: typeof approvals.$inferSelect,
    applied: boolean,
    targetStatus: "approved" | "rejected",
    input: ApprovalResolutionInput,
  ) {
    if (!applied) return;

    if (targetStatus === "approved" && updated.type === "hire_agent") {
      let hireApprovedAgentId: string | null = null;
      const now = new Date();
      const payload = updated.payload as Record<string, unknown>;
      const payloadAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
      if (payloadAgentId) {
        await agentsSvc.activatePendingApproval(payloadAgentId);
        hireApprovedAgentId = payloadAgentId;
      } else {
        const created = await agentsSvc.create(updated.companyId, {
          name: String(payload.name ?? "New Agent"),
          role: String(payload.role ?? "general"),
          title: typeof payload.title === "string" ? payload.title : null,
          reportsTo: typeof payload.reportsTo === "string" ? payload.reportsTo : null,
          capabilities: typeof payload.capabilities === "string" ? payload.capabilities : null,
          adapterType: String(payload.adapterType ?? "process"),
          adapterConfig:
            typeof payload.adapterConfig === "object" && payload.adapterConfig !== null
              ? (payload.adapterConfig as Record<string, unknown>)
              : {},
          budgetMonthlyCents:
            typeof payload.budgetMonthlyCents === "number" ? payload.budgetMonthlyCents : 0,
          metadata:
            typeof payload.metadata === "object" && payload.metadata !== null
              ? (payload.metadata as Record<string, unknown>)
              : null,
          status: "idle",
          spentMonthlyCents: 0,
          permissions: undefined,
          lastHeartbeatAt: null,
        });
        hireApprovedAgentId = created?.id ?? null;
      }
      if (hireApprovedAgentId) {
        const budgetMonthlyCents =
          typeof payload.budgetMonthlyCents === "number" ? payload.budgetMonthlyCents : 0;
        if (budgetMonthlyCents > 0) {
          await budgets.upsertPolicy(
            updated.companyId,
            {
              scopeType: "agent",
              scopeId: hireApprovedAgentId,
              amount: budgetMonthlyCents,
              windowKind: "calendar_month_utc",
            },
            input.decidedByUserId ?? input.decidedByAgentId ?? "board",
          );
        }
        void notifyHireApproved(db, {
          companyId: updated.companyId,
          agentId: hireApprovedAgentId,
          source: "approval",
          sourceId: updated.id,
          approvedAt: now,
        }).catch(() => {});
      }
      return;
    }

    if (targetStatus === "rejected" && updated.type === "hire_agent") {
      const payload = updated.payload as Record<string, unknown>;
      const payloadAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
      if (payloadAgentId) {
        await agentsSvc.terminate(payloadAgentId);
      }
    }
  }

  return {
    list: (companyId: string, options?: ApprovalListOptions) => {
      const conditions = [eq(approvals.companyId, companyId)];
      if (options?.status) conditions.push(eq(approvals.status, options.status));
      if ((options?.scope ?? "mine") === "mine" && options?.actor) {
        conditions.push(approvalMineCondition(options.actor));
      }
      return db.select().from(approvals).where(and(...conditions));
    },

    getById: (id: string) =>
      db
        .select()
        .from(approvals)
        .where(eq(approvals.id, id))
        .then((rows) => rows[0] ?? null),

    create: (companyId: string, data: Omit<typeof approvals.$inferInsert, "companyId">) =>
      db
        .insert(approvals)
        .values({
          routingMode: data.routingMode ?? "board_pool",
          targetAgentId: data.targetAgentId ?? null,
          targetUserId: data.targetUserId ?? null,
          escalatedAt: data.escalatedAt ?? null,
          escalationReason: data.escalationReason ?? null,
          decidedByAgentId: data.decidedByAgentId ?? null,
          ...data,
          companyId,
        })
        .returning()
        .then((rows) => rows[0]),

    approve: async (id: string, input: ApprovalResolutionInput) => {
      const { approval: updated, applied } = await resolveApproval(
        id,
        "approved",
        input,
      );
      await applyPostResolutionSideEffects(updated, applied, "approved", input);

      return { approval: updated, applied };
    },

    reject: async (id: string, input: ApprovalResolutionInput) => {
      const { approval: updated, applied } = await resolveApproval(
        id,
        "rejected",
        input,
      );
      await applyPostResolutionSideEffects(updated, applied, "rejected", input);

      return { approval: updated, applied };
    },

    approveWithLinkedIssueSync: async (id: string, input: ApprovalResolutionInput) => {
      return resolveWithLinkedIssueSync(id, "approved", input);
    },

    rejectWithLinkedIssueSync: async (id: string, input: ApprovalResolutionInput) => {
      return resolveWithLinkedIssueSync(id, "rejected", input);
    },

    requestRevision: async (id: string, input: ApprovalResolutionInput) => {
      const existing = await getExistingApproval(id);
      if (existing.status !== "pending") {
        throw unprocessable("Only pending approvals can request revision");
      }

      const now = new Date();
      // Reroute the approval back to the original requester so it appears
      // in their "mine" list. The reviewer should no longer see it as
      // actionable.
      return db
        .update(approvals)
        .set({
          status: "revision_requested",
          targetAgentId: existing.requestedByAgentId ?? null,
          targetUserId: existing.requestedByAgentId ? null : (existing.requestedByUserId ?? null),
          decidedByUserId: input.decidedByUserId,
          decidedByAgentId: input.decidedByAgentId,
          decisionNote: input.decisionNote ?? null,
          decidedAt: now,
          updatedAt: now,
        })
        .where(eq(approvals.id, id))
        .returning()
        .then((rows) => rows[0]);
    },

    resubmit: async (id: string, payload?: Record<string, unknown>) => {
      const existing = await getExistingApproval(id);
      if (existing.status !== "revision_requested") {
        throw unprocessable("Only revision requested approvals can be resubmitted");
      }

      // Restore the original routing stored before the revision was
      // requested.  The decidedBy fields recorded who requested the
      // revision — use them to point the approval back at the original
      // reviewer.  If both are null fall back to board_pool.
      const restoredTargetAgentId = existing.decidedByAgentId ?? null;
      const restoredTargetUserId = existing.decidedByAgentId ? null : (existing.decidedByUserId ?? null);
      const restoredRoutingMode =
        restoredTargetAgentId ? "parent_assignee_agent" as const
          : restoredTargetUserId ? "parent_assignee_user" as const
          : "board_pool" as const;

      const now = new Date();
      return db
        .update(approvals)
        .set({
          status: "pending",
          targetAgentId: restoredTargetAgentId,
          targetUserId: restoredTargetUserId,
          routingMode: restoredRoutingMode,
          payload: payload ?? existing.payload,
          decisionNote: null,
          decidedByUserId: null,
          decidedByAgentId: null,
          decidedAt: null,
          updatedAt: now,
        })
        .where(eq(approvals.id, id))
        .returning()
        .then((rows) => rows[0]);
    },

    listComments: async (approvalId: string) => {
      const existing = await getExistingApproval(approvalId);
      const { censorUsernameInLogs } = await instanceSettings.getGeneral();
      return db
        .select()
        .from(approvalComments)
        .where(
          and(
            eq(approvalComments.approvalId, approvalId),
            eq(approvalComments.companyId, existing.companyId),
          ),
        )
        .orderBy(asc(approvalComments.createdAt))
        .then((comments) => comments.map((comment) => redactApprovalComment(comment, censorUsernameInLogs)));
    },

    addComment: async (
      approvalId: string,
      body: string,
      actor: { agentId?: string; userId?: string },
    ) => {
      const existing = await getExistingApproval(approvalId);
      const currentUserRedactionOptions = {
        enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
      };
      const redactedBody = redactCurrentUserText(body, currentUserRedactionOptions);
      return db
        .insert(approvalComments)
        .values({
          companyId: existing.companyId,
          approvalId,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null,
          body: redactedBody,
        })
        .returning()
        .then((rows) => redactApprovalComment(rows[0], currentUserRedactionOptions.enabled));
    },

    removeOrphanedByIds: async (approvalIds: string[], database: Db | any = db) => {
      const uniqueApprovalIds = Array.from(new Set(approvalIds.filter((approvalId) => typeof approvalId === "string" && approvalId.length > 0)));
      if (uniqueApprovalIds.length === 0) return [];

      const orphanRows = await database
        .select({ id: approvals.id })
        .from(approvals)
        .where(
          and(
            inArray(approvals.id, uniqueApprovalIds),
            notExists(
              database
                .select({ one: sql`1` })
                .from(issueApprovals)
                .where(eq(issueApprovals.approvalId, approvals.id)),
            ),
            notExists(
              database
                .select({ one: sql`1` })
                .from(budgetIncidents)
                .where(eq(budgetIncidents.approvalId, approvals.id)),
            ),
          ),
        );

      const orphanIds = orphanRows.map((row: { id: string }) => row.id);
      if (orphanIds.length === 0) return [];

      await database.delete(approvalComments).where(inArray(approvalComments.approvalId, orphanIds));
      await database.delete(approvals).where(inArray(approvals.id, orphanIds));
      return orphanIds;
    },
  };
}
