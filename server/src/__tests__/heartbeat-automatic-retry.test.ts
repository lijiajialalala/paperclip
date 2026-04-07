import { describe, expect, it, vi } from "vitest";
import {
  classifyAutomaticRetry,
  getRetryChainAttempt,
  handleAutomaticRetryOrRelease,
  resolveAutomaticRetryPlan,
  resolveRunnableAutomaticRetryPlan,
  selectReadyQueuedRunsForStart,
} from "../services/heartbeat.ts";

describe("classifyAutomaticRetry", () => {
  it("classifies rate limit failures", () => {
    expect(
      classifyAutomaticRetry({
        errorMessage: "429 RESOURCE_EXHAUSTED: Too Many Requests",
      }),
    ).toEqual({
      reason: "rate_limited",
      maxAttempts: 2,
    });
  });

  it("classifies auth.json transient file failures only when auth.json context is present", () => {
    expect(
      classifyAutomaticRetry({
        errorMessage: "ENOENT: no such file or directory, unlink 'C:\\\\tmp\\\\codex-home\\\\auth.json'",
      }),
    ).toEqual({
      reason: "auth_file_transient",
      maxAttempts: 2,
    });

    expect(
      classifyAutomaticRetry({
        errorMessage: "ENOENT: no such file or directory, unlink 'C:\\\\tmp\\\\codex-home\\\\config.json'",
      }),
    ).toBeNull();
  });

  it("classifies browser busy failures", () => {
    expect(
      classifyAutomaticRetry({
        errorMessage: "Browser is already in use",
      }),
    ).toEqual({
      reason: "browser_busy",
      maxAttempts: 1,
    });
  });

  it("does not classify agent auth failures as transient retries", () => {
    expect(
      classifyAutomaticRetry({
        errorMessage: "Agent authentication required",
      }),
    ).toBeNull();
  });
});

describe("getRetryChainAttempt", () => {
  it("tracks retry attempts across the whole retry chain", () => {
    expect(
      getRetryChainAttempt({
        contextSnapshot: {
          retryAttempt: 2,
        },
        processLossRetryCount: 1,
      }),
    ).toBe(2);
  });

  it("falls back to processLossRetryCount for legacy process_lost retries", () => {
    expect(
      getRetryChainAttempt({
        contextSnapshot: null,
        processLossRetryCount: 1,
      }),
    ).toBe(1);
  });
});

describe("resolveAutomaticRetryPlan", () => {
  it("returns null after the retry chain reaches the max attempts", () => {
    const now = new Date("2026-04-05T10:00:00.000Z");
    expect(
      resolveAutomaticRetryPlan(
        {
          contextSnapshot: {
            retryAttempt: 2,
          },
          processLossRetryCount: 0,
        },
        {
          errorMessage: "429 Too Many Requests",
        },
        now,
      ),
    ).toBeNull();
  });

  it("computes delayed retry metadata for transient auth file failures", () => {
    const now = new Date("2026-04-05T10:00:00.000Z");
    expect(
      resolveAutomaticRetryPlan(
        {
          contextSnapshot: null,
          processLossRetryCount: 0,
        },
        {
          errorMessage: "unexpected token in C:\\\\tmp\\\\codex-home\\\\auth.json",
        },
        now,
      ),
    ).toMatchObject({
      reason: "auth_file_transient",
      attempt: 1,
      maxAttempts: 2,
      retryAfterMs: 10_000,
    });
  });
});

describe("resolveRunnableAutomaticRetryPlan", () => {
  it("drops delayed retries when the heartbeat scheduler is disabled", () => {
    const delayedPlan = {
      reason: "rate_limited" as const,
      attempt: 1,
      maxAttempts: 2,
      retryAfterMs: 30_000,
      retryNotBeforeAt: new Date("2026-04-05T10:00:30.000Z"),
    };

    expect(resolveRunnableAutomaticRetryPlan(delayedPlan, false)).toBeNull();
  });

  it("keeps delayed process_lost retries runnable when the heartbeat scheduler is enabled", () => {
    const immediatePlan = {
      reason: "process_lost" as const,
      attempt: 1,
      maxAttempts: 2,
      retryAfterMs: 5_000,
      retryNotBeforeAt: new Date("2026-04-05T10:00:05.000Z"),
    };

    expect(resolveRunnableAutomaticRetryPlan(immediatePlan, true)).toEqual(immediatePlan);
  });
});

describe("selectReadyQueuedRunsForStart", () => {
  it("does not let a delayed retry block later ready queued runs", () => {
    const now = new Date("2026-04-05T10:00:00.000Z");
    const runs = [
      {
        id: "run-delayed",
        createdAt: new Date("2026-04-05T09:59:00.000Z"),
        contextSnapshot: {
          retryNotBeforeAt: "2026-04-05T10:01:00.000Z",
        },
      },
      {
        id: "run-ready",
        createdAt: new Date("2026-04-05T09:59:30.000Z"),
        contextSnapshot: null,
      },
    ];

    expect(selectReadyQueuedRunsForStart(runs, now, 1).map((run) => run.id)).toEqual(["run-ready"]);
  });

  it("treats invalid retryNotBeforeAt values as ready instead of crashing queue selection", () => {
    const now = new Date("2026-04-05T10:00:00.000Z");
    const runs = [
      {
        id: "run-invalid-date",
        createdAt: new Date("2026-04-05T09:59:00.000Z"),
        contextSnapshot: {
          retryNotBeforeAt: "not-a-date",
        },
      },
    ];

    expect(selectReadyQueuedRunsForStart(runs, now, 1).map((run) => run.id)).toEqual(["run-invalid-date"]);
  });
});

describe("handleAutomaticRetryOrRelease", () => {
  it("falls back to release when enqueueing a retry fails", async () => {
    const plan = {
      reason: "browser_busy" as const,
      attempt: 1,
      maxAttempts: 1,
      retryAfterMs: 10_000,
      retryNotBeforeAt: new Date("2026-04-05T10:00:10.000Z"),
    };
    const enqueueRetry = vi.fn(async () => {
      throw new Error("db unavailable");
    });
    const release = vi.fn(async () => undefined);
    const onRetryEnqueueFailure = vi.fn(async () => undefined);

    const result = await handleAutomaticRetryOrRelease({
      plan,
      enqueueRetry,
      release,
      onRetryEnqueueFailure,
    });

    expect(result).toEqual({ action: "released", retriedRun: null, retryEnqueueFailed: true });
    expect(enqueueRetry).toHaveBeenCalledTimes(1);
    expect(onRetryEnqueueFailure).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
