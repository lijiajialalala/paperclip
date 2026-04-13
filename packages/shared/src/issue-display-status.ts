export const REVIEW_PENDING_DISPLAY_STATUS = "review_pending";

export type IssueDisplayStatusInput = {
  status: string;
  planProposedAt?: Date | string | null;
  planApprovedAt?: Date | string | null;
  runtimeState?: {
    review?: {
      state?: string | null;
    } | null;
  } | null;
};

export function getIssueDisplayStatus(issue: IssueDisplayStatusInput) {
  const hasPendingPlanReview =
    Boolean(issue.planProposedAt) && !issue.planApprovedAt;

  if (
    (issue.runtimeState?.review?.state === "pending" || hasPendingPlanReview)
    && issue.status !== "blocked"
    && issue.status !== "done"
    && issue.status !== "cancelled"
  ) {
    return REVIEW_PENDING_DISPLAY_STATUS;
  }
  return issue.status;
}

export function getIssueDisplayStatusFilterKeys(issue: IssueDisplayStatusInput) {
  const displayStatus = getIssueDisplayStatus(issue);
  if (displayStatus === REVIEW_PENDING_DISPLAY_STATUS) {
    return [REVIEW_PENDING_DISPLAY_STATUS, "in_review"];
  }
  return [displayStatus];
}

export function issueMatchesDisplayStatusFilter(
  issue: IssueDisplayStatusInput,
  requestedStatuses: ReadonlySet<string>,
) {
  const filterKeys = getIssueDisplayStatusFilterKeys(issue);
  return filterKeys.some((status) => requestedStatuses.has(status));
}

export function formatIssueDisplayStatus(status: string) {
  if (status === REVIEW_PENDING_DISPLAY_STATUS) return "Review Pending";
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
