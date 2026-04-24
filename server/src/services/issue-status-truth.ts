import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, heartbeatRunEvents, heartbeatRuns, issues } from "@paperclipai/db";
import { ISSUE_STATUSES, IssueStatus } from "@paperclipai/shared";
import { getIssueExecutionPlanGateReason, type IssueExecutionPlanGateReason } from "./issue-plan-policy.js";

const ISSUE_STALLED_RUN_THRESHOLD_MS = 5 * 60 * 1000;

export interface PlatformEvidenceRef {
  kind: "activity" | "run" | "comment";
  label: string;
  href: string;
  at: string | null;
}

export interface IssueStatusTruthSummary {
  effectiveStatus: IssueStatus;
  persistedStatus: IssueStatus;
  authoritativeStatus: IssueStatus;
  consistency: "consistent" | "drifted";
  authoritativeAt: string | null;
  authoritativeSource: "status_activity" | "bootstrap" | "issue_row";
  authoritativeActorType: "agent" | "user" | "system" | null;
  authoritativeActorId: string | null;
  reasonSummary: string | null;
  canExecute: boolean;
  canClose: boolean;
  executionState: "idle" | "active" | "stalled";
  executionDiagnosis: "no_active_run" | null;
  lastExecutionSignalAt: string | null;
  stalledSince: string | null;
  stalledThresholdMs: number | null;
  driftCode: "blocked_checkout_reopen" | "status_mismatch" | null;
  evidence: PlatformEvidenceRef[];
}

type IssueRow = {
  id: string;
  companyId: string;
  identifier: string | null;
  status: string;
  originKind: string | null;
  parentId: string | null;
  assigneeAgentId: string | null;
  executionRunId: string | null;
  planProposedAt: Date | string | null;
  planApprovedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type StatusActivityRow = {
  id: string;
  issueId: string;
  action: string;
  actorType: string;
  actorId: string;
  createdAt: Date | string;
  details: Record<string, unknown> | null;
};

type ExecutionSignalRow = {
  issueId: string;
  hasActiveExecutionRun: boolean;
  latestRunEventAt: Date | string | null;
  latestRunUpdateAt: Date | string | null;
};

type EffectiveStatusIssue<T extends { status: string }> = Omit<T, "status"> & {
  status: IssueStatus;
  statusTruthSummary?: IssueStatusTruthSummary | null;
};

const ISSUE_STATUS_SET = new Set<string>(ISSUE_STATUSES);
const STATUS_ACTIVITY_ACTIONS = ["issue.updated", "issue.checked_out", "issue.released"] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function coerceIssueStatus(value: string | null | undefined, fallback: IssueStatus = "todo"): IssueStatus {
  return typeof value === "string" && ISSUE_STATUS_SET.has(value)
    ? value as IssueStatus
    : fallback;
}

function coerceActorType(value: string | null | undefined): IssueStatusTruthSummary["authoritativeActorType"] {
  return value === "agent" || value === "user" || value === "system"
    ? value
    : null;
}

function parseIssuePrefix(identifier: string | null | undefined) {
  const match = typeof identifier === "string" ? identifier.match(/^([A-Z]+)-/i) : null;
  return match?.[1]?.toUpperCase() ?? "PAP";
}

function issueHref(issue: Pick<IssueRow, "id" | "identifier">) {
  const prefix = parseIssuePrefix(issue.identifier);
  return `/${prefix}/issues/${issue.identifier ?? issue.id}`;
}

function createEvidence(
  issue: IssueRow,
  kind: PlatformEvidenceRef["kind"],
  label: string,
  at: Date | string | null,
): PlatformEvidenceRef {
  return {
    kind,
    label,
    href: issueHref(issue),
    at: coerceDate(at)?.toISOString() ?? null,
  };
}

function summarizeReason(
  status: IssueStatus,
  details: Record<string, unknown> | null,
  source: IssueStatusTruthSummary["authoritativeSource"],
) {
  const explicitSummary = readNonEmptyString(details?.reasonSummary);
  if (explicitSummary) return explicitSummary;

  const previousStatus = readNonEmptyString(asRecord(details?._previous)?.status);
  if (source === "status_activity" && previousStatus) {
    return `Latest explicit status activity moved the issue from ${previousStatus} to ${status}.`;
  }
  if (source === "status_activity") {
    return `Latest explicit status activity set the issue to ${status}.`;
  }
  if (source === "bootstrap") {
    return "Using the initial persisted issue row because no explicit status activity exists yet.";
  }
  return "Using the persisted issue row because no explicit status activity exists.";
}

function canExecuteForStatus(status: IssueStatus) {
  return status !== "blocked" && status !== "done" && status !== "cancelled";
}

function canCloseForStatus(status: IssueStatus) {
  return status !== "blocked" && status !== "cancelled";
}

function coerceDate(value: Date | string | null | undefined) {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  return null;
}

function maxDate(...values: Array<Date | string | null | undefined>) {
  const timestamps = values
    .map((value) => coerceDate(value)?.getTime() ?? Number.NaN)
    .filter((value) => Number.isFinite(value));
  if (timestamps.length === 0) return null;
  return new Date(Math.max(...timestamps));
}

function resolveExecutionDiagnosis(input: {
  effectiveStatus: IssueStatus;
  authoritativeStatus: IssueStatus;
  issue: IssueRow;
  planGateReason: IssueExecutionPlanGateReason | null;
  latestSignal: ExecutionSignalRow | null;
  now: Date;
}) {
  const statusSuggestsExecution =
    !input.planGateReason
    && (
      input.effectiveStatus === "in_progress"
      || input.effectiveStatus === "in_review"
      || input.authoritativeStatus === "in_progress"
      || input.authoritativeStatus === "in_review"
    );

  if (!statusSuggestsExecution) {
    return {
      executionState: "idle" as const,
      executionDiagnosis: null,
      lastExecutionSignalAt: null,
      stalledSince: null,
      stalledThresholdMs: null,
    };
  }

  const latestExecutionSignalAt =
    maxDate(
      input.latestSignal?.latestRunEventAt ?? null,
      input.latestSignal?.latestRunUpdateAt ?? null,
    ) ?? coerceDate(input.issue.updatedAt);
  const latestExecutionSignalIso = latestExecutionSignalAt?.toISOString() ?? null;

  if (input.latestSignal?.hasActiveExecutionRun) {
    return {
      executionState: "active" as const,
      executionDiagnosis: null,
      lastExecutionSignalAt: latestExecutionSignalIso,
      stalledSince: null,
      stalledThresholdMs: null,
    };
  }

  const stale =
    latestExecutionSignalAt != null
      && input.now.getTime() - latestExecutionSignalAt.getTime() >= ISSUE_STALLED_RUN_THRESHOLD_MS;

  if (!stale) {
    return {
      executionState: "idle" as const,
      executionDiagnosis: null,
      lastExecutionSignalAt: latestExecutionSignalIso,
      stalledSince: null,
      stalledThresholdMs: ISSUE_STALLED_RUN_THRESHOLD_MS,
    };
  }

  return {
    executionState: "stalled" as const,
    executionDiagnosis: "no_active_run" as const,
    lastExecutionSignalAt: latestExecutionSignalIso,
    stalledSince: latestExecutionSignalIso,
    stalledThresholdMs: ISSUE_STALLED_RUN_THRESHOLD_MS,
  };
}

function buildSummary(
  issue: IssueRow,
  latestActivity: StatusActivityRow | null,
  latestSignal: ExecutionSignalRow | null,
  now: Date,
): IssueStatusTruthSummary {
  const details = asRecord(latestActivity?.details);
  const persistedStatus = coerceIssueStatus(issue.status);
  const authoritativeStatus = coerceIssueStatus(readNonEmptyString(details?.status), persistedStatus);
  const issueUpdatedAt = coerceDate(issue.updatedAt);
  const issueCreatedAt = coerceDate(issue.createdAt);
  const authoritativeSource: IssueStatusTruthSummary["authoritativeSource"] = latestActivity
    ? "status_activity"
    : issueUpdatedAt?.getTime() === issueCreatedAt?.getTime()
      ? "bootstrap"
      : "issue_row";
  const consistency: IssueStatusTruthSummary["consistency"] =
    persistedStatus === authoritativeStatus ? "consistent" : "drifted";
  const effectiveStatus = consistency === "consistent" ? persistedStatus : authoritativeStatus;
  const driftCode =
    consistency === "drifted"
      ? authoritativeStatus === "blocked" && persistedStatus === "in_progress"
        ? "blocked_checkout_reopen"
        : "status_mismatch"
      : null;
  const evidence: PlatformEvidenceRef[] = [];
  const planGateReason = getIssueExecutionPlanGateReason(issue);
  const executionDiagnosis = resolveExecutionDiagnosis({
    effectiveStatus,
    authoritativeStatus,
    issue,
    planGateReason,
    latestSignal,
    now,
  });

  if (latestActivity) {
    evidence.push(
      createEvidence(
        issue,
        "activity",
        `Latest explicit status activity -> ${authoritativeStatus}`,
        latestActivity.createdAt,
      ),
    );
  }
  if (consistency === "drifted") {
    evidence.push(
      createEvidence(
        issue,
        "activity",
        `Persisted issue row still reports ${persistedStatus}`,
        issue.updatedAt,
      ),
    );
  } else if (!latestActivity) {
    evidence.push(
      createEvidence(
        issue,
        "activity",
        `Persisted issue row -> ${persistedStatus}`,
        issue.updatedAt,
      ),
    );
  }
  if (executionDiagnosis.executionDiagnosis === "no_active_run") {
    evidence.push(
      createEvidence(
        issue,
        "run",
        "Issue is marked active, but no queued or running heartbeat run is currently linked",
        executionDiagnosis.stalledSince ? new Date(executionDiagnosis.stalledSince) : null,
      ),
    );
  }

  return {
    effectiveStatus,
    persistedStatus,
    authoritativeStatus,
    consistency,
    authoritativeAt: coerceDate(latestActivity?.createdAt ?? issue.updatedAt)?.toISOString() ?? null,
    authoritativeSource,
    authoritativeActorType: coerceActorType(latestActivity?.actorType),
    authoritativeActorId: latestActivity?.actorId ?? null,
    reasonSummary: summarizeReason(authoritativeStatus, details, authoritativeSource),
    canExecute:
      consistency === "consistent"
      && canExecuteForStatus(effectiveStatus)
      && !planGateReason,
    canClose: canCloseForStatus(authoritativeStatus),
    executionState: executionDiagnosis.executionState,
    executionDiagnosis: executionDiagnosis.executionDiagnosis,
    lastExecutionSignalAt: executionDiagnosis.lastExecutionSignalAt,
    stalledSince: executionDiagnosis.stalledSince,
    stalledThresholdMs: executionDiagnosis.stalledThresholdMs,
    driftCode,
    evidence,
  };
}

function normalizeStatusActivityRow(row: StatusActivityRow): StatusActivityRow | null {
  const details = asRecord(row.details) ?? {};

  if (row.action === "issue.updated") {
    return readNonEmptyString(details.status)
      ? { ...row, details }
      : null;
  }

  if (row.action === "issue.checked_out") {
    return {
      ...row,
      details: {
        ...details,
        status: readNonEmptyString(details.status) ?? "in_progress",
        source: readNonEmptyString(details.source) ?? "checkout",
      },
    };
  }

  if (row.action === "issue.released") {
    return {
      ...row,
      details: {
        ...details,
        status: readNonEmptyString(details.status) ?? "todo",
        source: readNonEmptyString(details.source) ?? "release",
      },
    };
  }

  return null;
}

export function applyEffectiveStatus<T extends { status: string }>(
  issue: T,
  summary: IssueStatusTruthSummary | null,
): EffectiveStatusIssue<T> {
  if (!summary) {
    return {
      ...issue,
      status: coerceIssueStatus(issue.status),
    } as EffectiveStatusIssue<T>;
  }
  return {
    ...issue,
    status: summary.effectiveStatus,
    statusTruthSummary: summary,
  } as EffectiveStatusIssue<T>;
}

export function issueStatusTruthService(db: Db) {
  async function loadIssueRows(issueIds: string[]) {
    if (issueIds.length === 0) return [] as IssueRow[];
    return db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        status: issues.status,
        originKind: issues.originKind,
        parentId: issues.parentId,
        assigneeAgentId: issues.assigneeAgentId,
        executionRunId: issues.executionRunId,
        planProposedAt: issues.planProposedAt,
        planApprovedAt: issues.planApprovedAt,
        createdAt: issues.createdAt,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .where(inArray(issues.id, issueIds));
  }

  async function loadLatestStatusActivities(issueIds: string[]) {
    if (issueIds.length === 0) return new Map<string, StatusActivityRow>();
    const rows = await db
      .select({
        id: activityLog.id,
        issueId: activityLog.entityId,
        action: activityLog.action,
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
        createdAt: activityLog.createdAt,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityType, "issue"),
          inArray(activityLog.action, [...STATUS_ACTIVITY_ACTIONS]),
          inArray(activityLog.entityId, issueIds),
        ),
      )
      .orderBy(desc(activityLog.createdAt));

    const latestByIssueId = new Map<string, StatusActivityRow>();
    for (const row of rows) {
      const normalized = normalizeStatusActivityRow(row);
      if (normalized && !latestByIssueId.has(normalized.issueId)) {
        latestByIssueId.set(normalized.issueId, normalized);
      }
    }
    return latestByIssueId;
  }

  async function loadExecutionSignals(issueIds: string[]) {
    if (issueIds.length === 0) return new Map<string, ExecutionSignalRow>();
    const runMatchesIssue = sql<boolean>`
      ${heartbeatRuns.id} = ${issues.executionRunId}
      OR ${heartbeatRuns.contextSnapshot} ->> 'issueId' = cast(${issues.id} as text)
    `;
    const rows = await db
      .select({
        issueId: issues.id,
        hasActiveExecutionRun: sql<boolean>`
          coalesce(bool_or(${heartbeatRuns.status} in ('queued', 'running')), false)
        `,
        latestRunEventAt: sql<Date | string | null>`MAX(${heartbeatRunEvents.createdAt})`,
        latestRunUpdateAt: sql<Date | string | null>`MAX(${heartbeatRuns.updatedAt})`,
      })
      .from(issues)
      .leftJoin(heartbeatRuns, runMatchesIssue)
      .leftJoin(heartbeatRunEvents, eq(heartbeatRunEvents.runId, heartbeatRuns.id))
      .where(inArray(issues.id, issueIds))
      .groupBy(issues.id, issues.executionRunId);

    const latestByIssueId = new Map<string, ExecutionSignalRow>();
    for (const row of rows) {
      latestByIssueId.set(row.issueId, {
        ...row,
        latestRunEventAt: coerceDate(row.latestRunEventAt),
        latestRunUpdateAt: coerceDate(row.latestRunUpdateAt),
      });
    }
    return latestByIssueId;
  }

  async function getIssueStatusTruthSummaries(issueIds: string[]) {
    const uniqueIssueIds = Array.from(new Set(issueIds.filter((issueId) => issueId.trim().length > 0)));
    const issueRows = await loadIssueRows(uniqueIssueIds);
    const [latestActivities, latestSignals] = await Promise.all([
      loadLatestStatusActivities(issueRows.map((issue) => issue.id)),
      loadExecutionSignals(issueRows.map((issue) => issue.id)),
    ]);
    const summaries = new Map<string, IssueStatusTruthSummary>();
    const now = new Date();

    for (const issue of issueRows) {
      summaries.set(
        issue.id,
        buildSummary(
          issue,
          latestActivities.get(issue.id) ?? null,
          latestSignals.get(issue.id) ?? null,
          now,
        ),
      );
    }

    return summaries;
  }

  return {
    async getIssueStatusTruthSummary(issueId: string): Promise<IssueStatusTruthSummary | null> {
      const summaries = await getIssueStatusTruthSummaries([issueId]);
      return summaries.get(issueId) ?? null;
    },

    getIssueStatusTruthSummaries,
  };
}
