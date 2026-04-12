import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMigrationNormalizationPlan, type JournalEntry } from "./migration-numbering.js";

type JournalFile = {
  entries?: JournalEntry[];
  [key: string]: unknown;
};

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));
const metaDir = fileURLToPath(new URL("./migrations/meta", import.meta.url));
const journalPath = fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url));

async function renameWithTemporaryStaging(baseDir: string, renames: Array<{ from: string; to: string }>) {
  const staged = renames.filter((renameEntry) => renameEntry.from !== renameEntry.to);
  const temporaryNames = new Map<string, string>();

  for (const renameEntry of staged) {
    const temporaryName = `${renameEntry.from}.renumbering-tmp`;
    temporaryNames.set(renameEntry.from, temporaryName);
    await rename(path.join(baseDir, renameEntry.from), path.join(baseDir, temporaryName));
  }

  for (const renameEntry of staged) {
    const temporaryName = temporaryNames.get(renameEntry.from);
    if (!temporaryName) continue;
    await rename(path.join(baseDir, temporaryName), path.join(baseDir, renameEntry.to));
  }
}

async function main() {
  const migrationFiles = (await readdir(migrationsDir))
    .filter((entry) => entry.endsWith(".sql"))
    .sort();
  const snapshotFiles = (await readdir(metaDir))
    .filter((entry) => entry.endsWith("_snapshot.json"))
    .sort();
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as JournalFile;

  const plan = buildMigrationNormalizationPlan({
    migrationFiles,
    journalEntries: journal.entries ?? [],
    snapshotFiles,
  });

  if (
    plan.fileRenames.length === 0 &&
    plan.snapshotRenames.length === 0 &&
    JSON.stringify(journal.entries ?? []) === JSON.stringify(plan.normalizedJournalEntries)
  ) {
    console.log("[paperclip/db] migration numbering already normalized.");
    return;
  }

  await renameWithTemporaryStaging(migrationsDir, plan.fileRenames);
  await renameWithTemporaryStaging(metaDir, plan.snapshotRenames);
  await writeFile(
    journalPath,
    `${JSON.stringify(
      {
        ...journal,
        entries: plan.normalizedJournalEntries,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  for (const renameEntry of plan.fileRenames) {
    console.log(`[paperclip/db] renamed ${renameEntry.from} -> ${renameEntry.to}`);
  }
  for (const renameEntry of plan.snapshotRenames) {
    console.log(`[paperclip/db] renamed ${renameEntry.from} -> ${renameEntry.to}`);
  }
  for (const warning of plan.warnings) {
    console.warn(`[paperclip/db] ${warning}`);
  }
}

await main();
