import { describe, expect, it } from "vitest";
import { createIssueSchema, updateIssueSchema } from "./issue.js";

describe("issue validators", () => {
  it("rejects in_review for newly created issues", () => {
    const result = createIssueSchema.safeParse({
      title: "Runtime axis migration",
      status: "in_review",
    });

    expect(result.success).toBe(false);
  });

  it("rejects in_review for issue updates", () => {
    const result = updateIssueSchema.safeParse({
      status: "in_review",
    });

    expect(result.success).toBe(false);
  });
});
