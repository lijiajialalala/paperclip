import type { IssueOriginKind, IssuePriority, IssueStatus } from "../constants.js";
import type { Goal } from "./goal.js";
import type { Project, ProjectWorkspace } from "./project.js";
import type { ExecutionWorkspace, IssueExecutionWorkspaceSettings } from "./workspace-runtime.js";
import type { IssueWorkProduct } from "./work-product.js";

export interface IssueAncestorProject {
  id: string;
  name: string;
  description: string | null;
  status: string;
  goalId: string | null;
  workspaces: ProjectWorkspace[];
  primaryWorkspace: ProjectWorkspace | null;
}

export interface IssueAncestorGoal {
  id: string;
  title: string;
  description: string | null;
  level: string;
  status: string;
}

export interface IssueAncestor {
  id: string;
  identifier: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  projectId: string | null;
  goalId: string | null;
  project: IssueAncestorProject | null;
  goal: IssueAncestorGoal | null;
}

export interface IssueLabel {
  id: string;
  companyId: string;
  name: string;
  color: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueAssigneeAdapterOverrides {
  adapterConfig?: Record<string, unknown>;
  useProjectWorkspace?: boolean;
}

export type QaVerdict = "pass" | "fail" | "inconclusive";

export type QaIssueWritebackStatus =
  | "agent_written"
  | "platform_written"
  | "platform_repaired_partial"
  | "alerted_missing"
  | "alerted_inconclusive";

export type QaIssueWritebackAlertType =
  | "partial_writeback_conflict"
  | "missing_writeback"
  | "plan_pending_review"
  | "inconclusive";

export type IssueHiddenReason = "manual" | "project_archived";

export interface QaIssueWriteback {
  status: QaIssueWritebackStatus;
  verdict: QaVerdict | null;
  source: "agent" | "platform" | "alert" | "none";
  canCloseUpstream: boolean | null;
  commentId: string | null;
  writebackAt: string | null;
  alertType: QaIssueWritebackAlertType | null;
  latest: boolean;
}

export interface IssueQaSummary {
  verdict: QaVerdict | null;
  source: "agent" | "platform" | "alert" | "manual" | "none";
  canCloseUpstream: boolean | null;
  latestRunId: string;
  latestRunFinishedAt: string | null;
  writebackAt: string | null;
  alertOpen: boolean;
  alertType: string | null;
  alertMessage: string | null;
  latestLabel: string;
}

export type PlatformRecoveryKind =
  | "runtime_recovered"
  | "writeback_gate_repaired"
  | "comment_visibility_recovered"
  | "manual_override";

export type PlatformUnblockCategory =
  | "runtime_process"
  | "qa_writeback_gate"
  | "comment_visibility"
  | "composite";

export type PlatformOwnerRole =
  | "runtime_owner"
  | "qa_writeback_owner"
  | "tech_lead"
  | "cto"
  | "board_operator";

export type PlatformAuthoritativeSignalSource =
  | "close_gate_block"
  | "latest_terminal_run"
  | "qa_summary"
  | "comment_delta_health"
  | "manual_override";

export interface PlatformEvidenceRef {
  kind: "activity" | "run" | "comment";
  label: string;
  href: string;
  at: string | null;
}

export interface CommentVisibilityHealth {
  state: "healthy" | "degraded";
  lastDeltaSuccessAt: string | null;
  lastDeltaFailureAt: string | null;
  lastError: string | null;
  fallbackSignals: string[];
}

export interface IssuePlatformUnblockSummary {
  mode: "product" | "platform";
  primaryCategory: PlatformUnblockCategory | null;
  secondaryCategories: PlatformUnblockCategory[];
  primaryOwnerRole: PlatformOwnerRole | null;
  primaryOwnerAgentId: string | null;
  escalationOwnerRole: PlatformOwnerRole | null;
  escalationOwnerAgentId: string | null;
  authoritativeSignalSource: PlatformAuthoritativeSignalSource | null;
  authoritativeSignalAt: string | null;
  authoritativeRunId: string | null;
  recommendedNextAction: string | null;
  recoveryCriteria: string | null;
  nextCheckpointAt: string | null;
  blocksExecutionRetry: boolean;
  blocksCloseOut: boolean;
  canRetryEngineering: boolean;
  canCloseUpstream: boolean | null;
  recoveryKind: PlatformRecoveryKind | null;
  commentVisibility: CommentVisibilityHealth | null;
  evidence: PlatformEvidenceRef[];
}

export interface RunPlatformHint {
  latestForIssue: boolean;
  processLost: boolean;
  processLossRetryCount: number;
  writebackAlertType: string | null;
  closeGateBlocked: boolean;
}

export interface IssueStatusTruthSummary {
  effectiveStatus: IssueStatus;
  persistedStatus: IssueStatus;
  authoritativeStatus: IssueStatus;
  consistency: "consistent" | "drifted";
  authoritativeAt: string | null;
  authoritativeSource: "status_activity" | "issue_row" | "bootstrap";
  authoritativeActorType: "agent" | "user" | "system" | null;
  authoritativeActorId: string | null;
  reasonSummary: string | null;
  canExecute: boolean;
  canClose: boolean;
  executionState: "idle" | "active" | "stalled";
  executionDiagnosis: "no_active_run" | null;
  lastExecutionSignalAt: string | null;
  stalledSince: string | null;
  stalledThresholdMs: number | null;
  driftCode: "status_mismatch" | "blocked_checkout_reopen" | null;
  evidence: PlatformEvidenceRef[];
}

export type IssueRuntimeExecutionState = "idle" | "active" | "stalled";

export type IssueRuntimeActivationState =
  | "runnable"
  | "awaiting_review"
  | "awaiting_human"
  | "blocked"
  | "closed";

export type IssueRuntimeExecutionDiagnosis =
  | "plan_review_pending"
  | "waiting_for_human_reply"
  | "no_active_run"
  | null;

export interface IssueLifecycleRuntimeState {
  status: IssueStatus;
  isTerminal: boolean;
  isBlocked: boolean;
}

export interface IssueExecutionRuntimeState {
  state: IssueRuntimeExecutionState;
  activation: IssueRuntimeActivationState;
  diagnosis: IssueRuntimeExecutionDiagnosis;
  canStart: boolean;
  checkoutRunId: string | null;
  executionRunId: string | null;
  executionLockedAt: Date | string | null;
  lastExecutionSignalAt: string | null;
  stalledSince: string | null;
}

export interface IssueReviewRuntimeState {
  state: "none" | "pending" | "approved";
  kind: "work_plan" | null;
  requestedAt: Date | string | null;
  approvedAt: Date | string | null;
}

export interface IssueHumanWaitRuntimeState {
  state: "none" | "reply_needed";
  requestedAt: Date | string | null;
  commentId: string | null;
}

export interface IssueRuntimeState {
  lifecycle: IssueLifecycleRuntimeState;
  execution: IssueExecutionRuntimeState;
  review: IssueReviewRuntimeState;
  humanWait: IssueHumanWaitRuntimeState;
}

export type DocumentFormat = "markdown";

export interface IssueDocumentSummary {
  id: string;
  companyId: string;
  issueId: string;
  key: string;
  title: string | null;
  format: DocumentFormat;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueDocument extends IssueDocumentSummary {
  body: string;
}

export interface DocumentRevision {
  id: string;
  companyId: string;
  documentId: string;
  issueId: string;
  key: string;
  revisionNumber: number;
  title: string | null;
  format: DocumentFormat;
  body: string;
  changeSummary: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
}

export interface LegacyPlanDocument {
  key: "plan";
  body: string;
  source: "issue_description";
}

export interface Issue {
  id: string;
  companyId: string;
  projectId: string | null;
  projectWorkspaceId: string | null;
  goalId: string | null;
  parentId: string | null;
  ancestors?: IssueAncestor[];
  title: string;
  description: string | null;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  checkoutRunId: string | null;
  executionRunId: string | null;
  executionAgentNameKey: string | null;
  executionLockedAt: Date | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  issueNumber: number | null;
  identifier: string | null;
  originKind?: IssueOriginKind;
  originId?: string | null;
  originRunId?: string | null;
  requestDepth: number;
  billingCode: string | null;
  assigneeAdapterOverrides: IssueAssigneeAdapterOverrides | null;
  executionWorkspaceId: string | null;
  executionWorkspacePreference: string | null;
  executionWorkspaceSettings: IssueExecutionWorkspaceSettings | null;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  hiddenAt: Date | null;
  hiddenReason?: IssueHiddenReason | null;
  planProposedAt?: string | Date | null;
  planApprovedAt?: string | Date | null;
  labelIds?: string[];
  labels?: IssueLabel[];
  planDocument?: IssueDocument | null;
  documentSummaries?: IssueDocumentSummary[];
  legacyPlanDocument?: LegacyPlanDocument | null;
  project?: Project | null;
  goal?: Goal | null;
  statusTruthSummary?: IssueStatusTruthSummary | null;
  runtimeState?: IssueRuntimeState | null;
  qaSummary?: IssueQaSummary | null;
  platformUnblockSummary?: IssuePlatformUnblockSummary | null;
  currentExecutionWorkspace?: ExecutionWorkspace | null;
  workProducts?: IssueWorkProduct[];
  mentionedProjects?: Project[];
  myLastTouchAt?: Date | null;
  lastExternalCommentAt?: Date | null;
  lastActivityAt?: Date | null;
  isUnreadForMe?: boolean;
  replyNeededForMe?: boolean;
  replyNeededCommentId?: string | null;
  replyNeededAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueComment {
  id: string;
  companyId: string;
  issueId: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueAttachment {
  id: string;
  companyId: string;
  issueId: string;
  issueCommentId: string | null;
  assetId: string;
  provider: string;
  objectKey: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  originalFilename: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  contentPath: string;
}
