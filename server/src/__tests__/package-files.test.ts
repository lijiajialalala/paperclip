import { describe, expect, it } from "vitest";

import { buildPnpmSpawnSpec } from "../../../scripts/package-files";

describe("package-files pnpm spawn spec", () => {
  it("uses cmd.exe with raw args on windows paths that contain spaces", () => {
    expect(
      buildPnpmSpawnSpec(
        [
          "--dir",
          "C:\\Users\\lijiajia\\paperclip repo",
          "--filter",
          "@paperclipai/ui",
          "build",
        ],
        {
          comSpec: "C:\\Windows\\System32\\cmd.exe",
          platform: "win32",
        },
      ),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        "pnpm.cmd",
        "--dir",
        "C:\\Users\\lijiajia\\paperclip repo",
        "--filter",
        "@paperclipai/ui",
        "build",
      ],
    });
  });

  it("uses pnpm directly on non-windows platforms", () => {
    expect(
      buildPnpmSpawnSpec(["--filter", "@paperclipai/ui", "build"], {
        platform: "linux",
      }),
    ).toEqual({
      command: "pnpm",
      args: ["--filter", "@paperclipai/ui", "build"],
    });
  });
});
