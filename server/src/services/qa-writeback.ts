import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { normalizeAgentUrlKey } from "@paperclipai/shared";
import { logActivity } from "./activity-log.js";
import { instanceSettingsService } from "./instance-settings.js";
import { getTelemetryClient } from "../telemetry.js";
import { redactCurrentUserText } from "../log-redaction.js";

export type QaVerdict = "pass" | "fail" | "inconclusive";

export type QaIssueWritebackStatus =
  | "agent_written"
  | "platform_written"
  | "platform_repaired_partial"
  | "platform_interrupted"
  | "alerted_missing"
  | "alerted_inconclusive";

export type QaIssueWritebackAlertType =
  | "partial_writeback_conflict"
  | "missing_writeback"
  | "plan_pending_review"
  | "inconclusive";

export interface QaIssueWriteback {
  status: QaIssueWritebackStatus;
  verdict: QaVerdict | null;
  source: "agent" | "platform" | "alert" | "none";
  canCloseUpstream: boolean | null;
  commentId: string | null;
  writebackAt: string | null;
  alertType: QaIssueWritebackAlertType | null;
  latest: boolean;
}

type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type IssueRow = typeof issues.$inferSelect;

const PASS_VERDICT_ALIASES = [
  "pass",
  "passed",
  "approved",
  "accept",
  "accepted",
  "通过",
  "通过验收",
  "qa acceptance passed",
] as const;

const FAIL_VERDICT_ALIASES = [
  "fail",
  "failed",
  "changes_requested",
  "rejected",
  "reject",
  "returned",
  "return",
  "退回",
  "未通过",
] as const;

const INCONCLUSIVE_VERDICT_ALIASES = [
  "inconclusive",
  "needs_info",
  "need_info",
  "blocked",
  "待补充",
  "unknown",
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractIssuePrefix(identifier: string | null | undefined): string {
  const match = typeof identifier === "string" ? identifier.match(/^([A-Z]+)-/i) : null;
  return match?.[1]?.toUpperCase() ?? "PAP";
}

function normalizeVerdictString(value: string | null): QaVerdict | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (PASS_VERDICT_ALIASES.some((alias) => normalized === alias)) return "pass";
  if (FAIL_VERDICT_ALIASES.some((alias) => normalized === alias)) return "fail";
  if (INCONCLUSIVE_VERDICT_ALIASES.some((alias) => normalized === alias)) return "inconclusive";
  return null;
}

function classifyTextVerdict(text: string | null): { verdict: QaVerdict | null; conflict: boolean } {
  if (!text) return { verdict: null, conflict: false };
  const normalized = text.toLowerCase();
  const hits = new Set<QaVerdict>();

  for (const alias of PASS_VERDICT_ALIASES) {
    if (normalized.includes(alias)) hits.add("pass");
  }
  for (const alias of FAIL_VERDICT_ALIASES) {
    if (normalized.includes(alias)) hits.add("fail");
  }
  for (const alias of INCONCLUSIVE_VERDICT_ALIASES) {
    if (normalized.includes(alias)) hits.add("inconclusive");
  }

  if (hits.size === 0) return { verdict: null, conflict: false };
  if (hits.size > 1) return { verdict: "inconclusive", conflict: true };
  return { verdict: [...hits][0]!, conflict: false };
}

function extractQaFinalText(resultJson: Record<string, unknown> | null | undefined): string | null {
  if (!resultJson) return null;
  return (
    readNonEmptyString(resultJson.summary)
    ?? readNonEmptyString(resultJson.result)
    ?? readNonEmptyString(resultJson.message)
    ?? null
  );
}

export function parseQaVerdictFromBody(body: string | null | undefined): QaVerdict | null {
  const text = readNonEmptyString(body);
  if (!text) return null;

  const verdictLine = text.match(/^\s*-\s*Verdict:\s*(.+)$/im)?.[1] ?? text.match(/^\s*Verdict:\s*(.+)$/im)?.[1] ?? null;
  const explicit = normalizeVerdictString(readNonEmptyString(verdictLine));
  if (explicit) return explicit;
  return classifyTextVerdict(text).verdict;
}

function buildIssueStatusPatch(status: IssueRow["status"], now: Date): Partial<typeof issues.$inferInsert> {
  if (status === "done") {
    return { status, completedAt: now, updatedAt: now };
  }
  if (status === "blocked") {
    return { status, updatedAt: now };
  }
  return { status, updatedAt: now };
}

function desiredIssueStatusForVerdict(verdict: QaVerdict | null): IssueRow["status"] {
  if (verdict === "pass" || verdict === "fail") return "done";
  return "blocked";
}

function canCloseUpstreamForVerdict(verdict: QaVerdict | null): boolean | null {
  if (verdict === "pass") return true;
  if (verdict === "fail" || verdict === "inconclusive") return false;
  return null;
}

function readQaIssueWritebackValue(value: unknown): QaIssueWriteback | null {
  const record = asRecord(value);
  if (!record) return null;
  const status = readNonEmptyString(record.status) as QaIssueWritebackStatus | null;
  if (!status) return null;
  return {
    status,
    verdict: normalizeVerdictString(readNonEmptyString(record.verdict)),
    source: (readNonEmptyString(record.source) as QaIssueWriteback["source"] | null) ?? "none",
    canCloseUpstream:
      typeof record.canCloseUpstream === "boolean"
        ? record.canCloseUpstream
        : null,
    commentId: readNonEmptyString(record.commentId),
    writebackAt: readNonEmptyString(record.writebackAt),
    alertType: (readNonEmptyString(record.alertType) as QaIssueWritebackAlertType | null) ?? null,
    latest: record.latest === true,
  };
}

export function readQaIssueWriteback(resultJson: Record<string, unknown> | null | undefined): QaIssueWriteback | null {
  return readQaIssueWritebackValue(asRecord(resultJson)?.issueWriteback);
}

export function buildQaIssueWriteback(
  patch: Omit<QaIssueWriteback, "latest"> & { latest?: boolean },
): QaIssueWriteback {
  return {
    ...patch,
    latest: patch.latest === true,
  };
}

export function classifyQaVerdictFromRun(input: {
  status: string | null | undefined;
  resultJson: Record<string, unknown> | null | undefined;
  errorCode: string | null | undefined;
  error: string | null | undefined;
}): {
  verdict: QaVerdict | null;
  finalText: string | null;
  conflict: boolean;
  reason: "explicit" | "summary" | "conflict" | "run_error" | "missing";
} {
  const explicit = normalizeVerdictString(readNonEmptyString(input.resultJson?.verdict));
  if (explicit) {
    return {
      verdict: explicit,
      finalText: extractQaFinalText(input.resultJson),
      conflict: false,
      reason: "explicit",
    };
  }

  const finalText = extractQaFinalText(input.resultJson);
  const fromText = classifyTextVerdict(finalText);
  if (fromText.verdict) {
    return {
      verdict: fromText.verdict,
      finalText,
      conflict: fromText.conflict,
      reason: fromText.conflict ? "conflict" : "summary",
    };
  }

  if (readNonEmptyString(input.errorCode) || readNonEmptyString(input.error)) {
    return {
      verdict: "inconclusive",
      finalText,
      conflict: false,
      reason: "run_error",
    };
  }

  return {
    verdict: null,
    finalText,
    conflict: false,
    reason: "missing",
  };
}

function renderRunLink(prefix: string, agent: AgentRow, runId: string): string {
  return `[run](/${prefix}/agents/${normalizeAgentUrlKey(agent.name) ?? agent.id}/runs/${runId})`;
}

function renderAgentLink(prefix: string, agent: AgentRow | null): string {
  if (!agent) return "_unassigned_";
  return `[${agent.name}](/${prefix}/agents/${normalizeAgentUrlKey(agent.name) ?? agent.id})`;
}

function buildQaVerdictComment(input: {
  prefix: string;
  run: HeartbeatRunRow;
  runAgent: AgentRow;
  verdict: Exclude<QaVerdict, "inconclusive">;
  source: "platform_writeback" | "platform_repaired_partial";
  finalText: string | null;
}): string {
  return [
    "## QA Verdict",
    "",
    `- Verdict: ${input.verdict}`,
    `- Source: ${input.source}`,
    `- Run: ${renderRunLink(input.prefix, input.runAgent, input.run.id)}`,
    `- Finished at: ${input.run.finishedAt?.toISOString() ?? new Date().toISOString()}`,
    `- Evidence: ${input.finalText ?? "No summary captured."}`,
    `- Scope/Defects: ${input.finalText ?? "See run transcript for details."}`,
    `- Upstream close: ${input.verdict === "pass" ? "allowed" : "blocked"}`,
  ].join("\n");
}

function buildQaAlertComment(input: {
  prefix: string;
  run: HeartbeatRunRow;
  runAgent: AgentRow;
  owner: AgentRow | null;
  manager: AgentRow | null;
  alertType: QaIssueWritebackAlertType;
}): string {
  const nextStep =
    input.alertType === "plan_pending_review"
      ? "- Next step: keep the issue in review, block automatic close-out, and repair the premature execution or approval gating path."
      : "- Next step: inspect the run output and repair the QA verdict writeback.";
  return [
    "## QA Writeback Alert",
    "",
    `- Type: ${input.alertType}`,
    `- Run: ${renderRunLink(input.prefix, input.runAgent, input.run.id)}`,
    `- Triggered at: ${new Date().toISOString()}`,
    `- Current owner: ${renderAgentLink(input.prefix, input.owner)}`,
    `- Manager: ${renderAgentLink(input.prefix, input.manager)}`,
    nextStep,
  ].join("\n");
}

export interface QaWritebackSettlement {
  issueWriteback: QaIssueWriteback;
}

export function qaWritebackService(db: Db) {
  const settings = instanceSettingsService(db);

  async function insertIssueComment(issue: IssueRow, body: string, actor: { agentId: string; runId: string }) {
    const redactedBody = redactCurrentUserText(body, {
      enabled: (await settings.getGeneral()).censorUsernameInLogs,
    });

    const [comment] = await db
      .insert(issueComments)
      .values({
        companyId: issue.companyId,
        issueId: issue.id,
        authorAgentId: actor.agentId,
        authorUserId: null,
        createdByRunId: actor.runId,
        body: redactedBody,
      })
      .returning();

    await db
      .update(issues)
      .set({ updatedAt: new Date() })
      .where(eq(issues.id, issue.id));

    return comment;
  }

  async function updateIssueStatus(issue: IssueRow, status: IssueRow["status"]) {
    const now = new Date();
    const [updated] = await db
      .update(issues)
      .set(buildIssueStatusPatch(status, now))
      .where(eq(issues.id, issue.id))
      .returning();
    return updated ?? issue;
  }

  async function writeIssueWriteback(run: HeartbeatRunRow, issueWriteback: QaIssueWriteback) {
    const resultJson = {
      ...(asRecord(run.resultJson) ?? {}),
      issueWriteback,
    };

    const [updated] = await db
      .update(heartbeatRuns)
      .set({
        resultJson,
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, run.id))
      .returning();

    return updated ?? run;
  }

  return {
    settleTerminalQaRun: async (input: {
      run: HeartbeatRunRow;
      runAgent: AgentRow;
      issueId: string;
    }): Promise<QaWritebackSettlement> => {
      // Idempotency guard: if a terminal writeback already exists, return it immediately.
      // This prevents duplicate comments and conflicting verdicts from concurrent invocations.
      const existingWriteback = readQaIssueWriteback(input.run.resultJson);
      const TERMINAL_WRITEBACK_STATUSES: QaIssueWritebackStatus[] = [
        "agent_written",
        "platform_written",
        "platform_repaired_partial",
        "platform_interrupted",
        "alerted_missing",
        "alerted_inconclusive",
      ];
      if (existingWriteback && TERMINAL_WRITEBACK_STATUSES.includes(existingWriteback.status)) {
        return { issueWriteback: existingWriteback };
      }

      if (input.run.errorCode === "process_lost") {
        // platform_interrupted is a neutral status: it does NOT block canCloseUpstream.
        // The QA gate must not penalize product completion for platform-level failures.
        return {
          issueWriteback: buildQaIssueWriteback({
            status: "platform_interrupted",
            verdict: null,
            source: "platform",
            canCloseUpstream: null,
            commentId: null,
            writebackAt: new Date().toISOString(),
            alertType: null,
          }),
        };
      }

      const issue = await db
        .select()
        .from(issues)
        .where(eq(issues.id, input.issueId))
        .then((rows) => rows[0] ?? null);

      if (!issue) {
        const issueWriteback = buildQaIssueWriteback({
          status: "alerted_missing",
          verdict: null,
          source: "alert",
          canCloseUpstream: false,
          commentId: null,
          writebackAt: new Date().toISOString(),
          alertType: "missing_writeback",
        });
        await writeIssueWriteback(input.run, issueWriteback);
        return { issueWriteback };
      }

      const prefix = extractIssuePrefix(issue.identifier);
      const owner = issue.assigneeAgentId
        ? await db.select().from(agents).where(eq(agents.id, issue.assigneeAgentId)).then((rows) => rows[0] ?? null)
        : null;
      const manager = owner?.reportsTo
        ? await db.select().from(agents).where(eq(agents.id, owner.reportsTo)).then((rows) => rows[0] ?? null)
        : null;

      const [runComments, runStatusActivities] = await Promise.all([
        db
          .select()
          .from(issueComments)
          .where(and(eq(issueComments.issueId, issue.id), eq(issueComments.createdByRunId, input.run.id)))
          .orderBy(desc(issueComments.createdAt)),
        db
          .select()
          .from(activityLog)
          .where(
            and(
              eq(activityLog.companyId, issue.companyId),
              eq(activityLog.entityType, "issue"),
              eq(activityLog.entityId, issue.id),
              eq(activityLog.action, "issue.updated"),
              eq(activityLog.runId, input.run.id),
            ),
          )
          .orderBy(desc(activityLog.createdAt)),
      ]);

      const verdictFromRun = classifyQaVerdictFromRun(input.run);
      const verdictComments = runComments
        .map((comment) => ({
          comment,
          verdict: parseQaVerdictFromBody(comment.body),
        }))
        .filter(
          (entry): entry is { comment: (typeof runComments)[number]; verdict: QaVerdict } => entry.verdict != null,
        );
      const durableVerdictComments = verdictComments.filter(
        (entry): entry is { comment: (typeof runComments)[number]; verdict: "pass" | "fail" } =>
          entry.verdict === "pass" || entry.verdict === "fail",
      );
      const distinctCommentVerdicts = [...new Set(durableVerdictComments.map((entry) => entry.verdict))];
      const commentVerdict = distinctCommentVerdicts.length === 1 ? distinctCommentVerdicts[0] : null;
      const existingVerdictComment = durableVerdictComments[0]?.comment ?? null;
      const runExplicitVerdict = normalizeVerdictString(readNonEmptyString(asRecord(input.run.resultJson)?.verdict));
      const resolvedVerdict =
        commentVerdict
        ?? (
          (verdictFromRun.verdict === "pass" || verdictFromRun.verdict === "fail") && !verdictFromRun.conflict
            ? verdictFromRun.verdict
            : null
        );
      const hasVerdictConflict =
        distinctCommentVerdicts.length > 1
        || (
          commentVerdict != null
          && runExplicitVerdict != null
          && commentVerdict !== runExplicitVerdict
        );
      const desiredStatus = desiredIssueStatusForVerdict(resolvedVerdict);
      const hasMatchingStatusActivity = runStatusActivities.some((entry) => {
        const details = asRecord(entry.details);
        return readNonEmptyString(details?.status) === desiredStatus;
      });
      const planPendingReview = Boolean(issue.planProposedAt) && !issue.planApprovedAt;

      let issueWriteback: QaIssueWriteback;
      const writebackAt = new Date().toISOString();

      if (planPendingReview) {
        const existingAlertComment =
          runComments.find((comment) => comment.body.includes("## QA Writeback Alert")) ?? null;
        let commentId = existingAlertComment?.id ?? null;
        const alertType: QaIssueWritebackAlertType = "plan_pending_review";

        if (!existingAlertComment) {
          const alertComment = await insertIssueComment(
            issue,
            buildQaAlertComment({
              prefix,
              run: input.run,
              runAgent: input.runAgent,
              owner,
              manager,
              alertType,
            }),
            { agentId: input.runAgent.id, runId: input.run.id },
          );
          commentId = alertComment.id;

          await logActivity(db, {
            companyId: issue.companyId,
            actorType: "agent",
            actorId: input.runAgent.id,
            agentId: input.runAgent.id,
            runId: input.run.id,
            action: "issue.comment_added",
            entityType: "issue",
            entityId: issue.id,
            details: {
              commentId: alertComment.id,
              identifier: issue.identifier,
              issueTitle: issue.title,
              source: "qa_writeback_alert",
            },
          });
        }

        issueWriteback = buildQaIssueWriteback({
          status: "alerted_inconclusive",
          verdict: resolvedVerdict ?? verdictFromRun.verdict,
          source: "alert",
          canCloseUpstream: false,
          commentId,
          writebackAt,
          alertType,
        });

        await logActivity(db, {
          companyId: issue.companyId,
          actorType: "system",
          actorId: "paperclip",
          agentId: input.runAgent.id,
          runId: input.run.id,
          action: "issue.qa_writeback_alerted",
          entityType: "issue",
          entityId: issue.id,
          details: {
            identifier: issue.identifier,
            alertType,
            verdict: resolvedVerdict ?? verdictFromRun.verdict,
            commentId,
          },
        });
      } else if (resolvedVerdict && !hasVerdictConflict) {
        const shouldAddComment = !existingVerdictComment;
        const shouldPatchStatus = issue.status !== desiredStatus || !hasMatchingStatusActivity;
        let commentId = existingVerdictComment?.id ?? null;
        let actionStatus: QaIssueWritebackStatus = "agent_written";
        let commentSource: "platform_writeback" | "platform_repaired_partial" = "platform_writeback";

        if (shouldAddComment || shouldPatchStatus) {
          const hadAnyRunWrite = runComments.length > 0 || runStatusActivities.length > 0;
          actionStatus = hadAnyRunWrite ? "platform_repaired_partial" : "platform_written";
          commentSource = actionStatus === "platform_written" ? "platform_writeback" : "platform_repaired_partial";
        }

        if (shouldAddComment) {
          const comment = await insertIssueComment(
            issue,
            buildQaVerdictComment({
              prefix,
              run: input.run,
              runAgent: input.runAgent,
              verdict: resolvedVerdict,
              source: commentSource,
              finalText: verdictFromRun.finalText,
            }),
            { agentId: input.runAgent.id, runId: input.run.id },
          );
          commentId = comment.id;

          await logActivity(db, {
            companyId: issue.companyId,
            actorType: "agent",
            actorId: input.runAgent.id,
            agentId: input.runAgent.id,
            runId: input.run.id,
            action: "issue.comment_added",
            entityType: "issue",
            entityId: issue.id,
            details: {
              commentId: comment.id,
              identifier: issue.identifier,
              issueTitle: issue.title,
              source: "qa_writeback",
            },
          });
        }

        if (shouldPatchStatus) {
          await updateIssueStatus(issue, desiredStatus);
          await logActivity(db, {
            companyId: issue.companyId,
            actorType: "agent",
            actorId: input.runAgent.id,
            agentId: input.runAgent.id,
            runId: input.run.id,
            action: "issue.updated",
            entityType: "issue",
            entityId: issue.id,
            details: {
              status: desiredStatus,
              identifier: issue.identifier,
              source: "qa_writeback",
            },
          });
        }

        issueWriteback = buildQaIssueWriteback({
          status: actionStatus,
          verdict: resolvedVerdict,
          source: actionStatus === "agent_written" ? "agent" : "platform",
          canCloseUpstream: canCloseUpstreamForVerdict(resolvedVerdict),
          commentId,
          writebackAt,
          alertType: null,
        });

        await logActivity(db, {
          companyId: issue.companyId,
          actorType: "system",
          actorId: "paperclip",
          agentId: input.runAgent.id,
          runId: input.run.id,
          action: actionStatus === "agent_written" ? "issue.qa_verdict_written" : "issue.qa_writeback_repaired",
          entityType: "issue",
          entityId: issue.id,
          details: {
            identifier: issue.identifier,
            verdict: resolvedVerdict,
            canCloseUpstream: canCloseUpstreamForVerdict(resolvedVerdict),
            writebackStatus: actionStatus,
            commentId,
          },
        });
      } else {
        const alertType: QaIssueWritebackAlertType =
          hasVerdictConflict || verdictFromRun.reason === "conflict"
            ? "partial_writeback_conflict"
            : verdictFromRun.reason === "missing"
              ? "missing_writeback"
              : "inconclusive";
        const existingAlertComment =
          runComments.find((comment) => comment.body.includes("## QA Writeback Alert")) ?? null;
        let commentId = existingAlertComment?.id ?? null;

        if (!existingAlertComment) {
          const alertComment = await insertIssueComment(
            issue,
            buildQaAlertComment({
              prefix,
              run: input.run,
              runAgent: input.runAgent,
              owner,
              manager,
              alertType,
            }),
            { agentId: input.runAgent.id, runId: input.run.id },
          );
          commentId = alertComment.id;

          await logActivity(db, {
            companyId: issue.companyId,
            actorType: "agent",
            actorId: input.runAgent.id,
            agentId: input.runAgent.id,
            runId: input.run.id,
            action: "issue.comment_added",
            entityType: "issue",
            entityId: issue.id,
            details: {
              commentId: alertComment.id,
              identifier: issue.identifier,
              issueTitle: issue.title,
              source: "qa_writeback_alert",
            },
          });
        }

        if (issue.status !== "blocked") {
          await updateIssueStatus(issue, "blocked");
          await logActivity(db, {
            companyId: issue.companyId,
            actorType: "agent",
            actorId: input.runAgent.id,
            agentId: input.runAgent.id,
            runId: input.run.id,
            action: "issue.updated",
            entityType: "issue",
            entityId: issue.id,
            details: {
              status: "blocked",
              identifier: issue.identifier,
              source: "qa_writeback_alert",
            },
          });
        }

        issueWriteback = buildQaIssueWriteback({
          status: alertType === "missing_writeback" ? "alerted_missing" : "alerted_inconclusive",
          verdict: verdictFromRun.verdict,
          source: "alert",
          canCloseUpstream: false,
          commentId,
          writebackAt,
          alertType,
        });

        await logActivity(db, {
          companyId: issue.companyId,
          actorType: "system",
          actorId: "paperclip",
          agentId: input.runAgent.id,
          runId: input.run.id,
          action: "issue.qa_writeback_alerted",
          entityType: "issue",
          entityId: issue.id,
          details: {
            identifier: issue.identifier,
            alertType,
            verdict: verdictFromRun.verdict,
            commentId,
          },
        });
      }

      await writeIssueWriteback(input.run, issueWriteback);

      const telemetry = getTelemetryClient();
      if (telemetry) {
        telemetry.track("qa_terminal_runs_total", {
          agent_role: input.runAgent.role,
          verdict: issueWriteback.verdict ?? "none",
          writeback_status: issueWriteback.status,
        });
        if (issueWriteback.status === "alerted_missing" || issueWriteback.status === "alerted_inconclusive") {
          telemetry.track("qa_writeback_alerts_total", {
            alert_type: issueWriteback.alertType ?? "unknown",
          });
        } else {
          telemetry.track("qa_writebacks_total", {
            verdict: issueWriteback.verdict ?? "none",
            source: issueWriteback.source,
          });
        }
      }

      return { issueWriteback };
    },
    readQaIssueWriteback,
  };
}
