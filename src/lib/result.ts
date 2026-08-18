/**
 * Errors as values. Business logic in this project never throws: every function
 * that can fail returns a Result and the caller branches on `ok`.
 *
 * The only code allowed to throw is the boundary that talks to a library which
 * throws by design (the Bolt driver, JSON.parse); those throws are caught at the
 * boundary and converted into a Result immediately.
 */

export type Result<TValue, TFailure = Failure> =
  | { ok: true; value: TValue }
  | { ok: false; failure: TFailure };

/** Machine-readable failure. `reason` is the discriminant callers branch on. */
export type Failure = {
  reason: FailureReason;
  message: string;
  /** Set when the failure came from an upstream HTTP call. */
  status?: number;
  /** Free-form context for logs. Never carries secrets or tokens. */
  context?: Record<string, string | number | boolean>;
};

export type FailureReason =
  | "not_found"
  | "invalid_input"
  | "upstream_unavailable"
  | "upstream_rejected"
  | "rate_limited"
  | "graph_unavailable"
  | "graph_rejected"
  | "query_budget_exceeded"
  | "timeout"
  | "unsupported"
  | "internal";

export function succeed<TValue>(value: TValue): Result<TValue, never> {
  return { ok: true, value };
}

export function fail(
  reason: FailureReason,
  message: string,
  extra?: { status?: number; context?: Record<string, string | number | boolean> },
): Result<never, Failure> {
  const failure: Failure = { reason, message };
  if (extra?.status !== undefined) failure.status = extra.status;
  if (extra?.context !== undefined) failure.context = extra.context;
  return { ok: false, failure };
}

/**
 * Wraps a throwing boundary (a driver call, a parser) into a Result. Every
 * `try/catch` in this codebase goes through here so the conversion is uniform.
 */
export async function fromThrowing<TValue>(
  reason: FailureReason,
  message: string,
  run: () => Promise<TValue>,
): Promise<Result<TValue, Failure>> {
  try {
    return succeed(await run());
  } catch (caught) {
    return fail(reason, `${message}: ${describeThrown(caught)}`);
  }
}

/** Synchronous sibling of `fromThrowing`, for parsers. */
export function fromThrowingSync<TValue>(
  reason: FailureReason,
  message: string,
  run: () => TValue,
): Result<TValue, Failure> {
  try {
    return succeed(run());
  } catch (caught) {
    return fail(reason, `${message}: ${describeThrown(caught)}`);
  }
}

/** Turns an unknown thrown value into a log-safe string. */
export function describeThrown(caught: unknown): string {
  if (caught instanceof Error) return caught.message;
  if (typeof caught === "string") return caught;
  return "non-error value thrown";
}

/**
 * Collects a list of Results into a Result of a list, failing on the first
 * failure. Use when a partial result is not meaningful.
 */
export function collect<TValue>(
  results: readonly Result<TValue, Failure>[],
): Result<TValue[], Failure> {
  const values: TValue[] = [];
  for (const result of results) {
    if (!result.ok) return result;
    values.push(result.value);
  }
  return succeed(values);
}

/**
 * Splits a list of Results into successes and failures. Use for ingestion,
 * where one unreachable package must not abort the whole batch.
 */
export function partition<TValue>(
  results: readonly Result<TValue, Failure>[],
): { values: TValue[]; failures: Failure[] } {
  const values: TValue[] = [];
  const failures: Failure[] = [];
  for (const result of results) {
    if (result.ok) values.push(result.value);
    else failures.push(result.failure);
  }
  return { values, failures };
}
