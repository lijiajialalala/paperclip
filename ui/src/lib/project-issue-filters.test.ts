import { describe, expect, it } from "vitest";
import { buildProjectIssueListFilters } from "./project-issue-filters";

describe("buildProjectIssueListFilters", () => {
  it("includes routine execution issues for project-scoped issue queries", () => {
    expect(buildProjectIssueListFilters("project-1")).toEqual({
      projectId: "project-1",
      includeRoutineExecutions: true,
    });
  });
});
