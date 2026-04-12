import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findWorktreeIntegrityIssues, formatWorktreeIntegrityIssues } from "../worktree-integrity.js";

const tempRoots: string[] = [];
const fixtureRollupNativePackage = "@rollup/fixture-missing-native";

function createFixtureRoot() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-worktree-integrity-"));
  tempRoots.push(tempRoot);
  fs.writeFileSync(path.join(tempRoot, "package.json"), "{}\n", "utf8");
  return tempRoot;
}

function writeFixtureFile(root: string, relativePath: string, contents: string) {
  const targetPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, contents, "utf8");
}

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0)) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe("worktree integrity checks", () => {
  it("detects a missing rollup native dependency", () => {
    const root = createFixtureRoot();

    writeFixtureFile(root, "node_modules/rollup/package.json", '{ "name": "rollup" }\n');
    writeFixtureFile(
      root,
      "node_modules/rollup/dist/native.js",
      `module.exports = require("${fixtureRollupNativePackage}");\n`,
    );
    writeFixtureFile(root, "node_modules/lucide-react/package.json", '{ "name": "lucide-react" }\n');
    writeFixtureFile(
      root,
      "node_modules/lucide-react/dist/esm/lucide-react.js",
      'export { default as FingerprintPattern } from "./icons/fingerprint-pattern.js";\n',
    );
    writeFixtureFile(root, "node_modules/lucide-react/dist/esm/icons/fingerprint-pattern.js", "export default {};\n");

    expect(findWorktreeIntegrityIssues(root)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "rollup_native_unavailable",
        }),
      ]),
    );
  });

  it("detects missing lucide icon modules", () => {
    const root = createFixtureRoot();

    writeFixtureFile(root, "node_modules/rollup/package.json", '{ "name": "rollup" }\n');
    writeFixtureFile(
      root,
      "node_modules/rollup/dist/native.js",
      `module.exports = require("${fixtureRollupNativePackage}");\n`,
    );
    writeFixtureFile(
      root,
      `node_modules/${fixtureRollupNativePackage}/package.json`,
      `{ "name": "${fixtureRollupNativePackage}", "main": "./index.js" }\n`,
    );
    writeFixtureFile(root, `node_modules/${fixtureRollupNativePackage}/index.js`, "module.exports = {};\n");
    writeFixtureFile(root, "node_modules/lucide-react/package.json", '{ "name": "lucide-react" }\n');
    writeFixtureFile(
      root,
      "node_modules/lucide-react/dist/esm/lucide-react.js",
      'export { default as FingerprintPattern } from "./icons/fingerprint-pattern.js";\n',
    );

    expect(findWorktreeIntegrityIssues(root)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "lucide_import_missing",
          detail: "./icons/fingerprint-pattern.js",
        }),
      ]),
    );
  });

  it("returns no issues when the critical packages are complete", () => {
    const root = createFixtureRoot();

    writeFixtureFile(root, "node_modules/rollup/package.json", '{ "name": "rollup" }\n');
    writeFixtureFile(
      root,
      "node_modules/rollup/dist/native.js",
      `module.exports = require("${fixtureRollupNativePackage}");\n`,
    );
    writeFixtureFile(
      root,
      `node_modules/${fixtureRollupNativePackage}/package.json`,
      `{ "name": "${fixtureRollupNativePackage}", "main": "./index.js" }\n`,
    );
    writeFixtureFile(root, `node_modules/${fixtureRollupNativePackage}/index.js`, "module.exports = {};\n");
    writeFixtureFile(root, "node_modules/lucide-react/package.json", '{ "name": "lucide-react" }\n');
    writeFixtureFile(
      root,
      "node_modules/lucide-react/dist/esm/lucide-react.js",
      'export { default as FingerprintPattern } from "./icons/fingerprint-pattern.js";\n',
    );
    writeFixtureFile(root, "node_modules/lucide-react/dist/esm/icons/fingerprint-pattern.js", "export default {};\n");

    expect(findWorktreeIntegrityIssues(root)).toEqual([]);
  });

  it("formats issues as a readable checklist", () => {
    const output = formatWorktreeIntegrityIssues([
      {
        code: "lucide_import_missing",
        summary: "lucide-react install is missing generated icon modules.",
        detail: "./icons/fingerprint-pattern.js",
      },
    ]);

    expect(output).toContain("[lucide_import_missing]");
    expect(output).toContain("./icons/fingerprint-pattern.js");
  });
});
