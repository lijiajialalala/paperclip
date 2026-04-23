import { z } from "zod";
import {
  ISSUE_BLACKBOARD_ENTRY_KEYS,
  ISSUE_BLACKBOARD_KEYS,
  ISSUE_BLACKBOARD_TEMPLATES,
  ISSUE_DOCUMENT_FORMATS,
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  ISSUE_WRITABLE_STATUSES,
} from "../constants.js";

export const ISSUE_EXECUTION_WORKSPACE_PREFERENCES = [
  "inherit",
  "shared_workspace",
  "isolated_workspace",
  "operator_branch",
  "reuse_existing",
  "agent_default",
] as const;

const executionWorkspaceStrategySchema = z
  .object({
    type: z.enum(["project_primary", "git_worktree", "adapter_managed", "cloud_sandbox"]).optional(),
    baseRef: z.string().optional().nullable(),
    branchTemplate: z.string().optional().nullable(),
    worktreeParentDir: z.string().optional().nullable(),
    provisionCommand: z.string().optional().nullable(),
    teardownCommand: z.string().optional().nullable(),
  })
  .strict();

export const issueExecutionWorkspaceSettingsSchema = z
  .object({
    mode: z.enum(ISSUE_EXECUTION_WORKSPACE_PREFERENCES).optional(),
    workspaceStrategy: executionWorkspaceStrategySchema.optional().nullable(),
    workspaceRuntime: z.record(z.unknown()).optional().nullable(),
  })
  .strict();

export const issueAssigneeAdapterOverridesSchema = z
  .object({
    adapterConfig: z.record(z.unknown()).optional(),
    useProjectWorkspace: z.boolean().optional(),
  })
  .strict();

export const createIssueSchema = z.object({
  projectId: z.string().uuid().optional().nullable(),
  projectWorkspaceId: z.string().uuid().optional().nullable(),
  goalId: z.string().uuid().optional().nullable(),
  parentId: z.string().uuid().optional().nullable(),
  inheritExecutionWorkspaceFromIssueId: z.string().uuid().optional().nullable(),
  blackboardTemplate: z.enum(ISSUE_BLACKBOARD_TEMPLATES).optional().nullable(),
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  status: z.enum(ISSUE_WRITABLE_STATUSES).optional().default("backlog"),
  priority: z.enum(ISSUE_PRIORITIES).optional().default("medium"),
  assigneeAgentId: z.string().uuid().optional().nullable(),
  assigneeUserId: z.string().optional().nullable(),
  originKind: z.string().trim().min(1).max(64).optional().nullable(),
  originId: z.string().trim().min(1).max(255).optional().nullable(),
  requestDepth: z.number().int().nonnegative().optional().default(0),
  billingCode: z.string().optional().nullable(),
  assigneeAdapterOverrides: issueAssigneeAdapterOverridesSchema.optional().nullable(),
  executionWorkspaceId: z.string().uuid().optional().nullable(),
  executionWorkspacePreference: z.enum(ISSUE_EXECUTION_WORKSPACE_PREFERENCES).optional().nullable(),
  executionWorkspaceSettings: issueExecutionWorkspaceSettingsSchema.optional().nullable(),
  labelIds: z.array(z.string().uuid()).optional(),
});

export type CreateIssue = z.infer<typeof createIssueSchema>;

const updateIssueFieldsSchema = createIssueSchema
  .omit({
    originKind: true,
    originId: true,
  })
  .partial();

export const createIssueLabelSchema = z.object({
  name: z.string().trim().min(1).max(48),
  color: z.string().regex(/^#(?:[0-9a-fA-F]{6})$/, "Color must be a 6-digit hex value"),
});

export type CreateIssueLabel = z.infer<typeof createIssueLabelSchema>;

export const updateIssueSchema = updateIssueFieldsSchema.extend({
  comment: z.string().min(1).optional(),
  reopen: z.boolean().optional(),
  interrupt: z.boolean().optional(),
  hiddenAt: z.string().datetime().nullable().optional(),
});

export type UpdateIssue = z.infer<typeof updateIssueSchema>;
export type IssueExecutionWorkspaceSettings = z.infer<typeof issueExecutionWorkspaceSettingsSchema>;

export const checkoutIssueSchema = z.object({
  agentId: z.string().uuid(),
  expectedStatuses: z.array(z.enum(ISSUE_STATUSES)).nonempty(),
});

export type CheckoutIssue = z.infer<typeof checkoutIssueSchema>;

export const addIssueCommentSchema = z.object({
  body: z.string().min(1),
  reopen: z.boolean().optional(),
  interrupt: z.boolean().optional(),
  replyNeeded: z.boolean().optional(),
});

export type AddIssueComment = z.infer<typeof addIssueCommentSchema>;

export const linkIssueApprovalSchema = z.object({
  approvalId: z.string().uuid(),
});

export type LinkIssueApproval = z.infer<typeof linkIssueApprovalSchema>;

export const createIssueAttachmentMetadataSchema = z.object({
  issueCommentId: z.string().uuid().optional().nullable(),
});

export type CreateIssueAttachmentMetadata = z.infer<typeof createIssueAttachmentMetadataSchema>;

export const issueDocumentFormatSchema = z.enum(ISSUE_DOCUMENT_FORMATS);

export const issueDocumentKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "Document key must be lowercase letters, numbers, _ or -");

export const upsertIssueDocumentSchema = z.object({
  title: z.string().trim().max(200).nullable().optional(),
  format: issueDocumentFormatSchema,
  body: z.string().max(524288),
  changeSummary: z.string().trim().max(500).nullable().optional(),
  baseRevisionId: z.string().uuid().nullable().optional(),
});

export const restoreIssueDocumentRevisionSchema = z.object({});

export const issueBlackboardTemplateSchema = z.enum(ISSUE_BLACKBOARD_TEMPLATES);

export const issueBlackboardKeySchema = z.enum(ISSUE_BLACKBOARD_KEYS);

export const issueBlackboardEntryKeySchema = z.enum(ISSUE_BLACKBOARD_ENTRY_KEYS);

export const issueBlackboardManifestEntrySchema = z
  .object({
    key: issueBlackboardEntryKeySchema,
    title: z.string().trim().min(1).max(200),
    format: issueDocumentFormatSchema,
    required: z.boolean(),
    description: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

export const issueBlackboardManifestSchema = z
  .object({
    kind: z.literal("issue_blackboard"),
    version: z.literal(1),
    template: issueBlackboardTemplateSchema,
    entries: z.array(issueBlackboardManifestEntrySchema).min(1),
  })
  .strict();

export const issueBlackboardSourceTypeSchema = z.enum([
  "official_source",
  "market_web",
  "community_signal",
  "interactive_page",
  "private_context",
]);

export const issueBlackboardAcquisitionMethodSchema = z.string().trim().min(1).max(100);

export const issueBlackboardSourceMatrixSchema = z
  .object({
    version: z.literal(1),
    items: z.array(
      z
        .object({
          question: z.string().trim().min(1).max(500),
          sourceType: issueBlackboardSourceTypeSchema,
          acquisitionMethod: issueBlackboardAcquisitionMethodSchema,
          required: z.boolean().optional().default(true),
          notes: z.string().trim().max(1000).nullable().optional(),
        })
        .strict(),
    ),
  })
  .strict();

export const issueBlackboardEvidenceKindSchema = z.enum([
  "official_fact",
  "market_signal",
  "community_signal",
  "interactive_observation",
  "private_context",
  "inference",
]);

export const issueBlackboardEvidenceLedgerSchema = z
  .object({
    version: z.literal(1),
    entries: z.array(
      z
        .object({
          sourceId: z.string().trim().min(1).max(120),
          kind: issueBlackboardEvidenceKindSchema,
          summary: z.string().trim().min(1).max(4000),
          acquisitionMethod: issueBlackboardAcquisitionMethodSchema,
          title: z.string().trim().max(500).nullable().optional(),
          href: z.string().trim().max(4000).nullable().optional(),
          quote: z.string().trim().max(2000).nullable().optional(),
          confidence: z.number().min(0).max(1).nullable().optional(),
          usedIn: z.array(z.string().trim().min(1).max(120)).optional().default([]),
          unavailableReason: z.string().trim().max(1000).nullable().optional(),
        })
        .strict(),
    ),
  })
  .strict();

export const issueBlackboardOpenQuestionsSchema = z
  .object({
    version: z.literal(1),
    items: z.array(
      z
        .object({
          id: z.string().trim().min(1).max(120),
          question: z.string().trim().min(1).max(1000),
          category: z.enum(["fact_gap", "decision_gap", "scope_gap", "success_gap"]).default("fact_gap"),
          status: z.enum(["open", "resolved", "assumed", "dropped"]).default("open"),
          resolution: z.string().trim().max(2000).nullable().optional(),
        })
        .strict(),
    ),
  })
  .strict();

export const issueBlackboardChallengeMemoSchema = z
  .object({
    version: z.literal(1),
    findings: z.array(
      z
        .object({
          claimId: z.string().trim().min(1).max(120),
          stance: z.enum(["accept", "reject", "uncertain"]),
          summary: z.string().trim().min(1).max(2000),
          evidenceSourceIds: z.array(z.string().trim().min(1).max(120)).optional().default([]),
          impact: z.string().trim().max(2000).nullable().optional(),
        })
        .strict(),
    ),
  })
  .strict();

export const bootstrapIssueBlackboardSchema = z.object({
  template: issueBlackboardTemplateSchema.optional().default("research_v1"),
});

export const upsertIssueBlackboardEntrySchema = z.object({
  content: z.unknown(),
  changeSummary: z.string().trim().max(500).nullable().optional(),
  baseRevisionId: z.string().uuid().nullable().optional(),
});

export type IssueDocumentFormat = z.infer<typeof issueDocumentFormatSchema>;
export type UpsertIssueDocument = z.infer<typeof upsertIssueDocumentSchema>;
export type RestoreIssueDocumentRevision = z.infer<typeof restoreIssueDocumentRevisionSchema>;
export type IssueBlackboardTemplate = z.infer<typeof issueBlackboardTemplateSchema>;
export type IssueBlackboardKey = z.infer<typeof issueBlackboardKeySchema>;
export type IssueBlackboardEntryKey = z.infer<typeof issueBlackboardEntryKeySchema>;
export type IssueBlackboardManifest = z.infer<typeof issueBlackboardManifestSchema>;
export type IssueBlackboardSourceMatrix = z.infer<typeof issueBlackboardSourceMatrixSchema>;
export type IssueBlackboardEvidenceLedger = z.infer<typeof issueBlackboardEvidenceLedgerSchema>;
export type IssueBlackboardOpenQuestions = z.infer<typeof issueBlackboardOpenQuestionsSchema>;
export type IssueBlackboardChallengeMemo = z.infer<typeof issueBlackboardChallengeMemoSchema>;
export type BootstrapIssueBlackboard = z.infer<typeof bootstrapIssueBlackboardSchema>;
export type UpsertIssueBlackboardEntry = z.infer<typeof upsertIssueBlackboardEntrySchema>;
