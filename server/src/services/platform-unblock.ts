import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, heartbeatRuns, issues } from "@paperclipai/db";
import { normalizeAgentUrlKey } from "@paperclipai/shared";
import { deriveHeartbeatRunBusinessVerdict } from "./heartbeat-run-verdict.js";
import { qaIssueStateService } from "./qa-issue-state.js";
import { readQaIssueWriteback } from "./qa-writeback.js";

export type PlatformRecoveryKind =
  | "runtime_recovered"
  | "writeback_gate_repaired"
  | "comment_visibility_recovered"
  | "manual_override";

export type PlatformUnblockCategory =
  | "runtime_process"
  | "qa_writeback_gate"
  | "comment_visibility"
  | "composite";

export type PlatformOwnerRole =
  | "runtime_owner"
  | "qa_writeback_owner"
  | "tech_lead"
  | "cto"
  | "board_operator";

export type PlatformAuthoritativeSignalSource =
  | "close_gate_block"
  | "latest_terminal_run"
  | "qa_summary"
  | "comment_delta_health"
  | "manual_override";

export interface PlatformEvidenceRef {
  kind: "activity" | "run" | "comment";
  label: string;
  href: string;
  at: string | null;
}

export interface CommentVisibilityHealth {
  state: "healthy" | "degraded";
  lastDeltaSuccessAt: string | null;
  lastDeltaFailureAt: string | null;
  lastError: string | null;
  fallbackSignals: string[];
}

export interface IssuePlatformUnblockSummary {
  mode: "product" | "platform";
  primaryCategory: PlatformUnblockCategory | null;
  secondaryCategories: PlatformUnblockCategory[];
  primaryOwnerRole: PlatformOwnerRole | null;
  primaryOwnerAgentId: string | null;
  escalationOwnerRole: PlatformOwnerRole | null;
  escalationOwnerAgentId: string | null;
  authoritativeSignalSource: PlatformAuthoritativeSignalSource | null;
  authoritativeSignalAt: string | null;
  authoritativeRunId: string | null;
  recommendedNextAction: string | null;
  recoveryCriteria: string | null;
  nextCheckpointAt: string | null;
  canRetryEngineering: boolean;
  canCloseUpstream: boolean | null;
  recoveryKind: PlatformRecoveryKind | null;
  commentVisibility: CommentVisibilityHealth | null;
  evidence: PlatformEvidenceRef[];
}

export interface RunPlatformHint {
  latestForIssue: boolean;
  processLost: boolean;
  processLossRetryCount: number;
  writebackAlertType: string | null;
  closeGateBlocked: boolean;
}

const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled", "timed_out"] as const;
const PLATFORM_ACTIVITY_ACTIONS = [
  "issue.close_gate_blocked",
  "issue.close_gate_overridden",
  "issue.comment_delta_read_succeeded",
  "issue.comment_delta_read_failed",
  "issue.platform_recovered",
] as const;
const COMMENT_FALLBACK_SIGNALS = [
  "issue_status",
  "latest_run",
  "qa_summary",
  "manager_comment_or_document",
] as const;

type IssueSummaryRow = {
  id: string;
  companyId: string;
  identifier: string | null;
  status: string;
  updatedAt: Date;
};

type AgentRow = {
  id: string;
  companyId: string;
  name: string;
  role: string;
};

type TerminalRunRow = {
  id: string;
  issueId: string | null;
  agentId: string;
  status: string;
  finishedAt: Date | null;
  createdAt: Date;
  errorCode: string | null;
  resultJson: Record<string, unknown> | null;
  processLossRetryCount: number;
};

type ActivityRow = {
  issueId: string;
  action: string;
  createdAt: Date;
  details: Record<string, unknown> | null;
};

type OwnerDirectory = {
  cto: AgentRow | null;
  techLead: AgentRow | null;
  sweBackend: AgentRow | null;
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

function parseIssuePrefix(identifier: string | null | undefined) {
  const match = typeof identifier === "string" ? identifier.match(/^([A-Z]+)-/i) : null;
  return match?.[1]?.toUpperCase() ?? "PAP";
}

function issueHref(issue: IssueSummaryRow) {
  const prefix = parseIssuePrefix(issue.identifier);
  return `/${prefix}/issues/${issue.identifier ?? issue.id}`;
}

function agentHref(issue: IssueSummaryRow, agent: AgentRow | null) {
  if (!agent) return null;
  const prefix = parseIssuePrefix(issue.identifier);
  return `/${prefix}/agents/${normalizeAgentUrlKey(agent.name) ?? agent.id}`;
}

function runHref(issue: IssueSummaryRow, run: TerminalRunRow, agent: AgentRow | null) {
  const agentLink = agentHref(issue, agent);
  if (!agentLink) return issueHref(issue);
  return `${agentLink}/runs/${run.id}`;
}

function toIso(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

function addMinutes(value: Date | null, minutes: number) {
  if (!value) return null;
  return new Date(value.getTime() + minutes * 60_000).toISOString();
}

function latestDate(...values: Array<Date | null | undefined>) {
  return values
    .filter((value): value is Date => value instanceof Date)
    .sort((left, right) => right.getTime() - left.getTime())[0] ?? null;
}

function findLatestActivity(rows: ActivityRow[], action: string) {
  return rows.find((row) => row.action === action) ?? null;
}

function findLatestRecoveryAt(rows: ActivityRow[], kinds: PlatformRecoveryKind[]) {
  return rows.find((row) => {
    if (row.action !== "issue.platform_recovered") return false;
    const recoveryKind = readNonEmptyString(asRecord(row.details)?.recoveryKind);
    return recoveryKind != null && kinds.includes(recoveryKind as PlatformRecoveryKind);
  })?.createdAt ?? null;
}

function buildOwnerDirectory(companyAgents: AgentRow[]): OwnerDirectory {
  const byUrlKey = new Map<string, AgentRow>();
  for (const agent of companyAgents) {
    const urlKey = normalizeAgentUrlKey(agent.name);
    if (urlKey && !byUrlKey.has(urlKey)) {
      byUrlKey.set(urlKey, agent);
    }
  }

  return {
    cto: companyAgents.find((agent) => agent.role === "cto") ?? byUrlKey.get("cto") ?? null,
    techLead: byUrlKey.get("tech-lead") ?? null,
    sweBackend: byUrlKey.get("swe-backend") ?? null,
  };
}

function buildCommentVisibilityHealth(rows: ActivityRow[]): CommentVisibilityHealth | null {
  const latestSuccess = findLatestActivity(rows, "issue.comment_delta_read_succeeded");
  const latestFailure = findLatestActivity(rows, "issue.comment_delta_read_failed");
  if (!latestSuccess && !latestFailure) return null;

  const degraded =
    !!latestFailure && (!latestSuccess || latestFailure.createdAt.getTime() > latestSuccess.createdAt.getTime());

  return {
    state: degraded ? "degraded" : "healthy",
    lastDeltaSuccessAt: toIso(latestSuccess?.createdAt),
    lastDeltaFailureAt: toIso(latestFailure?.createdAt),
    lastError: readNonEmptyString(asRecord(latestFailure?.details)?.error),
    fallbackSignals: degraded ? [...COMMENT_FALLBACK_SIGNALS] : [],
  };
}

function createEvidence(
  issue: IssueSummaryRow,
  kind: PlatformEvidenceRef["kind"],
  label: string,
  at: Date | null,
  href?: string | null,
): PlatformEvidenceRef {
  return {
    kind,
    label,
    href: href ?? issueHref(issue),
    at: toIso(at),
  };
}

function categoryCheckpointAt(category: PlatformUnblockCategory | null, at: Date | null) {
  if (!category) return null;
  if (category === "comment_visibility" || category === "composite") return addMinutes(at, 15);
  return addMinutes(at, 30);
}

function findGateRecoveredByLaterRunAt(run: TerminalRunRow | null, gateBlockedAt: Date | null) {
  if (!run || !gateBlockedAt) return null;
  const runAt = latestDate(run.finishedAt, run.createdAt);
  if (!runAt || runAt.getTime() <= gateBlockedAt.getTime()) return null;

  const verdict = deriveHeartbeatRunBusinessVerdict({
    status: run.status,
    resultJson: run.resultJson,
    errorCode: run.errorCode,
    error: null,
  });

  return verdict.kind === "blocked" || verdict.kind === "changes_requested"
    ? null
    : runAt;
}

export function platformUnblockService(db: Db) {
  const qaIssueState = qaIssueStateService(db);

  async function loadIssueRows(issueIds: string[]) {
    if (issueIds.length === 0) return [];
    return db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        status: issues.status,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .where(inArray(issues.id, issueIds));
  }

  async function loadTerminalRuns(issueIds: string[]) {
    if (issueIds.length === 0) return [] as TerminalRunRow[];
    const issueIdExpr = sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`;
    return db
      .select({
        id: heartbeatRuns.id,
        issueId: issueIdExpr.as("issueId"),
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        finishedAt: heartbeatRuns.finishedAt,
        createdAt: heartbeatRuns.createdAt,
        errorCode: heartbeatRuns.errorCode,
        resultJson: heartbeatRuns.resultJson,
        processLossRetryCount: heartbeatRuns.processLossRetryCount,
      })
      .from(heartbeatRuns)
      .where(
        and(
          inArray(issueIdExpr, issueIds),
          inArray(heartbeatRuns.status, [...TERMINAL_RUN_STATUSES]),
        ),
      )
      .orderBy(desc(heartbeatRuns.finishedAt), desc(heartbeatRuns.createdAt));
  }

  async function loadActivityRows(issueIds: string[]) {
    if (issueIds.length === 0) return [] as ActivityRow[];
    return db
      .select({
        issueId: activityLog.entityId,
        action: activityLog.action,
        createdAt: activityLog.createdAt,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityType, "issue"),
          inArray(activityLog.entityId, issueIds),
          inArray(activityLog.action, [...PLATFORM_ACTIVITY_ACTIONS]),
        ),
      )
      .orderBy(desc(activityLog.createdAt));
  }

  async function loadAgents(companyIds: string[]) {
    if (companyIds.length === 0) return [] as AgentRow[];
    return db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        name: agents.name,
        role: agents.role,
      })
      .from(agents)
      .where(inArray(agents.companyId, companyIds));
  }

  async function buildSummaries(issueRows: IssueSummaryRow[]) {
    const issueIds = issueRows.map((issue) => issue.id);
    const companyIds = Array.from(new Set(issueRows.map((issue) => issue.companyId)));
    const [terminalRuns, activityRows, companyAgents, qaSummaries] = await Promise.all([
      loadTerminalRuns(issueIds),
      loadActivityRows(issueIds),
      loadAgents(companyIds),
      Promise.all(issueRows.map(async (issue) => [issue.id, await qaIssueState.getIssueQaSummary(issue.id)] as const)),
    ]);

    const terminalRunsByIssueId = new Map<string, TerminalRunRow[]>();
    const runById = new Map<string, TerminalRunRow>();
    for (const run of terminalRuns) {
      if (!run.issueId) continue;
      runById.set(run.id, run);
      const existing = terminalRunsByIssueId.get(run.issueId);
      if (existing) existing.push(run);
      else terminalRunsByIssueId.set(run.issueId, [run]);
    }

    const activityByIssueId = new Map<string, ActivityRow[]>();
    for (const row of activityRows) {
      const existing = activityByIssueId.get(row.issueId);
      if (existing) existing.push(row);
      else activityByIssueId.set(row.issueId, [row]);
    }

    const ownersByCompanyId = new Map<string, OwnerDirectory>();
    for (const companyId of companyIds) {
      ownersByCompanyId.set(
        companyId,
        buildOwnerDirectory(companyAgents.filter((agent) => agent.companyId === companyId)),
      );
    }

    const qaSummaryByIssueId = new Map(qaSummaries);

    const summaries = new Map<string, IssuePlatformUnblockSummary>();
    for (const issue of issueRows) {
      const issueRuns = terminalRunsByIssueId.get(issue.id) ?? [];
      const latestTerminalRun = issueRuns[0] ?? null;
      const previousTerminalRun = issueRuns[1] ?? null;
      const issueActivities = activityByIssueId.get(issue.id) ?? [];
      const owners = ownersByCompanyId.get(issue.companyId) ?? {
        cto: null,
        techLead: null,
        sweBackend: null,
      };
      const qaSummary = qaSummaryByIssueId.get(issue.id) ?? null;
      const commentVisibility = buildCommentVisibilityHealth(issueActivities);
      const latestGateBlocked = findLatestActivity(issueActivities, "issue.close_gate_blocked");
      const latestCommentFailure = findLatestActivity(issueActivities, "issue.comment_delta_read_failed");
      const latestCommentSuccess = findLatestActivity(issueActivities, "issue.comment_delta_read_succeeded");
      const latestRecovery = issueActivities.find((row) => row.action === "issue.platform_recovered") ?? null;
      const latestRecoveryKind = readNonEmptyString(asRecord(latestRecovery?.details)?.recoveryKind) as PlatformRecoveryKind | null;

      const runtimeRecoveryAt = findLatestRecoveryAt(issueActivities, ["runtime_recovered", "manual_override"]);
      const gateRecoveryAt = findLatestRecoveryAt(issueActivities, ["writeback_gate_repaired", "manual_override"]);
      const commentRecoveryAt = findLatestRecoveryAt(issueActivities, ["comment_visibility_recovered", "manual_override"]);
      const gateRecoveredByLaterRunAt = findGateRecoveredByLaterRunAt(latestTerminalRun, latestGateBlocked?.createdAt ?? null);
      const effectiveGateRecoveryAt = latestDate(gateRecoveryAt, gateRecoveredByLaterRunAt);
      const recoveryKind =
        latestRecovery && (!gateRecoveredByLaterRunAt || latestRecovery.createdAt.getTime() >= gateRecoveredByLaterRunAt.getTime())
          ? latestRecoveryKind
          : gateRecoveredByLaterRunAt
            ? "writeback_gate_repaired"
            : latestRecoveryKind;

      const runtimeActive = Boolean(
        latestTerminalRun
        && latestTerminalRun.errorCode === "process_lost"
        && (
          latestTerminalRun.processLossRetryCount > 0
          || previousTerminalRun?.errorCode === "process_lost"
        )
        && (!runtimeRecoveryAt || latestDate(latestTerminalRun.finishedAt, latestTerminalRun.createdAt)!.getTime() > runtimeRecoveryAt.getTime()),
      );

      const gateSignalAt = latestGateBlocked?.createdAt ?? null;
      const gateActive = Boolean(
        (qaSummary?.alertOpen === true)
        || (
          latestGateBlocked
          && (!effectiveGateRecoveryAt || latestGateBlocked.createdAt.getTime() > effectiveGateRecoveryAt.getTime())
        ),
      );

      const commentActive = Boolean(
        latestCommentFailure
        && (!latestCommentSuccess || latestCommentFailure.createdAt.getTime() > latestCommentSuccess.createdAt.getTime())
        && (!commentRecoveryAt || latestCommentFailure.createdAt.getTime() > commentRecoveryAt.getTime())
      );

      const activeCategories: PlatformUnblockCategory[] = [];
      if (runtimeActive) activeCategories.push("runtime_process");
      if (gateActive) activeCategories.push("qa_writeback_gate");
      if (commentActive) activeCategories.push("comment_visibility");

      const primaryCategory =
        activeCategories.length === 0
          ? null
          : activeCategories.length === 1
            ? activeCategories[0]!
            : "composite";
      const secondaryCategories = primaryCategory === "composite" ? activeCategories : [];

      let primaryOwnerRole: PlatformOwnerRole | null = null;
      let primaryOwnerAgentId: string | null = null;
      let escalationOwnerRole: PlatformOwnerRole | null = null;
      let escalationOwnerAgentId: string | null = null;

      if (primaryCategory === "runtime_process") {
        primaryOwnerRole = "runtime_owner";
        primaryOwnerAgentId = owners.cto?.id ?? null;
        escalationOwnerRole = "board_operator";
      } else if (primaryCategory === "qa_writeback_gate") {
        primaryOwnerRole = "qa_writeback_owner";
        primaryOwnerAgentId = owners.sweBackend?.id ?? null;
        escalationOwnerRole = "tech_lead";
        escalationOwnerAgentId = owners.techLead?.id ?? null;
      } else if (primaryCategory === "comment_visibility" || primaryCategory === "composite") {
        primaryOwnerRole = "tech_lead";
        primaryOwnerAgentId = owners.techLead?.id ?? null;
        escalationOwnerRole = "cto";
        escalationOwnerAgentId = owners.cto?.id ?? null;
      }

      let authoritativeSignalSource: PlatformAuthoritativeSignalSource | null = null;
      let authoritativeSignalAt: string | null = null;
      let authoritativeRunId: string | null = null;

      if (primaryCategory !== null) {
        if (latestGateBlocked) {
          authoritativeSignalSource = "close_gate_block";
          authoritativeSignalAt = toIso(latestGateBlocked.createdAt);
          authoritativeRunId = readNonEmptyString(asRecord(latestGateBlocked.details)?.runId);
        } else if (runtimeActive && latestTerminalRun) {
          authoritativeSignalSource = "latest_terminal_run";
          authoritativeSignalAt = toIso(latestDate(latestTerminalRun.finishedAt, latestTerminalRun.createdAt));
          authoritativeRunId = latestTerminalRun.id;
        } else if (gateActive && qaSummary) {
          authoritativeSignalSource = "qa_summary";
          authoritativeSignalAt = qaSummary.writebackAt ?? qaSummary.latestRunFinishedAt ?? null;
          authoritativeRunId = qaSummary.latestRunId;
        } else if (commentActive) {
          authoritativeSignalSource = "comment_delta_health";
          authoritativeSignalAt = toIso(latestCommentFailure?.createdAt ?? null);
        }
      } else if (latestRecovery && latestRecoveryKind === "manual_override") {
        authoritativeSignalSource = "manual_override";
        authoritativeSignalAt = toIso(latestRecovery.createdAt);
      } else if (qaSummary) {
        authoritativeSignalSource = "qa_summary";
        authoritativeSignalAt = qaSummary.writebackAt ?? qaSummary.latestRunFinishedAt ?? null;
        authoritativeRunId = qaSummary.latestRunId;
      } else if (latestTerminalRun) {
        authoritativeSignalSource = "latest_terminal_run";
        authoritativeSignalAt = toIso(latestDate(latestTerminalRun.finishedAt, latestTerminalRun.createdAt));
        authoritativeRunId = latestTerminalRun.id;
      }

      let recommendedNextAction: string | null = null;
      let recoveryCriteria: string | null = null;
      let canCloseUpstream: boolean | null = qaSummary?.canCloseUpstream ?? (issue.status === "done" ? true : null);

      if (primaryCategory === "runtime_process") {
        recommendedNextAction = "Restore the execution environment or approve a substitute completion path.";
        recoveryCriteria = "Record one fresh non-process_lost terminal run for the issue or an approved manual override.";
        canCloseUpstream = false;
      } else if (primaryCategory === "qa_writeback_gate") {
        recommendedNextAction = "Repair QA writeback settlement or clear the erroneous close gate without asking for fresh product code.";
        recoveryCriteria = "Settle QA summary to a single non-alerting state and record a successful close signal or explicit override.";
        canCloseUpstream = false;
      } else if (primaryCategory === "comment_visibility") {
        recommendedNextAction = "Pause retry-based decisions and rely on fallback signals until comment delta health recovers.";
        recoveryCriteria = "Record a newer successful comment delta read or an approved manual override.";
        canCloseUpstream = false;
      } else if (primaryCategory === "composite") {
        recommendedNextAction = "Triage the runtime, gate, and comment visibility blockers in order before asking engineering to retry.";
        recoveryCriteria = "Resolve each active blocker category and leave one authoritative recovered state.";
        canCloseUpstream = false;
      } else if (recoveryKind) {
        recommendedNextAction = "Platform blocker has a recorded recovery; continue with normal execution or close-out flow.";
        recoveryCriteria = "Already recovered.";
      }

      const evidence: PlatformEvidenceRef[] = [];
      if (latestGateBlocked) {
        evidence.push(createEvidence(issue, "activity", "Close gate blocked", latestGateBlocked.createdAt, issueHref(issue)));
      }
      if (latestTerminalRun) {
        evidence.push(
          createEvidence(
            issue,
            "run",
            runtimeActive ? "Latest process_lost run" : "Latest terminal run",
            latestDate(latestTerminalRun.finishedAt, latestTerminalRun.createdAt),
            runHref(issue, latestTerminalRun, companyAgents.find((agent) => agent.id === latestTerminalRun.agentId) ?? null),
          ),
        );
      }
      if (qaSummary?.latestRunId) {
        const qaRun = runById.get(qaSummary.latestRunId) ?? null;
        evidence.push(
          createEvidence(
            issue,
            "run",
            qaSummary.alertOpen ? "QA summary alert" : "QA summary",
            qaRun ? latestDate(qaRun.finishedAt, qaRun.createdAt) : (qaSummary.writebackAt ? new Date(qaSummary.writebackAt) : null),
            qaRun ? runHref(issue, qaRun, companyAgents.find((agent) => agent.id === qaRun.agentId) ?? null) : issueHref(issue),
          ),
        );
      }
      if (latestCommentFailure) {
        evidence.push(createEvidence(issue, "activity", "Comment delta degraded", latestCommentFailure.createdAt, issueHref(issue)));
      }
      if (latestRecovery && latestRecoveryKind) {
        evidence.push(
          createEvidence(
            issue,
            "activity",
            `Recovered via ${latestRecoveryKind}`,
            latestRecovery.createdAt,
            issueHref(issue),
          ),
        );
      }

      summaries.set(issue.id, {
        mode: primaryCategory === null ? "product" : "platform",
        primaryCategory,
        secondaryCategories,
        primaryOwnerRole,
        primaryOwnerAgentId,
        escalationOwnerRole,
        escalationOwnerAgentId,
        authoritativeSignalSource,
        authoritativeSignalAt,
        authoritativeRunId,
        recommendedNextAction,
        recoveryCriteria,
        nextCheckpointAt: categoryCheckpointAt(
          primaryCategory,
          latestDate(
            authoritativeSignalAt ? new Date(authoritativeSignalAt) : null,
            gateSignalAt,
            latestCommentFailure?.createdAt,
            latestTerminalRun ? latestDate(latestTerminalRun.finishedAt, latestTerminalRun.createdAt) : null,
            issue.updatedAt,
          ),
        ),
        canRetryEngineering: primaryCategory === null ? true : false,
        canCloseUpstream,
        recoveryKind,
        commentVisibility,
        evidence,
      });
    }

    return summaries;
  }

  return {
    async getIssuePlatformUnblockSummary(issueId: string): Promise<IssuePlatformUnblockSummary | null> {
      const rows = await loadIssueRows([issueId]);
      if (rows.length === 0) return null;
      const summaries = await buildSummaries(rows);
      return summaries.get(issueId) ?? null;
    },

    async listIssuePlatformUnblockSummaries(issueIds: string[]) {
      const uniqueIssueIds = Array.from(new Set(issueIds.filter((issueId) => issueId.trim().length > 0)));
      const rows = await loadIssueRows(uniqueIssueIds);
      return buildSummaries(rows);
    },

    async getRunPlatformHint(runId: string): Promise<RunPlatformHint | null> {
      const run = await db
        .select({
          id: heartbeatRuns.id,
          companyId: heartbeatRuns.companyId,
          contextSnapshot: heartbeatRuns.contextSnapshot,
          errorCode: heartbeatRuns.errorCode,
          processLossRetryCount: heartbeatRuns.processLossRetryCount,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      if (!run) return null;

      const issueId = readNonEmptyString(asRecord(run.contextSnapshot)?.issueId);
      if (!issueId) {
        return {
          latestForIssue: false,
          processLost: run.errorCode === "process_lost",
          processLossRetryCount: run.processLossRetryCount ?? 0,
          writebackAlertType: readQaIssueWriteback(run.resultJson)?.alertType ?? null,
          closeGateBlocked: false,
        };
      }

      const issueIdExpr = sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`;
      const [latestRun, closeGateBlock] = await Promise.all([
        db
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(and(eq(heartbeatRuns.companyId, run.companyId), eq(issueIdExpr, issueId)))
          .orderBy(desc(heartbeatRuns.createdAt))
          .limit(1)
          .then((rows) => rows[0] ?? null),
        db
          .select({ id: activityLog.id })
          .from(activityLog)
          .where(
            and(
              eq(activityLog.companyId, run.companyId),
              eq(activityLog.entityType, "issue"),
              eq(activityLog.entityId, issueId),
              eq(activityLog.action, "issue.close_gate_blocked"),
              eq(sql<string | null>`${activityLog.details} ->> 'runId'`, runId),
            ),
          )
          .orderBy(desc(activityLog.createdAt))
          .limit(1)
          .then((rows) => rows[0] ?? null),
      ]);

      return {
        latestForIssue: latestRun?.id === runId,
        processLost: run.errorCode === "process_lost",
        processLossRetryCount: run.processLossRetryCount ?? 0,
        writebackAlertType: readQaIssueWriteback(run.resultJson)?.alertType ?? null,
        closeGateBlocked: closeGateBlock != null,
      };
    },
  };
}
