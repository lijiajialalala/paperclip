import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ensureJournalMatchesFiles, ensureNoDuplicates, ensureStrictlyOrdered } from "./migration-numbering.js";

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));
const journalPath = fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url));

type JournalFile = {
  entries?: Array<{
    idx?: number;
    tag?: string;
  }>;
};

async function main() {
  const migrationFiles = (await readdir(migrationsDir))
    .filter((entry) => entry.endsWith(".sql"))
    .sort();

  ensureNoDuplicates(migrationFiles, "migration files");
  ensureStrictlyOrdered(migrationFiles, "migration files");

  const rawJournal = await readFile(journalPath, "utf8");
  const journal = JSON.parse(rawJournal) as JournalFile;
  const journalTags = (journal.entries ?? [])
    .map((entry, index) => {
      if (typeof entry.tag !== "string" || entry.tag.length === 0) {
        throw new Error(`Migration journal entry ${index} is missing a tag`);
      }
      return entry.tag;
    });

  ensureNoDuplicates(journalTags, "migration journal");
  ensureStrictlyOrdered(journalTags, "migration journal");
  ensureJournalMatchesFiles(migrationFiles, journalTags);
}

try {
  await main();
} catch (error) {
  if (error instanceof Error) {
    throw new Error(
      `${error.message}\nRun 'pnpm --filter @paperclipai/db run renumber:migrations' to normalize migration numbers and _journal.json before merging.`,
    );
  }
  throw error;
}
