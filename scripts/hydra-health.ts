/**
 * Proves a real HydraDB round trip: readiness, a write, a read back, a comparison.
 *
 * Run it with `bun run hydra:health`, or `bun run hydra:health -- --bolt` for the
 * Bolt leg. It is the one command that answers "is the graph actually working"
 * without involving the UI, so it stays deliberately small and prints what it did.
 *
 * What it proves, in order:
 *   1. The environment carries a config HydraDB will accept.
 *   2. The node answers 200 on /readyz, on the ADMIN port.
 *   3. A node batch write lands and comes back byte for byte, through the same
 *      transport and the same statement builders the app uses.
 *
 * Errors are values everywhere below. Only `runHealthCheck` decides an exit code,
 * and only the last two lines of this file exit the process.
 *
 * The auth token is never printed. `describeTokenForLog` reports its length and
 * nothing else, and that is the only function in this file allowed near it.
 *
 * sourceRef: docs/HYDRADB.md sections 3, 6, 7 and 9. docs/RUNNING.md explains every
 * failure this script can print.
 */

import { NODE_LABELS, NODE_PROPERTY_NAMES, type NodeLabel } from "@/lib/graph/model";
import { BoltTransport } from "@/lib/hydra/bolt-transport";
import {
  type HydraConfig,
  type HydraTransportKind,
  describeTokenForLog,
  readHydraConfigFromEnv,
} from "@/lib/hydra/config";
import {
  type NodeBatchRow,
  buildNodeBatchStatement,
  buildReadNodesStatement,
} from "@/lib/hydra/cypher";
import { HttpTransport } from "@/lib/hydra/http-transport";
import type { GraphTransport } from "@/lib/hydra/transport";
import type { DecodedRow, DecodedValue } from "@/lib/hydra/wire";
import { type Failure, type Result, fail, fromThrowing, fromThrowingSync, succeed } from "@/lib/result";

/**
 * Reserved id base for the health-check probe nodes.
 *
 * The id map assigns ids sequentially from 0 and persists them, so ingested data
 * grows upward from 0 and cannot reach this base. A probe write can therefore never
 * land on a real package, whatever has been ingested.
 *
 * The base also sits below Number.MAX_SAFE_INTEGER (9,007,199,254,740,991), which is
 * the ceiling wire.ts enforces by refusing an out-of-range integer rather than
 * rounding it, so the id survives the round trip exactly.
 *
 * A sparse id costs nothing on the server: the compiled sparse kernel dimensions its
 * matrices by the number of vertices actually present, through a sorted ordinal map,
 * not by the largest id in the graph.
 * sourceRef: src/lib/hydra/id-map.ts, src/lib/hydra/wire.ts decodeInteger, HydraDB
 * src/sparse_kernel/graphblas.rs OrdinalMap.
 */
const HEALTH_PROBE_NODE_ID_BASE = 9_000_000_000_000_000;

/** Probe nodes written per run. Two, so the batch form is exercised, not a single row. */
const HEALTH_PROBE_NODE_COUNT = 2;

/**
 * The label the probe writes under. An existing label from the model, so the probe
 * exercises the same statement shape the ingest uses; MERGE on the id means repeated
 * runs keep updating these two nodes instead of growing the graph.
 */
const HEALTH_PROBE_LABEL: NodeLabel = NODE_LABELS.version;

/** Sentinel for a timestamp the probe has no real value for. Row fields cannot be absent. */
const HEALTH_PROBE_TIMESTAMP_SENTINEL = -1;

/** Query API port HydraDB serves by default, used only by the admin URL derivation. */
const HYDRA_QUERY_PORT = "8443";

/** Admin port HydraDB serves /readyz, /livez and /metrics on. */
const HYDRA_ADMIN_PORT = "9090";

/** Total time allowed for the node to reach readiness, in milliseconds. */
const READINESS_TIMEOUT_MS = 90_000;

/** Gap between two readiness polls, in milliseconds. */
const READINESS_POLL_INTERVAL_MS = 1_000;

/** Per-probe HTTP timeout for one /readyz request, in milliseconds. */
const READINESS_PROBE_TIMEOUT_MS = 2_000;

/**
 * Consecutive transport-level failures that mean nothing is listening.
 *
 * A node that is up but not yet willing to serve answers 503 on /readyz, which is an
 * HTTP response, not a transport failure. So three failures in a row to even get a
 * response mean the port is not there, and waiting out the full timeout would only
 * delay a message the human can act on.
 */
const NO_LISTENER_ATTEMPT_LIMIT = 3;

/** The compose command that starts the graph, named in every unreachable message. */
const COMPOSE_START_COMMAND = "docker compose up -d graph-node";

type TransportChoice = {
  kind: HydraTransportKind;
  transport: GraphTransport;
};

type ReadinessOutcome = {
  attempts: number;
  waitedMs: number;
};

type RoundTripOutcome = {
  writeLatencyMs: number;
  readLatencyMs: number;
  probeNodeIds: readonly number[];
};

/** One probe row. Scalars only, which is all HydraDB accepts in a batch row. */
type HealthProbeRow = {
  vertex: number;
  key: string;
  ecosystem: string;
  name: string;
  version: string;
  published_at_ms: number;
  has_install_script: boolean;
};

async function runHealthCheck(argumentValues: readonly string[]): Promise<number> {
  const config = readHydraConfigFromEnv();
  if (!config.ok) {
    reportFailure("configuration", config.failure);
    return 1;
  }

  console.log(
    `[runHealthCheck] config read, graph=${config.value.graphId} namespace=${config.value.namespace} ` +
      `cell=${config.value.cellId} token=${describeTokenForLog(config.value.authToken)}`,
  );

  const adminBaseUrl = resolveAdminBaseUrl(config.value);
  if (!adminBaseUrl.ok) {
    reportFailure("admin url", adminBaseUrl.failure);
    return 1;
  }
  console.log(
    `[runHealthCheck] admin endpoint ${adminBaseUrl.value.url} (${adminBaseUrl.value.source})`,
  );

  const readiness = await waitForNodeReadiness(adminBaseUrl.value.url);
  if (!readiness.ok) {
    reportFailure("readiness", readiness.failure);
    return 1;
  }

  const choice = chooseTransport(config.value, argumentValues);
  if (!choice.ok) {
    reportFailure("transport selection", choice.failure);
    return 1;
  }

  const roundTrip = await runRoundTrip(choice.value.transport);
  const endpoint = choice.value.transport.describe();
  const closed = await closeTransport(choice.value.transport);
  if (!closed.ok) {
    // A transport that will not close cleanly is worth saying out loud, but it does
    // not change what the round trip proved, so it does not change the exit code.
    console.warn(`[runHealthCheck] ${closed.failure.message}`);
  }

  if (!roundTrip.ok) {
    printReport({
      transportKind: choice.value.kind,
      endpoint,
      readyDetail: describeReadiness(readiness.value),
      writeLatencyMs: null,
      readLatencyMs: null,
      matched: false,
    });
    reportFailure("round trip", roundTrip.failure);
    return 1;
  }

  printReport({
    transportKind: choice.value.kind,
    endpoint,
    readyDetail: describeReadiness(readiness.value),
    writeLatencyMs: roundTrip.value.writeLatencyMs,
    readLatencyMs: roundTrip.value.readLatencyMs,
    matched: true,
  });

  console.log("[runHealthCheck] round trip matched, HydraDB is serving reads and writes");
  return 0;
}

/**
 * Where /readyz lives.
 *
 * HYDRA_ADMIN_URL wins when it is set. Otherwise the URL is DERIVED from
 * HYDRA_HTTP_URL by swapping the query port for the admin port: config.ts carries no
 * admin URL, and the compose file publishes both ports on the same host with their
 * own numbers, so the derivation is right for every local run. It is only a
 * derivation though, so it refuses to guess when the query URL does not carry the
 * expected port, and says which variable to set instead. That keeps a remote or
 * remapped deployment from silently probing the wrong endpoint.
 */
function resolveAdminBaseUrl(
  config: HydraConfig,
  environment: Record<string, string | undefined> = process.env,
): Result<{ url: string; source: "HYDRA_ADMIN_URL" | "derived from HYDRA_HTTP_URL" }, Failure> {
  const explicit = environment.HYDRA_ADMIN_URL;
  if (explicit !== undefined && explicit.length > 0) {
    return succeed({
      url: explicit.endsWith("/") ? explicit.slice(0, -1) : explicit,
      source: "HYDRA_ADMIN_URL",
    });
  }

  const parsed = fromThrowingSync(
    "invalid_input",
    `[resolveAdminBaseUrl] HYDRA_HTTP_URL is not a URL: "${config.httpBaseUrl}"`,
    () => new URL(config.httpBaseUrl),
  );
  if (!parsed.ok) return parsed;

  if (parsed.value.port !== HYDRA_QUERY_PORT) {
    return fail(
      "invalid_input",
      `[resolveAdminBaseUrl] cannot derive the admin URL: HYDRA_HTTP_URL is "${config.httpBaseUrl}", ` +
        `whose port is not the expected ${HYDRA_QUERY_PORT}. Set HYDRA_ADMIN_URL to the /readyz origin, ` +
        `for example http://127.0.0.1:${HYDRA_ADMIN_PORT}`,
    );
  }

  parsed.value.port = HYDRA_ADMIN_PORT;
  return succeed({
    url: `${parsed.value.protocol}//${parsed.value.host}`,
    source: "derived from HYDRA_HTTP_URL",
  });
}

/**
 * Polls /readyz until the node reports it may serve.
 *
 * Readiness is on the admin port, not the query port: the query listener accepts a
 * connection before the node is willing to answer, so a probe against 8443 goes green
 * early and the first real query then fails. /readyz answers 200 only once the node
 * may serve, and 503 until then.
 * sourceRef: HydraDB src/bin/graph_node/admin.rs readiness, docs/HYDRADB.md section 9.
 */
async function waitForNodeReadiness(adminBaseUrl: string): Promise<Result<ReadinessOutcome, Failure>> {
  const readyUrl = `${adminBaseUrl}/readyz`;
  const startedAtMs = Date.now();
  let attempts = 0;
  let consecutiveTransportFailures = 0;

  while (Date.now() - startedAtMs < READINESS_TIMEOUT_MS) {
    attempts += 1;
    const probe = await probeReadyEndpoint(readyUrl);
    const elapsedSeconds = Math.round((Date.now() - startedAtMs) / 1_000);

    if (probe.ok) {
      consecutiveTransportFailures = 0;
      if (probe.value === 200) {
        console.log(`[waitForNodeReadiness] ready after ${attempts} attempt(s), ${elapsedSeconds}s`);
        return succeed({ attempts, waitedMs: Date.now() - startedAtMs });
      }
      console.log(
        `[waitForNodeReadiness] attempt ${attempts} at ${elapsedSeconds}s: HTTP ${probe.value}, not ready yet`,
      );
    } else {
      consecutiveTransportFailures += 1;
      console.log(
        `[waitForNodeReadiness] attempt ${attempts} at ${elapsedSeconds}s: ${probe.failure.message}`,
      );
      if (consecutiveTransportFailures >= NO_LISTENER_ATTEMPT_LIMIT) {
        return fail(
          "graph_unavailable",
          `[waitForNodeReadiness] nothing is listening on ${readyUrl} after ${attempts} attempts. ` +
            `Start HydraDB with \`${COMPOSE_START_COMMAND}\`, or point HYDRA_ADMIN_URL at a running admin port. ` +
            "See docs/RUNNING.md.",
        );
      }
    }

    await sleepMs(READINESS_POLL_INTERVAL_MS);
  }

  return fail(
    "timeout",
    `[waitForNodeReadiness] ${readyUrl} did not answer 200 within ${READINESS_TIMEOUT_MS}ms over ${attempts} attempts. ` +
      "A node that answers 503 forever is usually a store it cannot open: check `docker compose logs graph-node`.",
  );
}

/** One /readyz request. Returns the status code, or a Failure if there was no response. */
async function probeReadyEndpoint(readyUrl: string): Promise<Result<number, Failure>> {
  const response = await fromThrowing(
    "graph_unavailable",
    "[probeReadyEndpoint] cannot reach the admin endpoint",
    () =>
      fetch(readyUrl, {
        method: "GET",
        signal: AbortSignal.timeout(READINESS_PROBE_TIMEOUT_MS),
      }),
  );
  if (!response.ok) return response;
  return succeed(response.value.status);
}

/**
 * Picks the transport.
 *
 * HTTP is the default because it is fully specified with no version negotiation.
 * Bolt is behind --bolt (or HYDRA_TRANSPORT=bolt) rather than being tried
 * automatically, because whether neo4j-driver 6.2.0 still offers Bolt 5.4, the
 * highest version this server accepts, is unverified. A silent fallback would hide a
 * failed handshake behind a green check.
 * sourceRef: docs/HYDRADB.md sections 8 and 11.
 */
function chooseTransport(
  config: HydraConfig,
  argumentValues: readonly string[],
): Result<TransportChoice, Failure> {
  let requested: HydraTransportKind | null = null;

  for (const argument of argumentValues) {
    if (argument === "--bolt" || argument === "--http") {
      const kind: HydraTransportKind = argument === "--bolt" ? "bolt" : "http";
      if (requested !== null && requested !== kind) {
        return fail("invalid_input", "[chooseTransport] --http and --bolt cannot both be given");
      }
      requested = kind;
      continue;
    }
    return fail(
      "invalid_input",
      `[chooseTransport] unknown argument "${argument}". Accepted: --http, --bolt`,
    );
  }

  const kind = requested ?? config.transport;
  return succeed({
    kind,
    transport: kind === "bolt" ? new BoltTransport(config) : new HttpTransport(config),
  });
}

/**
 * Writes the probe nodes, reads them back by id, and compares.
 *
 * The write and the read go through the same builders and the same transport the app
 * uses, so a green check means the app's path works, not that a hand-rolled request
 * works.
 */
async function runRoundTrip(transport: GraphTransport): Promise<Result<RoundTripOutcome, Failure>> {
  const rows = buildProbeRows(describeRunMarker());
  const probeNodeIds = rows.map((row) => row.vertex);
  // Stated rather than inferred: the batch form requires rows of scalars, and this is
  // where a probe row that stopped being one would be caught at compile time.
  const batchRows: readonly NodeBatchRow[] = rows;

  const writeStatement = buildNodeBatchStatement(
    { label: HEALTH_PROBE_LABEL, propertyNames: NODE_PROPERTY_NAMES[HEALTH_PROBE_LABEL] },
    batchRows,
  );
  if (!writeStatement.ok) return writeStatement;

  console.log(
    `[runRoundTrip] writing ${rows.length} probe node(s) as ${HEALTH_PROBE_LABEL} at ids ${probeNodeIds.join(", ")}`,
  );

  const writeStartedAtMs = performance.now();
  const written = await transport.run(writeStatement.value);
  const writeLatencyMs = elapsedMsSince(writeStartedAtMs);
  if (!written.ok) return written;

  const readStatement = buildReadNodesStatement(
    HEALTH_PROBE_LABEL,
    NODE_PROPERTY_NAMES[HEALTH_PROBE_LABEL],
    probeNodeIds,
  );
  if (!readStatement.ok) return readStatement;

  const readStartedAtMs = performance.now();
  const readBack = await transport.run(readStatement.value);
  const readLatencyMs = elapsedMsSince(readStartedAtMs);
  if (!readBack.ok) return readBack;

  const compared = compareReadBack(rows, readBack.value);
  if (!compared.ok) return compared;

  return succeed({ writeLatencyMs, readLatencyMs, probeNodeIds });
}

/**
 * The probe rows.
 *
 * Every row carries the run marker in its string properties, so a read back proves
 * THIS run's write landed rather than finding a node an earlier run left behind. The
 * ids stay fixed, so the graph keeps exactly two probe nodes however often the check
 * runs.
 */
function buildProbeRows(runMarker: string): readonly HealthProbeRow[] {
  const rows: HealthProbeRow[] = [];
  for (let offset = 0; offset < HEALTH_PROBE_NODE_COUNT; offset += 1) {
    rows.push({
      vertex: HEALTH_PROBE_NODE_ID_BASE + offset,
      key: `health:probe-${offset}:${runMarker}`,
      ecosystem: "health",
      name: `health-probe-${offset}`,
      version: `0.0.0-health.${runMarker}`,
      published_at_ms: HEALTH_PROBE_TIMESTAMP_SENTINEL,
      has_install_script: false,
    });
  }
  return rows;
}

/**
 * A per-run marker for the probe properties. Millisecond epoch in base 36, which is
 * short, sortable, and inside the character set cypher.ts allows in a literal, so a
 * probe key can also be used as a selector value later.
 */
function describeRunMarker(): string {
  return Date.now().toString(36);
}

/**
 * Compares what was read against what was written, field by field.
 *
 * A missing row and a wrong value are reported differently on purpose: a missing row
 * means the write did not land or the read cannot see it, and a wrong value means the
 * round trip lost or changed data. Those two need different fixes.
 */
function compareReadBack(
  expectedRows: readonly HealthProbeRow[],
  actualRows: readonly DecodedRow[],
): Result<void, Failure> {
  const actualById = new Map<number, DecodedRow>();
  for (const row of actualRows) {
    const id = row.id;
    if (typeof id !== "number") {
      return fail("graph_rejected", "[compareReadBack] a returned row has no numeric id column");
    }
    actualById.set(id, row);
  }

  for (const expected of expectedRows) {
    const actual = actualById.get(expected.vertex);
    if (actual === undefined) {
      return fail(
        "graph_rejected",
        `[compareReadBack] node ${expected.vertex} was written but did not come back. ` +
          `Read ${actualRows.length} of ${expectedRows.length} probe node(s).`,
      );
    }

    for (const propertyName of NODE_PROPERTY_NAMES[HEALTH_PROBE_LABEL]) {
      const expectedValue = readProbeProperty(expected, propertyName);
      if (expectedValue === null) {
        return fail(
          "internal",
          `[compareReadBack] the probe row carries no "${propertyName}" property, so the model and this script disagree`,
        );
      }
      const actualValue: DecodedValue | undefined = actual[propertyName];
      if (actualValue !== expectedValue) {
        return fail(
          "graph_rejected",
          `[compareReadBack] node ${expected.vertex} property "${propertyName}" came back as ` +
            `${describeValueForLog(actualValue)}, expected ${describeValueForLog(expectedValue)}`,
        );
      }
    }
  }

  return succeed(undefined);
}

/** Reads one probe property by name, without an index signature on the row type. */
function readProbeProperty(row: HealthProbeRow, propertyName: string): string | number | boolean | null {
  switch (propertyName) {
    case "key":
      return row.key;
    case "ecosystem":
      return row.ecosystem;
    case "name":
      return row.name;
    case "version":
      return row.version;
    case "published_at_ms":
      return row.published_at_ms;
    case "has_install_script":
      return row.has_install_script;
    default:
      return null;
  }
}

type HealthReport = {
  transportKind: HydraTransportKind;
  endpoint: string;
  readyDetail: string;
  writeLatencyMs: number | null;
  readLatencyMs: number | null;
  matched: boolean;
};

/** The summary a judge reads. Six rows, one fact each, no secrets. */
function printReport(report: HealthReport): void {
  const rows: readonly [string, string][] = [
    ["transport", report.transportKind],
    ["endpoint", report.endpoint],
    ["ready", report.readyDetail],
    ["write latency ms", report.writeLatencyMs === null ? "n/a" : String(report.writeLatencyMs)],
    ["read latency ms", report.readLatencyMs === null ? "n/a" : String(report.readLatencyMs)],
    ["round trip matched", report.matched ? "yes" : "no"],
  ];

  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  console.log("[printReport] HydraDB health check");
  for (const [label, value] of rows) {
    console.log(`[printReport]   ${label.padEnd(labelWidth)}  ${value}`);
  }
}

function describeReadiness(outcome: ReadinessOutcome): string {
  return `yes, after ${outcome.attempts} attempt(s) in ${outcome.waitedMs}ms`;
}

/**
 * Prints a Failure in full: the reason a caller would branch on, the message, and the
 * context. `context.budget` is called out on its own line because a 429 names the
 * exact budget that rejected the query, and that is what says whether to narrow the
 * hop count or the path count.
 */
function reportFailure(stage: string, failure: Failure): void {
  console.error(`[reportFailure] FAILED at ${stage}, reason=${failure.reason}`);
  console.error(`[reportFailure] ${failure.message}`);
  if (failure.status !== undefined) {
    console.error(`[reportFailure] http status ${failure.status}`);
  }
  const budget = failure.context?.budget;
  if (budget !== undefined) {
    console.error(`[reportFailure] engine budget rejected: ${String(budget)}`);
  }
  if (failure.context !== undefined) {
    const pairs = Object.entries(failure.context)
      .filter(([name]) => name !== "budget")
      .map(([name, value]) => `${name}=${String(value)}`);
    if (pairs.length > 0) console.error(`[reportFailure] context ${pairs.join(" ")}`);
  }
  const remedy = describeRemedy(failure);
  if (remedy !== null) console.error(`[reportFailure] next step: ${remedy}`);
}

/** Maps a failure reason onto the next thing to try. Every branch is in docs/RUNNING.md. */
function describeRemedy(failure: Failure): string | null {
  switch (failure.reason) {
    case "invalid_input":
      return "check .env against .env.example, then rerun";
    case "graph_unavailable":
      return `start or check HydraDB: \`${COMPOSE_START_COMMAND}\`, then \`docker compose logs graph-node\``;
    case "query_budget_exceeded":
      return "narrow the query: the engine rejected it on the budget named above, it did not rate limit it";
    case "timeout":
      return "the node accepted the request but did not finish it, check `docker compose logs graph-node`";
    case "graph_rejected":
      return "the statement or the data shape is wrong, see docs/HYDRADB.md sections 2 and 3";
    default:
      return null;
  }
}

/** Closes the transport. A driver close is a throwing boundary, so it is wrapped. */
async function closeTransport(transport: GraphTransport): Promise<Result<void, Failure>> {
  return fromThrowing("internal", "[closeTransport] transport did not close cleanly", async () => {
    await transport.close();
  });
}

function elapsedMsSince(startedAtMs: number): number {
  return Math.round(performance.now() - startedAtMs);
}

function describeValueForLog(value: DecodedValue | undefined): string {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (typeof value === "string") return `"${value}"`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "a non-scalar value";
}

function sleepMs(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

const exitCode = await runHealthCheck(process.argv.slice(2));
process.exit(exitCode);
