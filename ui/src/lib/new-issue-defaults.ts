import type { IssueBlackboardTemplate } from "@paperclipai/shared";

export interface NewIssueDefaultsInput {
  status?: string | null;
  priority?: string | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  projectId?: string | null;
  title?: string | null;
  description?: string | null;
}

export function withResearchIssueDefaults<T extends Record<string, unknown>>(defaults: T) {
  return {
    ...defaults,
    blackboardTemplate: "research_v1" as IssueBlackboardTemplate,
  };
}

export function buildResearchIssueDefaults(input: NewIssueDefaultsInput = {}) {
  return withResearchIssueDefaults({
    ...(input.status ? { status: input.status } : {}),
    ...(input.priority ? { priority: input.priority } : {}),
    ...(input.assigneeAgentId ? { assigneeAgentId: input.assigneeAgentId } : {}),
    ...(input.assigneeUserId ? { assigneeUserId: input.assigneeUserId } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.title ? { title: input.title } : {}),
    ...(input.description ? { description: input.description } : {}),
  });
}
