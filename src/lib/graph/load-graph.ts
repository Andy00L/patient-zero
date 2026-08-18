/**
 * The one place the app obtains a graph to answer from.
 *
 * Every route handler calls `loadGraph()` and gets three things back: a gateway, the slice
 * coverage that qualifies whatever the gateway says, and a log-safe description of which
 * source answered. Nothing else in `src/app` constructs a gateway, so there is a single
 * answer to "where did this number come from" and a single place to change it.
 *
 * Order of attempts:
 *   1. `HYDRA_SNAPSHOT_PATH`, when set, pins the answer to that file and nothing else is
 *      tried. An operator naming a file is naming the source; quietly answering from a
 *      different graph would make the variable a suggestion rather than a setting.
 *   2. A configured HydraDB, probed with one cheap count before it is trusted. A reachable
 *      DSN in the environment is not the same as a graph that answers.
 *   3. The committed snapshots, in the order below.
 *
 * When none of them works the result is a Failure, never an empty graph. "No ingest has run"
 * and "nothing depends on this package" are different answers, and the abstention model can
 * only tell them apart if the loader refuses to invent the second one.
 *
 * The load is cached in module scope, so a warm request reuses the parsed graph instead of
 * re-reading and re-parsing a megabyte of JSON. Failures are not cached: a HydraDB that was
 * down a second ago is retried on the next request.
 */

import type { GraphGateway } from "@/lib/graph/gateway";
import {
  SliceCoverage,
  type SliceManifest,
  DEFAULT_SLICE_MANIFEST_PATH,
  loadSliceManifest,
} from "@/lib/graph/slice-manifest";
import { RecordingGateway } from "@/lib/graph/recording-gateway";
import { DEFAULT_GRAPH_SNAPSHOT_PATH, loadGraphSnapshot } from "@/lib/graph/snapshot";
import { BoltTransport } from "@/lib/hydra/bolt-transport";
import { type HydraConfig, readHydraConfigFromEnv, readSnapshotPathFromEnv } from "@/lib/hydra/config";
import { HttpTransport } from "@/lib/hydra/http-transport";
import { HydraGateway } from "@/lib/hydra/hydra-gateway";
import { RecordingTransport } from "@/lib/hydra/recording-transport";
import type { GraphTransport } from "@/lib/hydra/transport";
import { type Failure, type Result, fail, fromThrowing, fromThrowingSync, succeed } from "@/lib/result";

/** Which kind of source answered. Rendered in the status rail. */
export type GraphSourceKind = "hydradb" | "snapshot";

/**
 * Where the answers come from, in terms safe to log and safe to return to a browser.
 *
 * `detail` is either a redacted description of the live target or a repo-relative snapshot path
 * plus the writer that produced it. No host, no connection string, no token, ever.
 */
export type GraphSource = {
  kind: GraphSourceKind;
  detail: string;
  /**
   * When the answering data was produced: the snapshot's write instant, or the slice
   * manifest's ingest instant when a live graph answers.
   */
  generatedAtMs: number;
  /**
   * Set when something better was tried and did not answer: a configured HydraDB that failed
   * its probe, or a snapshot candidate that was rejected. Carries failure reasons and paths
   * only, never a message from the transport, because those can name a host.
   */
  degradedReason: string | null;
};

export type LoadedGraph = {
  gateway: GraphGateway;
  /** Membership lookups the analysis layer needs to qualify every verdict. */
  coverage: SliceCoverage;
  /** The raw manifest, for the counts and key lists the status rail reports. */
  manifest: SliceManifest;
  source: GraphSource;
};

/**
 * Committed snapshots, best first.
 *
 * `demo-snapshot.json` is the merged graph: scripts/build-demo-graph.ts unions the incident
 * seed with the registry ingest, so it is the only file that can answer both "who pinned this
 * while the payload was live" (Service and RESOLVED) and "what depends on it" (DEPENDS_ON,
 * RESOLVES_TO, MAINTAINS). That script keeps its output path private, so the read side names
 * it here. The two inputs stay in the list behind it because each one still answers its own
 * half, and half an answer with honest coverage beats a 503.
 */
export const SNAPSHOT_CANDIDATE_PATHS: readonly string[] = [
  "data/graph/demo-snapshot.json",
  DEFAULT_GRAPH_SNAPSHOT_PATH,
  "data/graph/slice-snapshot.json",
];

/**
 * The in-flight or completed load. Holding the promise rather than the value means two
 * concurrent cold requests share one parse instead of racing to do it twice.
 */
let cachedGraph: Promise<Result<LoadedGraph, Failure>> | null = null;

/**
 * The graph, loaded once per process.
 *
 * The returned promise never rejects: every step inside is a Result and the whole attempt is
 * wrapped, because a route that awaits this must not have to guard against a throw.
 */
export function loadGraph(): Promise<Result<LoadedGraph, Failure>> {
  const cached = cachedGraph;
  if (cached !== null) return cached;

  const attempt = openGraphWithoutThrowing().then((loaded) => {
    // A failed load is not remembered: the next request tries again, which is what makes a
    // restarted HydraDB or a freshly written snapshot visible without restarting the app.
    if (!loaded.ok && cachedGraph === attempt) cachedGraph = null;
    return loaded;
  });

  cachedGraph = attempt;
  return attempt;
}

/**
 * Drops the cached graph and releases the gateway behind it.
 *
 * Used by tests that point `HYDRA_SNAPSHOT_PATH` at a fixture between cases. Also the
 * supported way to pick up a snapshot that was rewritten while the app was running.
 */
export async function resetLoadedGraph(): Promise<void> {
  const pending = cachedGraph;
  cachedGraph = null;
  if (pending === null) return;

  const loaded = await pending;
  if (loaded.ok) await closeQuietly(loaded.value.gateway);
}

async function openGraphWithoutThrowing(): Promise<Result<LoadedGraph, Failure>> {
  const attempted = await fromThrowing("internal", "[loadGraph] the graph loader threw", openGraph);
  if (!attempted.ok) return attempted;
  return attempted.value;
}

async function openGraph(): Promise<Result<LoadedGraph, Failure>> {
  const pinnedPath = readSnapshotPathFromEnv(process.env);
  if (pinnedPath !== null) return openSnapshot([pinnedPath], null);

  const config = readHydraConfigFromEnv();
  // A config failure here is the ordinary "HydraDB is not configured" case, not an error to
  // report: the snapshot path is the supported way to run this app.
  if (!config.ok) return openSnapshot(SNAPSHOT_CANDIDATE_PATHS, null);

  const live = await openHydra(config.value);
  if (live.ok) return live;

  return openSnapshot(
    SNAPSHOT_CANDIDATE_PATHS,
    `hydradb was configured but did not answer (${live.failure.reason})`,
  );
}

async function openHydra(config: HydraConfig): Promise<Result<LoadedGraph, Failure>> {
  const transport = fromThrowingSync(
    "graph_unavailable",
    "[loadGraph] cannot open the HydraDB transport",
    (): GraphTransport =>
      config.transport === "http" ? new HttpTransport(config) : new BoltTransport(config),
  );
  if (!transport.ok) return transport;

  // Both decorators, because they record different halves of the same account: the transport
  // sees the real Cypher, the gateway sees which semantic operation asked for it. Neither does
  // anything at all unless a caller opened a scope with withStatementLog.
  // sourceRef: src/lib/graph/statements.ts.
  const gateway = new RecordingGateway(new HydraGateway(new RecordingTransport(transport.value)));

  // One count before anything else. It is the cheapest question that separates a configured
  // DSN from a graph that answers, and getting the failure here means a route never has to
  // explain a transport error in the middle of a blast radius. The number is kept rather than
  // discarded, because the manifest below is a claim about a graph and this is the graph.
  const probe = await gateway.countNodes("Version");
  if (!probe.ok) {
    await closeQuietly(gateway);
    return probe;
  }

  const manifest = await loadSliceManifest();
  if (!manifest.ok) {
    await closeQuietly(gateway);
    // A live graph with no coverage claim would answer unknown to every question, which looks
    // like a bug rather than a missing file. Failing here lets the snapshot path answer, and
    // a snapshot always carries its own manifest.
    return fail(
      "graph_unavailable",
      `[loadGraph] HydraDB answered but ${DEFAULT_SLICE_MANIFEST_PATH} could not be read (${manifest.failure.reason}), so nothing can qualify its answers`,
    );
  }

  return succeed({
    gateway,
    coverage: new SliceCoverage(manifest.value),
    manifest: manifest.value,
    source: {
      kind: "hydradb",
      detail: describeLiveTarget(config),
      generatedAtMs: manifest.value.generatedAtMs,
      degradedReason: describeManifestSkew(manifest.value, probe.value),
    },
  });
}

/**
 * Whether the coverage claim on disk can be trusted to describe the graph that just answered.
 *
 * On the snapshot path the manifest travels inside the file it describes, so the two cannot
 * disagree. A live engine has no such guarantee: the manifest is a separate file written by
 * whichever ingest ran last, and the engine holds whatever was pushed into it. The two drift in
 * both directions and only one of them is a fault.
 *
 * More in the graph than the manifest claims is the expected shape, not a problem. A live run
 * seeds the incident packs on top of a registry ingest and deliberately leaves the manifest as
 * the ingest's record, because a coverage claim that is behind can only make an answer abstain,
 * never make it read clean. sourceRef: scripts/seed-incidents.ts (describeCoverageLocation).
 *
 * Fewer is a fault, and it is the one that has already been hit in this repository: an engine
 * holding two Version nodes answered every surface from the near-empty path while the rail
 * reported the full ingest, because the rail reads the manifest and the manifest was describing
 * a graph that was no longer there. Reporting it as degraded is what separates "this slice is
 * small" from "this claim is about a different graph".
 *
 * Counts only. No host, no path, no token: this string is returned to a browser.
 */
function describeManifestSkew(manifest: SliceManifest, observedVersionCount: number): string | null {
  const claimed = manifest.counts.versions;
  if (claimed <= observedVersionCount) return null;

  return (
    `the slice manifest claims ${claimed} versions but this graph holds ${observedVersionCount}, ` +
    "so its coverage claim describes a graph that is not the one answering"
  );
}

/**
 * Names the live target without its URI.
 *
 * `GraphTransport.describe()` is log safe in the sense that it holds no token, but it does
 * hold the base URL or the Bolt URI, and this string is returned to a browser. The graph and
 * cell identifiers say which graph answered, which is the whole question the status rail asks,
 * and they grant no access on their own.
 */
function describeLiveTarget(config: HydraConfig): string {
  return config.transport === "http"
    ? `hydradb over http (graph ${config.graphId}, cell ${config.cellId})`
    : `hydradb over bolt (graph ${config.graphId}, database ${config.database})`;
}

async function openSnapshot(
  paths: readonly string[],
  degradedReason: string | null,
): Promise<Result<LoadedGraph, Failure>> {
  const rejected: string[] = [];

  for (const path of paths) {
    const loaded = await loadGraphSnapshot(path);
    if (!loaded.ok) {
      rejected.push(`${path} (${loaded.failure.reason})`);
      continue;
    }

    const skipped = rejected.length > 0 ? `skipped ${rejected.join(", ")}` : null;
    return succeed({
      // The in-process graph speaks no Cypher, so only the operation half of the record
      // applies here. That is the honest shape: an answer from a snapshot lists the graph
      // operations that produced it and states that no engine was contacted.
      gateway: new RecordingGateway(loaded.value.graph),
      coverage: new SliceCoverage(loaded.value.manifest),
      manifest: loaded.value.manifest,
      source: {
        kind: "snapshot",
        detail: `${loaded.value.path} written by ${loaded.value.source}`,
        generatedAtMs: loaded.value.generatedAtMs,
        degradedReason: joinReasons(degradedReason, skipped),
      },
    });
  }

  return fail(
    "graph_unavailable",
    `[loadGraph] no graph is available. Tried ${rejected.length > 0 ? rejected.join(", ") : "no candidate path"}. ` +
      "Run an ingest, or point HYDRA_SNAPSHOT_PATH at a snapshot.",
    { context: { candidateCount: paths.length } },
  );
}

function joinReasons(first: string | null, second: string | null): string | null {
  const parts = [first, second].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join("; ") : null;
}

/**
 * Best-effort close. The caller is already returning a failure, and a driver that cannot
 * release its sockets has nothing to add to it.
 */
async function closeQuietly(gateway: GraphGateway): Promise<void> {
  await fromThrowing("internal", "[loadGraph] closing the gateway failed", () => gateway.close());
}
