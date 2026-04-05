export const ROOT_DEV_TSX_CLI_PATH = "server/node_modules/tsx/dist/cli.mjs";

export function getRootDevScriptCommands() {
  return {
    dev: `node ${ROOT_DEV_TSX_CLI_PATH} scripts/dev-runner.ts watch`,
    "dev:watch": `node ${ROOT_DEV_TSX_CLI_PATH} scripts/dev-runner.ts watch`,
    "dev:once": `node ${ROOT_DEV_TSX_CLI_PATH} scripts/dev-runner.ts dev`,
    "dev:list": `node ${ROOT_DEV_TSX_CLI_PATH} scripts/dev-service.ts list`,
    "dev:stop": `node ${ROOT_DEV_TSX_CLI_PATH} scripts/dev-service.ts stop`,
  } as const;
}

export function getServerChildPnpmArgs(
  mode: "watch" | "dev",
  forwardedArgs: string[] = [],
) {
  return ["--dir", "server", mode === "watch" ? "dev:watch" : "dev", ...forwardedArgs];
}

export function getPluginSdkBuildPnpmArgs() {
  return ["--dir", "packages/plugins/sdk", "build"];
}

export function getMigrationStatusPnpmArgs() {
  return [
    "--dir",
    "packages/db",
    "exec",
    "node",
    "./node_modules/tsx/dist/cli.mjs",
    "src/migration-status.ts",
    "--json",
  ];
}
