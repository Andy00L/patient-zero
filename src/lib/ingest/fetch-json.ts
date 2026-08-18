import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { z } from "zod";

import {
  type Failure,
  type Result,
  fail,
  fromThrowingSync,
  succeed,
} from "@/lib/result";

/**
 * The one HTTP door every ingest client goes through.
 *
 * Four public APIs feed this project (registry.npmjs.org, api.npmjs.org,
 * api.deps.dev, api.osv.dev). Retry policy, timeouts, the response size cap, the
 * on-disk cache and the mapping from an HTTP status onto a FailureReason live here
 * and nowhere else, so a change in etiquette is a one-file change and no client can
 * quietly disagree with another about what a 429 means.
 *
 * None of the four APIs takes a credential: no API key, no bearer token, no signed
 * URL. That is why a request path may appear in a Failure context below. The query
 * string is still dropped, because that is where a credential would land first if any
 * of these services ever grew one.
 *
 * Etiquette actually documented by the upstreams, checked 2026-08-17:
 *   - OSV: "Currently there are no limits on the API", plus a 32 MiB response ceiling
 *     on HTTP/1.1 and a recommendation to use HTTP/2 for large queries.
 *     sourceRef: https://google.github.io/osv.dev/api/
 *   - deps.dev: no rate limit or user-agent requirement published; caching is
 *     explicitly allowed ("Clients are expressly permitted to cache data served by
 *     the API"), which is what the on-disk cache below relies on.
 *     sourceRef: https://docs.deps.dev/api/v3/
 *   - npm registry and api.npmjs.org: no rate limit or user-agent requirement in the
 *     registry docs; the download endpoint documents only per-request size caps.
 *     sourceRef: https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md
 * No upstream asks for a specific user-agent, so the one below is courtesy: it names
 * the project and its repository so an operator can identify and contact the client.
 */

/** Injected so tests can stub the network without a live socket. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Injected so a retry test can assert the requested delay without waiting for it. */
export type SleepLike = (durationMs: number) => Promise<void>;

/** Per-request timeout. Generous because a cold packument for a large package is slow. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Total tries including the first. 4 tries spans roughly 0.5s + 1s + 2s of backoff. */
const DEFAULT_MAX_ATTEMPTS = 4;

/**
 * Wall-clock ceiling across all attempts of one request. An ingest run fans out over
 * thousands of packages, so one unreachable host must not hold a slot open for minutes.
 */
const TOTAL_ELAPSED_BUDGET_MS = 120_000;

/** First backoff step, doubled per retry and capped by MAX_BACKOFF_MS. */
const INITIAL_BACKOFF_MS = 500;

/** Multiplier applied per retry: 500ms, 1s, 2s, 4s, then flat at MAX_BACKOFF_MS. */
const BACKOFF_MULTIPLIER = 2;

/** Upper bound on one backoff step, so the cap on total attempts is what ends a retry loop. */
const MAX_BACKOFF_MS = 8_000;

/**
 * Ceiling on an honoured Retry-After. A misconfigured proxy can answer with hours;
 * waiting that long inside an ingest is the same as hanging.
 */
const MAX_HONOURED_RETRY_AFTER_MS = 60_000;

/**
 * Response body cap, in bytes: 32 MiB.
 *
 * Sized from measured reality, not a guess. The largest packuments actually observed
 * on 2026-08-17 were typescript at 15,564,188 bytes and @types/node at 11,088,606
 * bytes, and the npm docs warn that "For some packages in the registry, the full
 * metadata is over 10MB uncompressed". 32 MiB leaves roughly 2x headroom over the
 * largest real packument and coincides with the 32 MiB response ceiling OSV documents
 * for HTTP/1.1, so no legitimate response from these four APIs can exceed it.
 * sourceRef: https://github.com/npm/registry/blob/main/docs/responses/package-metadata.md
 * sourceRef: https://google.github.io/osv.dev/api/
 */
const MAX_RESPONSE_BYTES = 33_554_432;

/**
 * Default parallel in-flight requests. Deliberately small: none of the four APIs
 * publishes a rate limit, so the polite reading is that they do not expect a few
 * hundred simultaneous connections from one ingest.
 */
const DEFAULT_CONCURRENCY = 8;

/** Bound on server-controlled text copied into a Failure message or a log line. */
const MAX_ERROR_DETAIL_LENGTH = 200;

/** Number of schema issues named in a validation Failure before the list is truncated. */
const MAX_REPORTED_SCHEMA_ISSUES = 3;

/** Courtesy identification. No upstream requires a specific value (see the file header). */
const USER_AGENT = "patient-zero/0.1.0 (+https://github.com/Andy00L/patient-zero)";

/** Statuses that are worth another try. Everything else in 4xx is a permanent answer. */
const RETRYABLE_STATUS = 429;

/** On-disk cache of a single response body. */
export type ResponseCacheOptions = {
  /** Caller-supplied directory. Nothing is ever written outside it. */
  directory: string;
  /** Entries older than this are treated as a miss. */
  maxAgeMs: number;
};

/** Knobs every client forwards from its own options object. */
export type HttpClientOptions = {
  fetchImpl?: FetchLike;
  sleepImpl?: SleepLike;
  timeoutMs?: number;
  maxAttempts?: number;
  maxResponseBytes?: number;
  cache?: ResponseCacheOptions | null;
};

export type JsonRequest = HttpClientOptions & {
  url: string;
  method?: "GET" | "POST";
  /** JSON-encoded when present. Also part of the cache key, because OSV queries POST. */
  body?: unknown;
  headers?: Record<string, string>;
};

/** What the cache file holds. `fetchedAtMs` is what lets a caller expire an entry. */
const CACHE_ENVELOPE_SCHEMA = z.object({
  url: z.string(),
  fetchedAtMs: z.number(),
  body: z.string(),
});

export type CachedResponseEnvelope = z.infer<typeof CACHE_ENVELOPE_SCHEMA>;

/**
 * Fetches JSON and validates it with a caller-supplied schema.
 *
 * The schema is mandatory on purpose. These are public APIs this project does not
 * control; a field that changes name or type must surface here as a typed Failure
 * naming the field path, not as an undefined read three modules deeper inside the
 * graph loader.
 */
export async function fetchJson<TParsed>(
  request: JsonRequest,
  schema: z.ZodType<TParsed>,
): Promise<Result<TParsed, Failure>> {
  const fetched = await fetchJsonText(request);
  if (!fetched.ok) return fetched;

  const host = readHost(request.url);
  return parseAndValidate(fetched.value, schema, host);
}

/**
 * The transport half of `fetchJson`: retry, timeout, size cap and cache, returning the
 * raw body text. Exported for the rare caller that needs the text before validation.
 */
export async function fetchJsonText(request: JsonRequest): Promise<Result<string, Failure>> {
  const method = request.method ?? "GET";
  const bodyText = request.body === undefined ? null : JSON.stringify(request.body);
  const host = readHost(request.url);
  const path = readSafePath(request.url);
  const maxAttempts = Math.max(1, request.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const maxResponseBytes = request.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const performFetch = request.fetchImpl ?? globalThis.fetch;
  const waitFor = request.sleepImpl ?? sleepFor;
  const cacheKey = buildCacheKey(method, request.url, bodyText);

  if (request.cache != null) {
    const cached = await readCachedBody(request.cache, cacheKey, Date.now());
    if (cached !== null) return succeed(cached);
  }

  const startedAtMs = Date.now();
  let lastFailure: Failure = {
    reason: "internal",
    message: `[fetchJsonText] ${host} produced no attempt`,
  };

  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
    const outcome = await runOneAttempt({
      url: request.url,
      method,
      bodyText,
      headers: request.headers,
      timeoutMs,
      maxResponseBytes,
      performFetch,
      host,
      path,
    });

    if (outcome.kind === "success") {
      if (request.cache != null) {
        await writeCachedBody(request.cache, cacheKey, request.url, outcome.body, Date.now());
      }
      return succeed(outcome.body);
    }

    if (outcome.kind === "terminal") return { ok: false, failure: outcome.failure };

    lastFailure = outcome.failure;

    const isLastAttempt = attemptIndex === maxAttempts - 1;
    if (isLastAttempt) break;

    const backoffMs =
      outcome.retryAfterMs ?? computeBackoffMs(attemptIndex, Math.random());
    const elapsedMs = Date.now() - startedAtMs;
    if (elapsedMs + backoffMs > TOTAL_ELAPSED_BUDGET_MS) {
      console.warn(
        `[fetchJsonText] ${host} giving up after ${elapsedMs}ms, elapsed budget is ${TOTAL_ELAPSED_BUDGET_MS}ms`,
      );
      break;
    }

    await waitFor(backoffMs);
  }

  return { ok: false, failure: lastFailure };
}

type AttemptInput = {
  url: string;
  method: "GET" | "POST";
  bodyText: string | null;
  headers: Record<string, string> | undefined;
  timeoutMs: number;
  maxResponseBytes: number;
  performFetch: FetchLike;
  host: string;
  path: string;
};

type AttemptOutcome =
  | { kind: "success"; body: string }
  /** Worth another try: a network error, a 429, or a 5xx. */
  | { kind: "retryable"; failure: Failure; retryAfterMs: number | null }
  /** A permanent answer. Retrying a 404 only makes the failure slower. */
  | { kind: "terminal"; failure: Failure };

async function runOneAttempt(input: AttemptInput): Promise<AttemptOutcome> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": USER_AGENT,
    ...input.headers,
  };
  if (input.bodyText !== null) headers["content-type"] = "application/json";

  const requestInit: RequestInit = {
    method: input.method,
    headers,
    // A fresh signal per attempt: an AbortSignal cannot be reused once it has fired.
    signal: AbortSignal.timeout(input.timeoutMs),
  };
  if (input.bodyText !== null) requestInit.body = input.bodyText;

  let response: Response;
  try {
    response = await input.performFetch(input.url, requestInit);
  } catch (caught) {
    const isTimeout =
      caught instanceof Error && (caught.name === "TimeoutError" || caught.name === "AbortError");
    return {
      kind: "retryable",
      failure: {
        reason: isTimeout ? "timeout" : "upstream_unavailable",
        message: isTimeout
          ? `[runOneAttempt] ${input.host} did not answer within ${input.timeoutMs}ms`
          : `[runOneAttempt] cannot reach ${input.host}: ${describeNetworkError(caught)}`,
        context: { host: input.host, path: input.path },
      },
      retryAfterMs: null,
    };
  }

  const bodyResult = await readBodyWithinCap(response, input.maxResponseBytes, input.host, input.path);
  if (!bodyResult.ok) return { kind: "terminal", failure: bodyResult.failure };

  if (response.ok) return { kind: "success", body: bodyResult.value };

  const failure = describeErrorStatus(response.status, bodyResult.value, input.host, input.path);
  const isRetryableStatus = response.status === RETRYABLE_STATUS || response.status >= 500;
  if (!isRetryableStatus) return { kind: "terminal", failure };

  return {
    kind: "retryable",
    failure,
    retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after"), Date.now()),
  };
}

/**
 * Reads the body while refusing to buffer more than the cap.
 *
 * A hostile or broken endpoint answering with an endless stream must not be able to
 * exhaust the process, and an ingest of thousands of packages gives it thousands of
 * chances. Content-Length is the cheap check; the streaming count is the real one,
 * because the header is a claim and a chunked response has no header at all.
 */
async function readBodyWithinCap(
  response: Response,
  maxBytes: number,
  host: string,
  path: string,
): Promise<Result<string, Failure>> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isSafeInteger(declaredLength) && declaredLength > maxBytes) {
    return fail(
      "invalid_input",
      `[readBodyWithinCap] ${host} declared ${declaredLength} bytes, over the ${maxBytes} byte cap`,
      { status: response.status, context: { host, path, declaredLength } },
    );
  }

  const stream = response.body;
  if (stream === null) {
    const text = await response.text();
    const byteLength = new TextEncoder().encode(text).byteLength;
    if (byteLength > maxBytes) {
      return fail(
        "invalid_input",
        `[readBodyWithinCap] ${host} returned ${byteLength} bytes, over the ${maxBytes} byte cap`,
        { status: response.status, context: { host, path } },
      );
    }
    return succeed(text);
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;

  for (;;) {
    const step = await reader.read();
    if (step.done) break;

    totalBytes += step.value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      return fail(
        "invalid_input",
        `[readBodyWithinCap] ${host} exceeded the ${maxBytes} byte response cap`,
        { status: response.status, context: { host, path, bytesRead: totalBytes } },
      );
    }
    chunks.push(decoder.decode(step.value, { stream: true }));
  }

  chunks.push(decoder.decode());
  return succeed(chunks.join(""));
}

/**
 * Maps an HTTP status onto a FailureReason.
 *
 * 404 and 410 become `not_found` because "this package does not exist" is a normal,
 * expected answer during an ingest of a candidate list, not an outage.
 */
function describeErrorStatus(
  status: number,
  bodyText: string,
  host: string,
  path: string,
): Failure {
  const detail = truncateDetail(bodyText.trim());
  const context: Record<string, string | number> = { host, path, status };

  if (status === 404 || status === 410) {
    return {
      reason: "not_found",
      message: `[describeErrorStatus] ${host} has no such resource (status ${status})`,
      status,
      context,
    };
  }
  if (status === RETRYABLE_STATUS) {
    return {
      reason: "rate_limited",
      message: `[describeErrorStatus] ${host} rate limited the request (status ${status})`,
      status,
      context,
    };
  }
  if (status >= 500) {
    return {
      reason: "upstream_unavailable",
      message: `[describeErrorStatus] ${host} returned status ${status}: ${detail}`,
      status,
      context,
    };
  }
  return {
    reason: "upstream_rejected",
    message: `[describeErrorStatus] ${host} rejected the request with status ${status}: ${detail}`,
    status,
    context,
  };
}

/**
 * Parses a Retry-After header. RFC 9110 allows either delay-seconds or an HTTP date,
 * and both forms show up in the wild behind CDNs, so both are handled.
 * sourceRef: https://www.rfc-editor.org/rfc/rfc9110#field.retry-after
 */
export function parseRetryAfterMs(headerValue: string | null, nowMs: number): number | null {
  if (headerValue === null) return null;
  const trimmed = headerValue.trim();
  if (trimmed.length === 0) return null;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isSafeInteger(seconds)) return null;
    return Math.min(seconds * 1_000, MAX_HONOURED_RETRY_AFTER_MS);
  }

  const targetMs = Date.parse(trimmed);
  if (Number.isNaN(targetMs)) return null;
  const waitMs = targetMs - nowMs;
  if (waitMs <= 0) return 0;
  return Math.min(waitMs, MAX_HONOURED_RETRY_AFTER_MS);
}

/**
 * Exponential backoff with full jitter. `randomFraction` is a parameter rather than an
 * inlined Math.random() so the schedule is a pure function and can be asserted.
 */
export function computeBackoffMs(attemptIndex: number, randomFraction: number): number {
  const ceiling = Math.min(
    MAX_BACKOFF_MS,
    INITIAL_BACKOFF_MS * BACKOFF_MULTIPLIER ** attemptIndex,
  );
  // Full jitter spreads a fleet of retries instead of aligning them on the same tick.
  return Math.round(ceiling * Math.min(1, Math.max(0, randomFraction)));
}

function parseAndValidate<TParsed>(
  bodyText: string,
  schema: z.ZodType<TParsed>,
  host: string,
): Result<TParsed, Failure> {
  const parsed = fromThrowingSync<unknown>(
    "upstream_rejected",
    `[parseAndValidate] ${host} returned a body that is not JSON`,
    () => JSON.parse(bodyText) as unknown,
  );
  if (!parsed.ok) return parsed;

  const validated = schema.safeParse(parsed.value);
  if (validated.success) return succeed(validated.data);

  return fail("upstream_rejected", `[parseAndValidate] ${host} returned an unexpected shape: ${describeSchemaIssues(validated.error)}`, {
    context: { host, issueCount: validated.error.issues.length },
  });
}

/**
 * Renders the failing field paths. The path is the actionable part: it says which
 * upstream field moved, which is the difference between a five minute fix and an hour
 * of diffing JSON by hand.
 */
export function describeSchemaIssues(error: z.ZodError): string {
  const rendered = error.issues.slice(0, MAX_REPORTED_SCHEMA_ISSUES).map((issue) => {
    const fieldPath = issue.path.length === 0 ? "(root)" : issue.path.join(".");
    return `${fieldPath}: ${issue.message}`;
  });
  const omitted = error.issues.length - rendered.length;
  return omitted > 0 ? `${rendered.join("; ")} (+${omitted} more)` : rendered.join("; ");
}

// ---------------------------------------------------------------------------
// Concurrency limiter
// ---------------------------------------------------------------------------

export type ConcurrencyLimiter = {
  /** Runs `task` once a slot is free. Rejections propagate but always free the slot. */
  run: <TValue>(task: () => Promise<TValue>) => Promise<TValue>;
  /** In-flight tasks right now. Useful for a progress line during an ingest. */
  readActiveCount: () => number;
};

/**
 * A counting semaphore for fanning out a few hundred package fetches without opening a
 * few hundred sockets at once. `maxConcurrent` is clamped to at least 1 rather than
 * returning a Result: a caller passing 0 wants the limiter, not a stalled queue.
 */
export function createConcurrencyLimiter(
  maxConcurrent: number = DEFAULT_CONCURRENCY,
): ConcurrencyLimiter {
  const limit = Math.max(1, Math.floor(maxConcurrent));
  const waiting: (() => void)[] = [];
  let activeCount = 0;

  const releaseSlot = (): void => {
    activeCount -= 1;
    const next = waiting.shift();
    if (next !== undefined) next();
  };

  const acquireSlot = async (): Promise<void> => {
    if (activeCount < limit) {
      activeCount += 1;
      return;
    }
    await new Promise<void>((resolveSlot) => {
      waiting.push(() => {
        activeCount += 1;
        resolveSlot();
      });
    });
  };

  return {
    run: async <TValue>(task: () => Promise<TValue>): Promise<TValue> => {
      await acquireSlot();
      try {
        return await task();
      } finally {
        releaseSlot();
      }
    },
    readActiveCount: () => activeCount,
  };
}

// ---------------------------------------------------------------------------
// On-disk response cache
// ---------------------------------------------------------------------------

/**
 * Cache key: a hex SHA-256 of method, URL and body. The body belongs in the key because
 * OSV addresses everything through POST /v1/query, so two requests to the same URL with
 * different bodies are different resources.
 */
function buildCacheKey(method: string, url: string, bodyText: string | null): string {
  return createHash("sha256").update(`${method} ${url}\n${bodyText ?? ""}`).digest("hex");
}

/**
 * Resolves a cache entry path inside the caller's directory.
 *
 * The containment check is cheap insurance rather than a live threat: the key is hex
 * from a hash, so it cannot traverse. It states the invariant that this module writes
 * only under the directory it was handed, never a default path elsewhere on the disk.
 */
function resolveCacheEntryPath(directory: string, cacheKey: string): Result<string, Failure> {
  const root = resolve(directory);
  const entryPath = resolve(join(root, `${cacheKey}.json`));
  if (entryPath !== root && !entryPath.startsWith(`${root}${sep}`)) {
    return fail(
      "invalid_input",
      "[resolveCacheEntryPath] cache entry resolved outside the caller's directory",
    );
  }
  return succeed(entryPath);
}

/** A miss and a corrupt entry are the same thing to the caller: null, then refetch. */
async function readCachedBody(
  cache: ResponseCacheOptions,
  cacheKey: string,
  nowMs: number,
): Promise<string | null> {
  const entryPath = resolveCacheEntryPath(cache.directory, cacheKey);
  if (!entryPath.ok) return null;

  let rawText: string;
  try {
    rawText = await readFile(entryPath.value, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText) as unknown;
  } catch {
    return null;
  }

  const envelope = CACHE_ENVELOPE_SCHEMA.safeParse(parsed);
  if (!envelope.success) return null;
  if (nowMs - envelope.data.fetchedAtMs > cache.maxAgeMs) return null;

  return envelope.data.body;
}

/** A cache write failure is logged and swallowed: the response is already in hand. */
async function writeCachedBody(
  cache: ResponseCacheOptions,
  cacheKey: string,
  url: string,
  body: string,
  nowMs: number,
): Promise<void> {
  const entryPath = resolveCacheEntryPath(cache.directory, cacheKey);
  if (!entryPath.ok) {
    console.warn(`[writeCachedBody] ${entryPath.failure.message}`);
    return;
  }

  const envelope: CachedResponseEnvelope = { url, fetchedAtMs: nowMs, body };
  try {
    await mkdir(resolve(cache.directory), { recursive: true });
    await writeFile(entryPath.value, JSON.stringify(envelope), "utf8");
  } catch (caught) {
    console.warn(
      `[writeCachedBody] could not cache ${readHost(url)} response: ${describeNetworkError(caught)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function sleepFor(durationMs: number): Promise<void> {
  return new Promise((resolveTimer) => setTimeout(resolveTimer, durationMs));
}

/** Host only. A Failure message never carries the full URL (see the file header). */
export function readHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unparseable-url";
  }
}

/** Path without the query string, which is where a credential would appear if added. */
function readSafePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "/";
  }
}

function truncateDetail(value: string): string {
  if (value.length === 0) return "no detail";
  return value.length > MAX_ERROR_DETAIL_LENGTH
    ? `${value.slice(0, MAX_ERROR_DETAIL_LENGTH)}...`
    : value;
}

function describeNetworkError(caught: unknown): string {
  if (caught instanceof Error) return truncateDetail(caught.message);
  return "non-error value thrown";
}

/**
 * Parses an upstream ISO-8601 timestamp into epoch milliseconds. Shared because all
 * four APIs date things this way and every client needs the same "absent stays absent"
 * behaviour, which the graph writer turns into the -1 sentinel.
 */
export function parseTimestampMs(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.length === 0) return null;
  const parsedMs = Date.parse(value);
  return Number.isNaN(parsedMs) ? null : parsedMs;
}
