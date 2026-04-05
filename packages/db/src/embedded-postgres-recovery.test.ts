import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tryRecoverStaleEmbeddedPostgresPreferredPort } from "./embedded-postgres-recovery.js";

const tempDirs: string[] = [];

function createClusterDir(postmasterOpts?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-embedded-recovery-"));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, "PG_VERSION"), "15\n", "utf8");
  if (postmasterOpts) {
    fs.writeFileSync(path.join(dir, "postmaster.opts"), postmasterOpts, "utf8");
  }
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("tryRecoverStaleEmbeddedPostgresPreferredPort", () => {
  it("skips recovery when the startup failure is not a shared-memory conflict", async () => {
    const dataDir = createClusterDir();
    const terminateProcessTree = vi.fn(async () => undefined);

    await expect(
      tryRecoverStaleEmbeddedPostgresPreferredPort(
        {
          dataDir,
          preferredPort: 54329,
          error: new Error("different startup failure"),
          recentLogs: [],
        },
        {
          isPortInUse: async () => true,
          listListeningPids: async () => [1234],
          terminateProcessTree,
          waitForPortRelease: async () => true,
        },
      ),
    ).resolves.toBe(false);

    expect(terminateProcessTree).not.toHaveBeenCalled();
  });

  it("reaps listeners on the preferred port when shared-memory recovery is safe", async () => {
    const preferredPort = 54329;
    const dataDir = createClusterDir(
      `"C:/repo/node_modules/@embedded-postgres/windows-x64/native/bin/postgres.exe" "-D" "${dataDirPlaceholder()}" "-p" "${preferredPort}"`,
    );
    const normalizedDir = dataDir.replace(/\\/g, "/");
    fs.writeFileSync(
      path.join(dataDir, "postmaster.opts"),
      `"C:/repo/node_modules/@embedded-postgres/windows-x64/native/bin/postgres.exe" "-D" "${normalizedDir}" "-p" "${preferredPort}"`,
      "utf8",
    );

    const terminateProcessTree = vi.fn(async () => undefined);
    const waitForPortRelease = vi.fn(async () => true);

    await expect(
      tryRecoverStaleEmbeddedPostgresPreferredPort(
        {
          dataDir,
          preferredPort,
          error: new Error("Failed to start embedded PostgreSQL"),
          recentLogs: ["FATAL:  pre-existing shared memory block is still in use"],
        },
        {
          isPortInUse: async () => true,
          listListeningPids: async () => [4321, 9876],
          terminateProcessTree,
          waitForPortRelease,
        },
      ),
    ).resolves.toBe(true);

    expect(terminateProcessTree).toHaveBeenCalledTimes(2);
    expect(terminateProcessTree).toHaveBeenNthCalledWith(1, 4321, process.platform);
    expect(terminateProcessTree).toHaveBeenNthCalledWith(2, 9876, process.platform);
    expect(waitForPortRelease).toHaveBeenCalledWith(preferredPort, expect.any(Function));
  });

  it("refuses recovery when postmaster.opts does not match the configured cluster", async () => {
    const dataDir = createClusterDir(
      `"C:/repo/node_modules/@embedded-postgres/windows-x64/native/bin/postgres.exe" "-D" "C:/other/db" "-p" "55432"`,
    );
    const terminateProcessTree = vi.fn(async () => undefined);

    await expect(
      tryRecoverStaleEmbeddedPostgresPreferredPort(
        {
          dataDir,
          preferredPort: 54329,
          error: new Error("start failed"),
          recentLogs: ["FATAL:  pre-existing shared memory block is still in use"],
        },
        {
          isPortInUse: async () => true,
          listListeningPids: async () => [3210],
          terminateProcessTree,
          waitForPortRelease: async () => true,
        },
      ),
    ).resolves.toBe(false);

    expect(terminateProcessTree).not.toHaveBeenCalled();
  });
});

function dataDirPlaceholder() {
  return "C:/placeholder";
}
