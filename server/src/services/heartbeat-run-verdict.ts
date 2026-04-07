export type HeartbeatRunBusinessVerdictKind = "passed" | "changes_requested" | "blocked" | "unknown";

export interface HeartbeatRunBusinessVerdict {
  kind: HeartbeatRunBusinessVerdictKind;
  rawVerdict: string | null;
  source: "result_json" | "run_error" | "run_status" | "none";
  reasonCode: string;
  message: string | null;
}

export interface HeartbeatRunBusinessVerdictInput {
  status: string | null | undefined;
  resultJson: Record<string, unknown> | null | undefined;
  errorCode: string | null | undefined;
  error: string | null | undefined;
}

const POSITIVE_VERDICTS = new Set(["passed", "pass", "approved", "accept", "accepted"]);
const CHANGES_REQUESTED_VERDICTS = new Set(["changes_requested", "rejected", "returned"]);
const BLOCKED_VERDICTS = new Set(["blocked"]);

function readNonEmptyString(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readExplicitVerdict(resultJson: Record<string, unknown> | null | undefined) {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) {
    return null;
  }
  const verdict = readNonEmptyString(resultJson.verdict);
  return verdict ? verdict.toLowerCase() : null;
}

function normalizeVerdict(rawVerdict: string | null): HeartbeatRunBusinessVerdictKind {
  if (!rawVerdict) return "unknown";
  if (POSITIVE_VERDICTS.has(rawVerdict)) return "passed";
  if (CHANGES_REQUESTED_VERDICTS.has(rawVerdict)) return "changes_requested";
  if (BLOCKED_VERDICTS.has(rawVerdict)) return "blocked";
  return "unknown";
}

export function deriveHeartbeatRunBusinessVerdict(
  input: HeartbeatRunBusinessVerdictInput,
): HeartbeatRunBusinessVerdict {
  const errorCode = readNonEmptyString(input.errorCode);
  const error = readNonEmptyString(input.error);
  const status = readNonEmptyString(input.status)?.toLowerCase() ?? null;

  if (errorCode || error) {
    if (errorCode === "process_lost") {
      return {
        kind: "unknown",
        rawVerdict: null,
        source: "run_error",
        reasonCode: "process_lost",
        message: "Platform process lost",
      };
    }
    return {
      kind: "blocked",
      rawVerdict: null,
      source: "run_error",
      reasonCode: "run_error",
      message: error ?? errorCode,
    };
  }

  if (status === "failed" || status === "cancelled" || status === "timed_out") {
    return {
      kind: "blocked",
      rawVerdict: null,
      source: "run_status",
      reasonCode: "run_not_successful",
      message: null,
    };
  }

  const rawVerdict = readExplicitVerdict(input.resultJson);
  const kind = normalizeVerdict(rawVerdict);
  if (rawVerdict) {
    return {
      kind,
      rawVerdict,
      source: "result_json",
      reasonCode: kind === "unknown" ? "verdict_unrecognized" : "explicit_verdict",
      message: null,
    };
  }

  return {
    kind: "unknown",
    rawVerdict: null,
    source: "none",
    reasonCode: "verdict_missing",
    message: null,
  };
}
