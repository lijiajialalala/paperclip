import type { IssueExecutionWorkspaceSettings } from "@paperclipai/shared";

export type RoutineExecutionWorkspaceDraft = {
  executionWorkspaceId: string | null;
  executionWorkspacePreference: string | null;
  executionWorkspaceSettings: IssueExecutionWorkspaceSettings | null;
};

type ProjectWorkspaceLike = {
  id: string;
  isPrimary?: boolean | null;
};

type ProjectLike = {
  executionWorkspacePolicy?: {
    defaultProjectWorkspaceId?: string | null;
  } | null;
  workspaces?: ProjectWorkspaceLike[] | null;
} | null | undefined;

export function createRoutineExecutionWorkspaceDraft(): RoutineExecutionWorkspaceDraft {
  return {
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
  };
}

export function applyRoutineExecutionWorkspacePatch<T extends RoutineExecutionWorkspaceDraft>(
  current: T,
  patch: Record<string, unknown>,
): T {
  return {
    ...current,
    executionWorkspaceId: (patch.executionWorkspaceId as string | null | undefined) ?? null,
    executionWorkspacePreference: (patch.executionWorkspacePreference as string | null | undefined) ?? null,
    executionWorkspaceSettings:
      (patch.executionWorkspaceSettings as IssueExecutionWorkspaceSettings | null | undefined) ?? null,
  };
}

export function routineExecutionWorkspaceEquals(
  left: RoutineExecutionWorkspaceDraft,
  right: RoutineExecutionWorkspaceDraft,
) {
  return left.executionWorkspaceId === right.executionWorkspaceId
    && left.executionWorkspacePreference === right.executionWorkspacePreference
    && JSON.stringify(left.executionWorkspaceSettings ?? null) === JSON.stringify(right.executionWorkspaceSettings ?? null);
}

export function defaultProjectWorkspaceIdForProject(project: ProjectLike): string | null {
  if (!project) return null;
  return project.executionWorkspacePolicy?.defaultProjectWorkspaceId
    ?? project.workspaces?.find((workspace) => workspace.isPrimary)?.id
    ?? project.workspaces?.[0]?.id
    ?? null;
}
