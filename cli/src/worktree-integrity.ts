import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

export type WorktreeIntegrityIssueCode =
  | "rollup_native_unavailable"
  | "lucide_package_missing"
  | "lucide_entry_missing"
  | "lucide_import_missing";

export type WorktreeIntegrityIssue = {
  code: WorktreeIntegrityIssueCode;
  summary: string;
  detail: string;
};

function resolvePackageJson(cwd: string, packageName: string): string | null {
  const packageSegments = [...packageName.split("/"), "package.json"];
  const directNodeModulesPath = path.join(path.resolve(cwd), "node_modules", ...packageSegments);
  if (fs.existsSync(directNodeModulesPath)) {
    return directNodeModulesPath;
  }

  const pnpmDir = path.join(path.resolve(cwd), ".pnpm");
  if (!fs.existsSync(pnpmDir)) {
    return null;
  }

  for (const entry of fs.readdirSync(pnpmDir)) {
    const candidatePath = path.join(pnpmDir, entry, "node_modules", ...packageSegments);
    if (fs.existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  return null;
}

function findRollupNativeIssue(cwd: string): WorktreeIntegrityIssue | null {
  const packageJsonPath = resolvePackageJson(cwd, "rollup");
  if (!packageJsonPath) {
    return {
      code: "rollup_native_unavailable",
      summary: "Rollup native optional dependency is missing or unreadable.",
      detail: "Could not resolve rollup/package.json from the worktree install.",
    };
  }

  const requireFromPackage = createRequire(packageJsonPath);

  try {
    requireFromPackage("./dist/native.js");
    return null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      code: "rollup_native_unavailable",
      summary: "Rollup native optional dependency is missing or unreadable.",
      detail,
    };
  }
}

function collectLucideImports(entrySource: string): string[] {
  const imports = new Set<string>();
  const pattern = /from\s+["'](\.\/icons\/[^"']+\.js)["']/g;

  for (const match of entrySource.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier) {
      imports.add(specifier);
    }
  }

  return [...imports];
}

function findLucideIssue(cwd: string): WorktreeIntegrityIssue | null {
  const packageJsonPath = resolvePackageJson(cwd, "lucide-react");
  if (!packageJsonPath) {
    return {
      code: "lucide_package_missing",
      summary: "lucide-react is missing from this worktree install.",
      detail: "Could not resolve lucide-react/package.json from the repository root.",
    };
  }

  const packageDir = path.dirname(packageJsonPath);
  const entryPath = path.join(packageDir, "dist", "esm", "lucide-react.js");
  if (!fs.existsSync(entryPath)) {
    return {
      code: "lucide_entry_missing",
      summary: "lucide-react install is incomplete.",
      detail: `Missing entry file: ${entryPath}`,
    };
  }

  const entrySource = fs.readFileSync(entryPath, "utf8");
  const entryDir = path.dirname(entryPath);
  const missingImports = collectLucideImports(entrySource)
    .filter((specifier) => !fs.existsSync(path.resolve(entryDir, specifier)))
    .sort();

  if (missingImports.length === 0) {
    return null;
  }

  const sample = missingImports.slice(0, 5).join(", ");
  return {
    code: "lucide_import_missing",
    summary: "lucide-react install is missing generated icon modules.",
    detail:
      missingImports.length > 5
        ? `${sample} and ${missingImports.length - 5} more`
        : sample,
  };
}

export function findWorktreeIntegrityIssues(cwd: string): WorktreeIntegrityIssue[] {
  const issues = [findRollupNativeIssue(cwd), findLucideIssue(cwd)];
  return issues.filter((issue): issue is WorktreeIntegrityIssue => issue !== null);
}

export function formatWorktreeIntegrityIssues(issues: readonly WorktreeIntegrityIssue[]): string {
  return issues.map((issue) => `- [${issue.code}] ${issue.summary} ${issue.detail}`).join("\n");
}
