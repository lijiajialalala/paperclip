import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, issueApprovals, issues } from "@paperclipai/db";
import {
  APPROVAL_ESCALATION_REASONS,
  APPROVAL_ROUTING_MODES,
} from "@paperclipai/shared/constants";
import { notFound, unprocessable } from "../errors.js";
import { redactEventPayload } from "../redaction.js";

type ApprovalRoutingMode = (typeof APPROVAL_ROUTING_MODES)[number];
type ApprovalEscalationReason = (typeof APPROVAL_ESCALATION_REASONS)[number];
const LIVE_WORK_PLAN_APPROVAL_STATUSES = new Set(["pending", "revision_requested"]);
type IssueLinkedApprovalRecord = {
  id: string;
  companyId: string;
  type: string;
  requestedByAgentId: string | null;
  requestedByUserId: string | null;
  targetAgentId: string | null;
  targetUserId: string | null;
  routingMode: ApprovalRoutingMode;
  status: string;
  payload: Record<string, unknown>;
  decisionNote: string | null;
  decidedByUserId: string | null;
  decidedByAgentId: string | null;
  decidedAt: Date | null;
  escalatedAt: Date | null;
  escalationReason: ApprovalEscalationReason | null;
  createdAt: Date;
  updatedAt: Date;
};

interface LinkActor {
  agentId?: string | null;
  userId?: string | null;
}

export function issueApprovalService(db: Db) {
  function normalizeIssueIds(issueIds: string[]) {
    return Array.from(new Set(issueIds)).sort();
  }

  async function lockIssuesForApprovalLink(
    issueIds: string[],
    database: Db | any = db,
  ) {
    const uniqueIssueIds = normalizeIssueIds(issueIds);
    if (uniqueIssueIds.length === 0) return;

    await database.execute(sql`
      select ${issues.id}
      from ${issues}
      where ${issues.id} in (${sql.join(uniqueIssueIds.map((issueId) => sql`${issueId}`), sql`, `)})
      order by ${issues.id}
      for update
    `);
  }

  async function getIssue(issueId: string, database: Db | any = db) {
    return database
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows: any[]) => rows[0] ?? null);
  }

  async function getApproval(approvalId: string, database: Db | any = db) {
    return database
      .select()
      .from(approvals)
      .where(eq(approvals.id, approvalId))
      .then((rows: any[]) => rows[0] ?? null);
  }

  async function listApprovalsForIssueInternal(issueId: string, database: Db | any = db): Promise<IssueLinkedApprovalRecord[]> {
    const issue = await database
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows: any[]) => rows[0] ?? null);
    if (!issue) throw notFound("Issue not found");

    const result = await database
      .select({
        id: approvals.id,
        companyId: approvals.companyId,
        type: approvals.type,
        requestedByAgentId: approvals.requestedByAgentId,
        requestedByUserId: approvals.requestedByUserId,
        targetAgentId: approvals.targetAgentId,
        targetUserId: approvals.targetUserId,
        routingMode: approvals.routingMode,
        status: approvals.status,
        payload: approvals.payload,
        decisionNote: approvals.decisionNote,
        decidedByUserId: approvals.decidedByUserId,
        decidedByAgentId: approvals.decidedByAgentId,
        decidedAt: approvals.decidedAt,
        escalatedAt: approvals.escalatedAt,
        escalationReason: approvals.escalationReason,
        createdAt: approvals.createdAt,
        updatedAt: approvals.updatedAt,
      })
      .from(issueApprovals)
      .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
      .where(eq(issueApprovals.issueId, issueId))
      .orderBy(desc(issueApprovals.createdAt));

    return result.map((approval: any): IssueLinkedApprovalRecord => ({
      ...approval,
      routingMode: approval.routingMode as ApprovalRoutingMode,
      escalationReason: approval.escalationReason as ApprovalEscalationReason | null,
      payload: redactEventPayload(approval.payload) ?? {},
    }));
  }

  async function getLiveWorkPlanApprovalsForIssueInternal(issueId: string, database: Db | any = db) {
    const approvalsForIssue = await listApprovalsForIssueInternal(issueId, database);
    return approvalsForIssue.filter(
      (approval: IssueLinkedApprovalRecord) =>
        approval.type === "work_plan" &&
        LIVE_WORK_PLAN_APPROVAL_STATUSES.has(approval.status),
    );
  }

  async function assertCanLinkLiveWorkPlanApproval(
    issueId: string,
    approvalId: string,
    database: Db | any = db,
  ) {
    const approval = await database
      .select()
      .from(approvals)
      .where(eq(approvals.id, approvalId))
      .then((rows: any[]) => rows[0] ?? null);
    if (!approval) throw notFound("Approval not found");
    if (
      approval.type !== "work_plan" ||
      !LIVE_WORK_PLAN_APPROVAL_STATUSES.has(approval.status)
    ) {
      return;
    }

    const liveApprovals = await getLiveWorkPlanApprovalsForIssueInternal(issueId, database);
    const conflictingApprovals = liveApprovals.filter(
      (liveApproval: IssueLinkedApprovalRecord) => liveApproval.id !== approvalId,
    );
    if (conflictingApprovals.length > 0) {
      throw unprocessable("Issue already has a live work plan approval");
    }
  }

  async function assertIssueAndApprovalSameCompany(
    issueId: string,
    approvalId: string,
    database: Db | any = db,
  ) {
    const issue = await getIssue(issueId, database);
    if (!issue) throw notFound("Issue not found");

    const approval = await getApproval(approvalId, database);
    if (!approval) throw notFound("Approval not found");

    if (issue.companyId !== approval.companyId) {
      throw unprocessable("Issue and approval must belong to the same company");
    }

    return { issue, approval };
  }

  return {
    listApprovalsForIssue: async (issueId: string) => listApprovalsForIssueInternal(issueId),

    getLiveWorkPlanApprovalForIssue: async (issueId: string) => {
      const liveApprovals = await getLiveWorkPlanApprovalsForIssueInternal(issueId);
      if (liveApprovals.length === 0) return null;
      if (liveApprovals.length > 1) {
        throw unprocessable("Issue has multiple live work plan approvals; manual repair required");
      }
      return liveApprovals[0];
    },

    listIssuesForApproval: async (approvalId: string) => {
      const approval = await getApproval(approvalId);
      if (!approval) throw notFound("Approval not found");

      return db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          projectId: issues.projectId,
          goalId: issues.goalId,
          parentId: issues.parentId,
          title: issues.title,
          description: issues.description,
          status: issues.status,
          priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId,
          createdByAgentId: issues.createdByAgentId,
          createdByUserId: issues.createdByUserId,
          issueNumber: issues.issueNumber,
          identifier: issues.identifier,
          requestDepth: issues.requestDepth,
          billingCode: issues.billingCode,
          planProposedAt: issues.planProposedAt,
          planApprovedAt: issues.planApprovedAt,
          startedAt: issues.startedAt,
          completedAt: issues.completedAt,
          cancelledAt: issues.cancelledAt,
          createdAt: issues.createdAt,
          updatedAt: issues.updatedAt,
        })
        .from(issueApprovals)
        .innerJoin(issues, eq(issueApprovals.issueId, issues.id))
        .where(eq(issueApprovals.approvalId, approvalId))
        .orderBy(desc(issueApprovals.createdAt));
    },

    link: async (issueId: string, approvalId: string, actor?: LinkActor) => {
      return db.transaction(async (tx) => {
        const { issue } = await assertIssueAndApprovalSameCompany(issueId, approvalId, tx as unknown as Db);
        await lockIssuesForApprovalLink([issueId], tx as unknown as Db);
        await assertCanLinkLiveWorkPlanApproval(issueId, approvalId, tx as unknown as Db);

        await tx
          .insert(issueApprovals)
          .values({
            companyId: issue.companyId,
            issueId,
            approvalId,
            linkedByAgentId: actor?.agentId ?? null,
            linkedByUserId: actor?.userId ?? null,
          })
          .onConflictDoNothing();

        return tx
          .select()
          .from(issueApprovals)
          .where(and(eq(issueApprovals.issueId, issueId), eq(issueApprovals.approvalId, approvalId)))
          .then((rows) => rows[0] ?? null);
      });
    },

    unlink: async (issueId: string, approvalId: string) => {
      await assertIssueAndApprovalSameCompany(issueId, approvalId);
      await db
        .delete(issueApprovals)
        .where(and(eq(issueApprovals.issueId, issueId), eq(issueApprovals.approvalId, approvalId)));
    },

    linkManyForApproval: async (approvalId: string, issueIds: string[], actor?: LinkActor) => {
      if (issueIds.length === 0) return;

      return db.transaction(async (tx) => {
        const approval = await getApproval(approvalId, tx as unknown as Db);
        if (!approval) throw notFound("Approval not found");

        const uniqueIssueIds = normalizeIssueIds(issueIds);
        const rows = await tx
          .select({
            id: issues.id,
            companyId: issues.companyId,
          })
          .from(issues)
          .where(inArray(issues.id, uniqueIssueIds));

        if (rows.length !== uniqueIssueIds.length) {
          throw notFound("One or more issues not found");
        }

        for (const row of rows) {
          if (row.companyId !== approval.companyId) {
            throw unprocessable("Issue and approval must belong to the same company");
          }
        }

        await lockIssuesForApprovalLink(uniqueIssueIds, tx as unknown as Db);

        if (
          approval.type === "work_plan" &&
          LIVE_WORK_PLAN_APPROVAL_STATUSES.has(approval.status)
        ) {
          for (const issueId of uniqueIssueIds) {
            await assertCanLinkLiveWorkPlanApproval(issueId, approvalId, tx as unknown as Db);
          }
        }

        await tx
          .insert(issueApprovals)
          .values(
            uniqueIssueIds.map((issueId) => ({
              companyId: approval.companyId,
              issueId,
              approvalId,
              linkedByAgentId: actor?.agentId ?? null,
              linkedByUserId: actor?.userId ?? null,
            })),
          )
          .onConflictDoNothing();
      });
    },
  };
}
