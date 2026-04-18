import { parseObject } from "../adapters/utils.js";

export const PROCESS_LOST_ERROR_CODE = "process_lost";
export const SERVER_RESTARTED_ERROR_CODE = "server_restarted";

export const RUNTIME_INTERRUPTION_ERROR_CODES = [
  PROCESS_LOST_ERROR_CODE,
  SERVER_RESTARTED_ERROR_CODE,
] as const;

export type RuntimeInterruptionErrorCode = (typeof RUNTIME_INTERRUPTION_ERROR_CODES)[number];

const RUNTIME_INTERRUPTION_ERROR_CODE_SET = new Set<string>(RUNTIME_INTERRUPTION_ERROR_CODES);
const SERVER_BOOT_CONTEXT_KEY = "paperclipServerBoot";

export interface HeartbeatServerBootMarker {
  pid: number | null;
  bootedAt: string;
}

export function isRuntimeInterruptionErrorCode(value: unknown): value is RuntimeInterruptionErrorCode {
  return typeof value === "string" && RUNTIME_INTERRUPTION_ERROR_CODE_SET.has(value);
}

export function writeHeartbeatServerBootMarker(
  contextSnapshot: Record<string, unknown> | null | undefined,
  marker: HeartbeatServerBootMarker,
) {
  const nextContext = parseObject(contextSnapshot);
  nextContext[SERVER_BOOT_CONTEXT_KEY] = {
    pid: typeof marker.pid === "number" && Number.isInteger(marker.pid) && marker.pid > 0 ? marker.pid : null,
    bootedAt: marker.bootedAt,
  };
  return nextContext;
}

export function readHeartbeatServerBootMarker(
  contextSnapshot: Record<string, unknown> | null | undefined,
): HeartbeatServerBootMarker | null {
  const raw = parseObject(parseObject(contextSnapshot)[SERVER_BOOT_CONTEXT_KEY]);

  const pidValue = typeof raw.pid === "number" && Number.isInteger(raw.pid) && raw.pid > 0 ? raw.pid : null;
  const bootedAt = typeof raw.bootedAt === "string" ? raw.bootedAt.trim() : "";
  if (bootedAt.length === 0) return null;

  return {
    pid: pidValue,
    bootedAt,
  };
}

export function runBelongsToDifferentServerBoot(
  contextSnapshot: Record<string, unknown> | null | undefined,
  currentMarker: HeartbeatServerBootMarker,
) {
  const existing = readHeartbeatServerBootMarker(contextSnapshot);
  if (!existing) return false;
  return existing.bootedAt !== currentMarker.bootedAt || existing.pid !== currentMarker.pid;
}
