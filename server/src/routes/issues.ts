import fs from "node:fs/promises";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { activityLog, type Db } from "@paperclipai/db";
import {
  addIssueCommentSchema,
  createIssueAttachmentMetadataSchema,
  createIssueWorkProductSchema,
  createIssueLabelSchema,
  checkoutIssueSchema,
  createIssueSchema,
  feedbackTargetTypeSchema,
  feedbackTraceStatusSchema,
  feedbackVoteValueSchema,
  upsertIssueFeedbackVoteSchema,
  linkIssueApprovalSchema,
  issueBlackboardEntryKeySchema,
  bootstrapIssueBlackboardSchema,
  upsertIssueBlackboardEntrySchema,
  issueDocumentKeySchema,
  restoreIssueDocumentRevisionSchema,
  ISSUE_BLACKBOARD_KEYS,
  updateIssueWorkProductSchema,
  upsertIssueDocumentSchema,
  updateIssueSchema,
  getClosedIsolatedExecutionWorkspaceMessage,
  isClosedIsolatedExecutionWorkspace,
  type ExecutionWorkspace,
  type RoutineDispatchMode,
} from "@paperclipai/shared";
import { issueMatchesDisplayStatusFilter } from "@paperclipai/shared/issue-display-status";
import { trackAgentTaskCompleted } from "@paperclipai/shared/telemetry";
import { getTelemetryClient } from "../telemetry.js";
import type { StorageService } from "../storage/types.js";
import { validate } from "../middleware/validate.js";
import {
  accessService,
  agentService,
  approvalDecisionActor,
  approvalService,
  canActorResolveApproval,
  executionWorkspaceService,
  feedbackService,
  goalService,
  getIssueCreateDisposition,
  heartbeatService,
  instanceSettingsService,
  issueApprovalService,
  issueService,
  documentService,
  logActivity,
  projectService,
  routineService,
  type ApprovalActor,
  workProductService,
} from "../services/index.js";
import { isPlanExemptOriginKind } from "../services/issue-plan-policy.js";
import { logger } from "../middleware/logger.js";
import { forbidden, HttpError, unauthorized } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { shouldWakeAssigneeOnCheckout } from "./issues-checkout-wakeup.js";
import { isAllowedContentType, MAX_ATTACHMENT_BYTES } from "../attachment-types.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";
import {
  buildParentIssueCloseoutWake,
  resolveParentIssueCloseoutWakeReason,
} from "../services/issue-parent-closeout-wakeup.js";
import { applyEffectiveStatus, issueStatusTruthService } from "../services/issue-status-truth.js";
import { attachIssueRuntimeState } from "../services/issue-runtime-state.js";
import { platformUnblockService } from "../services/platform-unblock.js";
import { qaIssueStateService } from "../services/qa-issue-state.js";
import {
  runPlanProposalSideEffects,
  runPlanReviewSideEffects,
} from "../services/issue-plan-side-effects.js";
import {
  describeIssueExecutionPlanGateError,
  getIssueExecutionPlanGateReason,
} from "../services/issue-plan-policy.js";
import { issueBlackboardService } from "../services/issue-blackboard.js";

const MAX_ISSUE_COMMENT_LIMIT = 500;
const updateIssueRouteSchema = updateIssueSchema.extend({
  interrupt: z.boolean().optional(),
});
const publishArtifactTargetSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("parent") }),
  z.object({ mode: z.literal("ancestors") }),
  z.object({
    mode: z.literal("siblings"),
    includeSourceIssue: z.boolean().optional().default(false),
  }),
  z.object({
    mode: z.literal("issues"),
    issueIds: z.array(z.string().uuid()).min(1),
  }),
]);
const publishIssueArtifactSchema = z.object({
  artifact: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("document"),
      key: issueDocumentKeySchema,
    }),
    z.object({
      kind: z.literal("work_product"),
      workProductId: z.string().uuid(),
    }),
  ]),
  target: publishArtifactTargetSchema,
  summary: z.string().trim().max(4000).optional().nullable(),
  requiredAction: z.string().trim().max(1000).optional().nullable(),
  syncToProjectDocs: z
    .object({
      path: z.string().trim().min(1).max(500),
    })
    .optional()
    .nullable(),
  wakeTargets: z.boolean().optional().default(true),
});
const RESERVED_BLACKBOARD_DOCUMENT_KEYS = new Set<string>(ISSUE_BLACKBOARD_KEYS);

function isReservedBlackboardDocumentKey(key: string) {
  return RESERVED_BLACKBOARD_DOCUMENT_KEYS.has(key.trim().toLowerCase());
}

function respondReservedBlackboardDocumentKey(res: Response) {
  res.status(422).json({
    error: "Reserved blackboard document keys must be accessed via the /blackboard routes.",
  });
}

function filterGenericDocumentSummaries<T extends { key: string }>(documents: T[]) {
  return documents.filter((document) => !isReservedBlackboardDocumentKey(document.key));
}

export function issueRoutes(
  db: Db,
  storage: StorageService,
  opts?: {
    feedbackExportService?: {
      flushPendingFeedbackTraces(input?: {
        companyId?: string;
        traceId?: string;
        limit?: number;
        now?: Date;
      }): Promise<unknown>;
    };
  },
) {
  const router = Router();
  const svc = issueService(db);
  const access = accessService(db);
  const heartbeat = heartbeatService(db);
  const feedback = feedbackService(db);
  const instanceSettings = instanceSettingsService(db);
  const agentsSvc = agentService(db);
  const projectsSvc = projectService(db);
  const goalsSvc = goalService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const executionWorkspacesSvc = executionWorkspaceService(db);
  const workProductsSvc = workProductService(db);
  const documentsSvc = documentService(db);
  const blackboardSvc = issueBlackboardService(db);
  const routinesSvc = routineService(db);
  const statusTruth = issueStatusTruthService(db);
  const qaIssueState = qaIssueStateService(db);
  const platformUnblock = platformUnblockService(db);
  const feedbackExportService = opts?.feedbackExportService;
  const canQueryDb = typeof (db as { select?: unknown }).select === "function";
  type IssueRecord = NonNullable<Awaited<ReturnType<typeof svc.getById>>>;
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
  });

  function withContentPath<T extends { id: string }>(attachment: T) {
    return {
      ...attachment,
      contentPath: `/api/attachments/${attachment.id}/content`,
    };
  }

  function parseBooleanQuery(value: unknown) {
    return value === true || value === "true" || value === "1";
  }

  function parseDateQuery(value: unknown, field: string) {
    if (typeof value !== "string" || value.trim().length === 0) return undefined;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new HttpError(400, `Invalid ${field} query value`);
    }
    return parsed;
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  async function getLatestCommentDeltaActivity(issueId: string) {
    if (!canQueryDb) return null;
    return db
      .select({
        action: activityLog.action,
        createdAt: activityLog.createdAt,
      })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, issueId),
          inArray(activityLog.action, [
            "issue.comment_delta_read_succeeded",
            "issue.comment_delta_read_failed",
          ]),
        ),
      )
      .orderBy(desc(activityLog.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  function normalizeProjectDocsRelativePath(rawPath: string) {
    const trimmed = rawPath.trim().replace(/\\/g, "/");
    if (!trimmed) {
      throw new HttpError(400, "Project docs path is required.");
    }
    if (path.posix.isAbsolute(trimmed) || /^[a-zA-Z]:/.test(trimmed)) {
      throw new HttpError(400, "Project docs path must be relative and stay under docs/.");
    }
    const normalized = path.posix.normalize(trimmed).replace(/^(\.\/)+/, "");
    if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
      throw new HttpError(400, "Project docs path must stay under docs/.");
    }
    if (normalized.toLowerCase() === "docs" || !normalized.toLowerCase().startsWith("docs/")) {
      throw new HttpError(400, "Project docs path must stay under docs/.");
    }
    return normalized;
  }

  function sanitizeSummaryText(value: string | null | undefined, fallback: string) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
    const compact = fallback.replace(/\s+/g, " ").trim();
    if (!compact) return null;
    return compact.length > 320 ? `${compact.slice(0, 320)}...` : compact;
  }

  function formatIssueReference(issue: {
    identifier?: string | null;
    id: string;
    title?: string | null;
  }) {
    const reference = issue.identifier?.trim() || issue.id;
    return issue.title ? `${reference} ${issue.title}` : reference;
  }

  function buildArtifactPublicationComment(input: {
    sourceIssue: IssueRecord;
    artifact:
      | {
          kind: "document";
          title: string;
          key: string;
          revisionNumber: number;
        }
      | {
          kind: "work_product";
          title: string;
          type: string;
          sourceWorkProductId: string;
        };
    summary: string | null;
    requiredAction: string | null;
    syncedProjectDocsPath: string | null;
  }) {
    const lines = [
      "## Artifact handoff",
      "",
      `- Source issue: ${formatIssueReference(input.sourceIssue)}`,
      `- Artifact: ${input.artifact.title}`,
      input.artifact.kind === "document"
        ? `- Source document: key=${input.artifact.key}, revision=${input.artifact.revisionNumber}`
        : `- Source work product: id=${input.artifact.sourceWorkProductId}, type=${input.artifact.type}`,
    ];
    if (input.requiredAction) {
      lines.push(`- Required action: ${input.requiredAction}`);
    }
    if (input.syncedProjectDocsPath) {
      lines.push(`- Project docs path: ${input.syncedProjectDocsPath}`);
    }
    lines.push("", "Summary:");
    lines.push(input.summary ?? "No summary provided.");
    lines.push(
      "",
      "Use the source issue reference above to read the full artifact before acting on this handoff.",
    );
    return lines.join("\n");
  }

  async function resolveProjectDocsRoot(issue: IssueRecord) {
    if (issue.projectId) {
      const project = await projectsSvc.getById(issue.projectId);
      const workspaceFromIssue =
        issue.projectWorkspaceId && project?.workspaces
          ? project.workspaces.find(
              (workspace) =>
                workspace.id === issue.projectWorkspaceId
                && typeof workspace.cwd === "string"
                && workspace.cwd.trim().length > 0,
            ) ?? null
          : null;
      const primaryWorkspace = project?.workspaces?.find(
        (workspace) => workspace.isPrimary && typeof workspace.cwd === "string" && workspace.cwd.trim().length > 0,
      ) ?? null;
      const anyWorkspace = project?.workspaces?.find(
        (workspace) => typeof workspace.cwd === "string" && workspace.cwd.trim().length > 0,
      ) ?? null;
      const projectCwd = workspaceFromIssue?.cwd ?? primaryWorkspace?.cwd ?? anyWorkspace?.cwd ?? null;
      if (typeof projectCwd === "string" && projectCwd.trim().length > 0) {
        return projectCwd.trim();
      }
    }

    if (issue.executionWorkspaceId) {
      const executionWorkspace = await executionWorkspacesSvc.getById(issue.executionWorkspaceId);
      if (typeof executionWorkspace?.cwd === "string" && executionWorkspace.cwd.trim().length > 0) {
        return executionWorkspace.cwd.trim();
      }
    }

    return null;
  }

  async function syncDocumentToProjectDocs(input: {
    issue: IssueRecord;
    title: string | null;
    body: string;
    relativePath: string;
  }) {
    const normalizedRelativePath = normalizeProjectDocsRelativePath(input.relativePath);
    const workspaceRoot = await resolveProjectDocsRoot(input.issue);
    if (!workspaceRoot) {
      throw new HttpError(
        409,
        "No local project workspace is available for docs sync. Link the issue to a project workspace first.",
      );
    }

    const resolvedRoot = path.resolve(workspaceRoot);
    const targetPath = path.resolve(resolvedRoot, ...normalizedRelativePath.split("/"));
    const relativeFromRoot = path.relative(resolvedRoot, targetPath);
    if (
      !relativeFromRoot
      || relativeFromRoot === "."
      || relativeFromRoot.startsWith("..")
      || path.isAbsolute(relativeFromRoot)
    ) {
      throw new HttpError(400, "Project docs path must stay under docs/.");
    }

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const content = input.body.endsWith("\n") ? input.body : `${input.body}\n`;
    await fs.writeFile(targetPath, content, "utf8");

    return {
      workspaceRoot: resolvedRoot,
      relativePath: normalizedRelativePath,
      absolutePath: targetPath,
      title: input.title ?? null,
    };
  }

  async function resolvePublicationTargets(
    sourceIssue: IssueRecord,
    target: z.infer<typeof publishArtifactTargetSchema>,
  ): Promise<IssueRecord[]> {
    let candidates: IssueRecord[] = [];

    if (target.mode === "parent") {
      if (sourceIssue.parentId) {
        const parentIssue = await svc.getById(sourceIssue.parentId);
        if (parentIssue) candidates = [parentIssue];
      }
    } else if (target.mode === "ancestors") {
      const ancestorSummaries = await svc.getAncestors(sourceIssue.id);
      const resolvedAncestors = await Promise.all(ancestorSummaries.map((ancestor) => svc.getById(ancestor.id)));
      candidates = resolvedAncestors.filter((candidate): candidate is IssueRecord => Boolean(candidate));
    } else if (target.mode === "siblings") {
      if (sourceIssue.parentId) {
        const siblingSummaries = await svc.list(sourceIssue.companyId, { parentId: sourceIssue.parentId });
        const resolvedSiblings = await Promise.all(siblingSummaries.map((sibling) => svc.getById(sibling.id)));
        candidates = resolvedSiblings.filter((candidate): candidate is IssueRecord => Boolean(candidate));
      }
      if (target.includeSourceIssue !== true) {
        candidates = candidates.filter((candidate) => candidate.id !== sourceIssue.id);
      }
    } else {
      const resolved = await Promise.all(target.issueIds.map((issueId) => svc.getById(issueId)));
      candidates = resolved.filter((candidate): candidate is IssueRecord => Boolean(candidate));
      const missingIds = target.issueIds.filter((issueId) => !candidates.some((candidate) => candidate.id === issueId));
      if (missingIds.length > 0) {
        throw new HttpError(404, `Target issue not found: ${missingIds[0]}`);
      }
    }

    const deduped = new Map<string, IssueRecord>();
    for (const candidate of candidates) {
      if (!candidate || candidate.companyId !== sourceIssue.companyId) {
        throw new HttpError(422, "All publication targets must belong to the same company.");
      }
      if (candidate.id === sourceIssue.id) continue;
      if (!deduped.has(candidate.id)) deduped.set(candidate.id, candidate);
    }

    const targets = Array.from(deduped.values());
    if (targets.length === 0) {
      throw new HttpError(422, "No publication targets were resolved from the requested target mode.");
    }
    return targets;
  }

  async function assertAgentArtifactPublicationAccess(
    req: Request,
    res: Response,
    sourceIssue: IssueRecord,
    target: z.infer<typeof publishArtifactTargetSchema>,
    targetIssues: IssueRecord[],
  ) {
    if (req.actor.type !== "agent") return true;
    const actorAgentId = req.actor.agentId;
    if (!actorAgentId) {
      res.status(403).json({ error: "Agent authentication required" });
      return false;
    }
    if (sourceIssue.assigneeAgentId !== actorAgentId) {
      res.status(403).json({ error: "Only the assigned agent can publish artifacts from this issue" });
      return false;
    }
    if (!(await assertAgentRunCheckoutOwnership(req, res, sourceIssue))) return false;
    if (target.mode !== "issues") return true;

    const allowedTargetIds = new Set<string>();
    if (sourceIssue.parentId) {
      allowedTargetIds.add(sourceIssue.parentId);
      const siblingSummaries = await svc.list(sourceIssue.companyId, { parentId: sourceIssue.parentId });
      for (const sibling of siblingSummaries) {
        if (sibling.id !== sourceIssue.id) {
          allowedTargetIds.add(sibling.id);
        }
      }
    }

    const ancestorSummaries = await svc.getAncestors(sourceIssue.id);
    for (const ancestor of ancestorSummaries) {
      allowedTargetIds.add(ancestor.id);
    }

    const disallowedTarget = targetIssues.find((candidate) => !allowedTargetIds.has(candidate.id)) ?? null;
    if (disallowedTarget) {
      res.status(403).json({
        error: "Agents can only publish artifacts to parent, ancestor, or sibling issues",
      });
      return false;
    }
    return true;
  }

  function extractHandoffMetadata(value: unknown) {
    if (!isRecord(value)) return null;
    const handoff = isRecord(value.handoff) ? value.handoff : null;
    if (!handoff) return null;
    return {
      sourceIssueId: typeof handoff.sourceIssueId === "string" ? handoff.sourceIssueId : null,
      artifactKind: typeof handoff.artifactKind === "string" ? handoff.artifactKind : null,
      documentKey: typeof handoff.documentKey === "string" ? handoff.documentKey : null,
      sourceWorkProductId: typeof handoff.sourceWorkProductId === "string" ? handoff.sourceWorkProductId : null,
    };
  }

  function matchesHandoffProduct(
    product: { metadata: Record<string, unknown> | null; provider: string; type: string },
    input:
      | { kind: "document"; sourceIssueId: string; documentKey: string }
      | { kind: "work_product"; sourceIssueId: string; sourceWorkProductId: string },
  ) {
    if (product.provider !== "paperclip" || product.type !== "artifact") return false;
    const metadata = extractHandoffMetadata(product.metadata);
    if (!metadata || metadata.sourceIssueId !== input.sourceIssueId || metadata.artifactKind !== input.kind) {
      return false;
    }
    if (input.kind === "document") {
      return metadata.documentKey === input.documentKey;
    }
    return metadata.sourceWorkProductId === input.sourceWorkProductId;
  }

  async function runSingleFileUpload(req: Request, res: Response) {
    await new Promise<void>((resolve, reject) => {
      upload.single("file")(req, res, (err: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async function assertCanManageIssueApprovalLinks(req: Request, res: Response, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") return true;
    if (!req.actor.agentId) {
      res.status(403).json({ error: "Agent authentication required" });
      return false;
    }
    const actorAgent = await agentsSvc.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      res.status(403).json({ error: "Forbidden" });
      return false;
    }
    if (actorAgent.role === "ceo" || Boolean(actorAgent.permissions?.canCreateAgents)) return true;
    res.status(403).json({ error: "Missing permission to link approvals" });
    return false;
  }

  function actorCanAccessCompany(req: Request, companyId: string) {
    if (req.actor.type === "none") return false;
    if (req.actor.type === "agent") return req.actor.companyId === companyId;
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
    return (req.actor.companyIds ?? []).includes(companyId);
  }

  function canCreateAgentsLegacy(agent: { permissions: Record<string, unknown> | null | undefined; role: string }) {
    if (agent.role === "ceo") return true;
    if (!agent.permissions || typeof agent.permissions !== "object") return false;
    return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
  }

  async function assertCanAssignTasks(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
      const allowed = await access.canUser(companyId, req.actor.userId, "tasks:assign");
      if (!allowed) throw forbidden("Missing permission: tasks:assign");
      return;
    }
    if (req.actor.type === "agent") {
      if (!req.actor.agentId) throw forbidden("Agent authentication required");
      const allowedByGrant = await access.hasPermission(companyId, "agent", req.actor.agentId, "tasks:assign");
      if (allowedByGrant) return;
      const actorAgent = await agentsSvc.getById(req.actor.agentId);
      if (actorAgent && actorAgent.companyId === companyId && canCreateAgentsLegacy(actorAgent)) return;
      throw forbidden("Missing permission: tasks:assign");
    }
    throw unauthorized();
  }

  async function assertCanReviewPlan(req: Request, res: Response, issue: any, actionName: "approve" | "reject") {
    const actor = getActorInfo(req);
    if (actor.actorType === "agent" && actor.agentId === issue.assigneeAgentId) {
      res.status(403).json({ error: `Only the target approver can ${actionName} this plan (self-approval forbidden)` });
      return false;
    }

    let approvalRecord;
    try {
      approvalRecord = await issueApprovalsSvc.getLiveWorkPlanApprovalForIssue(issue.id);
    } catch (err) {
      if (err instanceof HttpError && err.status === 422) {
        res.status(409).json({ error: err.message });
        return false;
      }
      throw err;
    }
    if (!approvalRecord) {
      res.status(409).json({ error: "Issue has plan mirrors but no live work plan approval; manual repair required" });
      return false;
    }

    let reviewActor: ApprovalActor | null = null;
    if (req.actor.type === "agent" && req.actor.agentId) {
      reviewActor = {
        actorType: "agent",
        agentId: req.actor.agentId,
      };
    } else if (req.actor.type === "board") {
      reviewActor = {
        actorType: "board",
        userId: req.actor.userId ?? "board",
      };
    }

    if (!reviewActor || !canActorResolveApproval(approvalRecord, reviewActor)) {
      res.status(403).json({ error: `Only the target approver can ${actionName} this plan` });
      return false;
    }

    return true;
  }

  async function assertAgentExecutionPlanAllowed(
    req: Request,
    res: Response,
    issue: {
      parentId?: string | null;
      assigneeAgentId?: string | null;
      planProposedAt?: Date | null;
      planApprovedAt?: Date | null;
      status?: string | null;
    },
    action: string,
  ) {
    if (req.actor.type !== "agent") return true;
    const gateReason = getIssueExecutionPlanGateReason(issue);
    if (!gateReason) return true;

    res.status(409).json({
      error: describeIssueExecutionPlanGateError(gateReason, action),
      planGate: gateReason,
      planProposedAt: issue.planProposedAt ?? null,
      planApprovedAt: issue.planApprovedAt ?? null,
    });
    return false;
  }

    function requireAgentRunId(req: Request, res: Response) {
    if (req.actor.type !== "agent") return null;
    const runId = req.actor.runId?.trim();
    if (runId) return runId;
    res.status(401).json({ error: "Agent run id required" });
    return null;
  }

  async function assertAgentRunCheckoutOwnership(
    req: Request,
    res: Response,
    issue: { id: string; companyId: string; status: string; assigneeAgentId: string | null },
  ) {
    if (req.actor.type !== "agent") return true;
    const actorAgentId = req.actor.agentId;
    if (!actorAgentId) {
      res.status(403).json({ error: "Agent authentication required" });
      return false;
    }
    if (issue.status !== "in_progress" || issue.assigneeAgentId !== actorAgentId) {
      return true;
    }
    const runId = requireAgentRunId(req, res);
    if (!runId) return false;
    const ownership = await svc.assertCheckoutOwner(issue.id, actorAgentId, runId);
    if (ownership.adoptedFromRunId) {
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.checkout_lock_adopted",
        entityType: "issue",
        entityId: issue.id,
        details: {
          previousCheckoutRunId: ownership.adoptedFromRunId,
          checkoutRunId: runId,
          reason: "stale_checkout_run",
        },
      }).catch((err) =>
        logger.warn(
          {
            err,
            issueId: issue.id,
            actorAgentId,
            checkoutRunId: runId,
            previousCheckoutRunId: ownership.adoptedFromRunId,
          },
          "failed to log checkout lock adoption",
        ));
    }
    return true;
  }

  type ResumeChainRuntimeIssue = IssueRecord & {
    runtimeState: {
      lifecycle: { isTerminal: boolean };
      execution: { canStart: boolean };
    };
  };

  type ResumeChainDecision =
    | "woke_issue_owner"
    | "woke_parent_owner"
    | "woke_child_lanes"
    | "no_actionable_target";

  function isResumeChainActionable(issue: ResumeChainRuntimeIssue) {
    return Boolean(issue.assigneeAgentId) && issue.runtimeState.execution.canStart;
  }

  function summarizeResumeChainBlocker(issue: ResumeChainRuntimeIssue) {
    if (issue.runtimeState.execution.canStart) return "ready";
    if (issue.planProposedAt && !issue.planApprovedAt) return "plan_pending_review";
    if (issue.status === "blocked") return "issue_blocked";
    if (issue.runtimeState.lifecycle.isTerminal) return "issue_closed";
    return "not_runnable";
  }

  async function hydrateIssuesForResumeChain(items: IssueRecord[]) {
    const statusSummaries = await statusTruth.getIssueStatusTruthSummaries(items.map((issue) => issue.id));
    return items.map((issue) => attachIssueRuntimeState(applyEffectiveStatus(issue, statusSummaries.get(issue.id) ?? null))) as ResumeChainRuntimeIssue[];
  }

  async function resolveIssueDispatchMode(
    issue: IssueRecord,
    children: Array<Pick<IssueRecord, "originId" | "originKind">> = [],
  ): Promise<{
    mode: RoutineDispatchMode;
    source: "issue_origin_routine" | "ancestor_origin_routine" | "child_origin_routine" | "default";
    routineId: string | null;
  }> {
    if (issue.originKind === "routine_execution" && issue.originId) {
      const routine = await routinesSvc.get(issue.originId);
      if (routine) {
        return {
          mode: routine.dispatchMode,
          source: "issue_origin_routine",
          routineId: routine.id,
        };
      }
    }

    const ancestors = await svc.getAncestors(issue.id);
    for (const ancestor of ancestors) {
      const ancestorIssue = await svc.getById(ancestor.id);
      if (!ancestorIssue || ancestorIssue.originKind !== "routine_execution" || !ancestorIssue.originId) continue;
      const routine = await routinesSvc.get(ancestorIssue.originId);
      if (!routine) continue;
      return {
        mode: routine.dispatchMode,
        source: "ancestor_origin_routine",
        routineId: routine.id,
      };
    }

    const childRoutineOriginIds = [
      ...new Set(
        children
          .filter(
            (child): child is Pick<IssueRecord, "originId" | "originKind"> & { originId: string } =>
              child.originKind === "routine_execution" && typeof child.originId === "string" && child.originId.length > 0,
          )
          .map((child) => child.originId),
      ),
    ];

    for (const routineId of childRoutineOriginIds) {
      const routine = await routinesSvc.get(routineId);
      if (!routine || routine.parentIssueId !== issue.id) continue;
      return {
        mode: routine.dispatchMode,
        source: "child_origin_routine",
        routineId: routine.id,
      };
    }

    return {
      mode: "event_driven",
      source: "default",
      routineId: null,
    };
  }

  function selectResumeChainTargets(input: {
    issue: ResumeChainRuntimeIssue;
    children: ResumeChainRuntimeIssue[];
    dispatchMode: RoutineDispatchMode;
  }): {
    decision: ResumeChainDecision;
    targets: ResumeChainRuntimeIssue[];
    summary: string;
  } {
    const openChildren = input.children.filter((child) => !child.runtimeState.lifecycle.isTerminal);
    const actionableChildren = openChildren.filter((child) => isResumeChainActionable(child));
    const parentActionable = isResumeChainActionable(input.issue);

    if (input.dispatchMode === "fixed_parallel_lanes") {
      if (actionableChildren.length > 0) {
        return {
          decision: "woke_child_lanes",
          targets: actionableChildren,
          summary: `Resuming ${actionableChildren.length} lane${actionableChildren.length === 1 ? "" : "s"} in parallel.`,
        };
      }
      if (openChildren.length > 0 && parentActionable) {
        return {
          decision: "woke_parent_owner",
          targets: [input.issue],
          summary: "No lane was directly runnable, so the parent owner will reconcile the batch.",
        };
      }
      if (parentActionable) {
        return {
          decision: "woke_issue_owner",
          targets: [input.issue],
          summary: "Resuming the issue owner.",
        };
      }
      return {
        decision: "no_actionable_target",
        targets: [],
        summary: "No actionable lane or owner was eligible for recovery.",
      };
    }

    if (actionableChildren.length === 1) {
      return {
        decision: "woke_issue_owner",
        targets: actionableChildren,
        summary: "Resuming the current next hop.",
      };
    }
    if (openChildren.length > 0 && parentActionable) {
      return {
        decision: "woke_parent_owner",
        targets: [input.issue],
        summary: "Resuming the parent owner to decide the next event-driven hop.",
      };
    }
    if (parentActionable) {
      return {
        decision: "woke_issue_owner",
        targets: [input.issue],
        summary: "Resuming the issue owner.",
      };
    }
    return {
      decision: "no_actionable_target",
      targets: [],
      summary: "No actionable next hop was eligible for recovery.",
    };
  }

  async function resolveActiveIssueRun(issue: {
    id: string;
    assigneeAgentId: string | null;
    executionRunId?: string | null;
  }) {
    let runToInterrupt = issue.executionRunId ? await heartbeat.getRun(issue.executionRunId) : null;

    if ((!runToInterrupt || runToInterrupt.status !== "running") && issue.assigneeAgentId) {
      const activeRun = await heartbeat.getActiveRunForAgent(issue.assigneeAgentId);
      const activeIssueId =
        activeRun &&
        activeRun.contextSnapshot &&
        typeof activeRun.contextSnapshot === "object" &&
        typeof (activeRun.contextSnapshot as Record<string, unknown>).issueId === "string"
          ? ((activeRun.contextSnapshot as Record<string, unknown>).issueId as string)
          : null;
      if (activeRun && activeRun.status === "running" && activeIssueId === issue.id) {
        runToInterrupt = activeRun;
      }
    }

    return runToInterrupt?.status === "running" ? runToInterrupt : null;
  }

  async function getClosedIssueExecutionWorkspace(issue: { executionWorkspaceId?: string | null }) {
    if (!issue.executionWorkspaceId) return null;
    const workspace = await executionWorkspacesSvc.getById(issue.executionWorkspaceId);
    if (!workspace || !isClosedIsolatedExecutionWorkspace(workspace)) return null;
    return workspace;
  }

  function respondClosedIssueExecutionWorkspace(
    res: Response,
    workspace: Pick<ExecutionWorkspace, "closedAt" | "id" | "mode" | "name" | "status">,
  ) {
    res.status(409).json({
      error: getClosedIsolatedExecutionWorkspaceMessage(workspace),
      executionWorkspace: workspace,
    });
  }

  async function normalizeIssueIdentifier(rawId: string): Promise<string> {
    if (/^[A-Z]+-\d+$/i.test(rawId)) {
      const issue = await svc.getByIdentifier(rawId);
      if (issue) {
        return issue.id;
      }
    }
    return rawId;
  }

  async function resolveIssueProjectAndGoal(issue: {
    companyId: string;
    projectId: string | null;
    goalId: string | null;
  }) {
    const projectPromise = issue.projectId ? projectsSvc.getById(issue.projectId) : Promise.resolve(null);
    const directGoalPromise = issue.goalId ? goalsSvc.getById(issue.goalId) : Promise.resolve(null);
    const [project, directGoal] = await Promise.all([projectPromise, directGoalPromise]);

    if (directGoal) {
      return { project, goal: directGoal };
    }

    const projectGoalId = project?.goalId ?? project?.goalIds[0] ?? null;
    if (projectGoalId) {
      const projectGoal = await goalsSvc.getById(projectGoalId);
      return { project, goal: projectGoal };
    }

    if (!issue.projectId) {
      const defaultGoal = await goalsSvc.getDefaultCompanyGoal(issue.companyId);
      return { project, goal: defaultGoal };
    }

    return { project, goal: null };
  }

  // Resolve issue identifiers (e.g. "PAP-39") to UUIDs for all /issues/:id routes
  router.param("id", async (req, res, next, rawId) => {
    try {
      req.params.id = await normalizeIssueIdentifier(rawId);
      next();
    } catch (err) {
      next(err);
    }
  });

  // Resolve issue identifiers (e.g. "PAP-39") to UUIDs for company-scoped attachment routes.
  router.param("issueId", async (req, res, next, rawId) => {
    try {
      req.params.issueId = await normalizeIssueIdentifier(rawId);
      next();
    } catch (err) {
      next(err);
    }
  });

  // Common malformed path when companyId is empty in "/api/companies/{companyId}/issues".
  router.get("/issues", (_req, res) => {
    res.status(400).json({
      error: "Missing companyId in path. Use /api/companies/{companyId}/issues.",
    });
  });

  router.get("/companies/:companyId/issues", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const includePlatformUnblock = parseBooleanQuery(req.query.includePlatformUnblock);
    const requestedStatusFilter = typeof req.query.status === "string" && req.query.status.trim().length > 0
      ? new Set(req.query.status.split(",").map((status) => status.trim().toLowerCase()).filter(Boolean))
      : null;
    const assigneeUserFilterRaw = req.query.assigneeUserId as string | undefined;
    const touchedByUserFilterRaw = req.query.touchedByUserId as string | undefined;
    const inboxArchivedByUserFilterRaw = req.query.inboxArchivedByUserId as string | undefined;
    const unreadForUserFilterRaw = req.query.unreadForUserId as string | undefined;
    const replyNeededForUserFilterRaw = req.query.replyNeededForUserId as string | undefined;
    const includeHidden = parseBooleanQuery(req.query.includeHidden);
    const includeArchivedProjectIssues = parseBooleanQuery(req.query.includeArchivedProjectIssues);
    const assigneeUserId =
      assigneeUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : assigneeUserFilterRaw;
    const touchedByUserId =
      touchedByUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : touchedByUserFilterRaw;
    const inboxArchivedByUserId =
      inboxArchivedByUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : inboxArchivedByUserFilterRaw;
    const unreadForUserId =
      unreadForUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : unreadForUserFilterRaw;
    const replyNeededForUserId =
      replyNeededForUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : replyNeededForUserFilterRaw;

    if (assigneeUserFilterRaw === "me" && (!assigneeUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "assigneeUserId=me requires board authentication" });
      return;
    }
    if (touchedByUserFilterRaw === "me" && (!touchedByUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "touchedByUserId=me requires board authentication" });
      return;
    }
    if (inboxArchivedByUserFilterRaw === "me" && (!inboxArchivedByUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "inboxArchivedByUserId=me requires board authentication" });
      return;
    }
    if (unreadForUserFilterRaw === "me" && (!unreadForUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "unreadForUserId=me requires board authentication" });
      return;
    }
    if (replyNeededForUserFilterRaw === "me" && (!replyNeededForUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "replyNeededForUserId=me requires board authentication" });
      return;
    }

    const result = await svc.list(companyId, {
      status: canQueryDb && requestedStatusFilter ? undefined : req.query.status as string | undefined,
      assigneeAgentId: req.query.assigneeAgentId as string | undefined,
      participantAgentId: req.query.participantAgentId as string | undefined,
      assigneeUserId,
      touchedByUserId,
      inboxArchivedByUserId,
      unreadForUserId,
      replyNeededForUserId,
      projectId: req.query.projectId as string | undefined,
      executionWorkspaceId: req.query.executionWorkspaceId as string | undefined,
      parentId: req.query.parentId as string | undefined,
      labelId: req.query.labelId as string | undefined,
      originKind: req.query.originKind as string | undefined,
      originId: req.query.originId as string | undefined,
      includeRoutineExecutions:
        req.query.includeRoutineExecutions === "true" || req.query.includeRoutineExecutions === "1",
      includeHidden,
      includeArchivedProjectIssues,
      q: req.query.q as string | undefined,
    });

    if (!canQueryDb || result.length === 0) {
      res.json(result);
      return;
    }

    const [statusSummaries, platformSummaries] = await Promise.all([
      statusTruth.getIssueStatusTruthSummaries(result.map((issue) => issue.id)),
      includePlatformUnblock
        ? platformUnblock.listIssuePlatformUnblockSummaries(result.map((issue) => issue.id))
        : Promise.resolve(new Map()),
    ]);

    const serializedIssues = result.map((issue) => {
      const serialized = attachIssueRuntimeState(applyEffectiveStatus(issue, statusSummaries.get(issue.id) ?? null));
      if (!includePlatformUnblock) return serialized;
      return {
        ...serialized,
        platformUnblockSummary: platformSummaries.get(issue.id) ?? null,
      };
    });

    res.json(
      requestedStatusFilter
        ? serializedIssues.filter((issue) => issueMatchesDisplayStatusFilter(issue, requestedStatusFilter))
        : serializedIssues,
    );
  });

  router.get("/companies/:companyId/labels", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.listLabels(companyId);
    res.json(result);
  });

  router.post("/companies/:companyId/labels", validate(createIssueLabelSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const label = await svc.createLabel(companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "label.created",
      entityType: "label",
      entityId: label.id,
      details: { name: label.name, color: label.color },
    });
    res.status(201).json(label);
  });

  router.delete("/labels/:labelId", async (req, res) => {
    const labelId = req.params.labelId as string;
    const existing = await svc.getLabelById(labelId);
    if (!existing) {
      res.status(404).json({ error: "Label not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const removed = await svc.deleteLabel(labelId);
    if (!removed) {
      res.status(404).json({ error: "Label not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: removed.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "label.deleted",
      entityType: "label",
      entityId: removed.id,
      details: { name: removed.name, color: removed.color },
    });
    res.json(removed);
  });

  router.get("/issues/:id", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const [{ project, goal }, ancestors, mentionedProjectIds, documentPayload] = await Promise.all([
      resolveIssueProjectAndGoal(issue),
      svc.getAncestors(issue.id),
      svc.findMentionedProjectIds(issue.id),
      documentsSvc.getIssueDocumentPayload(issue),
    ]);
    const statusSummary = await statusTruth.getIssueStatusTruthSummary(issue.id);
    const serializedIssue = attachIssueRuntimeState(applyEffectiveStatus(issue, statusSummary));
    const genericDocumentPayload = {
      ...documentPayload,
      documentSummaries: filterGenericDocumentSummaries(documentPayload.documentSummaries ?? []),
    };
    const mentionedProjects = mentionedProjectIds.length > 0
      ? await projectsSvc.listByIds(issue.companyId, mentionedProjectIds)
      : [];
    const currentExecutionWorkspace = serializedIssue.executionWorkspaceId
      ? await executionWorkspacesSvc.getById(serializedIssue.executionWorkspaceId)
      : null;
    const workProducts = await workProductsSvc.listForIssue(serializedIssue.id);
    res.json({
      ...serializedIssue,
      goalId: goal?.id ?? serializedIssue.goalId,
      ancestors,
      ...genericDocumentPayload,
      project: project ?? null,
      goal: goal ?? null,
      mentionedProjects,
      currentExecutionWorkspace,
      workProducts,
    });
  });

  router.get("/issues/:id/heartbeat-context", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const statusSummary = await statusTruth.getIssueStatusTruthSummary(issue.id);
    const serializedIssue = attachIssueRuntimeState(applyEffectiveStatus(issue, statusSummary));

    const wakeCommentId =
      typeof req.query.wakeCommentId === "string" && req.query.wakeCommentId.trim().length > 0
        ? req.query.wakeCommentId.trim()
        : null;

    const [{ project, goal }, ancestors, commentCursor, wakeComment, qaSummary, platformUnblockSummary, blackboard] = await Promise.all([
      resolveIssueProjectAndGoal(issue),
      svc.getAncestors(issue.id),
      svc.getCommentCursor(issue.id),
      wakeCommentId ? svc.getComment(wakeCommentId) : null,
      canQueryDb ? qaIssueState.getIssueQaSummary(issue.id) : Promise.resolve(null),
      canQueryDb ? platformUnblock.getIssuePlatformUnblockSummary(issue.id) : Promise.resolve(null),
      blackboardSvc.getIssueBlackboardSummary(issue.id),
    ]);

    res.json({
      issue: {
        id: serializedIssue.id,
        identifier: serializedIssue.identifier,
        title: serializedIssue.title,
        description: serializedIssue.description,
        status: serializedIssue.status,
        statusTruthSummary: serializedIssue.statusTruthSummary ?? null,
        runtimeState: serializedIssue.runtimeState ?? null,
        priority: serializedIssue.priority,
        projectId: serializedIssue.projectId,
        goalId: goal?.id ?? serializedIssue.goalId,
        parentId: serializedIssue.parentId,
        assigneeAgentId: serializedIssue.assigneeAgentId,
        assigneeUserId: serializedIssue.assigneeUserId,
        planProposedAt: serializedIssue.planProposedAt,
        planApprovedAt: serializedIssue.planApprovedAt,
        updatedAt: serializedIssue.updatedAt,
      },
      ancestors: ancestors.map((ancestor) => ({
        id: ancestor.id,
        identifier: ancestor.identifier,
        title: ancestor.title,
        status: ancestor.status,
        priority: ancestor.priority,
      })),
      project: project
        ? {
            id: project.id,
            name: project.name,
            status: project.status,
            targetDate: project.targetDate,
          }
        : null,
      goal: goal
        ? {
            id: goal.id,
            title: goal.title,
            status: goal.status,
            level: goal.level,
            parentId: goal.parentId,
          }
        : null,
      blackboard,
      commentCursor,
      qaSummary,
      platformUnblockSummary,
      wakeComment:
        wakeComment && wakeComment.issueId === issue.id
          ? wakeComment
          : null,
    });
  });

  router.get("/issues/:id/qa-summary", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    const [qaSummary, platformUnblockSummary] = await Promise.all([
      canQueryDb ? qaIssueState.getIssueQaSummary(issue.id) : Promise.resolve(null),
      canQueryDb ? platformUnblock.getIssuePlatformUnblockSummary(issue.id) : Promise.resolve(null),
    ]);

    res.json({
      issueId: issue.id,
      qaSummary,
      platformUnblockSummary,
    });
  });

  router.get("/issues/:id/platform-unblock-summary", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    const summary = canQueryDb
      ? await platformUnblock.getIssuePlatformUnblockSummary(issue.id)
      : null;
    res.json({
      issueId: issue.id,
      platformUnblockSummary: summary,
    });
  });

  router.get("/issues/:id/work-products", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const workProducts = await workProductsSvc.listForIssue(issue.id);
    res.json(workProducts);
  });

  router.get("/issues/:id/blackboard", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const state = await blackboardSvc.getIssueBlackboard(issue.id);
    res.json(state);
  });

  router.get("/issues/:id/blackboard/:key", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const keyParsed = issueBlackboardEntryKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid blackboard key", details: keyParsed.error.issues });
      return;
    }
    const entry = await blackboardSvc.getIssueBlackboardEntry(issue.id, keyParsed.data);
    res.json(entry);
  });

  router.post("/issues/:id/blackboard/bootstrap", validate(bootstrapIssueBlackboardSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await assertAgentExecutionPlanAllowed(req, res, issue, "bootstrapping issue blackboard"))) return;

    const actor = getActorInfo(req);
    const state = await blackboardSvc.bootstrapIssueBlackboard({
      issueId: issue.id,
      template: req.body.template,
      createdByAgentId: actor.agentId ?? null,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      createdByRunId: actor.runId ?? null,
    });

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.blackboard_bootstrapped",
      entityType: "issue",
      entityId: issue.id,
      details: {
        template: req.body.template,
        entryCount: state.entries.length,
      },
    });

    res.json(state);
  });

  router.put("/issues/:id/blackboard/:key", validate(upsertIssueBlackboardEntrySchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const keyParsed = issueBlackboardEntryKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid blackboard key", details: keyParsed.error.issues });
      return;
    }
    if (!(await assertAgentExecutionPlanAllowed(req, res, issue, "updating issue blackboard"))) return;

    const actor = getActorInfo(req);
    const entry = await blackboardSvc.upsertIssueBlackboardEntry({
      issueId: issue.id,
      key: keyParsed.data,
      content: req.body.content,
      changeSummary: req.body.changeSummary ?? null,
      baseRevisionId: req.body.baseRevisionId ?? null,
      createdByAgentId: actor.agentId ?? null,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      createdByRunId: actor.runId ?? null,
    });

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.blackboard_entry_updated",
      entityType: "issue",
      entityId: issue.id,
      details: {
        key: entry.key,
        documentId: entry.document?.id ?? null,
        format: entry.document?.format ?? entry.format,
        revisionNumber: entry.document?.latestRevisionNumber ?? null,
      },
    });

    res.json(entry);
  });

  router.get("/issues/:id/documents", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const docs = await documentsSvc.listIssueDocuments(issue.id);
    res.json(filterGenericDocumentSummaries(docs));
  });

  router.get("/issues/:id/documents/:key", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    if (isReservedBlackboardDocumentKey(keyParsed.data)) {
      respondReservedBlackboardDocumentKey(res);
      return;
    }
    const doc = await documentsSvc.getIssueDocumentByKey(issue.id, keyParsed.data);
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    res.json(doc);
  });

  router.put("/issues/:id/documents/:key", validate(upsertIssueDocumentSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    if (isReservedBlackboardDocumentKey(keyParsed.data)) {
      respondReservedBlackboardDocumentKey(res);
      return;
    }
    if (!(await assertAgentExecutionPlanAllowed(req, res, issue, "writing issue documents"))) return;

    const actor = getActorInfo(req);
    const result = await documentsSvc.upsertIssueDocument({
      issueId: issue.id,
      key: keyParsed.data,
      title: req.body.title ?? null,
      format: req.body.format,
      body: req.body.body,
      changeSummary: req.body.changeSummary ?? null,
      baseRevisionId: req.body.baseRevisionId ?? null,
      createdByAgentId: actor.agentId ?? null,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      createdByRunId: actor.runId ?? null,
    });
    const doc = result.document;

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: result.created ? "issue.document_created" : "issue.document_updated",
      entityType: "issue",
      entityId: issue.id,
      details: {
        key: doc.key,
        documentId: doc.id,
        title: doc.title,
        format: doc.format,
        revisionNumber: doc.latestRevisionNumber,
      },
    });

    res.status(result.created ? 201 : 200).json(doc);
  });

  router.post("/issues/:id/publish-artifact", validate(publishIssueArtifactSchema), async (req, res) => {
    const id = req.params.id as string;
    const sourceIssue = await svc.getById(id);
    if (!sourceIssue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, sourceIssue.companyId);
    if (!(await assertAgentExecutionPlanAllowed(req, res, sourceIssue, "publishing artifacts"))) return;

    const actor = getActorInfo(req);
    const requestedSummary = req.body.summary?.trim() || null;
    const requiredAction = req.body.requiredAction?.trim() || null;
    const wakeTargets = req.body.wakeTargets !== false;
    const targetIssues = await resolvePublicationTargets(sourceIssue, req.body.target);
    if (!(await assertAgentArtifactPublicationAccess(req, res, sourceIssue, req.body.target, targetIssues))) {
      return;
    }

    let syncedProjectDocs: Awaited<ReturnType<typeof syncDocumentToProjectDocs>> | null = null;
    let artifactSummary: string | null = null;
    let artifactTitle = "";
    let artifactIdentity: { kind: "document"; sourceIssueId: string; documentKey: string } | { kind: "work_product"; sourceIssueId: string; sourceWorkProductId: string };
    let artifactCommentDescriptor:
      | {
          kind: "document";
          title: string;
          key: string;
          revisionNumber: number;
        }
      | {
          kind: "work_product";
          title: string;
          type: string;
          sourceWorkProductId: string;
        };
    let artifactUrl: string | null = null;
    let artifactHealthStatus: "unknown" | "healthy" | "unhealthy" = "unknown";

    if (req.body.artifact.kind === "document") {
      if (isReservedBlackboardDocumentKey(req.body.artifact.key)) {
        respondReservedBlackboardDocumentKey(res);
        return;
      }
      const document = await documentsSvc.getIssueDocumentByKey(sourceIssue.id, req.body.artifact.key);
      if (!document) {
        res.status(404).json({ error: "Document not found" });
        return;
      }
      if (req.body.syncToProjectDocs?.path) {
        syncedProjectDocs = await syncDocumentToProjectDocs({
          issue: sourceIssue,
          title: document.title ?? null,
          body: document.body ?? "",
          relativePath: req.body.syncToProjectDocs.path,
        });
      }
      artifactTitle = document.title ?? `Document: ${document.key}`;
      artifactSummary = sanitizeSummaryText(requestedSummary, document.body ?? "");
      artifactIdentity = {
        kind: "document",
        sourceIssueId: sourceIssue.id,
        documentKey: document.key,
      };
      artifactCommentDescriptor = {
        kind: "document",
        title: artifactTitle,
        key: document.key,
        revisionNumber: document.latestRevisionNumber,
      };
    } else {
      if (req.body.syncToProjectDocs?.path) {
        res.status(400).json({ error: "Only document artifacts can be synced into project docs." });
        return;
      }
      const workProduct = await workProductsSvc.getById(req.body.artifact.workProductId);
      if (!workProduct || workProduct.issueId !== sourceIssue.id || workProduct.companyId !== sourceIssue.companyId) {
        res.status(404).json({ error: "Work product not found on this issue" });
        return;
      }
      artifactTitle = workProduct.title;
      artifactSummary = sanitizeSummaryText(requestedSummary, workProduct.summary ?? workProduct.title);
      artifactIdentity = {
        kind: "work_product",
        sourceIssueId: sourceIssue.id,
        sourceWorkProductId: workProduct.id,
      };
      artifactCommentDescriptor = {
        kind: "work_product",
        title: workProduct.title,
        type: workProduct.type,
        sourceWorkProductId: workProduct.id,
      };
      artifactUrl = workProduct.url ?? null;
      artifactHealthStatus = workProduct.healthStatus;
    }

    const publicationDetails: Array<{
      issueId: string;
      identifier: string | null;
      workProductId: string;
      commentId: string;
    }> = [];

    for (const targetIssue of targetIssues) {
      const handoffMetadata = {
        handoff: {
          sourceIssueId: sourceIssue.id,
          sourceIssueIdentifier: sourceIssue.identifier ?? null,
          sourceIssueTitle: sourceIssue.title,
          artifactKind: artifactIdentity.kind,
          documentKey: artifactIdentity.kind === "document" ? artifactIdentity.documentKey : null,
          sourceWorkProductId:
            artifactIdentity.kind === "work_product" ? artifactIdentity.sourceWorkProductId : null,
          requiredAction,
          summary: artifactSummary,
          syncedProjectDocsPath: syncedProjectDocs?.relativePath ?? null,
          publishedBy: {
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId ?? null,
            runId: actor.runId ?? null,
          },
          publishedAt: new Date().toISOString(),
        },
      };

      const existingProducts = await workProductsSvc.listForIssue(targetIssue.id);
      const existing = existingProducts.find((product) => matchesHandoffProduct(product, artifactIdentity)) ?? null;
      const workProductPayload = {
        projectId: targetIssue.projectId ?? sourceIssue.projectId ?? null,
        executionWorkspaceId: null,
        runtimeServiceId: null,
        type: "artifact" as const,
        provider: "paperclip",
        externalId:
          artifactIdentity.kind === "document"
            ? `document:${sourceIssue.id}:${artifactIdentity.documentKey}:${targetIssue.id}`
            : `work_product:${sourceIssue.id}:${artifactIdentity.sourceWorkProductId}:${targetIssue.id}`,
        title: `Handoff: ${artifactTitle}`,
        url: artifactUrl,
        status: "ready_for_review" as const,
        reviewState: "none" as const,
        isPrimary: false,
        healthStatus: artifactHealthStatus,
        summary: artifactSummary,
        metadata: handoffMetadata,
        createdByRunId: actor.runId ?? null,
      };
      const publishedProduct = existing
        ? await workProductsSvc.update(existing.id, workProductPayload)
        : await workProductsSvc.createForIssue(targetIssue.id, targetIssue.companyId, workProductPayload);
      if (!publishedProduct) {
        res.status(422).json({ error: "Failed to create handoff work product" });
        return;
      }

      const comment = await svc.addComment(
        targetIssue.id,
        buildArtifactPublicationComment({
          sourceIssue,
          artifact: artifactCommentDescriptor,
          summary: artifactSummary,
          requiredAction,
          syncedProjectDocsPath: syncedProjectDocs?.relativePath ?? null,
        }),
        {
          agentId: actor.agentId ?? undefined,
          userId: actor.actorType === "user" ? actor.actorId : undefined,
          runId: actor.runId,
        },
      );

      await logActivity(db, {
        companyId: targetIssue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: existing ? "issue.artifact_handoff_updated" : "issue.artifact_handoff_created",
        entityType: "issue",
        entityId: targetIssue.id,
        details: {
          sourceIssueId: sourceIssue.id,
          sourceIssueIdentifier: sourceIssue.identifier ?? null,
          artifactKind: artifactIdentity.kind,
          workProductId: publishedProduct.id,
          commentId: comment.id,
          syncedProjectDocsPath: syncedProjectDocs?.relativePath ?? null,
        },
      });

      if (wakeTargets && targetIssue.assigneeAgentId) {
        heartbeat
          .wakeup(targetIssue.assigneeAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "artifact_published",
            payload: {
              issueId: targetIssue.id,
              commentId: comment.id,
              sourceIssueId: sourceIssue.id,
              artifactKind: artifactIdentity.kind,
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: targetIssue.id,
              sourceIssueId: sourceIssue.id,
              artifactKind: artifactIdentity.kind,
              wakeReason: "artifact_published",
            },
          })
          .catch((err) => logger.warn({ err, targetIssueId: targetIssue.id }, "failed to wake assignee on artifact publication"));
      }

      publicationDetails.push({
        issueId: targetIssue.id,
        identifier: targetIssue.identifier ?? null,
        workProductId: publishedProduct.id,
        commentId: comment.id,
      });
    }

    await logActivity(db, {
      companyId: sourceIssue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.artifact_published",
      entityType: "issue",
      entityId: sourceIssue.id,
      details: {
        artifactKind: artifactIdentity.kind,
        targetIssueIds: publicationDetails.map((entry) => entry.issueId),
        syncedProjectDocsPath: syncedProjectDocs?.relativePath ?? null,
      },
    });

    res.json({
      ok: true,
      artifact: {
        kind: artifactIdentity.kind,
        title: artifactTitle,
        summary: artifactSummary,
      },
      syncedProjectDocs:
        syncedProjectDocs
          ? {
              relativePath: syncedProjectDocs.relativePath,
              workspaceRoot: syncedProjectDocs.workspaceRoot,
            }
          : null,
      publishedTo: publicationDetails,
    });
  });

  router.get("/issues/:id/documents/:key/revisions", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    if (isReservedBlackboardDocumentKey(keyParsed.data)) {
      respondReservedBlackboardDocumentKey(res);
      return;
    }
    const revisions = await documentsSvc.listIssueDocumentRevisions(issue.id, keyParsed.data);
    res.json(revisions);
  });

  router.post(
    "/issues/:id/documents/:key/revisions/:revisionId/restore",
    validate(restoreIssueDocumentRevisionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const revisionId = req.params.revisionId as string;
      const issue = await svc.getById(id);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      assertCompanyAccess(req, issue.companyId);
      const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
      if (!keyParsed.success) {
        res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
        return;
      }
      if (isReservedBlackboardDocumentKey(keyParsed.data)) {
        respondReservedBlackboardDocumentKey(res);
        return;
      }
      if (!(await assertAgentExecutionPlanAllowed(req, res, issue, "restoring issue documents"))) return;

      const actor = getActorInfo(req);
      const result = await documentsSvc.restoreIssueDocumentRevision({
        issueId: issue.id,
        key: keyParsed.data,
        revisionId,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      });

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.document_restored",
        entityType: "issue",
        entityId: issue.id,
        details: {
          key: result.document.key,
          documentId: result.document.id,
          title: result.document.title,
          format: result.document.format,
          revisionNumber: result.document.latestRevisionNumber,
          restoredFromRevisionId: result.restoredFromRevisionId,
          restoredFromRevisionNumber: result.restoredFromRevisionNumber,
        },
      });

      res.json(result.document);
    },
  );

  router.delete("/issues/:id/documents/:key", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    if (isReservedBlackboardDocumentKey(keyParsed.data)) {
      respondReservedBlackboardDocumentKey(res);
      return;
    }
    const removed = await documentsSvc.deleteIssueDocument(issue.id, keyParsed.data);
    if (!removed) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.document_deleted",
      entityType: "issue",
      entityId: issue.id,
      details: {
        key: removed.key,
        documentId: removed.id,
        title: removed.title,
      },
    });
    res.json({ ok: true });
  });

  router.post("/issues/:id/work-products", validate(createIssueWorkProductSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await assertAgentExecutionPlanAllowed(req, res, issue, "creating work products"))) return;
    const product = await workProductsSvc.createForIssue(issue.id, issue.companyId, {
      ...req.body,
      projectId: req.body.projectId ?? issue.projectId ?? null,
    });
    if (!product) {
      res.status(422).json({ error: "Invalid work product payload" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.work_product_created",
      entityType: "issue",
      entityId: issue.id,
      details: { workProductId: product.id, type: product.type, provider: product.provider },
    });
    res.status(201).json(product);
  });

  router.patch("/work-products/:id", validate(updateIssueWorkProductSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await workProductsSvc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const issue = await svc.getById(existing.issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertAgentExecutionPlanAllowed(req, res, issue, "updating work products"))) return;
    const product = await workProductsSvc.update(id, req.body);
    if (!product) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.work_product_updated",
      entityType: "issue",
      entityId: existing.issueId,
      details: { workProductId: product.id, changedKeys: Object.keys(req.body).sort() },
    });
    res.json(product);
  });

  router.delete("/work-products/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await workProductsSvc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const issue = await svc.getById(existing.issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertAgentExecutionPlanAllowed(req, res, issue, "deleting work products"))) return;
    const removed = await workProductsSvc.remove(id);
    if (!removed) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.work_product_deleted",
      entityType: "issue",
      entityId: existing.issueId,
      details: { workProductId: removed.id, type: removed.type },
    });
    res.json(removed);
  });

  router.post("/issues/:id/read", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const readState = await svc.markRead(issue.companyId, issue.id, req.actor.userId, new Date());
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.read_marked",
      entityType: "issue",
      entityId: issue.id,
      details: { userId: req.actor.userId, lastReadAt: readState.lastReadAt },
    });
    res.json(readState);
  });

  router.delete("/issues/:id/read", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const removed = await svc.markUnread(issue.companyId, issue.id, req.actor.userId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.read_unmarked",
      entityType: "issue",
      entityId: issue.id,
      details: { userId: req.actor.userId },
    });
    res.json({ id: issue.id, removed });
  });

  router.post("/issues/:id/inbox-archive", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const archiveState = await svc.archiveInbox(issue.companyId, issue.id, req.actor.userId, new Date());
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.inbox_archived",
      entityType: "issue",
      entityId: issue.id,
      details: { userId: req.actor.userId, archivedAt: archiveState.archivedAt },
    });
    res.json(archiveState);
  });

  router.delete("/issues/:id/inbox-archive", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const removed = await svc.unarchiveInbox(issue.companyId, issue.id, req.actor.userId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.inbox_unarchived",
      entityType: "issue",
      entityId: issue.id,
      details: { userId: req.actor.userId },
    });
    res.json(removed ?? { ok: true });
  });

  router.get("/issues/:id/approvals", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const approvals = await issueApprovalsSvc.listApprovalsForIssue(id);
    res.json(approvals);
  });

  router.post("/issues/:id/approvals", validate(linkIssueApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertCanManageIssueApprovalLinks(req, res, issue.companyId))) return;

    const actor = getActorInfo(req);
    await issueApprovalsSvc.link(id, req.body.approvalId, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.approval_linked",
      entityType: "issue",
      entityId: issue.id,
      details: { approvalId: req.body.approvalId },
    });

    const approvals = await issueApprovalsSvc.listApprovalsForIssue(id);
    res.status(201).json(approvals);
  });

  router.delete("/issues/:id/approvals/:approvalId", async (req, res) => {
    const id = req.params.id as string;
    const approvalId = req.params.approvalId as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertCanManageIssueApprovalLinks(req, res, issue.companyId))) return;

    await issueApprovalsSvc.unlink(id, approvalId);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.approval_unlinked",
      entityType: "issue",
      entityId: issue.id,
      details: { approvalId },
    });

    res.json({ ok: true });
  });

  router.post("/companies/:companyId/issues", validate(createIssueSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (req.body.assigneeAgentId || req.body.assigneeUserId) {
      await assertCanAssignTasks(req, companyId);
    }
    if (req.actor.type === "agent" && req.body.parentId) {
      const parentIssue = await svc.getById(req.body.parentId);
      if (!parentIssue) {
        res.status(404).json({ error: "Parent issue not found" });
        return;
      }
      if (!(await assertAgentExecutionPlanAllowed(req, res, parentIssue, "creating child issues"))) return;
    }
    if (isPlanExemptOriginKind(req.body.originKind)) {
      res.status(422).json({
        error: "Reserved issue lineage cannot be set through generic issue creation",
      });
      return;
    }

    const actor = getActorInfo(req);
    const issue = await svc.create(companyId, {
      ...req.body,
      originRunId:
        req.actor.type === "agent"
          ? actor.runId
          : null,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      createdByRunId: actor.runId,
    });
    const createDisposition = getIssueCreateDisposition(issue);

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: createDisposition === "reused" ? "issue.updated" : "issue.created",
      entityType: "issue",
      entityId: issue.id,
      details: {
        title: issue.title,
        identifier: issue.identifier,
        createDisposition,
      },
    });

    void queueIssueAssignmentWakeup({
      heartbeat,
      issue,
      reason: "issue_assigned",
      mutation: createDisposition === "reused" ? "update" : "create",
      contextSource: "issue.create",
      requestedByActorType: actor.actorType,
      requestedByActorId: actor.actorId,
    });

    res.status(createDisposition === "reused" ? 200 : 201).json(issue);
  });

  router.patch("/issues/:id", validate(updateIssueRouteSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const assigneeWillChange =
      (req.body.assigneeAgentId !== undefined && req.body.assigneeAgentId !== existing.assigneeAgentId) ||
      (req.body.assigneeUserId !== undefined && req.body.assigneeUserId !== existing.assigneeUserId);

    const isAgentReturningIssueToCreator =
      req.actor.type === "agent" &&
      !!req.actor.agentId &&
      existing.assigneeAgentId === req.actor.agentId &&
      req.body.assigneeAgentId === null &&
      typeof req.body.assigneeUserId === "string" &&
      !!existing.createdByUserId &&
      req.body.assigneeUserId === existing.createdByUserId;

    if (assigneeWillChange) {
      if (!isAgentReturningIssueToCreator) {
        await assertCanAssignTasks(req, existing.companyId);
      }
    }
    if (!(await assertAgentRunCheckoutOwnership(req, res, existing))) return;

    const actor = getActorInfo(req);
    const isClosed = existing.status === "done" || existing.status === "cancelled";
    const {
      comment: commentBody,
      reopen: reopenRequested,
      interrupt: interruptRequested,
      hiddenAt: hiddenAtRaw,
      ...updateFields
    } = req.body;
    let interruptedRunId: string | null = null;
    const closedExecutionWorkspace = await getClosedIssueExecutionWorkspace(existing);

    if (interruptRequested) {
      if (!commentBody) {
        res.status(400).json({ error: "Interrupt is only supported when posting a comment" });
        return;
      }
      if (req.actor.type !== "board") {
        res.status(403).json({ error: "Only board users can interrupt active runs from issue comments" });
        return;
      }

      const runToInterrupt = await resolveActiveIssueRun(existing);
      if (runToInterrupt) {
        const cancelled = await heartbeat.cancelRun(runToInterrupt.id);
        if (cancelled) {
          interruptedRunId = cancelled.id;
          await logActivity(db, {
            companyId: cancelled.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "heartbeat.cancelled",
            entityType: "heartbeat_run",
            entityId: cancelled.id,
            details: { agentId: cancelled.agentId, source: "issue_comment_interrupt", issueId: existing.id },
          });
        }
      }
    }

    if (hiddenAtRaw !== undefined) {
      updateFields.hiddenAt = hiddenAtRaw ? new Date(hiddenAtRaw) : null;
      (updateFields as typeof updateFields & { hiddenReason?: "manual" | null }).hiddenReason = hiddenAtRaw ? "manual" : null;
    }

    // Agents cannot manually change status while a plan is pending review
    if (
      req.actor.type === "agent" &&
      updateFields.status !== undefined &&
      updateFields.status !== existing.status &&
      existing.planProposedAt &&
      !existing.planApprovedAt
    ) {
      res.status(409).json({ error: "Cannot change lifecycle status while a proposed plan is pending review." });
      return;
    }
    if (commentBody && reopenRequested === true && isClosed && updateFields.status === undefined) {
      updateFields.status = "todo";
    }
    const isAgentWorkUpdate = req.actor.type === "agent" && Object.keys(updateFields).length > 0;

    if (isAgentWorkUpdate) {
      if (!(await assertAgentExecutionPlanAllowed(req, res, existing, "updating issue fields"))) return;
    }

    if (closedExecutionWorkspace && (commentBody || isAgentWorkUpdate)) {
      respondClosedIssueExecutionWorkspace(res, closedExecutionWorkspace);
      return;
    }

    if (updateFields.status === "done" && existing.status !== "done") {
      await svc.assertCanTransitionIssueToDone({
        issueId: existing.id,
        companyId: existing.companyId,
        actorType: req.actor.type === "agent" ? "agent" : "board",
        actorAgentId: req.actor.type === "agent" ? req.actor.agentId ?? null : null,
        actorRunId: req.actor.runId ?? null,
      });
    }
    let issue;
    try {
      issue = await svc.update(id, updateFields);
    } catch (err) {
      if (err instanceof HttpError && err.status === 422) {
        logger.warn(
          {
            issueId: id,
            companyId: existing.companyId,
            assigneePatch: {
              assigneeAgentId:
                req.body.assigneeAgentId === undefined ? "__omitted__" : req.body.assigneeAgentId,
              assigneeUserId:
                req.body.assigneeUserId === undefined ? "__omitted__" : req.body.assigneeUserId,
            },
            currentAssignee: {
              assigneeAgentId: existing.assigneeAgentId,
              assigneeUserId: existing.assigneeUserId,
            },
            error: err.message,
            details: err.details,
          },
          "issue update rejected with 422",
        );
      }
      throw err;
    }
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    await routinesSvc.syncRunStatusForIssue(issue.id);

    if (actor.runId) {
      await heartbeat.reportRunActivity(actor.runId).catch((err) =>
        logger.warn({ err, runId: actor.runId }, "failed to clear detached run warning after issue activity"));
    }

    // Build activity details with previous values for changed fields
    const previous: Record<string, unknown> = {};
    for (const key of Object.keys(updateFields)) {
      if (key in existing && (existing as Record<string, unknown>)[key] !== (updateFields as Record<string, unknown>)[key]) {
        previous[key] = (existing as Record<string, unknown>)[key];
      }
    }

    const hasFieldChanges = Object.keys(previous).length > 0;
    const reopened =
      commentBody &&
      reopenRequested === true &&
      isClosed &&
      previous.status !== undefined &&
      issue.status === "todo";
    const reopenFromStatus = reopened ? existing.status : null;
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.updated",
      entityType: "issue",
      entityId: issue.id,
      details: {
        ...updateFields,
        identifier: issue.identifier,
        ...(commentBody ? { source: "comment" } : {}),
        ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus } : {}),
        ...(interruptedRunId ? { interruptedRunId } : {}),
        _previous: hasFieldChanges ? previous : undefined,
      },
    });

    if (issue.status === "done" && existing.status !== "done") {
      const tc = getTelemetryClient();
      if (tc && actor.agentId) {
        const actorAgent = await agentsSvc.getById(actor.agentId);
        if (actorAgent) {
          trackAgentTaskCompleted(tc, { agentRole: actorAgent.role });
        }
      }
    }

    let comment = null;
    if (commentBody) {
      comment = await svc.addComment(id, commentBody, {
        agentId: actor.agentId ?? undefined,
        userId: actor.actorType === "user" ? actor.actorId : undefined,
        runId: actor.runId,
      });

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.comment_added",
        entityType: "issue",
        entityId: issue.id,
        details: {
          commentId: comment.id,
          bodySnippet: comment.body.slice(0, 120),
          identifier: issue.identifier,
          issueTitle: issue.title,
          ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus, source: "comment" } : {}),
          ...(interruptedRunId ? { interruptedRunId } : {}),
          ...(hasFieldChanges ? { updated: true } : {}),
        },
      });

    }

    const assigneeChanged = assigneeWillChange;
    const statusChanged = existing.status !== issue.status && req.body.status !== undefined;
    const priorityChanged = existing.priority !== issue.priority && req.body.priority !== undefined;

    // Merge all wakeups from this update into one enqueue per agent to avoid duplicate runs.
    void (async () => {
      const wakeups = new Map<string, Parameters<typeof heartbeat.wakeup>[1]>();

      if (assigneeChanged && issue.assigneeAgentId && issue.status !== "backlog") {
        wakeups.set(issue.assigneeAgentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assigned",
          payload: {
            issueId: issue.id,
            mutation: "update",
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: issue.id,
            source: "issue.update",
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
        });
      }

      if (!assigneeChanged && (statusChanged || priorityChanged) && issue.assigneeAgentId && !wakeups.has(issue.assigneeAgentId)) {
        wakeups.set(issue.assigneeAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: statusChanged ? "issue_status_changed" : "issue_priority_changed",
          payload: {
            issueId: issue.id,
            mutation: "update",
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: issue.id,
            source: statusChanged ? "issue.status_change" : "issue.priority_change",
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
        });
      }

      if (commentBody && comment) {
        let mentionedIds: string[] = [];
        try {
          mentionedIds = await svc.findMentionedAgents(issue.companyId, commentBody);
        } catch (err) {
          logger.warn({ err, issueId: id }, "failed to resolve @-mentions");
        }

        for (const mentionedId of mentionedIds) {
          if (wakeups.has(mentionedId)) continue;
          if (actor.actorType === "agent" && actor.actorId === mentionedId) continue;
          wakeups.set(mentionedId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_comment_mentioned",
            payload: { issueId: id, commentId: comment.id },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: id,
              taskId: id,
              commentId: comment.id,
              wakeCommentId: comment.id,
              wakeReason: "issue_comment_mentioned",
              source: "comment.mention",
            },
          });
        }
      }

      // Wake assignee on any comment even without @mention (e.g. board feedback)
      if (commentBody && comment && issue.assigneeAgentId && !wakeups.has(issue.assigneeAgentId)) {
        const commentIsFromAssignee = actor.actorType === "agent" && actor.agentId === issue.assigneeAgentId;
        if (!commentIsFromAssignee) {
          wakeups.set(issue.assigneeAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_comment_received",
            payload: { issueId: issue.id, commentId: comment.id },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: issue.id,
              commentId: comment.id,
              wakeCommentId: comment.id,
              wakeReason: "issue_comment_received",
              source: "comment.direct",
            },
          });
        }
      }

      const parentWakeReason = resolveParentIssueCloseoutWakeReason({
        previousStatus: existing.status,
        nextStatus: issue.status,
      });

      // Wake parent issue assignee when a child issue needs explicit closeout attention.
      if (parentWakeReason && issue.parentId) {
        try {
          const parent = await svc.getById(issue.parentId);
          const parentWake = buildParentIssueCloseoutWake({
            parentIssue: parent,
            childIssue: issue,
            closeoutReason: parentWakeReason,
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
          });
          if (parentWake && !wakeups.has(parentWake.agentId)) {
            wakeups.set(parentWake.agentId, parentWake.wakeup);
          }
        } catch (err) {
          logger.warn({ err, issueId: issue.id, parentId: issue.parentId }, parentWakeReason.logMessage);
        }
      }

      for (const [agentId, wakeup] of wakeups.entries()) {
        heartbeat
          .wakeup(agentId, wakeup)
          .catch((err) => logger.warn({ err, issueId: issue.id, agentId }, "failed to wake agent on issue update"));
      }
    })();

    res.json({ ...issue, comment });
  });

  router.delete("/issues/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const attachments = await svc.listAttachments(id);

    const issue = await svc.remove(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    for (const attachment of attachments) {
      try {
        await storage.deleteObject(attachment.companyId, attachment.objectKey);
      } catch (err) {
        logger.warn({ err, issueId: id, attachmentId: attachment.id }, "failed to delete attachment object during issue delete");
      }
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.deleted",
      entityType: "issue",
      entityId: issue.id,
    });

    res.json(issue);
  });

  router.post("/issues/:id/resume-chain", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    assertCompanyAccess(req, existing.companyId);

    const [issue] = await hydrateIssuesForResumeChain([existing]);
    const children = await svc
      .list(existing.companyId, { parentId: existing.id, includeHidden: false })
      .then((items) => hydrateIssuesForResumeChain(items as IssueRecord[]));
    const dispatch = await resolveIssueDispatchMode(existing, children);
    const selection = selectResumeChainTargets({
      issue,
      children,
      dispatchMode: dispatch.mode,
    });

    if (selection.targets.length === 0) {
      res.json({
        issueId: existing.id,
        dispatchMode: dispatch.mode,
        dispatchSource: dispatch.source,
        routineId: dispatch.routineId,
        decision: selection.decision,
        summary: selection.summary,
        targets: [],
        diagnostics: {
          issueActionable: isResumeChainActionable(issue),
          issueBlocker: summarizeResumeChainBlocker(issue),
          openChildCount: children.filter((child) => !child.runtimeState.lifecycle.isTerminal).length,
          actionableChildCount: children.filter((child) => isResumeChainActionable(child)).length,
        },
      });
      return;
    }

    const actor = getActorInfo(req);
    const wakeResults = await Promise.all(
      selection.targets.map(async (target) => {
        const run = await heartbeat.wakeup(target.assigneeAgentId!, {
          source: "on_demand",
          triggerDetail: "manual",
          reason: "issue_chain_resumed",
          payload: {
            issueId: target.id,
            sourceIssueId: existing.id,
            dispatchMode: dispatch.mode,
          },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: target.id,
            taskId: target.id,
            sourceIssueId: existing.id,
            dispatchMode: dispatch.mode,
            source: "issue.resume_chain",
            wakeReason: "issue_chain_resumed",
          },
        });

        const runId = run && typeof run === "object" && "id" in run && typeof run.id === "string"
          ? run.id
          : null;

        return {
          issueId: target.id,
          identifier: target.identifier ?? null,
          title: target.title,
          assigneeAgentId: target.assigneeAgentId,
          action: runId ? "woken" : "skipped",
          runId,
          reason: runId
            ? "Wakeup enqueued."
            : "Wakeup was skipped because a live or queued execution already exists.",
        };
      }),
    );

    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.chain_resumed",
      entityType: "issue",
      entityId: existing.id,
      details: {
        dispatchMode: dispatch.mode,
        dispatchSource: dispatch.source,
        decision: selection.decision,
        targetIssueIds: wakeResults.map((result) => result.issueId),
        wokenCount: wakeResults.filter((result) => result.action === "woken").length,
        skippedCount: wakeResults.filter((result) => result.action === "skipped").length,
      },
    });

    const wokenCount = wakeResults.filter((result) => result.action === "woken").length;
    const summary = wokenCount > 0
      ? selection.summary
      : `${selection.summary} No new run was enqueued because the selected target already had live execution.`;

    res.json({
      issueId: existing.id,
      dispatchMode: dispatch.mode,
      dispatchSource: dispatch.source,
      routineId: dispatch.routineId,
      decision: selection.decision,
      summary,
      targets: wakeResults,
      diagnostics: {
        issueActionable: isResumeChainActionable(issue),
        issueBlocker: summarizeResumeChainBlocker(issue),
        openChildCount: children.filter((child) => !child.runtimeState.lifecycle.isTerminal).length,
        actionableChildCount: children.filter((child) => isResumeChainActionable(child)).length,
      },
    });
  });

  router.post("/issues/:id/checkout", validate(checkoutIssueSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await assertAgentExecutionPlanAllowed(req, res, issue, "checkout"))) return;

    if (issue.projectId) {
      const project = await projectsSvc.getById(issue.projectId);
      if (project?.pausedAt) {
        res.status(409).json({
          error:
            project.pauseReason === "budget"
              ? "Project is paused because its budget hard-stop was reached"
              : "Project is paused",
        });
        return;
      }
    }

    if (req.actor.type === "agent" && req.actor.agentId !== req.body.agentId) {
      res.status(403).json({ error: "Agent can only checkout as itself" });
      return;
    }

    const closedExecutionWorkspace = await getClosedIssueExecutionWorkspace(issue);
    if (closedExecutionWorkspace) {
      respondClosedIssueExecutionWorkspace(res, closedExecutionWorkspace);
      return;
    }

    const checkoutRunId = requireAgentRunId(req, res);
    if (req.actor.type === "agent" && !checkoutRunId) return;
    const updated = await svc.checkout(id, req.body.agentId, req.body.expectedStatuses, checkoutRunId);
    const actor = getActorInfo(req);

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.checked_out",
      entityType: "issue",
      entityId: issue.id,
      details: {
        agentId: req.body.agentId,
        status: updated.status,
        source: "checkout",
        ...(updated.status !== issue.status ? { _previous: { status: issue.status } } : {}),
      },
    });

    if (
      shouldWakeAssigneeOnCheckout({
        actorType: req.actor.type,
        actorAgentId: req.actor.type === "agent" ? req.actor.agentId ?? null : null,
        checkoutAgentId: req.body.agentId,
        checkoutRunId,
      })
    ) {
      void heartbeat
        .wakeup(req.body.agentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_checked_out",
          payload: { issueId: issue.id, mutation: "checkout" },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: { issueId: issue.id, source: "issue.checkout" },
        })
        .catch((err) => logger.warn({ err, issueId: issue.id }, "failed to wake assignee on issue checkout"));
    }

    res.json(updated);
  });

  // ── Propose Plan ──────────────────────────────────────────────────────────
  router.post("/issues/:id/propose-plan", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    if (req.actor.type === "agent") {
      if (req.actor.agentId !== issue.assigneeAgentId) {
        res.status(403).json({ error: "Only the assigned agent can propose a plan" });
        return;
      }
      if (!(await assertAgentRunCheckoutOwnership(req, res, issue))) return;
    }

    const planText = typeof req.body?.plan === "string" ? req.body.plan.trim() : "";
    if (!planText) {
      res.status(400).json({ error: "Plan text is required" });
      return;
    }

    const actor = getActorInfo(req);
    const proposal = await svc.proposePlan(id, {
      planText,
      actor: {
        actorType: req.actor.type === "board" ? "board" : "agent",
        actorId: actor.actorId,
        agentId: actor.agentId ?? null,
        runId: actor.runId,
        userId: req.actor.type === "board" ? (req.actor.userId ?? actor.actorId) : null,
      },
    });
    const updated = proposal.issue;
    const comment = proposal.comment;
    const planApproval = proposal.approval;
    await runPlanProposalSideEffects({
      db,
      issueSvc: svc,
      agentsSvc,
      heartbeat,
      logActivity,
      issue,
      proposal: {
        commentId: comment.id,
        approvalId: planApproval.id,
      },
      planText,
      actor,
    });

    res.status(201).json({ issue: attachIssueRuntimeState(updated), comment, approvalId: planApproval.id });
  });

  // ── Approve Plan ──────────────────────────────────────────────────────────
  router.post("/issues/:id/approve-plan", async (req, res) => {
    const id = req.params.id;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    if (!issue.planProposedAt) {
      res.status(409).json({ error: "No plan has been proposed yet" });
      return;
    }
    if (issue.planApprovedAt) {
      res.status(409).json({ error: "Plan has already been approved" });
      return;
    }

    const executionAlreadyStarted = Boolean(
      issue.status === "in_progress"
      || issue.status === "done"
      || issue.status === "blocked"
      || issue.executionRunId
      || issue.checkoutRunId,
    );
    if (executionAlreadyStarted) {
      res.status(409).json({
        error: "Cannot approve a plan after execution has already started. Return the issue to review and rerun after approval.",
      });
      return;
    }
    if (!(await assertCanReviewPlan(req, res, issue, "approve"))) return;

    const approvalActor: ApprovalActor =
      req.actor.type === "agent" && req.actor.agentId
        ? { actorType: "agent", agentId: req.actor.agentId }
        : { actorType: "board", userId: req.actor.userId ?? "board" };
    const outcome = await svc.approvePlan(id, {
      ...approvalDecisionActor(approvalActor),
      decisionNote: "Plan approved via issue review",
    });
    const updated = outcome.issue;

    await runPlanReviewSideEffects({
      db,
      issueSvc: svc,
      agentsSvc,
      heartbeat,
      logActivity,
      issue,
      action: "approved",
      actor: getActorInfo(req),
    });

    res.json({ issue: attachIssueRuntimeState(updated) });
  });

  // ── Reject Plan ──────────────────────────────────────────────────────────
  router.post("/issues/:id/reject-plan", async (req, res) => {
    const id = req.params.id;
    const body = z.object({ feedback: z.string().min(1) }).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Missing or invalid feedback" });
      return;
    }
    const { feedback } = body.data;

    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    if (!issue.planProposedAt) {
      res.status(409).json({ error: "No plan has been proposed yet" });
      return;
    }
    if (issue.planApprovedAt) {
      res.status(409).json({ error: "Plan has already been approved" });
      return;
    }

    if (!(await assertCanReviewPlan(req, res, issue, "reject"))) return;

    const approvalActor: ApprovalActor =
      req.actor.type === "agent" && req.actor.agentId
        ? { actorType: "agent", agentId: req.actor.agentId }
        : { actorType: "board", userId: req.actor.userId ?? "board" };
    const outcome = await svc.rejectPlan(id, {
      ...approvalDecisionActor(approvalActor),
      decisionNote: feedback,
    });
    const updated = outcome.issue;

    await runPlanReviewSideEffects({
      db,
      issueSvc: svc,
      agentsSvc,
      heartbeat,
      logActivity,
      issue,
      action: "rejected",
      actor: getActorInfo(req),
      feedback,
    });

    res.json({ issue: attachIssueRuntimeState(updated) });
  });

  router.post("/issues/:id/release", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    if (!(await assertAgentRunCheckoutOwnership(req, res, existing))) return;
    const actorRunId = requireAgentRunId(req, res);
    if (req.actor.type === "agent" && !actorRunId) return;

    const actor = getActorInfo(req);
    const released = await svc.release(id, req.actor.type === "agent" ? req.actor.agentId : undefined, actorRunId, {
      actorType: actor.actorType === "agent" ? "agent" : "system",
      actorId: actor.actorId,
    });
    if (!released) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    await logActivity(db, {
      companyId: released.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.released",
      entityType: "issue",
      entityId: released.id,
      details: {
        status: released.status,
        source: "release",
        ...(released.status !== existing.status ? { _previous: { status: existing.status } } : {}),
      },
    });

    res.json(released);
  });

  router.get("/issues/:id/comments", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const afterCommentId =
      typeof req.query.after === "string" && req.query.after.trim().length > 0
        ? req.query.after.trim()
        : typeof req.query.afterCommentId === "string" && req.query.afterCommentId.trim().length > 0
          ? req.query.afterCommentId.trim()
          : null;
    const order =
      typeof req.query.order === "string" && req.query.order.trim().toLowerCase() === "asc"
        ? "asc"
        : "desc";
    const limitRaw =
      typeof req.query.limit === "string" && req.query.limit.trim().length > 0
        ? Number(req.query.limit)
        : null;
    const limit =
      limitRaw && Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(Math.floor(limitRaw), MAX_ISSUE_COMMENT_LIMIT)
        : null;
    const actor = getActorInfo(req);
    const previousDeltaActivity =
      afterCommentId
        ? await getLatestCommentDeltaActivity(issue.id)
        : null;

    try {
      const comments = await svc.listComments(id, {
        afterCommentId,
        order,
        limit,
      });

      if (afterCommentId) {
        const latestReturnedComment = order === "asc" ? (comments.at(-1) ?? null) : (comments[0] ?? null);
        await logActivity(db, {
          companyId: issue.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.comment_delta_read_succeeded",
          entityType: "issue",
          entityId: issue.id,
          details: {
            identifier: issue.identifier,
            afterCommentId,
            order,
            limit,
            returnedCount: comments.length,
            latestReturnedCommentId: latestReturnedComment?.id ?? null,
          },
        });

        if (previousDeltaActivity?.action === "issue.comment_delta_read_failed") {
          await logActivity(db, {
            companyId: issue.companyId,
            actorType: "system",
            actorId: "paperclip",
            agentId: actor.agentId,
            runId: actor.runId,
            action: "issue.platform_recovered",
            entityType: "issue",
            entityId: issue.id,
            details: {
              identifier: issue.identifier,
              recoveryKind: "comment_visibility_recovered",
              recoveredBy: "comment_delta_read",
              afterCommentId,
            },
          });
        }
      }

      res.json(comments);
    } catch (err) {
      if (afterCommentId) {
        await logActivity(db, {
          companyId: issue.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.comment_delta_read_failed",
          entityType: "issue",
          entityId: issue.id,
          details: {
            identifier: issue.identifier,
            afterCommentId,
            order,
            limit,
            error: err instanceof Error ? err.message : String(err),
          },
        }).catch((logErr) =>
          logger.warn({ err: logErr, issueId: issue.id }, "failed to log comment delta read failure"));
      }
      throw err;
    }
  });

  router.get("/issues/:id/comments/:commentId", async (req, res) => {
    const id = req.params.id as string;
    const commentId = req.params.commentId as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const comment = await svc.getComment(commentId);
    if (!comment || comment.issueId !== id) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }
    res.json(comment);
  });

  router.get("/issues/:id/feedback-votes", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can view feedback votes" });
      return;
    }

    const votes = await feedback.listIssueVotesForUser(id, req.actor.userId ?? "local-board");
    res.json(votes);
  });

  router.get("/issues/:id/feedback-traces", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can view feedback traces" });
      return;
    }

    const targetTypeRaw = typeof req.query.targetType === "string" ? req.query.targetType : undefined;
    const voteRaw = typeof req.query.vote === "string" ? req.query.vote : undefined;
    const statusRaw = typeof req.query.status === "string" ? req.query.status : undefined;
    const targetType = targetTypeRaw ? feedbackTargetTypeSchema.parse(targetTypeRaw) : undefined;
    const vote = voteRaw ? feedbackVoteValueSchema.parse(voteRaw) : undefined;
    const status = statusRaw ? feedbackTraceStatusSchema.parse(statusRaw) : undefined;

    const traces = await feedback.listFeedbackTraces({
      companyId: issue.companyId,
      issueId: issue.id,
      targetType,
      vote,
      status,
      from: parseDateQuery(req.query.from, "from"),
      to: parseDateQuery(req.query.to, "to"),
      sharedOnly: parseBooleanQuery(req.query.sharedOnly),
      includePayload: parseBooleanQuery(req.query.includePayload),
    });
    res.json(traces);
  });

  router.get("/feedback-traces/:traceId", async (req, res) => {
    const traceId = req.params.traceId as string;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can view feedback traces" });
      return;
    }
    const includePayload = parseBooleanQuery(req.query.includePayload) || req.query.includePayload === undefined;
    const trace = await feedback.getFeedbackTraceById(traceId, includePayload);
    if (!trace || !actorCanAccessCompany(req, trace.companyId)) {
      res.status(404).json({ error: "Feedback trace not found" });
      return;
    }
    res.json(trace);
  });

  router.get("/feedback-traces/:traceId/bundle", async (req, res) => {
    const traceId = req.params.traceId as string;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can view feedback trace bundles" });
      return;
    }
    const bundle = await feedback.getFeedbackTraceBundle(traceId);
    if (!bundle || !actorCanAccessCompany(req, bundle.companyId)) {
      res.status(404).json({ error: "Feedback trace not found" });
      return;
    }
    res.json(bundle);
  });

  router.post("/issues/:id/comments", validate(addIssueCommentSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await assertAgentRunCheckoutOwnership(req, res, issue))) return;
    const closedExecutionWorkspace = await getClosedIssueExecutionWorkspace(issue);
    if (closedExecutionWorkspace) {
      respondClosedIssueExecutionWorkspace(res, closedExecutionWorkspace);
      return;
    }

    const actor = getActorInfo(req);
    const reopenRequested = req.body.reopen === true;
    const interruptRequested = req.body.interrupt === true;
    const isClosed = issue.status === "done" || issue.status === "cancelled";
    let reopened = false;
    let reopenFromStatus: string | null = null;
    let interruptedRunId: string | null = null;
    let currentIssue = issue;

    if (reopenRequested && isClosed) {
      const reopenedIssue = await svc.update(id, { status: "todo" });
      if (!reopenedIssue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      reopened = true;
      reopenFromStatus = issue.status;
      currentIssue = reopenedIssue;

      await logActivity(db, {
        companyId: currentIssue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.updated",
        entityType: "issue",
        entityId: currentIssue.id,
        details: {
          status: "todo",
          reopened: true,
          reopenedFrom: reopenFromStatus,
          source: "comment",
          identifier: currentIssue.identifier,
        },
      });
    }

    if (interruptRequested) {
      if (req.actor.type !== "board") {
        res.status(403).json({ error: "Only board users can interrupt active runs from issue comments" });
        return;
      }

      const runToInterrupt = await resolveActiveIssueRun(currentIssue);
      if (runToInterrupt) {
        const cancelled = await heartbeat.cancelRun(runToInterrupt.id);
        if (cancelled) {
          interruptedRunId = cancelled.id;
          await logActivity(db, {
            companyId: cancelled.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "heartbeat.cancelled",
            entityType: "heartbeat_run",
            entityId: cancelled.id,
            details: { agentId: cancelled.agentId, source: "issue_comment_interrupt", issueId: currentIssue.id },
          });
        }
      }
    }

    const comment = await svc.addComment(id, req.body.body, {
      agentId: actor.agentId ?? undefined,
      userId: actor.actorType === "user" ? actor.actorId : undefined,
      runId: actor.runId,
      replyNeeded: req.body.replyNeeded,
    });

    if (actor.runId) {
      await heartbeat.reportRunActivity(actor.runId).catch((err) =>
        logger.warn({ err, runId: actor.runId }, "failed to clear detached run warning after issue comment"));
    }

    await logActivity(db, {
      companyId: currentIssue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.comment_added",
      entityType: "issue",
      entityId: currentIssue.id,
      details: {
        commentId: comment.id,
        bodySnippet: comment.body.slice(0, 120),
        identifier: currentIssue.identifier,
        issueTitle: currentIssue.title,
        ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus, source: "comment" } : {}),
        ...(interruptedRunId ? { interruptedRunId } : {}),
      },
    });

    // Merge all wakeups from this comment into one enqueue per agent to avoid duplicate runs.
    void (async () => {
      const wakeups = new Map<string, Parameters<typeof heartbeat.wakeup>[1]>();
      const assigneeId = currentIssue.assigneeAgentId;
      const actorIsAgent = actor.actorType === "agent";
      const selfComment = actorIsAgent && actor.actorId === assigneeId;
      const skipWake = selfComment || isClosed;
      if (assigneeId && (reopened || !skipWake)) {
        if (reopened) {
          wakeups.set(assigneeId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_reopened_via_comment",
            payload: {
              issueId: currentIssue.id,
              commentId: comment.id,
              reopenedFrom: reopenFromStatus,
              mutation: "comment",
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: currentIssue.id,
              taskId: currentIssue.id,
              commentId: comment.id,
              source: "issue.comment.reopen",
              wakeReason: "issue_reopened_via_comment",
              reopenedFrom: reopenFromStatus,
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
          });
        } else {
          wakeups.set(assigneeId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_commented",
            payload: {
              issueId: currentIssue.id,
              commentId: comment.id,
              mutation: "comment",
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: currentIssue.id,
              taskId: currentIssue.id,
              commentId: comment.id,
              source: "issue.comment",
              wakeReason: "issue_commented",
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
          });
        }
      }

      let mentionedIds: string[] = [];
      try {
        mentionedIds = await svc.findMentionedAgents(issue.companyId, req.body.body);
      } catch (err) {
        logger.warn({ err, issueId: id }, "failed to resolve @-mentions");
      }

      for (const mentionedId of mentionedIds) {
        if (wakeups.has(mentionedId)) continue;
        if (actorIsAgent && actor.actorId === mentionedId) continue;
        wakeups.set(mentionedId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_comment_mentioned",
          payload: { issueId: id, commentId: comment.id },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: id,
            taskId: id,
            commentId: comment.id,
            wakeCommentId: comment.id,
            wakeReason: "issue_comment_mentioned",
            source: "comment.mention",
          },
        });
      }

      for (const [agentId, wakeup] of wakeups.entries()) {
        heartbeat
          .wakeup(agentId, wakeup)
          .catch((err) => logger.warn({ err, issueId: currentIssue.id, agentId }, "failed to wake agent on issue comment"));
      }
    })();

    res.status(201).json(comment);
  });

  router.post("/issues/:id/feedback-votes", validate(upsertIssueFeedbackVoteSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can vote on AI feedback" });
      return;
    }

    const actor = getActorInfo(req);
    const result = await feedback.saveIssueVote({
      issueId: id,
      targetType: req.body.targetType,
      targetId: req.body.targetId,
      vote: req.body.vote,
      reason: req.body.reason,
      authorUserId: req.actor.userId ?? "local-board",
      allowSharing: req.body.allowSharing === true,
    });

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.feedback_vote_saved",
      entityType: "issue",
      entityId: issue.id,
      details: {
        identifier: issue.identifier,
        targetType: result.vote.targetType,
        targetId: result.vote.targetId,
        vote: result.vote.vote,
        hasReason: Boolean(result.vote.reason),
        sharingEnabled: result.sharingEnabled,
      },
    });

    if (result.consentEnabledNow) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.feedback_data_sharing_updated",
        entityType: "company",
        entityId: issue.companyId,
        details: {
          feedbackDataSharingEnabled: true,
          source: "issue_feedback_vote",
        },
      });
    }

    if (result.persistedSharingPreference) {
      const settings = await instanceSettings.get();
      const companyIds = await instanceSettings.listCompanyIds();
      await Promise.all(
        companyIds.map((companyId) =>
          logActivity(db, {
            companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "instance.settings.general_updated",
            entityType: "instance_settings",
            entityId: settings.id,
            details: {
              general: settings.general,
              changedKeys: ["feedbackDataSharingPreference"],
              source: "issue_feedback_vote",
            },
          }),
        ),
      );
    }

    if (result.sharingEnabled && result.traceId && feedbackExportService) {
      try {
        await feedbackExportService.flushPendingFeedbackTraces({
          companyId: issue.companyId,
          traceId: result.traceId,
          limit: 1,
        });
      } catch (err) {
        logger.warn({ err, issueId: issue.id, traceId: result.traceId }, "failed to flush shared feedback trace immediately");
      }
    }

    res.status(201).json(result.vote);
  });

  router.get("/issues/:id/attachments", async (req, res) => {
    const issueId = req.params.id as string;
    const issue = await svc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const attachments = await svc.listAttachments(issueId);
    res.json(attachments.map(withContentPath));
  });

  router.post("/companies/:companyId/issues/:issueId/attachments", async (req, res) => {
    const companyId = req.params.companyId as string;
    const issueId = req.params.issueId as string;
    assertCompanyAccess(req, companyId);
    const issue = await svc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (issue.companyId !== companyId) {
      res.status(422).json({ error: "Issue does not belong to company" });
      return;
    }
    if (!(await assertAgentExecutionPlanAllowed(req, res, issue, "uploading attachments"))) return;

    try {
      await runSingleFileUpload(req, res);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({ error: `Attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes` });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const file = (req as Request & { file?: { mimetype: string; buffer: Buffer; originalname: string } }).file;
    if (!file) {
      res.status(400).json({ error: "Missing file field 'file'" });
      return;
    }
    const contentType = (file.mimetype || "").toLowerCase();
    if (!isAllowedContentType(contentType)) {
      res.status(422).json({ error: `Unsupported attachment type: ${contentType || "unknown"}` });
      return;
    }
    if (file.buffer.length <= 0) {
      res.status(422).json({ error: "Attachment is empty" });
      return;
    }

    const parsedMeta = createIssueAttachmentMetadataSchema.safeParse(req.body ?? {});
    if (!parsedMeta.success) {
      res.status(400).json({ error: "Invalid attachment metadata", details: parsedMeta.error.issues });
      return;
    }

    const actor = getActorInfo(req);
    const stored = await storage.putFile({
      companyId,
      namespace: `issues/${issueId}`,
      originalFilename: file.originalname || null,
      contentType,
      body: file.buffer,
    });

    const attachment = await svc.createAttachment({
      issueId,
      issueCommentId: parsedMeta.data.issueCommentId ?? null,
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.attachment_added",
      entityType: "issue",
      entityId: issueId,
      details: {
        attachmentId: attachment.id,
        originalFilename: attachment.originalFilename,
        contentType: attachment.contentType,
        byteSize: attachment.byteSize,
      },
    });

    res.status(201).json(withContentPath(attachment));
  });

  router.get("/attachments/:attachmentId/content", async (req, res, next) => {
    const attachmentId = req.params.attachmentId as string;
    const attachment = await svc.getAttachmentById(attachmentId);
    if (!attachment) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    assertCompanyAccess(req, attachment.companyId);

    const object = await storage.getObject(attachment.companyId, attachment.objectKey);
    res.setHeader("Content-Type", attachment.contentType || object.contentType || "application/octet-stream");
    res.setHeader("Content-Length", String(attachment.byteSize || object.contentLength || 0));
    res.setHeader("Cache-Control", "private, max-age=60");
    const filename = attachment.originalFilename ?? "attachment";
    res.setHeader("Content-Disposition", `inline; filename=\"${filename.replaceAll("\"", "")}\"`);

    object.stream.on("error", (err) => {
      next(err);
    });
    object.stream.pipe(res);
  });

  router.delete("/attachments/:attachmentId", async (req, res) => {
    const attachmentId = req.params.attachmentId as string;
    const attachment = await svc.getAttachmentById(attachmentId);
    if (!attachment) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    assertCompanyAccess(req, attachment.companyId);
    const issue = await svc.getById(attachment.issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertAgentExecutionPlanAllowed(req, res, issue, "deleting attachments"))) return;

    try {
      await storage.deleteObject(attachment.companyId, attachment.objectKey);
    } catch (err) {
      logger.warn({ err, attachmentId }, "storage delete failed while removing attachment");
    }

    const removed = await svc.removeAttachment(attachmentId);
    if (!removed) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: removed.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.attachment_removed",
      entityType: "issue",
      entityId: removed.issueId,
      details: {
        attachmentId: removed.id,
      },
    });

    res.json({ ok: true });
  });

  return router;
}
