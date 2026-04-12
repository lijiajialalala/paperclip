import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, issues } from "@paperclipai/db";
import { ISSUE_STATUSES, IssueStatus } from "@paperclipai/shared";

export interface PlatformEvidenceRef {
  kind: "activity" | "run" | "comment";
  label: string;
  href: string | null;
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
  reasonSummary: string;
  canExecute: boolean;
  canClose: boolean;
  /** True when consistency === "drifted" and the persisted row should be healed to authoritativeStatus. */
  repairDrift: boolean;
  driftCode: "blocked_checkout_reopen" | "status_mismatch" | null;
  evidence: PlatformEvidenceRef[];
}

type IssueRow = {
  id: string;
  companyId: string;
  identifier: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
};

type StatusActivityRow = {
  id: string;
  issueId: string;
  action: string;
  actorType: string;
  actorId: string;
  createdAt: Date;
  details: Record<string, unknown> | null;
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
  at: Date | null,
): PlatformEvidenceRef {
  return {
    kind,
    label,
    href: issueHref(issue),
    at: at?.toISOString() ?? null,
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

function buildSummary(issue: IssueRow, latestActivity: StatusActivityRow | null): IssueStatusTruthSummary {
  const details = asRecord(latestActivity?.details);
  const persistedStatus = coerceIssueStatus(issue.status);
  const authoritativeStatus = coerceIssueStatus(readNonEmptyString(details?.status), persistedStatus);
  const authoritativeSource: IssueStatusTruthSummary["authoritativeSource"] = latestActivity
    ? "status_activity"
    : issue.updatedAt.getTime() === issue.createdAt.getTime()
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

  return {
    effectiveStatus,
    persistedStatus,
    authoritativeStatus,
    consistency,
    authoritativeAt: (latestActivity?.createdAt ?? issue.updatedAt)?.toISOString() ?? null,
    authoritativeSource,
    authoritativeActorType: coerceActorType(latestActivity?.actorType),
    authoritativeActorId: latestActivity?.actorId ?? null,
    reasonSummary: summarizeReason(authoritativeStatus, details, authoritativeSource),
    // canExecute: only allow execution if state is stable and the authoritative status permits it.
    canExecute: consistency === "consistent" && canExecuteForStatus(effectiveStatus),
    // canClose: based on the authoritative truth, not consistency.
    // If the event-log says the issue is done/in_progress but the DB row hasn't caught up,
    // we should still allow close rather than incorrectly blocking.
    canClose: canCloseForStatus(authoritativeStatus),
    // repairDrift signals callers to heal the persisted row before proceeding.
    repairDrift: consistency === "drifted",
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

  async function getIssueStatusTruthSummaries(issueIds: string[]) {
    const uniqueIssueIds = Array.from(new Set(issueIds.filter((issueId) => issueId.trim().length > 0)));
    const issueRows = await loadIssueRows(uniqueIssueIds);
    const latestActivities = await loadLatestStatusActivities(issueRows.map((issue) => issue.id));
    const summaries = new Map<string, IssueStatusTruthSummary>();

    for (const issue of issueRows) {
      summaries.set(issue.id, buildSummary(issue, latestActivities.get(issue.id) ?? null));
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
