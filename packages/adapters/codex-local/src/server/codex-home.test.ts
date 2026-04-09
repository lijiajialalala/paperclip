import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FsPromisesModule = typeof import("node:fs/promises");
type CopyFn = FsPromisesModule["cp"];

const { mockCp } = vi.hoisted(() => ({
  mockCp: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<FsPromisesModule>();
  const mocked = {
    ...actual,
    cp: (source: string, target: string, options?: Parameters<CopyFn>[2]) =>
      mockCp(source, target, options, actual.cp),
  };
  return {
    ...mocked,
    default: mocked,
  };
});

import { prepareManagedCodexHome, resolveManagedCodexHomeDir } from "./codex-home.js";

describe("prepareManagedCodexHome", () => {
  let tempRoot = "";
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    mockCp.mockReset();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-codex-home-"));

    const sharedHome = path.join(tempRoot, "shared-codex-home");
    fs.mkdirSync(path.join(sharedHome, "agents"), { recursive: true });
    fs.writeFileSync(path.join(sharedHome, "agents", "reviewer.toml"), 'role = "reviewer"\n');
    fs.writeFileSync(path.join(sharedHome, "agents", "explorer.toml"), 'role = "explorer"\n');

    env = {
      ...process.env,
      CODEX_HOME: sharedHome,
      PAPERCLIP_HOME: path.join(tempRoot, ".paperclip"),
      PAPERCLIP_INSTANCE_ID: "test-instance",
    };

    const activeTargets = new Map<string, number>();
    mockCp.mockImplementation(
      async (
        source: string,
        target: string,
        options: Parameters<CopyFn>[2],
        actualCp: CopyFn,
      ) => {
        const concurrentCopies = activeTargets.get(target) ?? 0;
        activeTargets.set(target, concurrentCopies + 1);

        if (concurrentCopies > 0) {
          const mirroredFile = path.join(target, "reviewer.toml");
          throw Object.assign(
            new Error(`ENOENT: no such file or directory, unlink '${mirroredFile}'`),
            {
              code: "ENOENT",
              errno: -4058,
              syscall: "unlink",
              path: mirroredFile,
            },
          );
        }

        try {
          await new Promise((resolve) => setTimeout(resolve, 20));
          await actualCp(source, target, options);
        } finally {
          const remainingCopies = (activeTargets.get(target) ?? 1) - 1;
          if (remainingCopies > 0) {
            activeTargets.set(target, remainingCopies);
          } else {
            activeTargets.delete(target);
          }
        }
      },
    );
  });

  afterEach(() => {
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = "";
    }
  });

  it("serializes seeding for the same company codex home", async () => {
    const onLog = vi.fn(async () => undefined);
    const targetHome = resolveManagedCodexHomeDir(env, "company-1");

    await expect(
      Promise.all([
        prepareManagedCodexHome(env, onLog, "company-1"),
        prepareManagedCodexHome(env, onLog, "company-1"),
      ]),
    ).resolves.toEqual([targetHome, targetHome]);

    expect(fs.existsSync(path.join(targetHome, "agents", "reviewer.toml"))).toBe(true);
    expect(fs.existsSync(path.join(targetHome, "agents", "explorer.toml"))).toBe(true);
    expect(mockCp).toHaveBeenCalledTimes(2);
  });
});
