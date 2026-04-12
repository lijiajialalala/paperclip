import { describe, expect, it } from "vitest";
import { buildMigrationNormalizationPlan } from "./migration-numbering.js";

describe("buildMigrationNormalizationPlan", () => {
  it("renumbers a duplicate tail migration into the next free slot", () => {
    const plan = buildMigrationNormalizationPlan({
      migrationFiles: ["0000_init.sql", "0001_clever_shadowcat.sql", "0001_fancy_moondragon.sql"],
      journalEntries: [
        { idx: 0, tag: "0000_init", version: "7" },
        { idx: 1, tag: "0001_clever_shadowcat", version: "7" },
        { idx: 1, tag: "0001_fancy_moondragon", version: "7" },
      ],
    });

    expect(plan.fileRenames).toEqual([
      {
        from: "0001_fancy_moondragon.sql",
        to: "0002_fancy_moondragon.sql",
      },
    ]);
    expect(plan.normalizedJournalEntries.map((entry) => entry.tag)).toEqual([
      "0000_init",
      "0001_clever_shadowcat",
      "0002_fancy_moondragon",
    ]);
  });

  it("renumbers gap-based tails and their snapshots", () => {
    const plan = buildMigrationNormalizationPlan({
      migrationFiles: ["0000_init.sql", "0001_issue_plan_approval.sql", "0003_add_reply_needed.sql"],
      journalEntries: [
        { idx: 0, tag: "0000_init", version: "7" },
        { idx: 1, tag: "0001_issue_plan_approval", version: "7" },
        { idx: 3, tag: "0003_add_reply_needed", version: "7" },
      ],
      snapshotFiles: ["0003_snapshot.json"],
    });

    expect(plan.fileRenames).toEqual([
      {
        from: "0003_add_reply_needed.sql",
        to: "0002_add_reply_needed.sql",
      },
    ]);
    expect(plan.snapshotRenames).toEqual([
      {
        from: "0003_snapshot.json",
        to: "0002_snapshot.json",
      },
    ]);
    expect(plan.normalizedJournalEntries[2]).toMatchObject({
      idx: 2,
      tag: "0002_add_reply_needed",
    });
  });

  it("warns instead of renaming an ambiguous duplicate snapshot", () => {
    const plan = buildMigrationNormalizationPlan({
      migrationFiles: ["0000_init.sql", "0001_alpha.sql", "0001_beta.sql"],
      journalEntries: [
        { idx: 0, tag: "0000_init", version: "7" },
        { idx: 1, tag: "0001_alpha", version: "7" },
        { idx: 1, tag: "0001_beta", version: "7" },
      ],
      snapshotFiles: ["0001_snapshot.json"],
    });

    expect(plan.snapshotRenames).toEqual([]);
    expect(plan.warnings).toEqual(["Skipped snapshot rename for 0001_snapshot.json because multiple migrations shared 0001."]);
  });
});
