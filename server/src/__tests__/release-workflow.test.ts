import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const releaseWorkflow = readFileSync(
  path.join(repoRoot, ".github", "workflows", "release.yml"),
  "utf8",
);

describe("release workflow publishing", () => {
  it("only publishes from the canonical upstream repository", () => {
    expect(releaseWorkflow).toContain(
      "if: github.event_name == 'push' && github.repository == 'paperclipai/paperclip'",
    );
    expect(releaseWorkflow).toContain(
      "if: github.event_name == 'workflow_dispatch' && !inputs.dry_run && github.repository == 'paperclipai/paperclip'",
    );
  });

  it("configures the npm registry for publish jobs", () => {
    const registryMatches = releaseWorkflow.match(
      /registry-url: https:\/\/registry\.npmjs\.org\//g,
    );

    expect(registryMatches).toHaveLength(2);
  });
});
