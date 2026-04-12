export type JournalEntry = {
  idx?: number;
  tag?: string;
  [key: string]: unknown;
};

export type MigrationRename = {
  from: string;
  to: string;
};

export type MigrationNormalizationPlan = {
  normalizedFiles: string[];
  normalizedJournalEntries: JournalEntry[];
  fileRenames: MigrationRename[];
  snapshotRenames: MigrationRename[];
  warnings: string[];
};

function zeroPadMigrationNumber(value: number): string {
  return String(value).padStart(4, "0");
}

export function migrationNumber(value: string): string | null {
  const match = value.match(/^(\d{4})_/);
  return match ? match[1] : null;
}

export function ensureNoDuplicates(values: string[], label: string) {
  const seen = new Map<string, string>();

  for (const value of values) {
    const number = migrationNumber(value);
    if (!number) {
      throw new Error(`${label} entry does not start with a 4-digit migration number: ${value}`);
    }
    const existing = seen.get(number);
    if (existing) {
      throw new Error(`Duplicate migration number ${number} in ${label}: ${existing}, ${value}`);
    }
    seen.set(number, value);
  }
}

export function ensureStrictlyOrdered(values: string[], label: string) {
  const sorted = [...values].sort();
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] !== sorted[index]) {
      throw new Error(
        `${label} are out of order at position ${index}: expected ${sorted[index]}, found ${values[index]}`,
      );
    }
  }
}

export function ensureJournalMatchesFiles(migrationFiles: string[], journalTags: string[]) {
  const journalFiles = journalTags.map((tag) => `${tag}.sql`);

  if (journalFiles.length !== migrationFiles.length) {
    throw new Error(
      `Migration journal/file count mismatch: journal has ${journalFiles.length}, files have ${migrationFiles.length}`,
    );
  }

  for (let index = 0; index < migrationFiles.length; index += 1) {
    const migrationFile = migrationFiles[index];
    const journalFile = journalFiles[index];
    if (migrationFile !== journalFile) {
      throw new Error(
        `Migration journal/file order mismatch at position ${index}: journal has ${journalFile}, files have ${migrationFile}`,
      );
    }
  }
}

function normalizeMigrationFileName(fileName: string, index: number): string {
  return `${zeroPadMigrationNumber(index)}_${fileName.replace(/^\d{4}_/, "")}`;
}

function migrationTag(fileName: string): string {
  return fileName.replace(/\.sql$/, "");
}

export function buildMigrationNormalizationPlan(input: {
  migrationFiles: string[];
  journalEntries: JournalEntry[];
  snapshotFiles?: string[];
}): MigrationNormalizationPlan {
  const sortedFiles = [...input.migrationFiles].sort();
  const normalizedFiles = sortedFiles.map((fileName, index) => normalizeMigrationFileName(fileName, index));

  if (input.journalEntries.length !== sortedFiles.length) {
    throw new Error(
      `Cannot normalize migration journal with ${input.journalEntries.length} entries for ${sortedFiles.length} migration files.`,
    );
  }

  const fileRenames = sortedFiles
    .map((fileName, index) => ({
      from: fileName,
      to: normalizedFiles[index]!,
    }))
    .filter((rename) => rename.from !== rename.to);

  const normalizedJournalEntries = input.journalEntries.map((entry, index) => ({
    ...entry,
    idx: index,
    tag: migrationTag(normalizedFiles[index]!),
  }));

  const warnings: string[] = [];
  const snapshotFiles = new Set(input.snapshotFiles ?? []);
  const oldNumberCounts = new Map<string, number>();
  for (const fileName of sortedFiles) {
    const number = migrationNumber(fileName);
    if (!number) continue;
    oldNumberCounts.set(number, (oldNumberCounts.get(number) ?? 0) + 1);
  }

  const snapshotRenames: MigrationRename[] = [];
  for (const rename of fileRenames) {
    const oldNumber = migrationNumber(rename.from);
    const newNumber = migrationNumber(rename.to);
    if (!oldNumber || !newNumber || oldNumber === newNumber) {
      continue;
    }
    if ((oldNumberCounts.get(oldNumber) ?? 0) > 1) {
      warnings.push(`Skipped snapshot rename for ${oldNumber}_snapshot.json because multiple migrations shared ${oldNumber}.`);
      continue;
    }

    const oldSnapshot = `${oldNumber}_snapshot.json`;
    if (!snapshotFiles.has(oldSnapshot)) {
      continue;
    }

    const newSnapshot = `${newNumber}_snapshot.json`;
    if (oldSnapshot === newSnapshot) {
      continue;
    }
    if (snapshotFiles.has(newSnapshot)) {
      warnings.push(`Skipped snapshot rename from ${oldSnapshot} to ${newSnapshot} because the target already exists.`);
      continue;
    }

    snapshotRenames.push({
      from: oldSnapshot,
      to: newSnapshot,
    });
  }

  return {
    normalizedFiles,
    normalizedJournalEntries,
    fileRenames,
    snapshotRenames,
    warnings,
  };
}
