import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";

const {
  applyPendingMigrationsMock,
  createAppMock,
  createDbMock,
  detectPortMock,
  embeddedPostgresCtorMock,
  ensurePostgresDatabaseMock,
  fakeServer,
  getPostgresDataDirectoryMock,
  inspectMigrationsMock,
  loadConfigMock,
  tryRecoverStalePortMock,
} = vi.hoisted(() => {
  const createAppMock = vi.fn(async () => ((_: unknown, __: unknown) => {}) as never);
  const createDbMock = vi.fn(() => ({}) as never);
  const detectPortMock = vi.fn(async (port: number) => port);
  const ensurePostgresDatabaseMock = vi.fn(async () => undefined);
  const getPostgresDataDirectoryMock = vi.fn(async () => null);
  const inspectMigrationsMock = vi.fn(async () => ({ status: "upToDate" }));
  const applyPendingMigrationsMock = vi.fn(async () => undefined);
  const tryRecoverStalePortMock = vi.fn(async () => false);
  const loadConfigMock = vi.fn();
  const embeddedPostgresCtorMock = vi.fn((opts: { port: number }) => ({
    initialise: vi.fn(async () => undefined),
    start: vi.fn(async () => {
      if (opts.port === 54330) {
        throw new Error("embedded postgres start failed");
      }
    }),
    stop: vi.fn(async () => undefined),
  }));
  const fakeServer = {
    once: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    listen: vi.fn((_port: number, _host: string, callback?: () => void) => {
      callback?.();
      return fakeServer;
    }),
    close: vi.fn(),
  };

  return {
    applyPendingMigrationsMock,
    createAppMock,
    createDbMock,
    detectPortMock,
    embeddedPostgresCtorMock,
    ensurePostgresDatabaseMock,
    fakeServer,
    getPostgresDataDirectoryMock,
    inspectMigrationsMock,
    loadConfigMock,
    tryRecoverStalePortMock,
  };
});

vi.mock("node:http", () => ({
  createServer: vi.fn(() => fakeServer),
}));

vi.mock("embedded-postgres", () => ({
  default: embeddedPostgresCtorMock,
}));

vi.mock("detect-port", () => ({
  default: detectPortMock,
}));

vi.mock("@paperclipai/db", () => ({
  createDb: createDbMock,
  ensurePostgresDatabase: ensurePostgresDatabaseMock,
  getPostgresDataDirectory: getPostgresDataDirectoryMock,
  inspectMigrations: inspectMigrationsMock,
  applyPendingMigrations: applyPendingMigrationsMock,
  reconcilePendingMigrationHistory: vi.fn(async () => ({ repairedMigrations: [] })),
  createEmbeddedPostgresLogBuffer: vi.fn(() => ({
    append: vi.fn(),
    getRecentLogs: vi.fn(() => ["FATAL:  pre-existing shared memory block is still in use"]),
  })),
  formatEmbeddedPostgresError: vi.fn(
    (error: Error, input: { fallbackMessage: string; recentLogs?: string[] }) =>
      new Error([input.fallbackMessage, ...(input.recentLogs ?? []), error.message].join(" | ")),
  ),
  tryRecoverStaleEmbeddedPostgresPreferredPort: tryRecoverStalePortMock,
  formatDatabaseBackupResult: vi.fn(() => "ok"),
  runDatabaseBackup: vi.fn(),
  authUsers: {},
  companies: {},
  companyMemberships: {},
  instanceUserRoles: {},
}));

vi.mock("../app.js", () => ({
  createApp: createAppMock,
}));

vi.mock("../config.js", () => ({
  loadConfig: loadConfigMock,
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../realtime/live-events-ws.js", () => ({
  setupLiveEventsWebSocketServer: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  feedbackService: vi.fn(() => ({
    flushPendingFeedbackTraces: vi.fn(async () => ({ attempted: 0, sent: 0, failed: 0 })),
  })),
  heartbeatService: vi.fn(() => ({
    reapOrphanedRuns: vi.fn(async () => undefined),
    resumeQueuedRuns: vi.fn(async () => undefined),
    tickTimers: vi.fn(async () => ({ enqueued: 0 })),
  })),
  reconcilePersistedRuntimeServicesOnStartup: vi.fn(async () => ({ reconciled: 0 })),
  routineService: vi.fn(() => ({
    tickScheduledTriggers: vi.fn(async () => ({ triggered: 0 })),
  })),
}));

vi.mock("../storage/index.js", () => ({
  createStorageServiceFromConfig: vi.fn(() => ({ id: "storage-service" })),
}));

vi.mock("../services/feedback-share-client.js", () => ({
  createFeedbackTraceShareClientFromConfig: vi.fn(() => ({ id: "feedback-share-client" })),
}));

vi.mock("../startup-banner.js", () => ({
  printStartupBanner: vi.fn(),
}));

vi.mock("../board-claim.js", () => ({
  getBoardClaimWarningUrl: vi.fn(() => null),
  initializeBoardClaimChallenge: vi.fn(async () => undefined),
}));

vi.mock("../auth/better-auth.js", () => ({
  createBetterAuthHandler: vi.fn(() => undefined),
  createBetterAuthInstance: vi.fn(() => ({})),
  deriveAuthTrustedOrigins: vi.fn(() => []),
  resolveBetterAuthSession: vi.fn(async () => null),
  resolveBetterAuthSessionFromHeaders: vi.fn(async () => null),
}));

vi.mock("../worktree-config.js", () => ({
  maybePersistWorktreeRuntimePorts: vi.fn(async () => undefined),
}));

vi.mock("../telemetry.js", () => ({
  initTelemetry: vi.fn(),
  getTelemetryClient: vi.fn(() => undefined),
}));

import { startServer } from "../index.ts";

describe("startServer embedded postgres recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BETTER_AUTH_SECRET = "test-secret";
    loadConfigMock.mockReturnValue({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      host: "127.0.0.1",
      port: 3210,
      allowedHostnames: [],
      authBaseUrlMode: "auto",
      authPublicBaseUrl: undefined,
      authDisableSignUp: false,
      databaseMode: "embedded-postgres",
      databaseUrl: undefined,
      embeddedPostgresDataDir: "/tmp/paperclip-test-db",
      embeddedPostgresPort: 54329,
      databaseBackupEnabled: false,
      databaseBackupIntervalMinutes: 60,
      databaseBackupRetentionDays: 30,
      databaseBackupDir: "/tmp/paperclip-test-backups",
      serveUi: false,
      uiDevMiddleware: false,
      secretsProvider: "local_encrypted",
      secretsStrictMode: false,
      secretsMasterKeyFilePath: "/tmp/paperclip-master.key",
      storageProvider: "local_disk",
      storageLocalDiskBaseDir: "/tmp/paperclip-storage",
      storageS3Bucket: "paperclip-test",
      storageS3Region: "us-east-1",
      storageS3Endpoint: undefined,
      storageS3Prefix: "",
      storageS3ForcePathStyle: false,
      feedbackExportBackendUrl: null,
      feedbackExportBackendToken: null,
      heartbeatSchedulerEnabled: false,
      heartbeatSchedulerIntervalMs: 30000,
      companyDeletionEnabled: false,
    });
    detectPortMock.mockResolvedValue(54330);
    getPostgresDataDirectoryMock.mockRejectedValue(new Error("configured port unreachable"));
    inspectMigrationsMock.mockResolvedValue({ status: "upToDate" });
    tryRecoverStalePortMock.mockResolvedValue(true);
    embeddedPostgresCtorMock.mockImplementation((opts: { port: number }) => ({
      initialise: vi.fn(async () => undefined),
      start: vi.fn(async () => {
        if (opts.port === 54330) {
          throw new Error("embedded postgres start failed");
        }
      }),
      stop: vi.fn(async () => undefined),
    }));
  });

  it("retries the preferred port after stale listener recovery", async () => {
    const started = await startServer();

    expect(started.server).toBe(fakeServer);
    expect(embeddedPostgresCtorMock).toHaveBeenCalledTimes(2);
    expect(embeddedPostgresCtorMock.mock.calls[0]?.[0]).toMatchObject({ port: 54330 });
    expect(embeddedPostgresCtorMock.mock.calls[1]?.[0]).toMatchObject({ port: 54329 });
    expect(tryRecoverStalePortMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dataDir: resolve("/tmp/paperclip-test-db"),
        preferredPort: 54329,
      }),
    );
    expect(createDbMock).toHaveBeenCalledWith("postgres://paperclip:paperclip@127.0.0.1:54329/paperclip");
  });
});
