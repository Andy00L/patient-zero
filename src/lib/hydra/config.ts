import { type Failure, type Result, fail, succeed } from "@/lib/result";

/**
 * Connection configuration for HydraDB, read from the environment.
 *
 * Every default here was read from the HydraDB source, not from memory. The facts
 * and their file references are collected in docs/HYDRADB.md; the ones that decide
 * a value below are cited inline.
 *
 * The auth token is the one secret in this file. It is never logged, never
 * returned in an error message, and never sent to the browser: only server code
 * imports this module.
 */

export type HydraTransportKind = "http" | "bolt";

export type HydraConfig = {
  transport: HydraTransportKind;
  /** Base URL of the query API, for the http transport. */
  httpBaseUrl: string;
  /** Bolt URI, for the bolt transport. */
  boltUri: string;
  /**
   * Shared auth token. HydraDB requires at least 32 non-placeholder characters
   * and refuses to start otherwise.
   * sourceRef: HydraDB src/bin/graph_node/config.rs read_auth_token.
   */
  authToken: string;
  /** Matches GRAPH_ID on the server. Part of the HTTP query path. */
  graphId: string;
  /**
   * Matches GRAPH_NAMESPACE. Sent as the X-Graph-Namespace header, which the
   * server compares for equality.
   * sourceRef: HydraDB src/client/http.rs.
   */
  namespace: string;
  /**
   * Matches one entry of GRAPH_CELLS. Mandatory in every HTTP request body,
   * with no server-side default.
   * sourceRef: HydraDB src/client/http.rs request body.
   */
  cellId: string;
  /** Bolt database name, matching GRAPH_DATABASE. */
  database: string;
  /** Per-query timeout in milliseconds. */
  queryTimeoutMs: number;
  /**
   * Rows per page for cursor pagination. Set explicitly because the HTTP
   * transport default (256) and the server config default (1024) differ.
   * sourceRef: HydraDB src/client/http.rs DEFAULT_HTTP_PAGE_SIZE, and
   * src/bin/graph_node/config.rs GRAPH_DEFAULT_PAGE_SIZE.
   */
  pageSize: number;
};

/**
 * HydraDB caps an HTTP request body at 1 MiB by default, which directly bounds
 * how many rows one UNWIND batch can carry over that transport.
 * sourceRef: HydraDB src/client/http.rs DEFAULT_HTTP_MAX_BODY_BYTES.
 */
export const HTTP_MAX_BODY_BYTES = 1_048_576;

/**
 * Leave headroom under the 1 MiB cap for the JSON envelope around the rows
 * (query text, cell id, cursor). 90 percent is generous for a batch whose rows
 * dominate the payload.
 */
export const HTTP_BATCH_BUDGET_BYTES = Math.floor(HTTP_MAX_BODY_BYTES * 0.9);

/**
 * Longest query text the running engine accepts, in UTF-8 bytes.
 *
 * This one is measured rather than read off a constant, because no constant upstream
 * carries it: `max_query_bytes` defaults to 1 MiB and the HTTP body limit is 1 MiB, yet
 * a 1,025 byte statement is rejected while a 1,024 byte statement answers. Bisected
 * against the running node by padding one valid statement with trailing spaces, which
 * changes nothing but its length: 1,024 answers 200, 1,025 answers 400.
 *
 * Over the limit the statement is not refused for being long. It is parsed truncated,
 * so the engine complains about wherever the cut happened to land, and it lands
 * somewhere different for every statement. All three of these came from the same cause:
 *
 *   OpenCypher parse error: Invalid input '(': expected ',', ORDER BY, SKIP, LIMIT
 *   OpenCypher parse error: Invalid input at end of input: expected a label
 *   row execution currently supports MATCH/WITH clauses followed by RETURN
 *
 * None of them says "too long", and the last one arrives on a statement that is
 * MATCH followed by RETURN. That is why this is enforced client side, once, in
 * cypher.ts: a builder that emits 1,025 bytes gets a Failure naming the byte count,
 * instead of a caller three layers up trying to explain a parse error it did not cause.
 *
 * Applies to the query text only. Parameters travel in the JSON body beside it and are
 * bounded by HTTP_MAX_BODY_BYTES, which is why the batch writers pass their rows as
 * `$rows` and are unaffected by this at any batch size.
 */
export const MAX_QUERY_TEXT_BYTES = 1_024;

/**
 * The engine rejects a traversal whose maxLen exceeds this, and silently defaults
 * to it when maxLen is omitted. Never omit maxLen: an unstated 16 hop traversal
 * over a dependency graph is not a query anyone intended.
 * sourceRef: HydraDB src/core/config.rs GraphLimits.max_traversal_hops = 16.
 */
export const MAX_TRAVERSAL_HOPS = 16;

/**
 * Result vertex cap. A traversal asking for more paths than this is rejected with
 * AdmissionRejected rather than truncated silently.
 * sourceRef: HydraDB src/core/config.rs GraphLimits.max_query_result_vertices.
 */
export const MAX_QUERY_RESULT_VERTICES = 100_000;

/** Minimum token length the server enforces before it will start. */
const MIN_AUTH_TOKEN_LENGTH = 32;

/** Rejected by the server as a placeholder, whatever the length. */
const PLACEHOLDER_TOKEN_MARKER = "change-me";

export function readHydraConfigFromEnv(
  environment: Record<string, string | undefined> = process.env,
): Result<HydraConfig, Failure> {
  const transportValue = environment.HYDRA_TRANSPORT ?? "http";
  if (transportValue !== "http" && transportValue !== "bolt") {
    return fail(
      "invalid_input",
      `[readHydraConfigFromEnv] HYDRA_TRANSPORT must be "http" or "bolt", got "${transportValue}"`,
    );
  }

  const authToken = environment.HYDRA_AUTH_TOKEN ?? "";
  if (authToken.length < MIN_AUTH_TOKEN_LENGTH) {
    return fail(
      "invalid_input",
      `[readHydraConfigFromEnv] HYDRA_AUTH_TOKEN must be at least ${MIN_AUTH_TOKEN_LENGTH} characters, got ${authToken.length}`,
    );
  }
  if (authToken.includes(PLACEHOLDER_TOKEN_MARKER)) {
    return fail(
      "invalid_input",
      `[readHydraConfigFromEnv] HYDRA_AUTH_TOKEN still contains the placeholder marker "${PLACEHOLDER_TOKEN_MARKER}"`,
    );
  }

  const queryTimeoutMs = readPositiveInteger(environment.HYDRA_QUERY_TIMEOUT_MS, 30_000);
  if (!queryTimeoutMs.ok) return queryTimeoutMs;

  const pageSize = readPositiveInteger(environment.HYDRA_PAGE_SIZE, 1_024);
  if (!pageSize.ok) return pageSize;

  return succeed({
    transport: transportValue,
    httpBaseUrl: stripTrailingSlash(environment.HYDRA_HTTP_URL ?? "http://127.0.0.1:8443"),
    boltUri: environment.HYDRA_BOLT_URL ?? "bolt://127.0.0.1:7687",
    authToken,
    graphId: environment.HYDRA_GRAPH_ID ?? "default",
    namespace: environment.HYDRA_NAMESPACE ?? "default",
    cellId: environment.HYDRA_CELL_ID ?? "cell-0",
    database: environment.HYDRA_DATABASE ?? "default",
    queryTimeoutMs: queryTimeoutMs.value,
    pageSize: pageSize.value,
  });
}

/**
 * Where the app reads a graph snapshot when no HydraDB is reachable. Set
 * HYDRA_SNAPSHOT_PATH to run the UI against an exported slice; the UI states
 * which source answered every query, so a snapshot answer is never presented as
 * a live one.
 */
export function readSnapshotPathFromEnv(
  environment: Record<string, string | undefined> = process.env,
): string | null {
  const path = environment.HYDRA_SNAPSHOT_PATH;
  return path === undefined || path.length === 0 ? null : path;
}

function readPositiveInteger(
  raw: string | undefined,
  fallbackValue: number,
): Result<number, Failure> {
  if (raw === undefined || raw.length === 0) return succeed(fallbackValue);

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fail("invalid_input", `[readPositiveInteger] expected a positive integer, got "${raw}"`);
  }
  return succeed(parsed);
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * Redacts a token for logs. HydraDB tokens are shared secrets, so only the length
 * is ever safe to record.
 */
export function describeTokenForLog(token: string): string {
  return `<token:${token.length} chars>`;
}
