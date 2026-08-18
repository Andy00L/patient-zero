import { describe, expect, test } from "bun:test";

import { MemoryGraph } from "@/lib/graph/memory-gateway";
import { type RelType, REL_TYPES } from "@/lib/graph/model";
import { IdMap } from "@/lib/hydra/id-map";
import {
  type BuildReport,
  type IngestSlice,
  type ServiceFacts,
  type VersionFacts,
  buildGraph,
  emptyIngestSlice,
} from "@/lib/ingest/graph-builder";
import { GraphWriter, MemorySink } from "@/lib/ingest/writer";
import { type Failure, type Result } from "@/lib/result";

/**
 * The builder's job is to make the manifest describe the graph it just wrote. Both defects
 * covered here were of the same kind: a number that looked plausible and disagreed with
 * the graph, which is worse than an error because nothing reports it.
 *
 * Every case builds through MemoryGraph, so the assertions compare the manifest against
 * the edges and nodes that actually landed rather than against another copy of the
 * builder's own bookkeeping.
 */

const RESOLVED_AT_MS = 1_700_000_000_000;
const PUBLISHED_AT_MS = 1_690_000_000_000;
const GENERATED_AT_MS = 1_700_000_100_000;

const LEDGER_SERVICE_KEY = "svc:ledger-api";
const LEDGER_SERVICE_NAME = "ledger-api";

type BuiltGraph = {
  graph: MemoryGraph;
  report: BuildReport;
};

/** Builds a slice all the way into a MemoryGraph, so nothing is asserted on a plan. */
async function buildOrUnreachable(slice: IngestSlice): Promise<BuiltGraph> {
  const graph = new MemoryGraph();
  const writer = new GraphWriter(new MemorySink(graph), new IdMap());

  const built = await buildGraph(writer, slice, { generatedAtMs: GENERATED_AT_MS });
  if (!built.ok) return expect.unreachable(`build failed: ${built.failure.message}`);

  const flushed: Result<unknown, Failure> = await writer.flush();
  if (!flushed.ok) return expect.unreachable(`flush failed: ${flushed.failure.message}`);

  return { graph, report: built.value };
}

/** How many edges of one relationship type the graph holds. The ground truth. */
function countEdges(graph: MemoryGraph, relType: RelType): number {
  return graph.listEdges().filter((edge) => edge.relType === relType).length;
}

function buildVersion(name: string, version: string): VersionFacts {
  return {
    ecosystem: "npm",
    name,
    version,
    publishedAtMs: PUBLISHED_AT_MS,
    hasInstallScript: false,
    declaredDependencies: [],
    resolvedDependencies: [],
  };
}

function buildLedgerService(resolvedVersions: readonly string[]): ServiceFacts {
  return {
    key: LEDGER_SERVICE_KEY,
    name: LEDGER_SERVICE_NAME,
    source: "seed",
    resolutions: resolvedVersions.map((version) => ({
      ecosystem: "npm",
      name: "event-stream",
      version,
      resolvedAtMs: RESOLVED_AT_MS,
    })),
  };
}

describe("resolution edge count", () => {
  test("a lockfile-only slice reports the RESOLVED edges it wrote, not zero", async () => {
    // The incident seed produces exactly this shape: every resolution is a service
    // lockfile pin and no version states a dependency closure. The manifest used to report
    // 0 here because it counted the version-to-version closure list, which is empty.
    const slice: IngestSlice = {
      ...emptyIngestSlice(),
      packages: [
        { ecosystem: "npm", name: "event-stream", weeklyDownloads: 1000, maintainerUsernames: [] },
      ],
      versions: [buildVersion("event-stream", "3.3.6"), buildVersion("event-stream", "3.3.5")],
      services: [buildLedgerService(["3.3.6", "3.3.5"])],
    };

    const built = await buildOrUnreachable(slice);

    const resolvedEdges = countEdges(built.graph, REL_TYPES.resolved);
    expect(resolvedEdges).toBe(2);
    expect(countEdges(built.graph, REL_TYPES.resolvesTo)).toBe(0);
    expect(built.report.manifest.counts.resolutionEdges).toBe(resolvedEdges);
  });

  test("a slice holding both kinds reports their sum", async () => {
    const slice: IngestSlice = {
      ...emptyIngestSlice(),
      packages: [
        { ecosystem: "npm", name: "event-stream", weeklyDownloads: 1000, maintainerUsernames: [] },
        { ecosystem: "npm", name: "flatmap-stream", weeklyDownloads: 5, maintainerUsernames: [] },
      ],
      versions: [
        {
          ...buildVersion("event-stream", "3.3.6"),
          resolvedDependencies: [{ ecosystem: "npm", name: "flatmap-stream", version: "0.1.1" }],
        },
        buildVersion("flatmap-stream", "0.1.1"),
      ],
      services: [buildLedgerService(["3.3.6"])],
    };

    const built = await buildOrUnreachable(slice);

    const resolvesTo = countEdges(built.graph, REL_TYPES.resolvesTo);
    const resolved = countEdges(built.graph, REL_TYPES.resolved);
    expect(resolvesTo).toBe(1);
    expect(resolved).toBe(1);
    expect(built.report.manifest.counts.resolutionEdges).toBe(resolvesTo + resolved);
  });

  test("an empty slice reports no resolutions rather than a stale number", async () => {
    const built = await buildOrUnreachable(emptyIngestSlice());

    expect(built.graph.edgeCount).toBe(0);
    expect(built.report.manifest.counts.resolutionEdges).toBe(0);
  });
});

describe("service identity", () => {
  test("a Service node carries the stated key and the readable name as two properties", async () => {
    const slice: IngestSlice = {
      ...emptyIngestSlice(),
      packages: [
        { ecosystem: "npm", name: "event-stream", weeklyDownloads: 1000, maintainerUsernames: [] },
      ],
      versions: [buildVersion("event-stream", "3.3.6")],
      services: [buildLedgerService(["3.3.6"])],
    };

    const built = await buildOrUnreachable(slice);

    // Addressable by the key, because the key is what an MSpaths selector matches.
    const nodeId = built.graph.findNodeIdByKey("Service", LEDGER_SERVICE_KEY);
    expect(nodeId).not.toBeNull();

    const serviceNode = built.graph.listNodes().find((node) => node.label === "Service");
    expect(serviceNode?.properties.key).toBe(LEDGER_SERVICE_KEY);
    // The regression: the readable name used to be overwritten by the key, so the UI had
    // nothing to render but "svc:ledger-api".
    expect(serviceNode?.properties.name).toBe(LEDGER_SERVICE_NAME);
  });

  test("closedServiceKeys lists keys, so a manifest entry still resolves to a node", async () => {
    const slice: IngestSlice = {
      ...emptyIngestSlice(),
      packages: [
        { ecosystem: "npm", name: "event-stream", weeklyDownloads: 1000, maintainerUsernames: [] },
      ],
      versions: [buildVersion("event-stream", "3.3.6")],
      services: [buildLedgerService(["3.3.6"])],
    };

    const built = await buildOrUnreachable(slice);

    expect(built.report.manifest.closedServiceKeys).toEqual([LEDGER_SERVICE_KEY]);
    expect(built.report.manifest.counts.services).toBe(1);
  });
});
