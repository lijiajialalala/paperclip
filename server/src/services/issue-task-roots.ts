import { and, inArray, not } from "drizzle-orm";
import { issues } from "@paperclipai/db";

type TaskRootRow = {
  id: string;
  parentId: string | null;
  taskRootIssueId: string | null;
};

export function resolveTaskRootIssueId(issue: { id: string; taskRootIssueId: string | null }) {
  return issue.taskRootIssueId ?? issue.id;
}

export async function syncTaskRootForDescendants(
  dbOrTx: any,
  rootIssueId: string,
  taskRootIssueId: string,
) {
  const queue: string[] = [rootIssueId];
  const visited = new Set<string>(queue);

  while (queue.length > 0) {
    const batch = queue.splice(0, 50);
    const children = await dbOrTx
      .select({ id: issues.id })
      .from(issues)
      .where(inArray(issues.parentId, batch));

    const childIds = children
      .map((row: { id: string }) => row.id)
      .filter((childId: string) => !visited.has(childId));

    if (childIds.length === 0) continue;

    await dbOrTx
      .update(issues)
      .set({ taskRootIssueId })
      .where(inArray(issues.id, childIds));

    for (const childId of childIds) {
      visited.add(childId);
      queue.push(childId);
    }
  }
}

export async function repairTaskRootReferencesForDeletedIssues(
  dbOrTx: any,
  deletedIssueIds: string[],
) {
  if (deletedIssueIds.length === 0) return;

  const deletedSet = new Set(deletedIssueIds);
  const affectedRows = await dbOrTx
    .select({
      id: issues.id,
      parentId: issues.parentId,
      taskRootIssueId: issues.taskRootIssueId,
    })
    .from(issues)
    .where(
      and(
        inArray(issues.taskRootIssueId, deletedIssueIds),
        not(inArray(issues.id, deletedIssueIds)),
      ),
    );

  if (affectedRows.length === 0) return;

  const affectedById = new Map<string, TaskRootRow>(
    affectedRows.map((row: TaskRootRow) => [row.id, row]),
  );
  const externalParentIds: string[] = Array.from(
    new Set(
      affectedRows
        .map((row: TaskRootRow) => row.parentId)
        .filter(
          (parentId: string | null): parentId is string =>
            parentId != null && !deletedSet.has(parentId) && !affectedById.has(parentId),
        ),
    ),
  );

  const externalParents = externalParentIds.length === 0
    ? new Map<string, TaskRootRow>()
    : new Map<string, TaskRootRow>(
      (
        await dbOrTx
          .select({
            id: issues.id,
            parentId: issues.parentId,
            taskRootIssueId: issues.taskRootIssueId,
          })
          .from(issues)
          .where(inArray(issues.id, externalParentIds))
      ).map((row: TaskRootRow) => [row.id, row]),
    );

  const resolvedRoots = new Map<string, string>();
  const resolveNextRoot = (issueId: string): string => {
    const cached = resolvedRoots.get(issueId);
    if (cached) return cached;

    const row = affectedById.get(issueId);
    if (!row) {
      throw new Error(`Cannot resolve task root for unknown issue ${issueId}`);
    }

    if (!row.parentId || deletedSet.has(row.parentId)) {
      resolvedRoots.set(issueId, row.id);
      return row.id;
    }

    if (affectedById.has(row.parentId)) {
      const inheritedRoot = resolveNextRoot(row.parentId);
      resolvedRoots.set(issueId, inheritedRoot);
      return inheritedRoot;
    }

    const parent = externalParents.get(row.parentId);
    const inheritedRoot = parent ? resolveTaskRootIssueId(parent) : row.id;
    resolvedRoots.set(issueId, inheritedRoot);
    return inheritedRoot;
  };

  const idsByRoot = new Map<string, string[]>();
  for (const row of affectedRows) {
    const nextRoot = resolveNextRoot(row.id);
    const existingIds = idsByRoot.get(nextRoot) ?? [];
    existingIds.push(row.id);
    idsByRoot.set(nextRoot, existingIds);
  }

  const updatedAt = new Date();
  for (const [taskRootIssueId, issueIds] of idsByRoot) {
    await dbOrTx
      .update(issues)
      .set({ taskRootIssueId, updatedAt })
      .where(inArray(issues.id, issueIds));
  }
}
