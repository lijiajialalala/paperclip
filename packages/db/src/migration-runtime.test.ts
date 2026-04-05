import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createEmbeddedPostgresLogBufferMock,
  createServerMock,
  embeddedPostgresCtorMock,
  ensurePostgresDatabaseMock,
  formatEmbeddedPostgresErrorMock,
  getPostgresDataDirectoryMock,
  portsInUse,
  resolveDatabaseTargetMock,
  tryRecoverStalePortMock,
} = vi.hoisted(() => {
  const portsInUse = new Set<number>();
  const createServerMock = vi.fn(() => {
    let errorHandler: ((error: NodeJS.ErrnoException) => void) | null = null;
    const server = {
      unref: vi.fn(),
      once: vi.fn((event: string, handler: (error: NodeJS.ErrnoException) => void) => {
        if (event === "error") errorHandler = handler;
        return server;
      }),
      listen: vi.fn((port: number, _host: string, callback?: () => void) => {
        if (portsInUse.has(port)) {
          errorHandler?.({ code: "EADDRINUSE" } as NodeJS.ErrnoException);
          return server;
        }
        callback?.();
        return server;
      }),
      close: vi.fn(),
    };
    return server;
  });

  return {
    createEmbeddedPostgresLogBufferMock: vi.fn(() => ({
      append: vi.fn(),
      getRecentLogs: vi.fn(() => ["FATAL:  pre-existing shared memory block is still in use"]),
    })),
    createServerMock,
    embeddedPostgresCtorMock: vi.fn(),
    ensurePostgresDatabaseMock: vi.fn(async () => undefined),
    formatEmbeddedPostgresErrorMock: vi.fn(
      (error: Error, input: { fallbackMessage: string; recentLogs?: string[] }) =>
        new Error([input.fallbackMessage, ...(input.recentLogs ?? []), error.message].join(" | ")),
    ),
    getPostgresDataDirectoryMock: vi.fn(async () => null),
    portsInUse,
    resolveDatabaseTargetMock: vi.fn(),
    tryRecoverStalePortMock: vi.fn(async () => false),
  };
});

vi.mock("node:net", () => ({
  createServer: createServerMock,
}));

vi.mock("embedded-postgres", () => ({
  default: embeddedPostgresCtorMock,
}));

vi.mock("./client.js", () => ({
  ensurePostgresDatabase: ensurePostgresDatabaseMock,
  getPostgresDataDirectory: getPostgresDataDirectoryMock,
}));

vi.mock("./embedded-postgres-error.js", () => ({
  createEmbeddedPostgresLogBuffer: createEmbeddedPostgresLogBufferMock,
  formatEmbeddedPostgresError: formatEmbeddedPostgresErrorMock,
}));

vi.mock("./embedded-postgres-recovery.js", () => ({
  tryRecoverStaleEmbeddedPostgresPreferredPort: tryRecoverStalePortMock,
}));

vi.mock("./runtime-config.js", () => ({
  resolveDatabaseTarget: resolveDatabaseTargetMock,
}));

import { resolveMigrationConnection } from "./migration-runtime.js";

const tempDirs: string[] = [];

function createEmbeddedClusterDir() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-migration-runtime-"));
  tempDirs.push(dataDir);
  fs.writeFileSync(path.join(dataDir, "PG_VERSION"), "15\n", "utf8");
  return dataDir;
}

describe("resolveMigrationConnection embedded-postgres recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    portsInUse.clear();
    getPostgresDataDirectoryMock.mockRejectedValue(new Error("configured port unreachable"));
    tryRecoverStalePortMock.mockResolvedValue(true);
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retries the preferred port after recovering a stale configured listener", async () => {
    const preferredPort = 55429;
    const fallbackPort = preferredPort + 1;
    const dataDir = createEmbeddedClusterDir();
    const stopFallback = vi.fn(async () => undefined);
    const stopPreferred = vi.fn(async () => undefined);

    portsInUse.add(preferredPort);
    resolveDatabaseTargetMock.mockReturnValue({
      mode: "embedded-postgres",
      dataDir,
      port: preferredPort,
    });
    embeddedPostgresCtorMock.mockImplementation((opts: { port: number }) => ({
      initialise: vi.fn(async () => undefined),
      start: vi.fn(async () => {
        if (opts.port === fallbackPort) {
          throw new Error("fallback start failed");
        }
      }),
      stop: opts.port === fallbackPort ? stopFallback : stopPreferred,
    }));

    const connection = await resolveMigrationConnection();

    expect(embeddedPostgresCtorMock).toHaveBeenCalledTimes(2);
    expect(embeddedPostgresCtorMock.mock.calls[0]?.[0]).toMatchObject({ port: fallbackPort });
    expect(embeddedPostgresCtorMock.mock.calls[1]?.[0]).toMatchObject({ port: preferredPort });
    expect(tryRecoverStalePortMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dataDir,
        preferredPort,
      }),
    );
    expect(connection).toMatchObject({
      connectionString: `postgres://paperclip:paperclip@127.0.0.1:${preferredPort}/paperclip`,
      source: `embedded-postgres@${preferredPort}`,
    });

    await connection.stop();

    expect(stopFallback).not.toHaveBeenCalled();
    expect(stopPreferred).toHaveBeenCalledTimes(1);
    expect(ensurePostgresDatabaseMock).toHaveBeenLastCalledWith(
      `postgres://paperclip:paperclip@127.0.0.1:${preferredPort}/postgres`,
      "paperclip",
    );
  });

  it("formats the retry failure if startup still fails after recovery", async () => {
    const preferredPort = 56429;
    const fallbackPort = preferredPort + 1;
    const dataDir = createEmbeddedClusterDir();

    portsInUse.add(preferredPort);
    resolveDatabaseTargetMock.mockReturnValue({
      mode: "embedded-postgres",
      dataDir,
      port: preferredPort,
    });
    embeddedPostgresCtorMock.mockImplementation((opts: { port: number }) => ({
      initialise: vi.fn(async () => undefined),
      start: vi.fn(async () => {
        if (opts.port === fallbackPort) {
          throw new Error("fallback start failed");
        }
        throw new Error("preferred retry failed");
      }),
      stop: vi.fn(async () => undefined),
    }));

    await expect(resolveMigrationConnection()).rejects.toThrow(
      `Failed to start embedded PostgreSQL on port ${preferredPort}`,
    );

    expect(formatEmbeddedPostgresErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: "preferred retry failed" }),
      expect.objectContaining({
        fallbackMessage: `Failed to start embedded PostgreSQL on port ${preferredPort}`,
        recentLogs: ["FATAL:  pre-existing shared memory block is still in use"],
      }),
    );
  });
});
