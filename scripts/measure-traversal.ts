/**
 * Measures what the materialised reverse edge buys, which is milestone M0's one
 * measurement (plan.md section 13).
 *
 * The question. "Which versions depend on this compromised version" is a reverse walk.
 * The engine can express one directly: relDirection accepts "incoming", "outgoing", or
 * "both" on all three algo.*paths procedures and defaults to outgoing. So the ingest
 * writing DEPENDED_ON_BY next to every RESOLVES_TO is an index-shape choice, not a
 * workaround for a missing argument: an outgoing walk over the stored reverse type reads
 * the forward adjacency, while an incoming walk over RESOLVES_TO drives the reverse index.
 * Two code paths, two costs, and only a measurement says which one a slice should use.
 * This script is that measurement, and it times both on the same synthetic slice.
 * sourceRef: docs/HYDRADB.md section 4.
 *
 *   pattern A  neighbors(RESOLVES_TO, direction incoming)     one-hop reverse MATCH
 *   pattern B  pathsFromSource(DEPENDED_ON_BY, outgoing, 1 hop)  materialised walk
 *
 * Usage:
 *   bun run hydra:measure                    measures against a live HydraDB
 *   bun run hydra:measure -- --memory        measures MemoryGraph, in process
 *   bun run hydra:measure -- --iterations 15 --dependents 500
 *
 * HONESTY RULES THIS SCRIPT KEEPS.
 *   - It never prints a number it did not measure. With no reachable HydraDB the live
 *     mode does not fall back to anything: it says the measurement was NOT run, names
 *     what to start, and exits non-zero.
 *   - The in-process mode is a correctness and shape check, not an engine benchmark.
 *     Every line it prints says so, because MemoryGraph is TypeScript maps in this
 *     process and its timings say nothing about HydraDB's cost.
 *   - Live mode writes a small synthetic slice under reserved ids and says so before
 *     writing. There is no delete in the Cypher subset this project uses, so the slice
 *     stays in the graph; the reserved id base keeps it away from ingested data.
 *
 * Errors are values everywhere below. Only `runMeasurement` decides an exit code, and
 * only the last two lines of this file exit the process.
 *
 * sourceRef: docs/HYDRADB.md sections 3 and 6 for the budgets, plan.md sections 6 and 13.
 */

import type { GraphGateway } from "@/lib/graph/gateway";
import { MemoryGraph } from "@/lib/graph/memory-gateway";
import { type Ecosystem, versionKey } from "@/lib/graph/model";
import { BoltTransport } from "@/lib/hydra/bolt-transport";
import {
  type HydraConfig,
  type HydraTransportKind,
  describeTokenForLog,
  readHydraConfigFromEnv,
} from "@/lib/hydra/config";
import { HttpTransport } from "@/lib/hydra/http-transport";
import { HydraGateway } from "@/lib/hydra/hydra-gateway";
import { IdMap } from "@/lib/hydra/id-map";
import type { GraphTransport } from "@/lib/hydra/transport";
import {
  type IngestSlice,
  type PackageFacts,
  type VersionFacts,
  buildGraph,
} from "@/lib/ingest/graph-builder";
import { GraphWriter, MemorySink, TransportSink } from "@/lib/ingest/writer";
import { type Failure, type Result, fail, fromThrowing, fromThrowingSync, succeed } from "@/lib/result";

/** The measurement ran and both patterns returned the same answer. */
const EXIT_MEASURED = 0;

/** The measurement did not run, or the two patterns disagreed on the answer. */
const EXIT_NOT_MEASURED = 1;

/**
 * Reserved id base for the synthetic measurement slice. Unit: node id.
 *
 * The id map assigns ingested ids sequentially from 0, so a reserved base this high
 * cannot collide with real data. It sits above the health check's own reserved base so
 * the two scripts cannot overwrite each other's probe nodes, and far enough below
 * Number.MAX_SAFE_INTEGER (9_007_199_254_740_991) that base plus the largest slice this
 * script can build is still an exact integer. Ids are checked against that bound before
 * anything is written, because a base past it silently loses precision.
 * sourceRef: scripts/hydra-health.ts HEALTH_PROBE_NODE_ID_BASE (9_000_000_000_000_000),
 * src/lib/hydra/id-map.ts (node and relationship ids are separate spaces, both from 0),
 * src/lib/ingest/writer.ts readRowId (refuses an id that is not a safe integer).
 */
const MEASURE_ID_BASE = 9_001_000_000_000_000;

/** Ecosystem the synthetic slice is written under. One is enough for a fan-in shape. */
const MEASURE_ECOSYSTEM: Ecosystem = "npm";

/** Package name of the version every synthetic dependent resolves to. */
const TARGET_PACKAGE_NAME = "patient-zero-measure-target";

/** The one version the fan-in points at. */
const TARGET_VERSION = "1.0.0";

/** Package name prefix of the synthetic dependents. */
const DEPENDENT_PACKAGE_PREFIX = "patient-zero-measure-dependent-";

/** Version every synthetic dependent carries. */
const DEPENDENT_VERSION = "1.0.0";

/** Sentinel for a field the synthetic slice has no real value for. sourceRef: graph-builder.ts. */
const SYNTHETIC_ABSENT_NUMBER = -1;

/**
 * Dependents pointing at the target version. Unit: Version nodes.
 *
 * 200 is large enough that a one-hop expansion is not lost in request overhead, and
 * small enough that the whole slice is one HTTP batch under the engine's 1 MiB body cap
 * and that 200 paths stay far under the 100,000 result vertex budget.
 * sourceRef: src/lib/hydra/config.ts HTTP_BATCH_BUDGET_BYTES, MAX_QUERY_RESULT_VERTICES.
 */
const DEFAULT_DEPENDENT_COUNT = 200;

/**
 * Upper bound on --dependents. Unit: Version nodes. Each returned path carries 2
 * vertices, so 20,000 paths is 40,000 result vertices, inside the engine's 100,000 cap
 * with room for the node writes that precede the walk. The largest slice this allows
 * needs roughly 3 ids per dependent, which keeps every id under
 * Number.MAX_SAFE_INTEGER when counted from MEASURE_ID_BASE.
 */
const MAX_DEPENDENT_COUNT = 20_000;

/**
 * Ids one dependent can consume. Unit: ids. A dependent adds a Package node, a Version
 * node, a HAS_VERSION edge, a RESOLVES_TO edge and a DEPENDED_ON_BY edge, and node ids
 * and relationship ids come from separate spaces, so 5 is a ceiling for either space.
 * Used only to prove the reserved id range cannot run past the safe integer bound.
 */
const IDS_PER_DEPENDENT = 5;

/** Timed repetitions per pattern. Unit: iterations. Odd, so the median is a real sample. */
const DEFAULT_ITERATION_COUNT = 7;

/** Upper bound on --iterations. Unit: iterations. */
const MAX_ITERATION_COUNT = 200;

/**
 * Untimed calls before the timed run. Unit: iterations. One is enough to pay the
 * connection setup and the engine's first-touch compilation once, outside the samples.
 */
const WARMUP_ITERATION_COUNT = 1;

/** Query API port HydraDB serves by default, used only by the admin URL derivation. */
const HYDRA_QUERY_PORT = "8443";

/** Admin port HydraDB serves /readyz on. */
const HYDRA_ADMIN_PORT = "9090";

/** Per-probe timeout for one /readyz request. Unit: milliseconds. */
const READINESS_PROBE_TIMEOUT_MS = 2_000;

/**
 * Readiness attempts before the measurement gives up. Unit: attempts.
 *
 * Deliberately small: hydra-health waits 90 seconds for a node that is starting, but a
 * measurement has nothing to wait for. Either a ready node is there now or there is no
 * measurement to take.
 */
const READINESS_ATTEMPT_LIMIT = 2;

/** Gap between two readiness attempts. Unit: milliseconds. */
const READINESS_RETRY_DELAY_MS = 500;

/** The compose command that starts the graph, named in every unreachable message. */
const COMPOSE_START_COMMAND = "docker compose up -d graph-node";

const USAGE_LINE =
  "usage: bun run hydra:measure [-- --memory] [-- --iterations <count>] [-- --dependents <count>]";

/**
 * live   measures a running HydraDB through HydraGateway.
 * memory measures MemoryGraph in this process, which is not an engine measurement.
 */
type MeasurementMode = "live" | "memory";

type MeasureArguments = {
  mode: MeasurementMode;
  iterationCount: number;
  dependentCount: number;
};

type LatencySummary = {
  minMs: number;
  medianMs: number;
  maxMs: number;
  /** Timed samples behind the three numbers above. Unit: iterations. */
  sampleCount: number;
};

type PatternOutcome = {
  /** Rows the pattern returned. Every iteration returned this same count. */
  rowCount: number;
  latency: LatencySummary;
};

type ReverseWalkAvailability = {
  /** True when the gateway answered a path request in the incoming direction. */
  isAccepted: boolean;
  detail: string;
};

type MeasurementReport = {
  mode: MeasurementMode;
  source: string;
  dependentCount: number;
  iterationCount: number;
  incomingNeighbors: PatternOutcome;
  materialisedWalk: PatternOutcome;
  reversePathWalk: ReverseWalkAvailability;
};

async function runMeasurement(argumentValues: readonly string[]): Promise<number> {
  const parsed = parseArguments(argumentValues);
  if (!parsed.ok) {
    reportFailure("arguments", parsed.failure);
    return EXIT_NOT_MEASURED;
  }

  const prepared =
    parsed.value.mode === "memory"
      ? await prepareMemoryMeasurement(parsed.value)
      : await prepareLiveMeasurement(parsed.value);
  if (!prepared.ok) {
    reportFailure(`${parsed.value.mode} setup`, prepared.failure);
    console.error("[runMeasurement] the measurement was NOT run, so no numbers are reported");
    return EXIT_NOT_MEASURED;
  }

  const measured = await measureBothPatterns(prepared.value, parsed.value);
  const closed = await closeGateway(prepared.value.gateway);
  if (!closed.ok) console.warn(`[runMeasurement] ${closed.failure.message}`);

  if (!measured.ok) {
    reportFailure("measurement", measured.failure);
    console.error("[runMeasurement] the measurement was NOT completed, so no numbers are reported");
    return EXIT_NOT_MEASURED;
  }

  printMeasurementReport(measured.value);

  if (measured.value.incomingNeighbors.rowCount !== measured.value.materialisedWalk.rowCount) {
    console.error(
      `[runMeasurement] the two patterns disagree: incoming MATCH returned ` +
        `${measured.value.incomingNeighbors.rowCount} row(s), the materialised walk returned ` +
        `${measured.value.materialisedWalk.rowCount}. Timings of two different answers are not comparable.`,
    );
    return EXIT_NOT_MEASURED;
  }

  printVerdict(measured.value);
  return EXIT_MEASURED;
}

/** Everything a measurement needs, whichever graph it runs against. */
type PreparedMeasurement = {
  mode: MeasurementMode;
  /** Log-safe description of what answered. Never holds a secret. */
  source: string;
  gateway: GraphGateway;
  targetNodeId: number;
};

function parseArguments(argumentValues: readonly string[]): Result<MeasureArguments, Failure> {
  let mode: MeasurementMode = "live";
  let iterationCount = DEFAULT_ITERATION_COUNT;
  let dependentCount = DEFAULT_DEPENDENT_COUNT;

  for (let index = 0; index < argumentValues.length; index += 1) {
    const argument = argumentValues[index];

    if (argument === "--memory") {
      mode = "memory";
      continue;
    }
    if (argument === "--live") {
      mode = "live";
      continue;
    }

    if (argument === "--iterations" || argument === "--dependents") {
      const rawValue = argumentValues[index + 1];
      const upperBound = argument === "--iterations" ? MAX_ITERATION_COUNT : MAX_DEPENDENT_COUNT;
      const readCount = readPositiveInteger(argument, rawValue, upperBound);
      if (!readCount.ok) return readCount;

      if (argument === "--iterations") iterationCount = readCount.value;
      else dependentCount = readCount.value;

      index += 1;
      continue;
    }

    return fail("invalid_input", `[parseArguments] unknown argument "${argument}". ${USAGE_LINE}`);
  }

  // The reserved range has to stay inside the exact integer range, because an id past it
  // loses precision and two synthetic nodes would end up sharing one id.
  const highestReservedId = MEASURE_ID_BASE + (dependentCount + 1) * IDS_PER_DEPENDENT;
  if (!Number.isSafeInteger(highestReservedId)) {
    return fail(
      "invalid_input",
      `[parseArguments] ${dependentCount} dependents would need ids past Number.MAX_SAFE_INTEGER ` +
        `from the reserved base ${MEASURE_ID_BASE}. Lower --dependents.`,
    );
  }

  return succeed({ mode, iterationCount, dependentCount });
}

function readPositiveInteger(
  flagName: string,
  rawValue: string | undefined,
  upperBound: number,
): Result<number, Failure> {
  if (rawValue === undefined) {
    return fail("invalid_input", `[readPositiveInteger] ${flagName} needs a count. ${USAGE_LINE}`);
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > upperBound) {
    return fail(
      "invalid_input",
      `[readPositiveInteger] ${flagName} must be an integer from 1 to ${upperBound}, got "${rawValue}"`,
    );
  }
  return succeed(parsed);
}

// ---------------------------------------------------------------------------
// Setup: live HydraDB
// ---------------------------------------------------------------------------

/**
 * Reads the config, proves a node is ready, writes the synthetic slice, and hands back
 * a gateway.
 *
 * Every step that can fail says what the human must start or fix, because the whole
 * point of this path is that it refuses to invent a number when there is no engine.
 */
async function prepareLiveMeasurement(
  argumentValues: MeasureArguments,
): Promise<Result<PreparedMeasurement, Failure>> {
  const config = readHydraConfigFromEnv();
  if (!config.ok) {
    return fail(
      config.failure.reason,
      `${config.failure.message}. No HydraDB configuration means no live measurement: fix .env ` +
        `against .env.example, or rerun with --memory for an in-process check that is not an engine measurement`,
    );
  }

  console.log(
    `[prepareLiveMeasurement] config read, transport=${config.value.transport} ` +
      `graph=${config.value.graphId} namespace=${config.value.namespace} ` +
      `cell=${config.value.cellId} token=${describeTokenForLog(config.value.authToken)}`,
  );

  const adminBaseUrl = resolveAdminBaseUrl(config.value);
  if (!adminBaseUrl.ok) return adminBaseUrl;

  const readiness = await probeNodeReadiness(adminBaseUrl.value.url);
  if (!readiness.ok) return readiness;

  console.log(
    `[prepareLiveMeasurement] ${adminBaseUrl.value.url}/readyz answered 200 (${adminBaseUrl.value.source})`,
  );

  printLiveWritePlan(argumentValues);

  const transport = createTransport(config.value.transport, config.value);
  const idMap = new IdMap({ nextNodeId: MEASURE_ID_BASE, nextRelationshipId: MEASURE_ID_BASE });
  // No idMapPaths: a measurement must not leave anything behind in data/graph/.
  const writer = new GraphWriter(new TransportSink(transport), idMap);

  const written = await writeSyntheticSlice(writer, argumentValues.dependentCount);
  if (!written.ok) {
    const closed = await closeTransport(transport);
    if (!closed.ok) console.warn(`[prepareLiveMeasurement] ${closed.failure.message}`);
    return written;
  }

  const gateway = new HydraGateway(transport);
  const targetNodeId = await resolveTargetNodeId(gateway);
  if (!targetNodeId.ok) {
    const closed = await closeTransport(transport);
    if (!closed.ok) console.warn(`[prepareLiveMeasurement] ${closed.failure.message}`);
    return targetNodeId;
  }

  return succeed({
    mode: "live",
    source: transport.describe(),
    gateway,
    targetNodeId: targetNodeId.value,
  });
}

function createTransport(kind: HydraTransportKind, config: HydraConfig): GraphTransport {
  return kind === "bolt" ? new BoltTransport(config) : new HttpTransport(config);
}

/**
 * Where /readyz lives.
 *
 * A copy of the derivation in scripts/hydra-health.ts rather than an import: that file
 * is an entry point that exits the process on import, so its helpers cannot be reused.
 * The rule is the same. HYDRA_ADMIN_URL wins, otherwise the admin URL is derived from
 * HYDRA_HTTP_URL by swapping the query port for the admin port, and the derivation
 * refuses to guess when the query URL does not carry the expected port.
 */
function resolveAdminBaseUrl(
  config: HydraConfig,
  environment: Record<string, string | undefined> = process.env,
): Result<{ url: string; source: string }, Failure> {
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
 * Proves a node is willing to serve, on the admin port.
 *
 * Readiness is checked on 9090 and not on the query port, because the query listener
 * accepts a connection before the node will answer, so a probe against 8443 goes green
 * early and the first real query then fails.
 * sourceRef: docs/HYDRADB.md section 9.
 */
async function probeNodeReadiness(adminBaseUrl: string): Promise<Result<void, Failure>> {
  const readyUrl = `${adminBaseUrl}/readyz`;
  let lastDetail = "no attempt was made";

  for (let attempt = 1; attempt <= READINESS_ATTEMPT_LIMIT; attempt += 1) {
    const response = await fromThrowing(
      "graph_unavailable",
      "[probeNodeReadiness] cannot reach the admin endpoint",
      () => fetch(readyUrl, { method: "GET", signal: AbortSignal.timeout(READINESS_PROBE_TIMEOUT_MS) }),
    );

    if (response.ok) {
      if (response.value.status === 200) return succeed(undefined);
      lastDetail = `HTTP ${response.value.status}, the node is up but not willing to serve yet`;
    } else {
      lastDetail = response.failure.message;
    }

    console.log(`[probeNodeReadiness] attempt ${attempt}: ${lastDetail}`);
    if (attempt < READINESS_ATTEMPT_LIMIT) await sleepMs(READINESS_RETRY_DELAY_MS);
  }

  return fail(
    "graph_unavailable",
    `[probeNodeReadiness] no ready HydraDB at ${readyUrl} after ${READINESS_ATTEMPT_LIMIT} attempts ` +
      `(${lastDetail}). Nothing was measured. Start the node with \`${COMPOSE_START_COMMAND}\` and wait for ` +
      "`bun run hydra:health` to pass, then rerun. For an in-process check that does NOT measure engine " +
      "cost, rerun with --memory.",
  );
}

/** Says what the live mode is about to write, before it writes it. */
function printLiveWritePlan(argumentValues: MeasureArguments): void {
  console.log(
    `[printLiveWritePlan] writing a synthetic slice: 1 target version, ` +
      `${argumentValues.dependentCount} dependent version(s), and the RESOLVES_TO plus DEPENDED_ON_BY edge ` +
      `for each, under node ids from ${MEASURE_ID_BASE}. Ingested ids grow from 0, so nothing real is ` +
      "touched. There is no delete in the Cypher subset this project uses, so the slice stays in the graph.",
  );
}

// ---------------------------------------------------------------------------
// Setup: in-process MemoryGraph
// ---------------------------------------------------------------------------

/**
 * Builds the same synthetic slice in this process.
 *
 * This exists so the comparison can be exercised and its shape verified with no server,
 * which is the situation whenever Docker is unavailable. It is not a substitute for the
 * live measurement: MemoryGraph is a pair of TypeScript maps, its adjacency lists are
 * already in memory, and it has no query planner, no wire format, and no admission
 * control. Its timings describe this process, not HydraDB.
 */
async function prepareMemoryMeasurement(
  argumentValues: MeasureArguments,
): Promise<Result<PreparedMeasurement, Failure>> {
  console.warn(
    "[prepareMemoryMeasurement] IN-PROCESS MODE: this measures MemoryGraph inside this Bun process. " +
      "It does NOT measure HydraDB and its numbers must never be quoted as engine cost.",
  );

  const graph = new MemoryGraph();
  const idMap = new IdMap({ nextNodeId: MEASURE_ID_BASE, nextRelationshipId: MEASURE_ID_BASE });
  const writer = new GraphWriter(new MemorySink(graph), idMap);

  const written = await writeSyntheticSlice(writer, argumentValues.dependentCount);
  if (!written.ok) return written;

  const targetNodeId = await resolveTargetNodeId(graph);
  if (!targetNodeId.ok) return targetNodeId;

  return succeed({
    mode: "memory",
    source: graph.describe(),
    gateway: graph,
    targetNodeId: targetNodeId.value,
  });
}

// ---------------------------------------------------------------------------
// The synthetic slice
// ---------------------------------------------------------------------------

/**
 * A fan-in: many dependent versions, one target version, one resolution edge each.
 *
 * Fan-in is the shape the product's query has. "Who depends on this compromised
 * version" is answered by expanding one node's reverse edges, so the cost that matters
 * is the cost of that expansion, not the cost of a deep walk.
 */
function buildSyntheticSlice(dependentCount: number): IngestSlice {
  const packages: PackageFacts[] = [
    {
      ecosystem: MEASURE_ECOSYSTEM,
      name: TARGET_PACKAGE_NAME,
      weeklyDownloads: SYNTHETIC_ABSENT_NUMBER,
      maintainerUsernames: [],
    },
  ];

  const versions: VersionFacts[] = [
    {
      ecosystem: MEASURE_ECOSYSTEM,
      name: TARGET_PACKAGE_NAME,
      version: TARGET_VERSION,
      publishedAtMs: SYNTHETIC_ABSENT_NUMBER,
      hasInstallScript: false,
      declaredDependencies: [],
      resolvedDependencies: [],
    },
  ];

  for (let dependentIndex = 0; dependentIndex < dependentCount; dependentIndex += 1) {
    const dependentName = `${DEPENDENT_PACKAGE_PREFIX}${dependentIndex}`;

    packages.push({
      ecosystem: MEASURE_ECOSYSTEM,
      name: dependentName,
      weeklyDownloads: SYNTHETIC_ABSENT_NUMBER,
      maintainerUsernames: [],
    });

    versions.push({
      ecosystem: MEASURE_ECOSYSTEM,
      name: dependentName,
      version: DEPENDENT_VERSION,
      publishedAtMs: SYNTHETIC_ABSENT_NUMBER,
      hasInstallScript: false,
      declaredDependencies: [],
      resolvedDependencies: [
        { ecosystem: MEASURE_ECOSYSTEM, name: TARGET_PACKAGE_NAME, version: TARGET_VERSION },
      ],
    });
  }

  return { packages, versions, services: [], advisories: [], typosquats: [] };
}

/** Stages the slice through the same builder and writer the ingest uses, then flushes. */
async function writeSyntheticSlice(
  writer: GraphWriter,
  dependentCount: number,
): Promise<Result<void, Failure>> {
  const slice = buildSyntheticSlice(dependentCount);

  const built = await buildGraph(writer, slice, { generatedAtMs: Date.now() });
  if (!built.ok) return built;

  const flushed = await writer.flush();
  if (!flushed.ok) return flushed;

  console.log(
    `[writeSyntheticSlice] wrote ${flushed.value.nodesWritten} node(s) and ` +
      `${flushed.value.edgesWritten} edge(s) in ${flushed.value.nodeBatches} node batch(es) and ` +
      `${flushed.value.edgeBatches} edge batch(es)`,
  );
  for (const note of flushed.value.notes) console.warn(`[writeSyntheticSlice] note: ${note}`);

  return succeed(undefined);
}

/** Resolves the target version's integer id the way the app does, which also proves the write landed. */
async function resolveTargetNodeId(gateway: GraphGateway): Promise<Result<number, Failure>> {
  const targetKey = versionKey(MEASURE_ECOSYSTEM, TARGET_PACKAGE_NAME, TARGET_VERSION);

  const resolved = await gateway.resolveNodeIds({ label: "Version", keys: [targetKey] });
  if (!resolved.ok) return resolved;

  const nodeId = resolved.value.get(targetKey);
  if (nodeId === undefined) {
    return fail(
      "not_found",
      `[resolveTargetNodeId] the synthetic target "${targetKey}" is not in the graph after the write, ` +
        "so there is nothing to measure",
    );
  }
  return succeed(nodeId);
}

// ---------------------------------------------------------------------------
// The measurement
// ---------------------------------------------------------------------------

async function measureBothPatterns(
  prepared: PreparedMeasurement,
  argumentValues: MeasureArguments,
): Promise<Result<MeasurementReport, Failure>> {
  const { gateway, targetNodeId } = prepared;
  const resultLimit = argumentValues.dependentCount;

  const incomingNeighbors = await timeIterations(
    "incoming RESOLVES_TO neighbors",
    argumentValues.iterationCount,
    async () => {
      const edges = await gateway.neighbors({
        nodeId: targetNodeId,
        nodeLabel: "Version",
        relType: "RESOLVES_TO",
        direction: "incoming",
        limit: resultLimit,
      });
      return edges.ok ? succeed(edges.value.length) : edges;
    },
  );
  if (!incomingNeighbors.ok) return incomingNeighbors;

  const materialisedWalk = await timeIterations(
    "outgoing DEPENDED_ON_BY one-hop walk",
    argumentValues.iterationCount,
    async () => {
      const paths = await gateway.pathsFromSource({
        sourceNodeId: targetNodeId,
        relTypes: ["DEPENDED_ON_BY"],
        direction: "outgoing",
        maxLength: 1,
        pathCount: resultLimit,
      });
      return paths.ok ? succeed(paths.value.length) : paths;
    },
  );
  if (!materialisedWalk.ok) return materialisedWalk;

  const reversePathWalk = await checkReversePathWalk(gateway, targetNodeId, resultLimit);

  return succeed({
    mode: prepared.mode,
    source: prepared.source,
    dependentCount: argumentValues.dependentCount,
    iterationCount: argumentValues.iterationCount,
    incomingNeighbors: incomingNeighbors.value,
    materialisedWalk: materialisedWalk.value,
    reversePathWalk,
  });
}

/**
 * Records whether the engine really accepts a path walk in the incoming direction.
 *
 * relDirection: "incoming" is documented and both gateways send it, so this checks that
 * the server in front of us agrees rather than taking the document on trust. The answer
 * decides how the verdict below frames the materialised edge: accepted means
 * DEPENDED_ON_BY is an index-shape choice between two working shapes, refused means it is
 * the only shape available beyond one hop. Not timed, because acceptance is a capability
 * and not a cost. sourceRef: docs/HYDRADB.md section 4.
 */
async function checkReversePathWalk(
  gateway: GraphGateway,
  targetNodeId: number,
  resultLimit: number,
): Promise<ReverseWalkAvailability> {
  const attempted = await gateway.pathsFromSource({
    sourceNodeId: targetNodeId,
    relTypes: ["RESOLVES_TO"],
    direction: "incoming",
    maxLength: 1,
    pathCount: resultLimit,
  });

  if (attempted.ok) {
    return {
      isAccepted: true,
      detail: `accepted, ${attempted.value.length} path(s), which is a capability check and not a timed cost`,
    };
  }
  return { isAccepted: false, detail: `refused, reason=${attempted.failure.reason}` };
}

/**
 * Runs one pattern and summarises its latency.
 *
 * A warmup call is discarded so connection setup and first-touch compilation do not
 * land in the samples. Every iteration's row count is compared with the first: an
 * unchanged graph that answers differently twice makes the timings incomparable, and
 * that is a failure rather than a footnote.
 */
async function timeIterations(
  patternLabel: string,
  iterationCount: number,
  runOnce: () => Promise<Result<number, Failure>>,
): Promise<Result<PatternOutcome, Failure>> {
  for (let warmup = 0; warmup < WARMUP_ITERATION_COUNT; warmup += 1) {
    const warmed = await runOnce();
    if (!warmed.ok) return warmed;
  }

  const samplesMs: number[] = [];
  let firstRowCount: number | null = null;

  for (let iteration = 0; iteration < iterationCount; iteration += 1) {
    const startedAtMs = performance.now();
    const executed = await runOnce();
    const elapsedMs = performance.now() - startedAtMs;
    if (!executed.ok) return executed;

    if (firstRowCount === null) firstRowCount = executed.value;
    else if (executed.value !== firstRowCount) {
      return fail(
        "internal",
        `[timeIterations] ${patternLabel} returned ${firstRowCount} row(s) then ${executed.value} over an ` +
          "unchanged graph, so its timings are not comparable",
      );
    }

    samplesMs.push(elapsedMs);
  }

  if (firstRowCount === null) {
    return fail("invalid_input", `[timeIterations] ${patternLabel} was asked for 0 iterations`);
  }

  return succeed({ rowCount: firstRowCount, latency: summariseLatencies(samplesMs) });
}

/** Min, median and max, which is what a small sample can honestly support. */
function summariseLatencies(samplesMs: readonly number[]): LatencySummary {
  const sorted = [...samplesMs].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const medianMs =
    sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;

  return {
    minMs: sorted[0],
    medianMs,
    maxMs: sorted[sorted.length - 1],
    sampleCount: sorted.length,
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printMeasurementReport(report: MeasurementReport): void {
  const rows: readonly [string, string][] = [
    ["mode", describeMode(report.mode)],
    ["source", report.source],
    ["fan-in size", `${report.dependentCount} dependent version(s)`],
    ["iterations", `${report.iterationCount} timed, ${WARMUP_ITERATION_COUNT} warmup discarded`],
    ["A rows", String(report.incomingNeighbors.rowCount)],
    ["A latency ms", describeLatency(report.incomingNeighbors.latency)],
    ["B rows", String(report.materialisedWalk.rowCount)],
    ["B latency ms", describeLatency(report.materialisedWalk.latency)],
    ["reverse path walk", report.reversePathWalk.detail],
  ];

  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  console.log("[printMeasurementReport] one-hop reverse traversal cost");
  console.log("[printMeasurementReport]   A = neighbors(RESOLVES_TO, incoming)");
  console.log("[printMeasurementReport]   B = pathsFromSource(DEPENDED_ON_BY, outgoing, 1 hop)");
  for (const [label, value] of rows) {
    console.log(`[printMeasurementReport]   ${label.padEnd(labelWidth)}  ${value}`);
  }

  if (report.mode === "memory") {
    console.warn(
      "[printMeasurementReport] REMINDER: these are in-process MemoryGraph timings. They do not " +
        "reflect HydraDB cost and must not be reported as an engine measurement.",
    );
  }
}

/** Names the faster pattern, with the ratio, and refuses to call a tie a win. */
function printVerdict(report: MeasurementReport): void {
  const incomingMedianMs = report.incomingNeighbors.latency.medianMs;
  const walkMedianMs = report.materialisedWalk.latency.medianMs;
  const scope = report.mode === "memory" ? "in this process only" : "on this engine";

  if (incomingMedianMs === 0 || walkMedianMs === 0) {
    console.log(
      `[printVerdict] one median is 0.000 ms, which is below the timer's useful resolution: rerun with ` +
        "a larger --dependents or more --iterations before drawing a conclusion",
    );
    return;
  }

  const ratio = incomingMedianMs / walkMedianMs;
  const faster = ratio < 1 ? "A, the incoming MATCH" : "B, the materialised DEPENDED_ON_BY walk";
  const factor = ratio < 1 ? 1 / ratio : ratio;

  console.log(
    `[printVerdict] ${scope}, ${faster} is faster by ${factor.toFixed(2)}x on the median ` +
      `(A ${formatMs(incomingMedianMs)} ms, B ${formatMs(walkMedianMs)} ms over ` +
      `${report.iterationCount} iteration(s) at fan-in ${report.dependentCount})`,
  );

  if (!report.reversePathWalk.isAccepted) {
    console.log(
      "[printVerdict] the reverse path walk was refused, so B is the only shape available beyond one " +
        "hop: the materialised edge is a requirement, not an optimisation",
    );
  }
}

function describeMode(mode: MeasurementMode): string {
  return mode === "memory"
    ? "in-process MemoryGraph, NOT an engine measurement"
    : "live HydraDB through HydraGateway";
}

function describeLatency(latency: LatencySummary): string {
  return `min ${formatMs(latency.minMs)}  median ${formatMs(latency.medianMs)}  max ${formatMs(latency.maxMs)}`;
}

/** Three decimals, because a one-hop expansion can land well under a millisecond. */
function formatMs(value: number): string {
  return value.toFixed(3);
}

/** Prints a Failure in full, then the next thing to try. Same shape as hydra-health. */
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

function describeRemedy(failure: Failure): string | null {
  switch (failure.reason) {
    case "invalid_input":
      return `check .env against .env.example and the arguments. ${USAGE_LINE}`;
    case "graph_unavailable":
      return `start HydraDB with \`${COMPOSE_START_COMMAND}\`, or rerun with --memory for an in-process check`;
    case "query_budget_exceeded":
      return "lower --dependents: the engine rejected the traversal on the budget named above";
    case "timeout":
      return "the node accepted the request but did not finish it, check `docker compose logs graph-node`";
    case "unsupported":
      return "this gateway refuses the traversal shape, which is the fact the measurement exists to record";
    default:
      return null;
  }
}

/** Closes the gateway. A driver close is a throwing boundary, so it is wrapped. */
async function closeGateway(gateway: GraphGateway): Promise<Result<void, Failure>> {
  return fromThrowing("internal", "[closeGateway] gateway did not close cleanly", async () => {
    await gateway.close();
  });
}

async function closeTransport(transport: GraphTransport): Promise<Result<void, Failure>> {
  return fromThrowing("internal", "[closeTransport] transport did not close cleanly", async () => {
    await transport.close();
  });
}

function sleepMs(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

const exitCode = await runMeasurement(process.argv.slice(2));
process.exit(exitCode);
