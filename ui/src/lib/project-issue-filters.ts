export function buildProjectIssueListFilters(projectId: string) {
  return {
    projectId,
    includeRoutineExecutions: true,
  } as const;
}
