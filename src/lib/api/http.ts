/**
 * The HTTP shell every route handler in `src/app/api` shares.
 *
 * Seven handlers answer questions produced by the analysis layer, and all seven have the same
 * three jobs: validate the query, run one analysis, and serialise whatever came back. This
 * file holds the parts of that which must be identical everywhere, because the alternative is
 * seven envelopes that drift and a UI that has to handle all of them.
 *
 * Two rules are enforced here rather than left to each route:
 *   - A failure never escapes as a throw. `runRoute` wraps the handler, so a bug inside one
 *     becomes a JSON body with a reason instead of an unhandled rejection.
 *   - A message returned to a browser never carries an endpoint. Transport failures name the
 *     HydraDB URI they were talking to, and a connection string does not belong in a response
 *     body, so every message is scrubbed on the way out.
 *
 * What this file deliberately does not do is decide verdicts. An `unknown` verdict is a
 * successful answer and leaves through `jsonOk` with its rationale and limits intact; only a
 * failed read reaches `jsonFailure`.
 */

import { z } from "zod";

import type { Failure, FailureReason, Result } from "@/lib/result";
import { fail, fromThrowing, fromThrowingSync, succeed } from "@/lib/result";

/** Anything that looks like an endpoint: http, https, bolt, neo4j+s, and the rest. */
const ENDPOINT_PATTERN = /[a-z][a-z0-9+.-]*:\/\/\S+/gi;

/**
 * A quoted absolute filesystem path.
 *
 * Node quotes the path in every fs error it raises ("ENOENT: ..., open '/srv/app/data/x.json'"),
 * and where a deployment keeps its files is not the client's business. Matching only quoted
 * paths is what keeps a route name intact: "[GET /api/replay]" looks like a path and is not one,
 * and a message that says which endpoint failed is the useful half.
 */
const QUOTED_PATH_PATTERN = /'\/[^']*'|"\/[^"]*"/g;

const REDACTED_ENDPOINT = "<redacted-endpoint>";

const REDACTED_PATH = "<redacted-path>";

/** How much of a failure message a client is allowed to see. Enough to act on, no essays. */
const MAX_CLIENT_MESSAGE_LENGTH = 400;

/**
 * HTTP status per failure reason.
 *
 * The mapping is one place because the same reason must mean the same status on every route:
 * a malformed query is the client's problem, an unreachable graph is not, and neither of them
 * is a 500. `not_found` is the only reason that can come from a well-formed request naming
 * something that does not exist.
 */
export function failureStatus(reason: FailureReason): number {
  switch (reason) {
    case "invalid_input":
    case "unsupported":
      return 400;
    case "not_found":
      return 404;
    case "rate_limited":
      return 429;
    case "timeout":
      return 504;
    case "upstream_unavailable":
    case "graph_unavailable":
    case "query_budget_exceeded":
      return 503;
    case "upstream_rejected":
    case "graph_rejected":
    case "internal":
      return 500;
  }
}

/** The body shape of every failed response. */
export type ApiFailureBody = {
  ok: false;
  error: {
    reason: FailureReason;
    message: string;
    context?: Record<string, string | number | boolean>;
  };
};

/**
 * A successful answer.
 *
 * `ok` sits next to the payload rather than wrapping it, so a client reads
 * `body.answer.verdict` instead of `body.data.answer.verdict`, and an abstaining answer looks
 * exactly like a decided one at the transport level. That is the point: a 200 with
 * `verdict: "unknown"` is the product working.
 */
export function jsonOk<TPayload extends object>(payload: TPayload): Response {
  return Response.json({ ok: true, ...payload });
}

/**
 * A failed read, with the status the reason maps to and a message safe to display.
 *
 * `statusOverride` exists for the cases where the reason code is right but the status is too
 * coarse: an upload over the size cap is `invalid_input`, and the honest status for it is 413,
 * not 400. The reason codes stay a closed set the whole codebase branches on, so the override
 * changes the wire status only, never the classification.
 */
export function jsonFailure(failure: Failure, statusOverride?: number): Response {
  const body: ApiFailureBody = {
    ok: false,
    error: {
      reason: failure.reason,
      message: redactForClient(failure.message),
    },
  };
  if (failure.context !== undefined) body.error.context = failure.context;

  return Response.json(body, { status: statusOverride ?? failureStatus(failure.reason) });
}

/**
 * Runs a handler so that nothing it does can produce an unhandled rejection.
 *
 * Next.js would turn a throw into an HTML error page, which a fetch on the client cannot
 * read. `routeName` is prefixed to the message so a 500 in the browser console still says
 * which handler produced it.
 */
export async function runRoute(
  routeName: string,
  run: () => Promise<Response>,
): Promise<Response> {
  const ran = await fromThrowing("internal", `[${routeName}] the handler threw`, run);
  if (ran.ok) return ran.value;
  return jsonFailure(ran.failure);
}

/**
 * Validates the query string of a request against a schema.
 *
 * Repeated parameters keep their last value, which is what `URLSearchParams` iteration gives
 * and what every browser form does. A schema that needs a list should take a delimited string
 * so the rule stays visible in the schema rather than hidden in this function.
 *
 * A parameter the schema does not mention is ignored rather than rejected, because the schemas
 * here are plain `z.object`. That is deliberate: analytics and cache-busting parameters ride
 * along on real URLs, and a 400 for `?utm_source=` would be a bug, not a validation.
 */
export function parseQuery<TSchema extends z.ZodType>(
  request: Request,
  schema: TSchema,
  routeName: string,
): Result<z.infer<TSchema>, Failure> {
  const url = fromThrowingSync(
    "invalid_input",
    `[${routeName}] the request URL cannot be parsed`,
    () => new URL(request.url),
  );
  if (!url.ok) return url;

  const raw: Record<string, string> = {};
  for (const [key, value] of url.value.searchParams) raw[key] = value;

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return fail("invalid_input", `[${routeName}] ${describeZodIssues(parsed.error)}`);
  }
  return succeed(parsed.data);
}

/** Renders zod issues as one line naming each offending parameter. */
export function describeZodIssues(error: z.ZodError): string {
  const described = error.issues.map((issue) => {
    const path = issue.path.map((segment) => String(segment)).join(".");
    return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
  });
  return described.length > 0 ? described.join("; ") : "the request is not valid";
}

/**
 * A whole number written in digits, inside bounds.
 *
 * Deliberately not `z.coerce.number()`: coercion turns an empty parameter into 0 and "1e3"
 * into 1000, and a query contract that accepts either of those is a contract nobody can read
 * off the URL. Callers apply their own fallback with `??` on the optional field, so the
 * default value lives next to the route that owns it.
 */
export function digitsInRange(minimum: number, maximum: number) {
  return z
    .string()
    .regex(/^\d{1,15}$/, "must be a whole number written in digits")
    .transform((raw) => Number.parseInt(raw, 10))
    .refine(
      (value) => value >= minimum && value <= maximum,
      `must be between ${minimum} and ${maximum}`,
    );
}

/**
 * An instant in epoch milliseconds.
 *
 * Zero is rejected along with everything before it: the graph stores absent timestamps as 0
 * or -1, so accepting 0 as "the epoch" would make an absent value indistinguishable from a
 * deliberate one in a bitemporal question.
 */
export function epochMs() {
  return digitsInRange(1, Number.MAX_SAFE_INTEGER);
}

/**
 * Strips endpoints and quoted filesystem paths out of a message and caps its length.
 *
 * Applied to every message on its way to a client. Failure messages from the Bolt and HTTP
 * transports embed the URI they were talking to, and that is a connection string; a failure that
 * came from a file read embeds wherever the deployment keeps its files. The reason code already
 * tells the client what kind of problem it is.
 */
export function redactForClient(message: string): string {
  const scrubbed = message
    .replace(ENDPOINT_PATTERN, REDACTED_ENDPOINT)
    .replace(QUOTED_PATH_PATTERN, REDACTED_PATH);
  return scrubbed.length <= MAX_CLIENT_MESSAGE_LENGTH
    ? scrubbed
    : `${scrubbed.slice(0, MAX_CLIENT_MESSAGE_LENGTH)}...`;
}
