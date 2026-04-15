import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  getMigrationStatusPnpmArgs,
  getPluginSdkBuildPnpmArgs,
  getRootDevScriptCommands,
  getServerChildPnpmArgs,
} from "../../../scripts/dev-command-helpers.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const rootPackageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
  scripts?: Record<string, string>;
};
const rootDockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
const smokeDevOnceScript = readFileSync(path.join(repoRoot, "scripts", "smoke-dev-once.ts"), "utf8");

describe("root dev command coverage", () => {
  it("keeps root dev scripts on the explicit server tsx runner", () => {
    expect(rootPackageJson.scripts).toMatchObject(getRootDevScriptCommands());
  });

  it("builds workspace child commands without pnpm exec tsx", () => {
    expect(getServerChildPnpmArgs("dev")).toEqual(["--dir", "server", "dev"]);
    expect(getServerChildPnpmArgs("watch", ["--tailscale-auth"])).toEqual([
      "--dir",
      "server",
      "dev:watch",
      "--tailscale-auth",
    ]);
    expect(getPluginSdkBuildPnpmArgs()).toEqual(["--dir", "packages/plugins/sdk", "build"]);
    expect(getMigrationStatusPnpmArgs()).toEqual([
      "--dir",
      "packages/db",
      "exec",
      "node",
      "./node_modules/tsx/dist/cli.mjs",
      "src/migration-status.ts",
      "--json",
    ]);
  });

  it("installs github cli in Docker without pinning a stale keyring checksum", () => {
    expect(rootDockerfile).toContain("curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg");
    expect(rootDockerfile).not.toContain("sha256sum -c -");
  });

  it("stops dev:once smoke runs by terminating the spawned process tree directly", () => {
    expect(smokeDevOnceScript).toContain('detached: process.platform !== "win32"');
    expect(smokeDevOnceScript).not.toContain('runPnpm(["dev:stop"]');
  });
});
