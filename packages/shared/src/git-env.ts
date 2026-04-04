const GIT_ENV_CONTEXT_KEYS = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
  "GIT_SUPER_PREFIX",
]);

export function buildIsolatedGitEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(baseEnv).filter(([key]) => !GIT_ENV_CONTEXT_KEYS.has(key.toUpperCase())),
  );
}
