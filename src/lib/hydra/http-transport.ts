import { HTTP_MAX_BODY_BYTES, type HydraConfig } from "@/lib/hydra/config";
import type { GraphStatement, GraphTransport, StatementParameterValue } from "@/lib/hydra/transport";
import { type DecodedRow, decodeRow } from "@/lib/hydra/wire";
import { type Failure, type FailureReason, type Result, fail, succeed } from "@/lib/result";

/**
 * The HTTPS query API transport.
 *
 * POST /v1/graphs/{graph_id}/query, with the auth token as a bearer credential, the
 * namespace as a header the server compares for equality, and a mandatory cell_id in
 * the body. Results come back as tagged cells plus an optional numeric cursor.
 *
 * Chosen as the default transport because it is fully specified with no version
 * negotiation: Bolt requires the driver and server to agree on a protocol version,
 * and this project has no way to verify that agreement without a running server. The
 * cost is a 1 MiB request body cap, which bounds batch size.
 *
 * Two request fields need care:
 *   - read_epoch is never sent. Any present value, including 0, is a 400.
 *   - the request struct has no deny_unknown_fields, so a misspelled field name is
 *     ignored rather than rejected. Every field below is spelled from the source.
 *
 * sourceRef: docs/HYDRADB.md, section "HTTP query API".
 */
export class HttpTransport implements GraphTransport {
  /** Guards against a cursor loop that never terminates on a buggy server. */
  private static readonly MAX_PAGES = 4_096;

  constructor(private readonly config: HydraConfig) {}

  async run(statement: GraphStatement): Promise<Result<DecodedRow[], Failure>> {
    const rows: DecodedRow[] = [];
    let cursor: number | null = null;
    let queryId: string | null = null;

    for (let pageIndex = 0; pageIndex < HttpTransport.MAX_PAGES; pageIndex += 1) {
      const page = await this.requestPage(statement, cursor, queryId);
      if (!page.ok) return page;

      rows.push(...page.value.rows);
      cursor = page.value.nextCursor;
      queryId = page.value.queryId;

      if (cursor === null) return succeed(rows);
    }

    return fail(
      "graph_rejected",
      `[HttpTransport.run] cursor did not terminate after ${HttpTransport.MAX_PAGES} pages`,
    );
  }

  async close(): Promise<void> {
    // fetch holds no long-lived state this class owns.
  }

  describe(): string {
    return `http ${this.config.httpBaseUrl}/v1/graphs/${this.config.graphId} cell=${this.config.cellId}`;
  }

  private async requestPage(
    statement: GraphStatement,
    cursor: number | null,
    queryId: string | null,
  ): Promise<Result<QueryPage, Failure>> {
    const body: Record<string, unknown> = {
      cell_id: this.config.cellId,
      query: statement.text,
      page_size: this.config.pageSize,
      timeout_ms: this.config.queryTimeoutMs,
    };

    if (Object.keys(statement.parameters).length > 0) {
      body.parameters = encodeParameters(statement.parameters);
    }
    // The cursor is a u64 offset, not an opaque token.
    if (cursor !== null) body.cursor = cursor;
    // The server correlates pages of one query by its id and generates one for the
    // first page, so this is only sent on continuations.
    if (queryId !== null) body.query_id = queryId;

    const serialised = JSON.stringify(body);
    if (serialised.length > HTTP_MAX_BODY_BYTES) {
      return fail(
        "invalid_input",
        `[HttpTransport.requestPage] body of ${serialised.length} bytes exceeds the ${HTTP_MAX_BODY_BYTES} byte cap`,
        { context: { queryPrefix: statement.text.slice(0, 60) } },
      );
    }

    const url = `${this.config.httpBaseUrl}/v1/graphs/${encodeURIComponent(this.config.graphId)}/query`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // The token is a shared secret. It appears here and nowhere else, and is
          // never included in a Failure message or a log line.
          authorization: `Bearer ${this.config.authToken}`,
          "x-graph-namespace": this.config.namespace,
        },
        body: serialised,
        signal: AbortSignal.timeout(this.config.queryTimeoutMs + REQUEST_OVERHEAD_MS),
      });
    } catch (caught) {
      return fail("graph_unavailable", `[HttpTransport.requestPage] ${describeFetchFailure(caught)}`);
    }

    const responseText = await response.text();

    if (!response.ok) {
      return classifyErrorResponse(response.status, responseText, statement.text);
    }

    return parseQueryResponse(responseText);
  }
}

/** Extra time allowed for connect and transfer on top of the server-side timeout. */
const REQUEST_OVERHEAD_MS = 5_000;

type QueryPage = {
  rows: DecodedRow[];
  nextCursor: number | null;
  queryId: string | null;
};

/**
 * Encodes request parameters.
 *
 * Plain JSON, deliberately. The request struct declares parameters as
 * BTreeMap<String, serde_json::Value> and infers the graph type from the JSON type:
 * a JSON array becomes a list, a JSON object becomes a map, a number becomes an
 * unsigned or signed integer or a float by fit, and a string becomes a string. The
 * tagged {type, value} envelope is response-only; sending it would be read as a
 * two-key map with the fields "type" and "value".
 *
 * Isolated in one function because it is the single place a wrong assumption about
 * the request encoding would surface.
 */
export function encodeParameters(
  parameters: Record<string, StatementParameterValue>,
): Record<string, StatementParameterValue> {
  return parameters;
}

function parseQueryResponse(responseText: string): Result<QueryPage, Failure> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    return fail("graph_rejected", "[parseQueryResponse] response body is not JSON");
  }

  if (typeof parsed !== "object" || parsed === null) {
    return fail("graph_rejected", "[parseQueryResponse] response body is not an object");
  }

  const record = parsed as Record<string, unknown>;

  const columns: string[] = [];
  if (Array.isArray(record.columns)) {
    for (const column of record.columns) {
      if (typeof column !== "string") {
        return fail("graph_rejected", "[parseQueryResponse] a column name is not a string");
      }
      columns.push(column);
    }
  }

  const rawRows = record.rows;
  if (!Array.isArray(rawRows)) {
    return fail("graph_rejected", "[parseQueryResponse] response has no rows array");
  }

  const rows: DecodedRow[] = [];
  for (let rowIndex = 0; rowIndex < rawRows.length; rowIndex += 1) {
    const cells = rawRows[rowIndex];
    if (!Array.isArray(cells)) {
      return fail("graph_rejected", `[parseQueryResponse] row ${rowIndex} is not an array of cells`);
    }
    const decoded = decodeRow(columns, cells, rowIndex);
    if (!decoded.ok) return decoded;
    rows.push(decoded.value);
  }

  return succeed({
    rows,
    nextCursor: readOptionalCursor(record.next_cursor),
    queryId: readOptionalString(record.query_id),
  });
}

/**
 * The error envelope: {"error": {"code": "...", "message": "..."}}. A 421 adds an
 * "owner" field naming the node that owns the write.
 */
type ServerError = {
  code: string;
  message: string;
  owner: string | null;
};

/**
 * Maps a server error onto a failure reason, keyed on the documented code rather
 * than guessed from the status number.
 *
 * The mapping that matters most: 429 resource_exhausted is a BUDGET rejection, not
 * rate limiting. Every scan, row, candidate, and hop limit funnels through admission
 * control and arrives as 429. Treating it as rate limiting would make the client
 * retry the same oversized traversal instead of narrowing it, and would let the UI
 * present an incomplete traversal as a clean result.
 *
 * sourceRef: docs/HYDRADB.md, table "HTTP status and error codes".
 */
const REASON_BY_ERROR_CODE: Record<string, FailureReason> = {
  invalid_request: "graph_rejected",
  invalid_parameter: "invalid_input",
  missing_namespace: "invalid_input",
  unauthenticated: "graph_unavailable",
  permission_denied: "graph_unavailable",
  query_timeout: "timeout",
  not_cell_writer: "graph_unavailable",
  resource_exhausted: "query_budget_exceeded",
  internal: "internal",
  routing_unavailable: "graph_unavailable",
};

/** Fallback when the body carries no recognisable code. */
function reasonFromStatus(status: number): FailureReason {
  if (status === 401 || status === 403 || status === 421 || status === 502 || status === 503) {
    return "graph_unavailable";
  }
  if (status === 404) return "not_found";
  if (status === 408 || status === 504) return "timeout";
  if (status === 413) return "invalid_input";
  if (status === 429) return "query_budget_exceeded";
  if (status >= 400 && status < 500) return "graph_rejected";
  return "internal";
}

function classifyErrorResponse(
  status: number,
  responseText: string,
  queryText: string,
): Result<never, Failure> {
  const serverError = parseServerError(responseText);
  const code = serverError?.code ?? null;
  const detail = serverError?.message ?? truncateDetail(responseText.trim());

  const reason = (code === null ? undefined : REASON_BY_ERROR_CODE[code]) ?? reasonFromStatus(status);

  const context: Record<string, string | number> = {
    status,
    queryPrefix: queryText.slice(0, 120),
  };
  if (code !== null) context.code = code;
  if (serverError?.owner !== null && serverError?.owner !== undefined) {
    context.owner = serverError.owner;
  }
  // Admission rejections name the exact budget in the message, which is what tells
  // the analysis layer whether to narrow the hop count or the path count.
  const budget = extractBudgetOperation(detail);
  if (budget !== null) context.budget = budget;

  // Credential failures are the one case where the detail is not worth surfacing:
  // it can echo back parts of the request, and the actionable information is which
  // setting to check.
  if (code === "unauthenticated" || status === 401) {
    return fail(
      reason,
      "[classifyErrorResponse] HydraDB rejected the credentials, check HYDRA_AUTH_TOKEN",
      { status, context: { status, ...(code === null ? {} : { code }) } },
    );
  }

  return fail(reason, `[classifyErrorResponse] ${describeReason(reason)}: ${detail}`, {
    status,
    context,
  });
}

function describeReason(reason: FailureReason): string {
  switch (reason) {
    case "query_budget_exceeded":
      return "traversal exceeded an engine budget";
    case "graph_rejected":
      return "HydraDB rejected the query";
    case "invalid_input":
      return "HydraDB rejected the request shape";
    case "timeout":
      return "query timed out";
    case "graph_unavailable":
      return "HydraDB is not serving this query";
    case "not_found":
      return "graph or endpoint not found";
    default:
      return "HydraDB returned an error";
  }
}

/**
 * Admission rejections render a stable operation identifier such as
 * native_path_max_len or native_path_edges. Pulling it out gives the analysis layer
 * a machine-readable reason to narrow a traversal.
 */
const BUDGET_OPERATIONS = [
  "native_path_max_len",
  "native_path_edges",
  "native_path_count",
  "native_path_vertices",
  "native_path_candidates",
  "native_path_cursor_bytes",
  "native_path_selector_candidates",
  "query_cancelled",
] as const;

function extractBudgetOperation(detail: string): string | null {
  return BUDGET_OPERATIONS.find((operation) => detail.includes(operation)) ?? null;
}

function parseServerError(responseText: string): ServerError | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const envelope = (parsed as Record<string, unknown>).error;
  if (typeof envelope !== "object" || envelope === null) return null;

  const record = envelope as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code : null;
  const message = typeof record.message === "string" ? record.message : null;
  if (code === null && message === null) return null;

  return {
    code: code ?? "unknown",
    message: truncateDetail(message ?? "no error detail"),
    owner: typeof record.owner === "string" ? record.owner : null,
  };
}

/** Error text is server-controlled and ends up in logs, so it is bounded. */
const MAX_ERROR_DETAIL_LENGTH = 400;

function truncateDetail(value: string): string {
  if (value.length === 0) return "no error detail";
  return value.length > MAX_ERROR_DETAIL_LENGTH
    ? `${value.slice(0, MAX_ERROR_DETAIL_LENGTH)}...`
    : value;
}

function readOptionalCursor(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  // Tolerated because a u64 cursor may be serialised as a string by a proxy.
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function describeFetchFailure(caught: unknown): string {
  if (caught instanceof Error) {
    return caught.name === "TimeoutError" || caught.name === "AbortError"
      ? "request aborted before HydraDB responded"
      : `cannot reach HydraDB: ${caught.message}`;
  }
  return "cannot reach HydraDB";
}
