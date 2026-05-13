import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_CWD = process.cwd();

async function importFreshConfigModule() {
  vi.resetModules();
  return import("../config.ts");
}

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }
});

describe("Paperclip env provider overrides", () => {
  it("prefers repo-local .paperclip/.env provider keys over inherited host values", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-config-provider-env-"));
    const workspaceRoot = path.join(tempRoot, "workspace");
    const paperclipDir = path.join(workspaceRoot, ".paperclip");
    const configPath = path.join(paperclipDir, "config.json");
    const envPath = path.join(paperclipDir, ".env");

    await fs.mkdir(paperclipDir, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          $meta: {
            version: 1,
            updatedAt: "2026-05-13T00:00:00.000Z",
            source: "configure",
          },
          database: {
            mode: "embedded-postgres",
            embeddedPostgresDataDir: path.join(tempRoot, "db"),
            embeddedPostgresPort: 54329,
            backup: {
              enabled: true,
              intervalMinutes: 60,
              retentionDays: 30,
              dir: path.join(tempRoot, "backups"),
            },
          },
          logging: {
            mode: "file",
            logDir: path.join(tempRoot, "logs"),
          },
          server: {
            deploymentMode: "local_trusted",
            exposure: "private",
            host: "127.0.0.1",
            port: 3100,
            allowedHostnames: [],
            serveUi: true,
          },
          auth: {
            baseUrlMode: "auto",
            disableSignUp: false,
          },
          storage: {
            provider: "local_disk",
            localDisk: {
              baseDir: path.join(tempRoot, "storage"),
            },
            s3: {
              bucket: "paperclip",
              region: "us-east-1",
              prefix: "",
              forcePathStyle: false,
            },
          },
          secrets: {
            provider: "local_encrypted",
            strictMode: false,
            localEncrypted: {
              keyFilePath: path.join(tempRoot, "master.key"),
            },
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    await fs.writeFile(
      envPath,
      [
        "OPENAI_API_KEY=paperclip-instance-key",
        "OPENAI_BASE_URL=https://leleapi.top/v1",
        "",
      ].join("\n"),
      "utf8",
    );

    process.chdir(workspaceRoot);
    process.env.OPENAI_API_KEY = "host-parent-key";
    process.env.OPENAI_BASE_URL = "https://old-provider.example/v1";
    delete process.env.PAPERCLIP_CONFIG;

    await importFreshConfigModule();

    expect(process.env.OPENAI_API_KEY).toBe("paperclip-instance-key");
    expect(process.env.OPENAI_BASE_URL).toBe("https://leleapi.top/v1");

    process.chdir(ORIGINAL_CWD);
    await fs.rm(tempRoot, { recursive: true, force: true });
  });
});
