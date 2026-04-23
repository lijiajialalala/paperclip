import { describe, expect, it } from "vitest";
import {
  coerceIssueBlackboardTemplate,
  resolveIssueBlackboardTemplate,
} from "./issue-blackboard-template";

describe("issue blackboard template helpers", () => {
  it("accepts known blackboard templates", () => {
    expect(coerceIssueBlackboardTemplate("research_v1")).toBe("research_v1");
  });

  it("drops unknown blackboard templates", () => {
    expect(coerceIssueBlackboardTemplate("legacy-template")).toBe("");
    expect(coerceIssueBlackboardTemplate(null)).toBe("");
  });

  it("prefers explicit defaults over a saved draft", () => {
    expect(
      resolveIssueBlackboardTemplate({
        defaultTemplate: "research_v1",
        draftTemplate: "",
      }),
    ).toBe("research_v1");
  });

  it("falls back to the saved draft when defaults omit the template", () => {
    expect(
      resolveIssueBlackboardTemplate({
        defaultTemplate: undefined,
        draftTemplate: "research_v1",
      }),
    ).toBe("research_v1");
  });

  it("returns empty when neither defaults nor draft carry a valid template", () => {
    expect(
      resolveIssueBlackboardTemplate({
        defaultTemplate: "invalid-template",
        draftTemplate: "legacy-template",
      }),
    ).toBe("");
  });
});
