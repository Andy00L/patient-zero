import { describe, expect, test } from "bun:test";

import { MemoryGraph } from "@/lib/graph/memory-gateway";
import { packageKey } from "@/lib/graph/model";
import {
  BATCH_COLUMNS,
  type EdgeBatchSpec,
  type NodeBatchRow,
  type NodeBatchSpec,
} from "@/lib/hydra/cypher";
import { IdMap } from "@/lib/hydra/id-map";
import {
  type GraphSink,
  GraphWriter,
  MemorySink,
  type WriteStats,
  packageRef,
  serviceRef,
  versionRef,
} from "@/lib/ingest/writer";
import { type Failure, type Result, fail } from "@/lib/result";

/**
 * The writer is the only code that writes to the graph, and every mistake it can make is
 * invisible at write time: a duplicated edge doubles a blast radius without changing any
 * count that looks wrong, a key that changes id orphans every edge pointing at it, and a
 * mislabelled endpoint is rejected by the engine with nothing but a row index.
 *
 * Docker is not available here, so every test runs against MemorySink, which mirrors the
 * engine's endpoint check, and against a recording sink that refuses over-large batches
 * the way the engine does. Neither needs a server, and both fail for the same reasons one
 * would.
 */

const NPM_CHALK = packageKey("npm", "chalk");
const RESOLVED_AT_MS = 1_700_000_000_000;

/**
 * A sink that records what it was asked to write and can refuse a batch over a row count
 * the way the engine refuses one over max_query_intermediate_rows: as a 429, which the
 * writer is supposed to answer by halving rather than by giving up.
 */
class RecordingSink implements GraphSink {
  readonly calls: string[] = [];
  private readonly inner: MemorySink;

  constructor(
    graph: MemoryGraph,
    private readonly maxRowsPerBatch: number = Number.POSITIVE_INFINITY,
  ) {
    this.inner = new MemorySink(graph);
  }

  async writeNodeBatch(
    spec: NodeBatchSpec,
    rows: readonly NodeBatchRow[],
  ): Promise<Result<void, Failure>> {
    this.calls.push(`node:${spec.label}:${rows.length}`);
    if (rows.length > this.maxRowsPerBatch) return this.refuse(rows.length);
    return await this.inner.writeNodeBatch(spec, rows);
  }

  async writeEdgeBatch(
    spec: EdgeBatchSpec,
    rows: readonly NodeBatchRow[],
  ): Promise<Result<void, Failure>> {
    this.calls.push(`edge:${spec.relType}:${rows.length}`);
    if (rows.length > this.maxRowsPerBatch) return this.refuse(rows.length);
    return await this.inner.writeEdgeBatch(spec, rows);
  }

  describe(): string {
    return `recording sink over ${this.inner.describe()}`;
  }

  private refuse(rowCount: number): Result<void, Failure> {
    return fail("query_budget_exceeded", `[RecordingSink] refused ${rowCount} rows`, {
      status: 429,
      context: { budget: "max_query_intermediate_rows" },
    });
  }
}

type WriterHarness = {
  graph: MemoryGraph;
  sink: RecordingSink;
  idMap: IdMap;
  writer: GraphWriter;
};

function buildHarness(options: { maxRowsPerBatch?: number; batchBudgetBytes?: number } = {}): WriterHarness {
  const graph = new MemoryGraph();
  const sink = new RecordingSink(graph, options.maxRowsPerBatch ?? Number.POSITIVE_INFINITY);
  const idMap = new IdMap();
  const writerOptions =
    options.batchBudgetBytes === undefined ? {} : { batchBudgetBytes: options.batchBudgetBytes };
  return { graph, sink, idMap, writer: new GraphWriter(sink, idMap, writerOptions) };
}

async function nodeIdOrUnreachable(staged: Promise<Result<number, Failure>>): Promise<number> {
  const result = await staged;
  if (result.ok) return result.value;
  return expect.unreachable(`staging failed: ${result.failure.message}`);
}

async function stageOrUnreachable(staged: Promise<Result<void, Failure>>): Promise<void> {
  const result = await staged;
  if (!result.ok) expect.unreachable(`staging failed: ${result.failure.message}`);
}

async function failureOrUnreachable<TValue>(
  attempted: Promise<Result<TValue, Failure>>,
): Promise<Failure> {
  const result = await attempted;
  if (result.ok) return expect.unreachable("expected a Failure, received a value");
  return result.failure;
}

async function flushOrUnreachable(writer: GraphWriter): Promise<WriteStats> {
  const flushed = await writer.flush();
  if (flushed.ok) return flushed.value;
  return expect.unreachable(`flush failed: ${flushed.failure.message}`);
}

/** Stages `count` distinct packages, which is the cheapest way to fill a batch. */
async function stageNumberedPackages(writer: GraphWriter, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await nodeIdOrUnreachable(
      writer.stagePackage({ ecosystem: "npm", name: `fixture-${index}`, weekly_downloads: index }),
    );
  }
}

/** Everything about a graph that a write is supposed to determine, in a stable order. */
function describeGraph(graph: MemoryGraph): string[] {
  const described = graph
    .listNodes()
    .map((node) => `${node.id}|${node.label}|${JSON.stringify(node.properties)}`);
  return described.sort();
}

describe("node identity", () => {
  test("the same node staged twice is one node carrying the last properties", async () => {
    const harness = buildHarness();

    const firstId = await nodeIdOrUnreachable(
      harness.writer.stagePackage({ ecosystem: "npm", name: "chalk", weekly_downloads: 1 }),
    );
    const secondId = await nodeIdOrUnreachable(
      harness.writer.stagePackage({ ecosystem: "npm", name: "chalk", weekly_downloads: 2 }),
    );
    const stats = await flushOrUnreachable(harness.writer);

    expect(secondId).toBe(firstId);
    expect(harness.graph.nodeCount).toBe(1);
    expect(harness.graph.listNodes()[0].properties.weekly_downloads).toBe(2);
    // The counters measure rows sent, not distinct nodes, because the engine's MERGE is
    // what collapses them. Two rows, one node, and both numbers are true.
    expect(stats.nodesWritten).toBe(2);
  });

  test("a natural key keeps its integer id across separate writers", async () => {
    const harness = buildHarness();

    const firstId = await nodeIdOrUnreachable(
      harness.writer.stagePackage({ ecosystem: "npm", name: "chalk", weekly_downloads: 1 }),
    );
    await flushOrUnreachable(harness.writer);

    // A resumed ingest builds a new writer over the loaded id map. If the key resolved to
    // a different id here, every edge already written would point at the wrong node.
    const resumed = new GraphWriter(harness.sink, harness.idMap);
    const secondId = await nodeIdOrUnreachable(
      resumed.stagePackage({ ecosystem: "npm", name: "chalk", weekly_downloads: 5 }),
    );
    await flushOrUnreachable(resumed);

    expect(secondId).toBe(firstId);
    expect(harness.idMap.resolve("Package", NPM_CHALK)).toBe(firstId);
    expect(harness.graph.findNodeIdByKey("Package", NPM_CHALK)).toBe(firstId);
    expect(harness.graph.nodeCount).toBe(1);
  });

  test("the label is part of the identity, so one key under two labels is two nodes", async () => {
    const harness = buildHarness();

    // packageKey and maintainerKey both render as "npm:<name>", so an id map keyed on the
    // bare key would merge a package with a maintainer who shares its name.
    const packageId = await nodeIdOrUnreachable(
      harness.writer.stagePackage({ ecosystem: "npm", name: "right9ctrl", weekly_downloads: 0 }),
    );
    const maintainerId = await nodeIdOrUnreachable(
      harness.writer.stageMaintainer({ ecosystem: "npm", username: "right9ctrl" }),
    );
    await flushOrUnreachable(harness.writer);

    expect(maintainerId).not.toBe(packageId);
    expect(harness.graph.nodeCount).toBe(2);
  });
});

describe("edge validation", () => {
  test("an edge that contradicts REL_ENDPOINTS never reaches the sink", async () => {
    const harness = buildHarness();
    await nodeIdOrUnreachable(
      harness.writer.stageVersion({
        ecosystem: "npm",
        name: "chalk",
        version: "5.3.1",
        published_at_ms: RESOLVED_AT_MS,
        has_install_script: false,
      }),
    );

    // RESOLVED runs Service to Version. Version to Version is the shape the engine would
    // refuse, and refusing it locally is what turns a 400 into a message naming both ends.
    const failure = await failureOrUnreachable(
      harness.writer.stageEdge(
        "RESOLVED",
        versionRef("npm", "chalk", "5.3.1"),
        versionRef("npm", "chalk", "5.3.1"),
        { resolved_at_ms: RESOLVED_AT_MS },
      ),
    );

    expect(failure.reason).toBe("invalid_input");
    expect(failure.message).toContain("RESOLVED");
    await flushOrUnreachable(harness.writer);
    expect(harness.graph.edgeCount).toBe(0);
    expect(harness.sink.calls.some((call) => call.startsWith("edge:"))).toBe(false);
  });

  test("an edge whose endpoint was never staged is refused, naming the key", async () => {
    const harness = buildHarness();
    await nodeIdOrUnreachable(
      harness.writer.stageVersion({
        ecosystem: "npm",
        name: "chalk",
        version: "5.3.1",
        published_at_ms: RESOLVED_AT_MS,
        has_install_script: false,
      }),
    );

    const failure = await failureOrUnreachable(
      harness.writer.stageEdge(
        "VERSION_OF",
        versionRef("npm", "chalk", "5.3.1"),
        packageRef("npm", "chalk"),
        {},
      ),
    );

    expect(failure.reason).toBe("invalid_input");
    expect(failure.message).toContain(NPM_CHALK);
  });

  test("MemorySink refuses a mislabelled endpoint the way the engine does", async () => {
    const graph = new MemoryGraph();
    const idMap = new IdMap();
    const writer = new GraphWriter(new MemorySink(graph), idMap);
    const versionId = await nodeIdOrUnreachable(
      writer.stageVersion({
        ecosystem: "npm",
        name: "chalk",
        version: "5.3.1",
        published_at_ms: RESOLVED_AT_MS,
        has_install_script: false,
      }),
    );
    await flushOrUnreachable(writer);

    // Written straight to the sink, because GraphWriter refuses this earlier. The sink is
    // the fixture engine, and a permissive fixture engine would let the seed script build
    // a graph the real HydraDB rejects.
    const sink = new MemorySink(graph);
    const spec: EdgeBatchSpec = {
      fromLabel: "Service",
      relType: "RESOLVED",
      toLabel: "Version",
      propertyNames: ["resolved_at_ms"],
    };
    const written = await sink.writeEdgeBatch(spec, [
      {
        [BATCH_COLUMNS.sourceVertex]: versionId,
        [BATCH_COLUMNS.destinationVertex]: versionId,
        [BATCH_COLUMNS.relationshipVertex]: 0,
        resolved_at_ms: RESOLVED_AT_MS,
      },
    ]);

    expect(written.ok).toBe(false);
    if (written.ok) return;
    expect(written.failure.reason).toBe("graph_rejected");
    expect(written.failure.message).toContain("Service");
    expect(graph.edgeCount).toBe(0);
  });

  test("a node rejected on its properties leaves no resolvable id behind", async () => {
    const harness = buildHarness();
    await nodeIdOrUnreachable(
      harness.writer.stageVersion({
        ecosystem: "npm",
        name: "left-pad",
        version: "1.3.0",
        published_at_ms: RESOLVED_AT_MS,
        has_install_script: false,
      }),
    );

    // An upstream publish date that failed to parse arrives as NaN, and the row is
    // refused. The version was therefore never staged.
    const rejected = await failureOrUnreachable(
      harness.writer.stageVersion({
        ecosystem: "npm",
        name: "chalk",
        version: "5.3.1",
        published_at_ms: Number.NaN,
        has_install_script: false,
      }),
    );
    expect(rejected.reason).toBe("invalid_input");

    const edge = await harness.writer.stageEdge(
      "RESOLVES_TO",
      versionRef("npm", "left-pad", "1.3.0"),
      versionRef("npm", "chalk", "5.3.1"),
      {},
    );

    // The writer promises that an edge whose endpoint was never staged fails locally
    // instead of costing a round trip. stageNode assigns the id before it validates the
    // row, so the rejected key stays resolvable and this edge is accepted instead.
    if (edge.ok) {
      const flushed = await harness.writer.flush();
      expect.unreachable(
        `the edge to a rejected node was accepted; the failure surfaced only at flush time: ${
          flushed.ok ? "the sink accepted a dangling edge" : flushed.failure.message
        }`,
      );
    }
    expect(edge.failure.reason).toBe("invalid_input");
  });
});

describe("edge duplicates", () => {
  async function stageTwoVersions(harness: WriterHarness): Promise<void> {
    await nodeIdOrUnreachable(
      harness.writer.stageVersion({
        ecosystem: "npm",
        name: "chalk",
        version: "5.3.1",
        published_at_ms: RESOLVED_AT_MS,
        has_install_script: false,
      }),
    );
    await nodeIdOrUnreachable(
      harness.writer.stageVersion({
        ecosystem: "npm",
        name: "left-pad",
        version: "1.3.0",
        published_at_ms: RESOLVED_AT_MS,
        has_install_script: false,
      }),
    );
  }

  test("the same edge staged twice is written once", async () => {
    const harness = buildHarness();
    await stageTwoVersions(harness);

    const from = versionRef("npm", "chalk", "5.3.1");
    const to = versionRef("npm", "left-pad", "1.3.0");
    await stageOrUnreachable(harness.writer.stageEdge("RESOLVES_TO", from, to, {}));
    await stageOrUnreachable(harness.writer.stageEdge("RESOLVES_TO", from, to, {}));
    const stats = await flushOrUnreachable(harness.writer);

    // Edge writes are a CREATE, so a second identical edge would be a second
    // relationship, and every path crossing it would be counted twice.
    expect(stats.duplicateEdgesSkipped).toBe(1);
    expect(stats.edgesWritten).toBe(1);
    expect(harness.graph.edgeCount).toBe(1);
  });

  test("two resolutions of the same version at different times stay distinct", async () => {
    const harness = buildHarness();
    await stageTwoVersions(harness);
    await nodeIdOrUnreachable(harness.writer.stageService({ name: "checkout-api", source: "seed" }));

    const service = serviceRef("checkout-api");
    const version = versionRef("npm", "chalk", "5.3.1");
    await stageOrUnreachable(
      harness.writer.stageEdge("RESOLVED", service, version, { resolved_at_ms: RESOLVED_AT_MS }),
    );
    await stageOrUnreachable(
      harness.writer.stageEdge("RESOLVED", service, version, {
        resolved_at_ms: RESOLVED_AT_MS + 86_400_000,
      }),
    );
    const stats = await flushOrUnreachable(harness.writer);

    // The two lockfile resolutions are the bitemporal answer. Suppressing the second as
    // a duplicate would erase the history the "what did we ship" query reads.
    expect(stats.duplicateEdgesSkipped).toBe(0);
    expect(stats.edgesWritten).toBe(2);
    expect(harness.graph.edgeCount).toBe(2);
  });
});

describe("write statistics", () => {
  /** A slice small enough to count by hand: two versions of one package, one service. */
  async function stageSmallSlice(harness: WriterHarness): Promise<void> {
    await nodeIdOrUnreachable(
      harness.writer.stagePackage({ ecosystem: "npm", name: "chalk", weekly_downloads: 10 }),
    );
    await nodeIdOrUnreachable(
      harness.writer.stageVersion({
        ecosystem: "npm",
        name: "chalk",
        version: "5.3.1",
        published_at_ms: RESOLVED_AT_MS,
        has_install_script: false,
      }),
    );
    await nodeIdOrUnreachable(
      harness.writer.stageVersion({
        ecosystem: "npm",
        name: "left-pad",
        version: "1.3.0",
        published_at_ms: RESOLVED_AT_MS,
        has_install_script: false,
      }),
    );
    await nodeIdOrUnreachable(harness.writer.stageService({ name: "checkout-api", source: "seed" }));

    await stageOrUnreachable(
      harness.writer.stageEdge(
        "VERSION_OF",
        versionRef("npm", "chalk", "5.3.1"),
        packageRef("npm", "chalk"),
        {},
      ),
    );
    await stageOrUnreachable(
      harness.writer.stageEdge(
        "RESOLVED",
        serviceRef("checkout-api"),
        versionRef("npm", "chalk", "5.3.1"),
        { resolved_at_ms: RESOLVED_AT_MS },
      ),
    );
  }

  test("the counters agree with the graph when nothing was staged twice", async () => {
    const harness = buildHarness();
    await stageSmallSlice(harness);
    const stats = await flushOrUnreachable(harness.writer);

    expect(stats.nodesWritten).toBe(harness.graph.nodeCount);
    expect(stats.edgesWritten).toBe(harness.graph.edgeCount);
    expect(stats.nodesWritten).toBe(4);
    expect(stats.edgesWritten).toBe(2);
    // One batch per label and one per relationship type, because a node batch carries
    // exactly one label and an edge batch exactly one type.
    expect(stats.nodeBatches).toBe(3);
    expect(stats.edgeBatches).toBe(2);
    expect(stats.duplicateEdgesSkipped).toBe(0);
    expect(stats.batchSplits).toBe(0);
    expect(stats.notes).toEqual([]);
  });

  test("every node batch is written before any edge batch", async () => {
    const harness = buildHarness();
    await stageSmallSlice(harness);
    await flushOrUnreachable(harness.writer);

    const firstEdgeCall = harness.sink.calls.findIndex((call) => call.startsWith("edge:"));
    const lastNodeCall = harness.sink.calls.reduce(
      (last, call, index) => (call.startsWith("node:") ? index : last),
      -1,
    );

    // The engine verifies that an edge's endpoints already exist, so an edge batch that
    // overtook a node batch would fail the whole request.
    expect(firstEdgeCall).toBeGreaterThan(-1);
    expect(firstEdgeCall).toBeGreaterThan(lastNodeCall);
  });
});

describe("batch splitting", () => {
  test("a batch refused on a budget is halved until it fits, with the same result", async () => {
    const split = buildHarness({ maxRowsPerBatch: 2 });
    await stageNumberedPackages(split.writer, 5);
    const stats = await flushOrUnreachable(split.writer);

    const whole = buildHarness();
    await stageNumberedPackages(whole.writer, 5);
    await flushOrUnreachable(whole.writer);

    // Five rows refused, then three refused, then two, one and two accepted. The point of
    // the assertion is the last line: halving changes how the rows travel, never what
    // ends up in the graph.
    expect(stats.batchSplits).toBe(2);
    expect(stats.nodeBatches).toBe(3);
    expect(stats.nodesWritten).toBe(5);
    expect(stats.notes).toHaveLength(2);
    expect(stats.notes[0]).toContain("refused on a budget");
    expect(describeGraph(split.graph)).toEqual(describeGraph(whole.graph));
  });

  test("halving stops at the split ceiling instead of retrying forever", async () => {
    // A sink that refuses every batch, however small. Without a depth ceiling the writer
    // would keep halving until every row travelled alone.
    const harness = buildHarness({ maxRowsPerBatch: 0 });
    await stageNumberedPackages(harness.writer, 128);

    const flushed = await harness.writer.flush();
    expect(flushed.ok).toBe(false);
    if (flushed.ok) return;

    expect(flushed.failure.reason).toBe("query_budget_exceeded");
    // 128 rows halve to 2 in six steps, and the seventh is refused rather than attempted,
    // which is what distinguishes the ceiling from simply running out of rows to halve.
    expect(harness.writer.stats.batchSplits).toBe(6);
    expect(harness.graph.nodeCount).toBe(0);
  });
});

describe("row rules", () => {
  test("a non-finite number is refused before the row is staged", async () => {
    const harness = buildHarness();

    const failure = await failureOrUnreachable(
      harness.writer.stageVersion({
        ecosystem: "npm",
        name: "chalk",
        version: "5.3.1",
        published_at_ms: Number.NaN,
        has_install_script: false,
      }),
    );

    // NaN serialises as null, and the engine reports a null field as a row index with no
    // property name, so this has to fail here to be diagnosable at all.
    expect(failure.reason).toBe("invalid_input");
    expect(failure.message).toContain("published_at_ms");
    await flushOrUnreachable(harness.writer);
    expect(harness.graph.nodeCount).toBe(0);
  });

  test("a row larger than the batch budget is refused and names the budget", async () => {
    const harness = buildHarness();

    // Advisory summaries are free text, so this is the one property that can genuinely
    // arrive over the engine's 1 MiB body cap.
    const failure = await failureOrUnreachable(
      harness.writer.stageAdvisory({
        ghsa_id: "GHSA-oversized-row",
        published_at_ms: RESOLVED_AT_MS,
        modified_at_ms: RESOLVED_AT_MS,
        summary: "x".repeat(1_000_000),
      }),
    );

    expect(failure.reason).toBe("invalid_input");
    expect(failure.message).toContain("batch budget");
    await flushOrUnreachable(harness.writer);
    expect(harness.graph.nodeCount).toBe(0);
  });
});
