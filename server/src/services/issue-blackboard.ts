import { z } from "zod";
import type { Db } from "@paperclipai/db";
import {
  ISSUE_BLACKBOARD_MANIFEST_KEY,
  issueBlackboardChallengeMemoSchema,
  issueBlackboardEntryKeySchema,
  issueBlackboardEvidenceLedgerSchema,
  issueBlackboardManifestSchema,
  issueBlackboardOpenQuestionsSchema,
  issueBlackboardSourceMatrixSchema,
  type IssueBlackboardEntryKey,
  type IssueBlackboardEntryState,
  type IssueBlackboardManifest,
  type IssueBlackboardManifestState,
  type IssueBlackboardState,
  type IssueBlackboardTemplate,
  type IssueDocument,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { documentService } from "./documents.js";

type BlackboardEntryDefinition = {
  key: IssueBlackboardEntryKey;
  title: string;
  format: "markdown" | "json";
  required: boolean;
  description?: string | null;
  emptyContent: string | Record<string, unknown>;
};

export type IssueBlackboardSummaryEntry = {
  key: IssueBlackboardEntryKey;
  title: string;
  format: "markdown" | "json";
  required: boolean;
  status: "ready" | "missing" | "invalid";
  latestRevisionNumber: number | null;
  updatedAt: string | null;
};

export type IssueBlackboardSummary = {
  template: IssueBlackboardTemplate;
  manifestStatus: "ready" | "missing" | "invalid";
  isComplete: boolean;
  requiredReadyCount: number;
  requiredTotalCount: number;
  missingKeys: IssueBlackboardEntryKey[];
  invalidKeys: IssueBlackboardEntryKey[];
  entries: IssueBlackboardSummaryEntry[];
};

type PersistedIssueDocument = Omit<IssueDocument, "body" | "format"> & {
  body?: string;
  format: string;
};

const RESEARCH_V1_ENTRY_DEFINITIONS: BlackboardEntryDefinition[] = [
  {
    key: "original-request",
    title: "原始需求",
    format: "markdown",
    required: true,
    description: "记录用户原始题目、边界和交付预期。",
    emptyContent: "",
  },
  {
    key: "brief",
    title: "研究简报",
    format: "markdown",
    required: true,
    description: "记录当前问题定义、目标读者、成功标准和研究假设。",
    emptyContent: "",
  },
  {
    key: "clarification-log",
    title: "澄清记录",
    format: "markdown",
    required: true,
    description: "记录已向用户补问、已确认事实、显式假设和决策口径。",
    emptyContent: "",
  },
  {
    key: "source-matrix",
    title: "信息源矩阵",
    format: "json",
    required: true,
    description: "按题型声明必须覆盖的信息源与获取方式。",
    emptyContent: {
      version: 1,
      items: [],
    },
  },
  {
    key: "skeleton",
    title: "结论骨架",
    format: "markdown",
    required: true,
    description: "记录主结论骨架、主要论点和待挑战位置。",
    emptyContent: "",
  },
  {
    key: "evidence-ledger",
    title: "证据台账",
    format: "json",
    required: true,
    description: "沉淀最终被结论引用的证据片段与来源。",
    emptyContent: {
      version: 1,
      entries: [],
    },
  },
  {
    key: "open-questions",
    title: "待决问题",
    format: "json",
    required: false,
    description: "记录 fact/decision/scope/success 四类缺口。",
    emptyContent: {
      version: 1,
      items: [],
    },
  },
  {
    key: "challenge-memo",
    title: "挑战备忘",
    format: "json",
    required: false,
    description: "记录 Challenger 的反证、降强度建议和未决争议。",
    emptyContent: {
      version: 1,
      findings: [],
    },
  },
  {
    key: "audit-memo",
    title: "审校备忘",
    format: "markdown",
    required: false,
    description: "高风险题使用，记录证据审校和降强度依据。",
    emptyContent: "",
  },
  {
    key: "final-report",
    title: "正式报告",
    format: "markdown",
    required: true,
    description: "前台正式交付给用户的完整报告。",
    emptyContent: "",
  },
  {
    key: "action-memo",
    title: "行动摘要",
    format: "markdown",
    required: true,
    description: "面向执行的摘要、建议和下一步动作。",
    emptyContent: "",
  },
];

const structuredEntrySchemas: Record<string, z.ZodType<unknown>> = {
  "source-matrix": issueBlackboardSourceMatrixSchema,
  "evidence-ledger": issueBlackboardEvidenceLedgerSchema,
  "open-questions": issueBlackboardOpenQuestionsSchema,
  "challenge-memo": issueBlackboardChallengeMemoSchema,
};

function getEntryDefinitions(template: IssueBlackboardTemplate = "research_v1") {
  if (template !== "research_v1") {
    throw unprocessable("Unsupported blackboard template", { template });
  }
  return RESEARCH_V1_ENTRY_DEFINITIONS;
}

function getEntryDefinition(key: IssueBlackboardEntryKey, template: IssueBlackboardTemplate = "research_v1") {
  const definition = getEntryDefinitions(template).find((entry) => entry.key === key);
  if (!definition) {
    throw unprocessable("Unsupported blackboard entry key", { key, template });
  }
  return definition;
}

function serializeManifest(manifest: IssueBlackboardManifest) {
  const parsed = issueBlackboardManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    throw unprocessable("Invalid blackboard manifest", parsed.error.issues);
  }
  return JSON.stringify(parsed.data, null, 2);
}

function coerceIssueDocument(document: PersistedIssueDocument): IssueDocument {
  return {
    ...document,
    format: document.format === "json" ? "json" : "markdown",
    body: document.body ?? "",
  };
}

function parseStructuredEntry(key: IssueBlackboardEntryKey, body: string) {
  const schema = structuredEntrySchemas[key];
  if (!schema) return { ok: true as const, content: body };

  try {
    const decoded = JSON.parse(body);
    const parsed = schema.safeParse(decoded);
    if (!parsed.success) {
      return {
        ok: false as const,
        errors: parsed.error.issues.map((issue) => issue.message),
      };
    }
    return { ok: true as const, content: parsed.data };
  } catch (error) {
    return {
      ok: false as const,
      errors: [`Invalid JSON: ${error instanceof Error ? error.message : "unknown parse error"}`],
    };
  }
}

function resolveManifestState(
  manifestDocument: IssueDocument | null,
  fallbackTemplate: IssueBlackboardTemplate = "research_v1",
): IssueBlackboardManifestState {
  const fallback = buildDefaultIssueBlackboardManifest(fallbackTemplate);
  if (!manifestDocument) {
    return {
      status: "missing",
      key: ISSUE_BLACKBOARD_MANIFEST_KEY,
      content: fallback,
      document: null,
    };
  }
  if (manifestDocument.format !== "json") {
    return {
      status: "invalid",
      key: ISSUE_BLACKBOARD_MANIFEST_KEY,
      content: fallback,
      document: manifestDocument,
      errors: [`Expected format json but received ${manifestDocument.format}`],
    };
  }

  try {
    const decoded = JSON.parse(manifestDocument.body);
    const parsed = issueBlackboardManifestSchema.safeParse(decoded);
    if (!parsed.success) {
      return {
        status: "invalid",
        key: ISSUE_BLACKBOARD_MANIFEST_KEY,
        content: fallback,
        document: manifestDocument,
        errors: parsed.error.issues.map((issue) => issue.message),
      };
    }
    return {
      status: "ready",
      key: ISSUE_BLACKBOARD_MANIFEST_KEY,
      content: parsed.data,
      document: manifestDocument,
    };
  } catch (error) {
    return {
      status: "invalid",
      key: ISSUE_BLACKBOARD_MANIFEST_KEY,
      content: fallback,
      document: manifestDocument,
      errors: [`Invalid JSON: ${error instanceof Error ? error.message : "unknown parse error"}`],
    };
  }
}

export function buildDefaultIssueBlackboardManifest(
  template: IssueBlackboardTemplate = "research_v1",
): IssueBlackboardManifest {
  return {
    kind: "issue_blackboard",
    version: 1,
    template,
    entries: getEntryDefinitions(template).map((entry) => ({
      key: entry.key,
      title: entry.title,
      format: entry.format,
      required: entry.required,
      description: entry.description ?? null,
    })),
  };
}

export function serializeIssueBlackboardContent(
  key: IssueBlackboardEntryKey,
  content: unknown,
  template: IssueBlackboardTemplate = "research_v1",
) {
  const definition = getEntryDefinition(key, template);
  if (definition.format === "markdown") {
    if (typeof content !== "string") {
      throw unprocessable("Markdown blackboard entry requires string content", { key });
    }
    return {
      format: "markdown" as const,
      body: content,
    };
  }

  const parsed = structuredEntrySchemas[key]?.safeParse(content);
  if (!parsed?.success) {
    throw unprocessable("Invalid blackboard entry content", {
      key,
      details: parsed?.error.issues ?? [],
    });
  }

  return {
    format: "json" as const,
    body: JSON.stringify(parsed.data, null, 2),
  };
}

export function deriveIssueBlackboardState(input: {
  manifestDocument: IssueDocument | null;
  documents: IssueDocument[];
  fallbackTemplate?: IssueBlackboardTemplate;
}): IssueBlackboardState {
  const manifest = resolveManifestState(input.manifestDocument, input.fallbackTemplate ?? "research_v1");
  const docsByKey = new Map(input.documents.map((document) => [document.key, document]));

  const entries: IssueBlackboardEntryState[] = manifest.content.entries.map((entry) => {
    const document = docsByKey.get(entry.key) ?? null;
    if (!document) {
      return {
        key: entry.key,
        title: entry.title,
        format: entry.format,
        required: entry.required,
        status: "missing",
        content: null,
        document: null,
      };
    }

    if (document.format !== entry.format) {
      return {
        key: entry.key,
        title: entry.title,
        format: entry.format,
        required: entry.required,
        status: "invalid",
        content: null,
        document,
        errors: [`Expected format ${entry.format} but received ${document.format}`],
      };
    }

    if (entry.format === "markdown") {
      const body = document.body.trim();
      if (!body) {
        return {
          key: entry.key,
          title: entry.title,
          format: entry.format,
          required: entry.required,
          status: "missing",
          content: "",
          document,
        };
      }
      return {
        key: entry.key,
        title: entry.title,
        format: entry.format,
        required: entry.required,
        status: "ready",
        content: document.body,
        document,
      };
    }

    const parsed = parseStructuredEntry(entry.key, document.body);
    if (!parsed.ok) {
      return {
        key: entry.key,
        title: entry.title,
        format: entry.format,
        required: entry.required,
        status: "invalid",
        content: null,
        document,
        errors: parsed.errors,
      };
    }

    return {
      key: entry.key,
      title: entry.title,
      format: entry.format,
      required: entry.required,
      status: "ready",
      content: parsed.content,
      document,
    };
  });

  const missingKeys = entries.filter((entry) => entry.required && entry.status === "missing").map((entry) => entry.key);
  const hasInvalidEntries = entries.some((entry) => entry.status === "invalid");

  return {
    manifest,
    entries,
    missingKeys,
    isComplete: manifest.status === "ready" && missingKeys.length === 0 && !hasInvalidEntries,
  };
}

export function summarizeIssueBlackboardState(state: IssueBlackboardState): IssueBlackboardSummary {
  const entries = state.entries.map((entry) => ({
    key: entry.key,
    title: entry.title,
    format: entry.format,
    required: entry.required,
    status: entry.status,
    latestRevisionNumber: entry.document?.latestRevisionNumber ?? null,
    updatedAt: entry.document?.updatedAt?.toISOString?.() ?? null,
  }));
  const requiredEntries = entries.filter((entry) => entry.required);

  return {
    template: state.manifest.content.template,
    manifestStatus: state.manifest.status,
    isComplete: state.isComplete,
    requiredReadyCount: requiredEntries.filter((entry) => entry.status === "ready").length,
    requiredTotalCount: requiredEntries.length,
    missingKeys: [...state.missingKeys],
    invalidKeys: entries.filter((entry) => entry.status === "invalid").map((entry) => entry.key),
    entries,
  };
}

export function issueBlackboardService(db: Db) {
  const documentsSvc = documentService(db);

  async function getIssueBlackboard(issueId: string) {
    const documents = (await documentsSvc.listIssueDocuments(issueId)).map((document) =>
      coerceIssueDocument(document as PersistedIssueDocument),
    );
    const manifestDocument = documents.find((document) => document.key === ISSUE_BLACKBOARD_MANIFEST_KEY) ?? null;
    return deriveIssueBlackboardState({
      manifestDocument,
      documents: documents.filter((document) => document.key !== ISSUE_BLACKBOARD_MANIFEST_KEY),
    });
  }

  async function getIssueBlackboardEntry(issueId: string, key: IssueBlackboardEntryKey) {
    const state = await getIssueBlackboard(issueId);
    const entry = state.entries.find((item) => item.key === key) ?? null;
    if (!entry) {
      throw notFound("Blackboard entry not found");
    }
    return entry;
  }

  async function getIssueBlackboardSummary(issueId: string) {
    const state = await getIssueBlackboard(issueId);
    return summarizeIssueBlackboardState(state);
  }

  async function bootstrapIssueBlackboard(input: {
    issueId: string;
    template?: IssueBlackboardTemplate;
    createdByAgentId?: string | null;
    createdByUserId?: string | null;
    createdByRunId?: string | null;
  }) {
    const template = input.template ?? "research_v1";
    const manifest = buildDefaultIssueBlackboardManifest(template);
    const existingDocuments = (await documentsSvc.listIssueDocuments(input.issueId)).map((document) =>
      coerceIssueDocument(document as PersistedIssueDocument),
    );
    const docsByKey = new Map(existingDocuments.map((document) => [document.key, document]));
    const manifestDocument = docsByKey.get(ISSUE_BLACKBOARD_MANIFEST_KEY) ?? null;
    const serializedManifest = serializeManifest(manifest);

    let shouldRewriteManifest = !manifestDocument;
    if (manifestDocument && manifestDocument.format === "json") {
      try {
        const parsed = issueBlackboardManifestSchema.safeParse(JSON.parse(manifestDocument.body));
        shouldRewriteManifest =
          !parsed.success ||
          JSON.stringify(parsed.data.entries) !== JSON.stringify(manifest.entries) ||
          parsed.data.template !== manifest.template;
      } catch {
        shouldRewriteManifest = true;
      }
    }

    if (shouldRewriteManifest) {
      await documentsSvc.upsertIssueDocument({
        issueId: input.issueId,
        key: ISSUE_BLACKBOARD_MANIFEST_KEY,
        title: "黑板清单",
        format: "json",
        body: serializedManifest,
        changeSummary: manifestDocument ? "Repair blackboard manifest" : "Bootstrap blackboard manifest",
        baseRevisionId: manifestDocument?.latestRevisionId ?? null,
        createdByAgentId: input.createdByAgentId ?? null,
        createdByUserId: input.createdByUserId ?? null,
        createdByRunId: input.createdByRunId ?? null,
      });
    }

    for (const entry of getEntryDefinitions(template)) {
      if (docsByKey.has(entry.key)) continue;
      const serialized = serializeIssueBlackboardContent(entry.key, entry.emptyContent, template);
      await documentsSvc.upsertIssueDocument({
        issueId: input.issueId,
        key: entry.key,
        title: entry.title,
        format: serialized.format,
        body: serialized.body,
        changeSummary: "Bootstrap blackboard entry",
        createdByAgentId: input.createdByAgentId ?? null,
        createdByUserId: input.createdByUserId ?? null,
        createdByRunId: input.createdByRunId ?? null,
      });
    }

    return getIssueBlackboard(input.issueId);
  }

  async function upsertIssueBlackboardEntry(input: {
    issueId: string;
    key: IssueBlackboardEntryKey;
    content: unknown;
    changeSummary?: string | null;
    baseRevisionId?: string | null;
    createdByAgentId?: string | null;
    createdByUserId?: string | null;
    createdByRunId?: string | null;
  }) {
    const keyParsed = issueBlackboardEntryKeySchema.safeParse(input.key);
    if (!keyParsed.success) {
      throw unprocessable("Invalid blackboard entry key", keyParsed.error.issues);
    }

    const definition = getEntryDefinition(keyParsed.data);
    const serialized = serializeIssueBlackboardContent(keyParsed.data, input.content);
    const result = await documentsSvc.upsertIssueDocument({
      issueId: input.issueId,
      key: keyParsed.data,
      title: definition.title,
      format: serialized.format,
      body: serialized.body,
      changeSummary: input.changeSummary ?? null,
      baseRevisionId: input.baseRevisionId ?? null,
      createdByAgentId: input.createdByAgentId ?? null,
      createdByUserId: input.createdByUserId ?? null,
      createdByRunId: input.createdByRunId ?? null,
    });

    const entry = await getIssueBlackboardEntry(input.issueId, keyParsed.data);
    return {
      ...entry,
      document: result.document,
    };
  }

  return {
    getIssueBlackboard,
    getIssueBlackboardEntry,
    getIssueBlackboardSummary,
    bootstrapIssueBlackboard,
    upsertIssueBlackboardEntry,
  };
}
