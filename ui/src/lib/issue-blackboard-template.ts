import { ISSUE_BLACKBOARD_TEMPLATES, type IssueBlackboardTemplate } from "@paperclipai/shared";

export type IssueBlackboardTemplateSelection = IssueBlackboardTemplate | "";

const issueBlackboardTemplateSet = new Set<string>(ISSUE_BLACKBOARD_TEMPLATES);

export const ISSUE_BLACKBOARD_TEMPLATE_OPTIONS = [
  { value: "", label: "None" },
  ...ISSUE_BLACKBOARD_TEMPLATES.map((template) => ({
    value: template,
    label: template === "research_v1" ? "Research v1" : template,
  })),
] as const;

export function coerceIssueBlackboardTemplate(
  value: string | null | undefined,
): IssueBlackboardTemplateSelection {
  return value && issueBlackboardTemplateSet.has(value) ? (value as IssueBlackboardTemplate) : "";
}

export function resolveIssueBlackboardTemplate(input: {
  defaultTemplate?: string | null;
  draftTemplate?: string | null;
}): IssueBlackboardTemplateSelection {
  const defaultTemplate = coerceIssueBlackboardTemplate(input.defaultTemplate);
  if (defaultTemplate) return defaultTemplate;
  return coerceIssueBlackboardTemplate(input.draftTemplate);
}

export function describeIssueBlackboardTemplate(
  value: IssueBlackboardTemplateSelection | null | undefined,
): string | null {
  if (value === "research_v1") {
    return "Creates a research blackboard with brief, source matrix, skeleton, evidence ledger, and final report slots.";
  }
  return null;
}
