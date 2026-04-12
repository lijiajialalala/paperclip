export function buildPnpmSpawnSpec(
  args: string[],
  options: {
    comSpec?: string;
    platform?: NodeJS.Platform;
  } = {},
): {
  args: string[];
  command: string;
} {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return {
      command: options.comSpec ?? process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", "pnpm.cmd", ...args],
    };
  }

  return {
    command: "pnpm",
    args,
  };
}
