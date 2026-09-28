export const OBSERVATION_FAILURE_CATEGORIES = [
  "transport",
  "http-5xx",
  "http-error",
  "non-json",
  "rate-limited",
  "state-unavailable",
  "timeout",
  "chain-mismatch",
  "invalid-response",
  "reverted",
  "rpc-error",
  "unknown",
] as const;
export type ObservationFailureCategory = (typeof OBSERVATION_FAILURE_CATEGORIES)[number];

/** Safe diagnostics only. Endpoint is its zero-based index in the configured URL pool. */
export interface ObservationAttempt {
  readonly endpoint: number;
  readonly category: ObservationFailureCategory;
  readonly rpcCode: number | null;
  readonly httpStatus: number | null;
}
export interface ObservationCause {
  readonly attempts: readonly ObservationAttempt[];
}

const retained = new WeakMap<object, ObservationCause | null>();

export class MoesiObservationError extends Error {
  readonly code: "observation_failed" | "observation_aborted" | "invalid_observer_configuration";
  override readonly cause: ObservationCause | null;

  constructor(code: MoesiObservationError["code"], cause: ObservationCause | null = null) {
    super(code);
    this.name = "MoesiObservationError";
    this.code = code;
    this.cause = cause === null ? null : parseObservationCause(cause);
    retained.set(this, this.cause);
  }
}

/** Parse serialized diagnostics without admitting provider prose, URLs, or accessors. */
export function parseObservationCause(value: unknown): ObservationCause {
  const invalid = () => {
    throw new Error("invalid_observation_cause");
  };
  function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (
      Object.keys(descriptors).length !== keys.length ||
      keys.some((key) => !descriptors[key] || !("value" in descriptors[key]!))
    )
      return invalid();
    return Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value]));
  }
  try {
    const source = record(value, ["attempts"]);
    if (
      !Array.isArray(source.attempts) ||
      source.attempts.length < 1 ||
      source.attempts.length > 16
    )
      return invalid();
    const attempts: ObservationAttempt[] = [];
    for (let i = 0; i < source.attempts.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(source.attempts, i);
      if (!descriptor || !("value" in descriptor)) return invalid();
      const entry = record(descriptor.value, ["endpoint", "category", "rpcCode", "httpStatus"]);
      if (
        typeof entry.endpoint !== "number" ||
        !Number.isInteger(entry.endpoint) ||
        entry.endpoint < 0 ||
        entry.endpoint > 31 ||
        !OBSERVATION_FAILURE_CATEGORIES.includes(entry.category as ObservationFailureCategory) ||
        (entry.rpcCode !== null &&
          (typeof entry.rpcCode !== "number" || !Number.isSafeInteger(entry.rpcCode))) ||
        (entry.httpStatus !== null &&
          (typeof entry.httpStatus !== "number" ||
            !Number.isInteger(entry.httpStatus) ||
            entry.httpStatus < 100 ||
            entry.httpStatus > 599))
      )
        return invalid();
      attempts.push(entry as unknown as ObservationAttempt);
    }
    return Object.freeze({
      attempts: Object.freeze(attempts.map((attempt) => Object.freeze(attempt))),
    });
  } catch {
    return invalid();
  }
}

export function observationCause(error: unknown): ObservationCause | null {
  if (typeof error !== "object" || error === null) return null;
  if (retained.has(error)) return retained.get(error) ?? null;
  try {
    return parseObservationCause(Object.getOwnPropertyDescriptor(error, "cause")?.value);
  } catch {
    return null;
  }
}

export function throwIfObservationAborted(error: unknown): void {
  if (error instanceof MoesiObservationError && error.code === "observation_aborted") throw error;
}

export function withObservationAbort<T>(
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (signal === undefined) return run();
  if (!(signal instanceof AbortSignal))
    throw new MoesiObservationError("invalid_observer_configuration");
  if (signal.aborted) return Promise.reject(new MoesiObservationError("observation_aborted"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new MoesiObservationError("observation_aborted"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        if (signal.aborted) throw new MoesiObservationError("observation_aborted");
        return run();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
