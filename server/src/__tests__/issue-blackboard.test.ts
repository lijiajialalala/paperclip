import { describe, expect, it } from "vitest";
import {
  buildDefaultIssueBlackboardManifest,
  deriveIssueBlackboardState,
  serializeIssueBlackboardContent,
} from "../services/issue-blackboard.js";

describe("issue blackboard helpers", () => {
  it("builds the default research blackboard manifest with structured defaults", () => {
    const manifest = buildDefaultIssueBlackboardManifest();

    expect(manifest).toEqual(
      expect.objectContaining({
        kind: "issue_blackboard",
        version: 1,
        template: "research_v1",
      }),
    );

    expect(manifest.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "original-request",
          format: "markdown",
          required: true,
        }),
        expect.objectContaining({
          key: "clarification-log",
          format: "markdown",
          required: true,
        }),
        expect.objectContaining({
          key: "source-matrix",
          format: "json",
          required: true,
        }),
        expect.objectContaining({
          key: "skeleton",
          format: "markdown",
          required: true,
        }),
        expect.objectContaining({
          key: "evidence-ledger",
          format: "json",
          required: true,
        }),
        expect.objectContaining({
          key: "audit-memo",
          format: "markdown",
          required: false,
        }),
        expect.objectContaining({
          key: "final-report",
          format: "markdown",
          required: true,
        }),
      ]),
    );
  });

  it("marks required entries as missing when no blackboard docs exist", () => {
    const state = deriveIssueBlackboardState({
      manifestDocument: null,
      documents: [],
    });

    expect(state.manifest.status).toBe("missing");
    expect(state.isComplete).toBe(false);
    expect(state.missingKeys).toContain("source-matrix");
    expect(state.missingKeys).toContain("clarification-log");
    expect(state.missingKeys).toContain("skeleton");
    expect(state.entries.find((entry) => entry.key === "brief")?.status).toBe("missing");
  });

  it("parses valid structured evidence ledger entries", () => {
    const evidenceDoc = {
      id: "doc-evidence",
      companyId: "company-1",
      issueId: "issue-1",
      key: "evidence-ledger",
      title: "证据台账",
      format: "json",
      body: JSON.stringify({
        version: 1,
        entries: [
          {
            sourceId: "source-1",
            kind: "official_fact",
            summary: "官方能力页确认该功能已上线。",
            acquisitionMethod: "documentation-lookup",
            usedIn: ["40-final-report"],
          },
        ],
      }),
      latestRevisionId: "rev-1",
      latestRevisionNumber: 1,
      createdByAgentId: null,
      createdByUserId: "board-user",
      updatedByAgentId: null,
      updatedByUserId: "board-user",
      createdAt: new Date("2026-04-22T10:00:00.000Z"),
      updatedAt: new Date("2026-04-22T10:00:00.000Z"),
    };

    const state = deriveIssueBlackboardState({
      manifestDocument: null,
      documents: [evidenceDoc],
    });

    const entry = state.entries.find((item) => item.key === "evidence-ledger");
    expect(entry?.status).toBe("ready");
    expect(entry?.content).toEqual({
      version: 1,
      entries: [
        expect.objectContaining({
          sourceId: "source-1",
          kind: "official_fact",
          acquisitionMethod: "documentation-lookup",
        }),
      ],
    });
  });

  it("marks entries invalid when the stored format does not match the blackboard contract", () => {
    const state = deriveIssueBlackboardState({
      manifestDocument: null,
      documents: [
        {
          id: "doc-evidence",
          companyId: "company-1",
          issueId: "issue-1",
          key: "evidence-ledger",
          title: "证据台账",
          format: "markdown",
          body: "# wrong format",
          latestRevisionId: "rev-1",
          latestRevisionNumber: 1,
          createdByAgentId: null,
          createdByUserId: "board-user",
          updatedByAgentId: null,
          updatedByUserId: "board-user",
          createdAt: new Date("2026-04-22T10:00:00.000Z"),
          updatedAt: new Date("2026-04-22T10:00:00.000Z"),
        },
      ],
    });

    const entry = state.entries.find((item) => item.key === "evidence-ledger");
    expect(entry?.status).toBe("invalid");
    expect(entry?.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("Expected format json")]),
    );
    expect(state.isComplete).toBe(false);
  });

  it("serializes structured content into persisted json documents", () => {
    const serialized = serializeIssueBlackboardContent("source-matrix", {
      version: 1,
      items: [
        {
          question: "当前最值得优先验证的切入口是什么？",
          sourceType: "market_web",
          acquisitionMethod: "exa-search",
          required: true,
        },
      ],
    });

    expect(serialized.format).toBe("json");
    expect(JSON.parse(serialized.body)).toEqual({
      version: 1,
      items: [
        expect.objectContaining({
          question: "当前最值得优先验证的切入口是什么？",
          sourceType: "market_web",
        }),
      ],
    });
  });
});
