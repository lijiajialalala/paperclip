import { describe, expect, it } from "vitest";
import {
  formatIssueDisplayStatus,
  getIssueDisplayStatus,
  getIssueDisplayStatusFilterKeys,
  issueMatchesDisplayStatusFilter,
  REVIEW_PENDING_DISPLAY_STATUS,
} from "./issue-display-status.js";

describe("issue display status", () => {
  it("derives review_pending from pending runtime review", () => {
    const issue = {
      status: "in_progress",
      planProposedAt: "2026-04-12T02:00:00.000Z",
      planApprovedAt: null,
      runtimeState: {
        review: {
          state: "pending",
        },
      },
    };

    expect(getIssueDisplayStatus(issue)).toBe(REVIEW_PENDING_DISPLAY_STATUS);
    expect(getIssueDisplayStatusFilterKeys(issue)).toEqual(["review_pending", "in_review"]);
  });

  it("does not treat raw in_review as review_pending without plan evidence", () => {
    expect(getIssueDisplayStatus({ status: "in_review" })).toBe("in_review");
  });

  it("matches review_pending filters without matching unrelated lifecycle statuses", () => {
    const issue = {
      status: "in_progress",
      planProposedAt: "2026-04-12T02:00:00.000Z",
      planApprovedAt: null,
      runtimeState: {
        review: {
          state: "pending",
        },
      },
    };

    expect(issueMatchesDisplayStatusFilter(issue, new Set(["review_pending"]))).toBe(true);
    expect(issueMatchesDisplayStatusFilter(issue, new Set(["in_review"]))).toBe(true);
    expect(issueMatchesDisplayStatusFilter(issue, new Set(["in_progress"]))).toBe(false);
  });

  it("keeps blocked issues in the blocked bucket even if a review request still exists", () => {
    const issue = {
      status: "blocked",
      planProposedAt: null,
      planApprovedAt: null,
      runtimeState: {
        review: {
          state: "pending",
        },
      },
    };

    expect(getIssueDisplayStatus(issue)).toBe("blocked");
  });

  it("formats the derived display status for UI labels", () => {
    expect(formatIssueDisplayStatus("review_pending")).toBe("Review Pending");
    expect(formatIssueDisplayStatus("in_progress")).toBe("In Progress");
  });
});
