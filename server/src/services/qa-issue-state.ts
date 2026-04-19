import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, issues } from "@paperclipai/db";
import type { QaIssueWriteback, QaVerdict } from "./qa-writeback.js";
import {
  buildQaIssueWriteback,
  classifyQaVerdictFromRun,
  readQaIssueWriteback,
} from "./qa-writeback.js";
import { isRuntimeInterruptionErrorCode } from "./runtime-interruption.js";

export interface IssueQaSummary {
  verdict: QaVerdict | null;
  source: "agent" | "platform" | "alert" | "manual" | "none";
  canCloseUpstream: boolean | null;
  latestRunId: string;
  latestRunFinishedAt: string | null;
  writebackAt: string | null;
  alertOpen: boolean;
  alertType: string | null;
  alertMessage: string | null;
  latestLabel: string;
}

const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled", "timed_out"] as const;

type QaRunRow = {
  id: string;
  status: string;
  agentId: string;
  finishedAt: Date | null;
  createdAt: Date;
  resultJson: Record<string, unknown> | null;
  errorCode: string | null;
  error: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function summarizeAlertMessage(writeback: QaIssueWriteback | null): string | null {
  if (!writeback?.alertType) return null;
  if (writeback.alertType === "missing_writeback") return "QA run reached terminal state without a durable verdict writeback.";
  if (writeback.alertType === "missing_plan_approval") return "Execution reached a terminal QA state before the assigned child issue had any approved work plan.";
  if (writeback.alertType === "partial_writeback_conflict") return "QA run produced conflicting writeback signals that require manual repair.";
  if (writeback.alertType === "plan_pending_review") return "QA run reached terminal state while the issue plan was still pending review.";
  return "QA run completed without a unique, durable verdict.";
}

function buildSummaryFromWriteback(run: QaRunRow, writeback: QaIssueWriteback | null): IssueQaSummary {
  const fallbackVerdict = classifyQaVerdictFromRun(run);
  const verdict = writeback?.verdict ?? fallbackVerdict.verdict ?? null;
  const source = writeback?.source ?? (verdict ? "agent" : "none");
  const canCloseUpstream =
    writeback?.canCloseUpstream
    ?? (verdict === "pass" ? true : verdict === "fail" || verdict === "inconclusive" ? false : null);
  const alertOpen =
    writeback?.status === "alerted_missing"
    || writeback?.status === "alerted_inconclusive";
    // Note: platform_interrupted is intentionally excluded — it is a neutral platform signal
    // and must not block canCloseUpstream or trigger manual recovery flows.

  return {
    verdict,
    source,
    canCloseUpstream,
    latestRunId: run.id,
    latestRunFinishedAt: run.finishedAt?.toISOString() ?? null,
    writebackAt: writeback?.writebackAt ?? run.finishedAt?.toISOString() ?? null,
    alertOpen,
    alertType: writeback?.alertType ?? null,
    alertMessage: alertOpen ? summarizeAlertMessage(writeback) : null,
    latestLabel: "latest",
  };
}

function applyLatestFlag(writeback: QaIssueWriteback | null, latest: boolean): QaIssueWriteback | null {
  if (!writeback) return null;
  return buildQaIssueWriteback({ ...writeback, latest });
}

export function qaIssueStateService(db: Db) {
  async function getIssueRow(issueId: string) {
    return db
      .select({ id: issues.id, companyId: issues.companyId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
  }

  async function getLatestTerminalQaRun(issueId: string): Promise<QaRunRow | null> {
    const issue = await getIssueRow(issueId);
    if (!issue) return null;

    return db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        agentId: heartbeatRuns.agentId,
        finishedAt: heartbeatRuns.finishedAt,
        createdAt: heartbeatRuns.createdAt,
        resultJson: heartbeatRuns.resultJson,
        errorCode: heartbeatRuns.errorCode,
        error: heartbeatRuns.error,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(
        and(
          eq(heartbeatRuns.companyId, issue.companyId),
          eq(agents.role, "qa"),
          eq(sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`, issueId),
          inArray(heartbeatRuns.status, [...TERMINAL_RUN_STATUSES]),
        ),
      )
      .orderBy(desc(heartbeatRuns.finishedAt), desc(heartbeatRuns.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  return {
    getIssueQaSummary: async (issueId: string): Promise<IssueQaSummary | null> => {
      const latestRun = await getLatestTerminalQaRun(issueId);
      if (!latestRun) return null;

      const persistedWriteback =
        readQaIssueWriteback(latestRun.resultJson)
        ?? (isRuntimeInterruptionErrorCode(latestRun.errorCode)
          // Runtime interruption runs are platform failures, not product failures.
          // Use platform_interrupted (canCloseUpstream: null) so the close gate is not blocked.
          ? buildQaIssueWriteback({
              status: "platform_interrupted",
              verdict: null,
              source: "platform",
              canCloseUpstream: null,
              commentId: null,
              writebackAt: latestRun.finishedAt?.toISOString() ?? latestRun.createdAt.toISOString(),
              alertType: null,
            })
          : buildQaIssueWriteback({
              status: "alerted_missing",
              verdict: classifyQaVerdictFromRun(latestRun).verdict,
              source: "alert",
              canCloseUpstream: false,
              commentId: null,
              writebackAt: latestRun.finishedAt?.toISOString() ?? latestRun.createdAt.toISOString(),
              alertType: "missing_writeback",
            }));
      const baseSummary = buildSummaryFromWriteback(latestRun, persistedWriteback);
      // QA issue state is intentionally derived from the durable run writeback only.
      // Later issue comments or row-status edits are not authoritative QA settlement signals.
      return baseSummary;
    },

    getRunIssueWriteback: async (runId: string): Promise<QaIssueWriteback | null> => {
      const run = await db
        .select({
          id: heartbeatRuns.id,
          resultJson: heartbeatRuns.resultJson,
          contextSnapshot: heartbeatRuns.contextSnapshot,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      if (!run) return null;

      const persisted = readQaIssueWriteback(run.resultJson);
      if (!persisted) return null;

      const issueId = readNonEmptyString(asRecord(run.contextSnapshot)?.issueId);
      if (!issueId) return persisted;

      const latestQaRun = await getLatestTerminalQaRun(issueId);
      return applyLatestFlag(persisted, latestQaRun?.id === run.id);
    },
  };
}
