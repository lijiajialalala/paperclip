import type { Agent, Issue } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { AlertTriangle } from "lucide-react";
import { cn, formatDateTime, relativeTime } from "../lib/utils";

type IssuePlatformUnblockSummary = NonNullable<Issue["platformUnblockSummary"]>;

const CATEGORY_LABELS: Record<NonNullable<IssuePlatformUnblockSummary["primaryCategory"]>, string> = {
  runtime_process: "Runtime process",
  qa_writeback_gate: "QA writeback gate",
  comment_visibility: "Comment visibility",
  composite: "Composite platform blocker",
};

const OWNER_ROLE_LABELS: Record<Exclude<IssuePlatformUnblockSummary["primaryOwnerRole"], null>, string> = {
  runtime_owner: "Runtime owner",
  qa_writeback_owner: "QA writeback owner",
  tech_lead: "Tech lead",
  cto: "CTO",
  board_operator: "Board operator",
};

const SIGNAL_SOURCE_LABELS: Record<Exclude<IssuePlatformUnblockSummary["authoritativeSignalSource"], null>, string> = {
  close_gate_block: "Close gate block",
  latest_terminal_run: "Latest terminal run",
  qa_summary: "QA summary",
  comment_delta_health: "Comment delta health",
  manual_override: "Manual override",
};

function resolveAgentName(agentId: string | null, agentMap: Map<string, Agent>) {
  if (!agentId) return null;
  return agentMap.get(agentId)?.name ?? null;
}

function resolveOwnerLabel(
  role: IssuePlatformUnblockSummary["primaryOwnerRole"],
  agentId: string | null,
  agentMap: Map<string, Agent>,
) {
  if (!role) return null;
  const roleLabel = OWNER_ROLE_LABELS[role];
  const agentName = resolveAgentName(agentId, agentMap);
  return agentName ? `${roleLabel}: ${agentName}` : roleLabel;
}

function resolveAuthoritativeRunHref(summary: IssuePlatformUnblockSummary) {
  if (!summary.authoritativeRunId) return null;
  return summary.evidence.find(
    (entry: IssuePlatformUnblockSummary["evidence"][number]) =>
      entry.kind === "run" && entry.href.includes(summary.authoritativeRunId!),
  )?.href ?? null;
}

export function IssuePlatformUnblockBanner({
  summary,
  agentMap,
}: {
  summary: IssuePlatformUnblockSummary | null | undefined;
  agentMap: Map<string, Agent>;
}) {
  if (!summary || summary.mode !== "platform" || !summary.primaryCategory) {
    return null;
  }

  const primaryOwner = resolveOwnerLabel(summary.primaryOwnerRole, summary.primaryOwnerAgentId, agentMap);
  const escalationOwner = resolveOwnerLabel(summary.escalationOwnerRole, summary.escalationOwnerAgentId, agentMap);
  const authoritativeRunHref = resolveAuthoritativeRunHref(summary);
  const authoritativeSignalLabel = summary.authoritativeSignalSource
    ? SIGNAL_SOURCE_LABELS[summary.authoritativeSignalSource]
    : "Unknown";
  const checkpointText = summary.nextCheckpointAt
    ? `${formatDateTime(summary.nextCheckpointAt)} (${relativeTime(summary.nextCheckpointAt)})`
    : null;

  return (
    <div className="space-y-3 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-300" />
            <p className="text-sm font-semibold text-foreground">Platform blocker</p>
          </div>
          <p className="text-sm text-muted-foreground">
            {CATEGORY_LABELS[summary.primaryCategory]} is currently the authoritative blocker for this issue.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span
            className={cn(
              "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
              summary.blocksExecutionRetry
                ? "bg-red-500/15 text-red-700 dark:text-red-300"
                : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
            )}
          >
            {summary.blocksExecutionRetry ? "Retry blocked" : "Retry allowed"}
          </span>
          <span
            className={cn(
              "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
              summary.blocksCloseOut
                ? "bg-red-500/15 text-red-700 dark:text-red-300"
                : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
            )}
          >
            {summary.blocksCloseOut ? "Close-out blocked" : "Close-out allowed"}
          </span>
        </div>
      </div>

      <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Primary owner</p>
          <p className="text-foreground">{primaryOwner ?? "Unassigned"}</p>
        </div>
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Escalation</p>
          <p className="text-foreground">{escalationOwner ?? "None"}</p>
        </div>
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Authoritative signal</p>
          <p className="text-foreground">{authoritativeSignalLabel}</p>
        </div>
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Signal time</p>
          <p className="text-foreground">
            {summary.authoritativeSignalAt
              ? `${formatDateTime(summary.authoritativeSignalAt)} (${relativeTime(summary.authoritativeSignalAt)})`
              : "Unknown"}
          </p>
        </div>
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Authoritative run</p>
          {authoritativeRunHref ? (
            <Link
              to={authoritativeRunHref}
              className="text-foreground underline underline-offset-2 hover:text-primary"
            >
              {summary.authoritativeRunId}
            </Link>
          ) : (
            <p className="text-foreground">{summary.authoritativeRunId ?? "None"}</p>
          )}
        </div>
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Next checkpoint</p>
          <p className="text-foreground">{checkpointText ?? "Not scheduled"}</p>
        </div>
      </div>

      {summary.recommendedNextAction ? (
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Next action</p>
          <p className="text-sm text-foreground">{summary.recommendedNextAction}</p>
        </div>
      ) : null}

      {summary.recoveryCriteria ? (
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Recovery criteria</p>
          <p className="text-sm text-foreground">{summary.recoveryCriteria}</p>
        </div>
      ) : null}

      {summary.commentVisibility?.state === "degraded" ? (
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Comment visibility</p>
          <p className="text-sm text-foreground">
            Comment delta health is degraded. Prefer fallback signals until the read path recovers.
          </p>
        </div>
      ) : null}

      {summary.evidence.length > 0 ? (
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Evidence</p>
          <div className="flex flex-wrap gap-2">
            {summary.evidence.map((entry: IssuePlatformUnblockSummary["evidence"][number]) => (
              <Link
                key={`${entry.kind}:${entry.href}:${entry.label}`}
                to={entry.href}
                className="inline-flex items-center rounded-full border border-border/70 bg-background/70 px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                title={entry.at ? formatDateTime(entry.at) : undefined}
              >
                {entry.label}
              </Link>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
