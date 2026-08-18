import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type GraphPath,
  type GraphProperties,
  type GraphPropertyValue,
  pathTargetNode,
  readStringProperty,
} from "@/lib/graph/gateway";
import { MemoryGraph } from "@/lib/graph/memory-gateway";
import { NODE_PROPERTY_NAMES } from "@/lib/graph/model";
import { SLICE_MANIFEST_VERSION, type SliceManifest } from "@/lib/graph/slice-manifest";
import {
  GRAPH_SNAPSHOT_FORMAT_VERSION,
  type GraphSnapshot,
  buildGraphSnapshot,
  loadGraphSnapshot,
  parseGraphSnapshot,
  restoreGraphFromSnapshot,
  writeGraphSnapshot,
} from "@/lib/graph/snapshot";
import type { Failure, Result } from "@/lib/result";

import {
  EVENT_STREAM_KEYS,
  FIXTURE_RESOLVED_AT_MS,
  buildEventStreamScenario,
  findFixtureModelViolations,
} from "./fixtures/graph";

/**
 * Snapshot tests.
 *
 * Two things are being defended here. The first is the round trip: a snapshot that loses
 * its manifest, a property, or an edge produces answers that look clean and are wrong, so
 * the round trip is asserted against a manifest with every field populated and against a
 * traversal run on the restored graph rather than against node counts alone.
 *
 * The second is refusal. Every corruption below has one property in common: a reader that
 * skipped the bad row instead of failing would return a smaller blast radius with no sign
 * that anything was dropped. One test per rejection path, each asserting that the message
 * names the row a human has to go and look at.
 */

/** Fixed clock for the snapshot itself, so no assertion depends on when the suite runs. */
const SNAPSHOT_GENERATED_AT_MS = 1_543_104_000_000;

/** Fixed clock for the manifest, deliberately different from the snapshot's. */
const MANIFEST_GENERATED_AT_MS = 1_543_017_600_000;

const SNAPSHOT_SOURCE = "snapshot-test";

/** An id no fixture node carries, for the dangling endpoint tests. */
const ABSENT_NODE_ID = 999_999;

function readValueOrUnreachable<TValue>(result: Result<TValue, Failure>, context: string): TValue {
  if (result.ok) return result.value;
  return expect.unreachable(`${context}: ${result.failure.message}`);
}

function readFailureOrUnreachable<TValue>(
  result: Result<TValue, Failure>,
  context: string,
): Failure {
  if (!result.ok) return result.failure;
  return expect.unreachable(`${context}: expected a failure`);
}

/**
 * A manifest with every field carrying a distinct value, including a package that is
 * partial rather than closed and packages named in neither list.
 *
 * The three-way distinction is the whole point of round-tripping the manifest: closed means
 * a negative answer is real, partial and absent mean the answer is unknown. A serialiser
 * that merged or reordered these lists would still pass a counts-only assertion.
 */
function buildRoundTripManifest(): SliceManifest {
  return {
    version: SLICE_MANIFEST_VERSION,
    generatedAtMs: MANIFEST_GENERATED_AT_MS,
    ecosystems: ["npm", "pypi"],
    closedPackageKeys: [
      EVENT_STREAM_KEYS.flatmapStreamPackage,
      EVENT_STREAM_KEYS.eventStreamPackage,
      EVENT_STREAM_KEYS.psTreePackage,
    ],
    partialPackageKeys: [EVENT_STREAM_KEYS.nodemonPackage],
    closedServiceKeys: [
      EVENT_STREAM_KEYS.checkoutApiService,
      EVENT_STREAM_KEYS.walletWebService,
    ],
    counts: {
      packages: 5,
      versions: 5,
      maintainers: 1,
      services: 3,
      advisories: 1,
      resolutionEdges: 3,
    },
    notes: ["chalk was cut short at depth 2"],
  };
}

/** The event-stream scenario as a snapshot, checked against the model registries first. */
function buildScenarioSnapshot(): GraphSnapshot {
  const fixture = buildEventStreamScenario();
  const violations = findFixtureModelViolations(fixture);
  if (violations.length > 0) {
    return expect.unreachable(`the fixture is not model shaped: ${violations.join("; ")}`);
  }

  return buildGraphSnapshot({
    graph: fixture.graph,
    manifest: buildRoundTripManifest(),
    generatedAtMs: SNAPSHOT_GENERATED_AT_MS,
    source: SNAPSHOT_SOURCE,
  });
}

/**
 * A snapshot as plain JSON: labels and relationship types are strings here, not model
 * unions. Corruption tests need to write values the model's types forbid, and widening the
 * shape is how they do it without a type assertion.
 */
type RawNode = { id: number; label: string; properties: Record<string, GraphPropertyValue> };

type RawEdge = {
  id: number;
  relType: string;
  fromNodeId: number;
  toNodeId: number;
  properties: Record<string, GraphPropertyValue>;
};

type RawSnapshot = {
  formatVersion: number;
  generatedAtMs: number;
  source: string;
  manifest: SliceManifest;
  nodes: RawNode[];
  edges: RawEdge[];
};

function buildRawScenarioSnapshot(): RawSnapshot {
  return structuredClone(buildScenarioSnapshot());
}

async function withTemporaryDirectory(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(import.meta.dir, ".tmp-snapshot-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function fileExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** The natural keys a set of paths ends at, sorted so the assertion is order free. */
function readSortedTargetKeys(paths: readonly GraphPath[]): string[] {
  const keys: string[] = [];
  for (const path of paths) {
    const target = pathTargetNode(path);
    const key = target === null ? null : readStringProperty(target.properties, "key");
    if (key !== null) keys.push(key);
  }
  return keys.sort();
}

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

describe("snapshot round trip", () => {
  test("a written snapshot loads back with its manifest, properties and traversals intact", async () => {
    await withTemporaryDirectory(async (directory) => {
      const snapshot = buildScenarioSnapshot();
      expect(snapshot.formatVersion).toBe(GRAPH_SNAPSHOT_FORMAT_VERSION);

      const path = join(directory, "nested", "snapshot.json");
      const written = readValueOrUnreachable(
        await writeGraphSnapshot(snapshot, path),
        "write the scenario snapshot",
      );
      expect(written.nodeCount).toBe(snapshot.nodes.length);
      expect(written.edgeCount).toBe(snapshot.edges.length);
      expect(written.byteSize).toBeGreaterThan(0);

      const loaded = readValueOrUnreachable(await loadGraphSnapshot(path), "load it back");

      // The manifest is the reason a snapshot exists at all: coverage is what decides
      // whether a negative answer reads as not_exposed or as unknown.
      expect(loaded.manifest).toEqual(buildRoundTripManifest());
      expect(loaded.generatedAtMs).toBe(SNAPSHOT_GENERATED_AT_MS);
      expect(loaded.source).toBe(SNAPSHOT_SOURCE);
      expect(loaded.path).toBe(path);
      expect(loaded.graph.nodeCount).toBe(snapshot.nodes.length);
      expect(loaded.graph.edgeCount).toBe(snapshot.edges.length);

      // A resolved key proves the property index was rebuilt, not just the node map.
      const flatmapNodeId = loaded.graph.findNodeIdByKey(
        "Version",
        EVENT_STREAM_KEYS.flatmapStreamVersion,
      );
      if (flatmapNodeId === null) {
        return expect.unreachable("the key index did not survive the round trip");
      }

      const records = readValueOrUnreachable(
        await loaded.graph.readNodes({ nodeIds: [flatmapNodeId], label: "Version" }),
        "read flatmap-stream back",
      );
      const originalNode = snapshot.nodes.find((node) => node.id === flatmapNodeId);
      if (originalNode === undefined) {
        return expect.unreachable("flatmap-stream is not in the snapshot it was built from");
      }
      expect(records[0]?.properties).toEqual(originalNode.properties);
      // Named on its own because JSON is where a boolean turns into the string "true",
      // and has_install_script is a scoring input.
      expect(records[0]?.properties.has_install_script).toBe(true);

      const serviceNodeId = loaded.graph.findNodeIdByKey(
        "Service",
        EVENT_STREAM_KEYS.checkoutApiService,
      );
      if (serviceNodeId === null) return expect.unreachable("checkout-api did not survive");

      const resolvedEdges = readValueOrUnreachable(
        await loaded.graph.neighbors({
          nodeId: serviceNodeId,
          nodeLabel: "Service",
          relType: "RESOLVED",
          direction: "outgoing",
          limit: 10,
        }),
        "expand checkout-api over RESOLVED",
      );
      expect(resolvedEdges).toHaveLength(1);
      expect(resolvedEdges[0]?.properties.resolved_at_ms).toBe(FIXTURE_RESOLVED_AT_MS);

      // The answer the app actually renders: every version that depends on the payload.
      // Counts can match while an edge is missing, a traversal cannot.
      const paths = readValueOrUnreachable(
        await loaded.graph.pathsFromSources({
          sourceLabel: "Version",
          sourceKeys: [EVENT_STREAM_KEYS.flatmapStreamVersion],
          relTypes: ["DEPENDED_ON_BY"],
          direction: "outgoing",
          maxLength: 3,
          pathCount: 20,
          targetLabel: "Version",
        }),
        "walk the dependents of flatmap-stream",
      );
      expect(readSortedTargetKeys(paths)).toEqual(
        [
          EVENT_STREAM_KEYS.eventStreamVersion,
          EVENT_STREAM_KEYS.psTreeVersion,
          EVENT_STREAM_KEYS.nodemonVersion,
        ].sort(),
      );
    });
  });

  test("a restored graph owns its properties, so a later write cannot rewrite the snapshot", () => {
    const snapshot = buildScenarioSnapshot();
    const graph = restoreGraphFromSnapshot(snapshot);

    const restoredNode = graph.listNodes()[0];
    if (restoredNode === undefined) return expect.unreachable("the fixture has no nodes");
    restoredNode.properties.name = "rewritten-by-a-caller";

    expect(snapshot.nodes[0]?.properties.name).not.toBe("rewritten-by-a-caller");
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

/** Replays a graph with rows and property keys in reverse insertion order. */
function rebuildInReverse(graph: MemoryGraph): MemoryGraph {
  const rebuilt = new MemoryGraph();
  for (const node of [...graph.listNodes()].reverse()) {
    rebuilt.addNode({ ...node, properties: reverseKeyOrder(node.properties) });
  }
  for (const edge of [...graph.listEdges()].reverse()) {
    rebuilt.addEdge({ ...edge, properties: reverseKeyOrder(edge.properties) });
  }
  return rebuilt;
}

function reverseKeyOrder(properties: GraphProperties): GraphProperties {
  const reversed: GraphProperties = {};
  for (const name of Object.keys(properties).reverse()) reversed[name] = properties[name];
  return reversed;
}

describe("buildGraphSnapshot", () => {
  test("serialises byte for byte identically whatever order the graph was built in", () => {
    const fixture = buildEventStreamScenario();
    const manifest = buildRoundTripManifest();

    const asBuilt = buildGraphSnapshot({
      graph: fixture.graph,
      manifest,
      generatedAtMs: SNAPSHOT_GENERATED_AT_MS,
      source: SNAPSHOT_SOURCE,
    });
    const reversed = buildGraphSnapshot({
      graph: rebuildInReverse(fixture.graph),
      manifest,
      generatedAtMs: SNAPSHOT_GENERATED_AT_MS,
      source: SNAPSHOT_SOURCE,
    });

    const asBuiltText = JSON.stringify(asBuilt);
    expect(asBuiltText.length).toBeGreaterThan(0);
    // Byte identical output is what makes a snapshot diff readable: a changed line means
    // the data changed, never that a Map iterated differently.
    expect(JSON.stringify(reversed)).toBe(asBuiltText);
  });

  test("orders rows by id and property keys by the model registry", () => {
    const snapshot = buildScenarioSnapshot();

    const nodeIds = snapshot.nodes.map((node) => node.id);
    expect(nodeIds).toEqual([...nodeIds].sort((left, right) => left - right));
    const edgeIds = snapshot.edges.map((edge) => edge.id);
    expect(edgeIds).toEqual([...edgeIds].sort((left, right) => left - right));

    for (const node of snapshot.nodes) {
      expect(Object.keys(node.properties)).toEqual([...NODE_PROPERTY_NAMES[node.label]]);
    }
  });

  test("does not share the caller's manifest arrays", () => {
    const manifest = buildRoundTripManifest();
    const snapshot = buildGraphSnapshot({
      graph: buildEventStreamScenario().graph,
      manifest,
      generatedAtMs: SNAPSHOT_GENERATED_AT_MS,
      source: SNAPSHOT_SOURCE,
    });

    manifest.notes.push("added after the snapshot was built");
    manifest.counts.versions = 0;

    expect(snapshot.manifest.notes).toHaveLength(1);
    expect(snapshot.manifest.counts.versions).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Refusals: structure
// ---------------------------------------------------------------------------

describe("parseGraphSnapshot refuses a corrupt graph", () => {
  test("an edge pointing at a node the snapshot does not declare", () => {
    const raw = buildRawScenarioSnapshot();
    const firstEdge = raw.edges[0];
    if (firstEdge === undefined) return expect.unreachable("the fixture has no edges");
    firstEdge.toNodeId = ABSENT_NODE_ID;

    const failure = readFailureOrUnreachable(parseGraphSnapshot(raw), "a dangling edge");
    expect(failure.reason).toBe("invalid_input");
    expect(failure.message).toContain("edges.0.toNodeId");
    expect(failure.message).toContain(String(ABSENT_NODE_ID));
  });

  test("an edge whose endpoint carries the wrong label", () => {
    const raw = buildRawScenarioSnapshot();
    const edgeIndex = raw.edges.findIndex((edge) => edge.relType === "RESOLVED");
    const resolvedEdge = raw.edges[edgeIndex];
    const versionNode = raw.nodes.find((node) => node.label === "Version");
    if (resolvedEdge === undefined || versionNode === undefined) {
      return expect.unreachable("the fixture has no RESOLVED edge or no Version node");
    }
    resolvedEdge.fromNodeId = versionNode.id;

    const failure = readFailureOrUnreachable(parseGraphSnapshot(raw), "a mislabelled endpoint");
    expect(failure.message).toContain(`edges.${edgeIndex}.fromNodeId`);
    expect(failure.message).toContain("needs a Service");
  });

  test("a node label outside the model", () => {
    const raw = buildRawScenarioSnapshot();
    const firstNode = raw.nodes[0];
    if (firstNode === undefined) return expect.unreachable("the fixture has no nodes");
    firstNode.label = "Bundle";

    const failure = readFailureOrUnreachable(parseGraphSnapshot(raw), "an unknown node label");
    expect(failure.reason).toBe("invalid_input");
    expect(failure.message).toContain("nodes.0.label");
  });

  test("a relationship type outside the model", () => {
    const raw = buildRawScenarioSnapshot();
    const firstEdge = raw.edges[0];
    if (firstEdge === undefined) return expect.unreachable("the fixture has no edges");
    firstEdge.relType = "SHIPS_WITH";

    const failure = readFailureOrUnreachable(parseGraphSnapshot(raw), "an unknown rel type");
    expect(failure.message).toContain("edges.0.relType");
  });

  test("a duplicate node id", () => {
    const raw = buildRawScenarioSnapshot();
    const firstNode = raw.nodes[0];
    if (firstNode === undefined) return expect.unreachable("the fixture has no nodes");
    raw.nodes.push(structuredClone(firstNode));

    const failure = readFailureOrUnreachable(parseGraphSnapshot(raw), "a duplicate node id");
    expect(failure.message).toContain("duplicate node id");
    expect(failure.message).toContain(String(firstNode.id));
  });

  test("a duplicate relationship id", () => {
    const raw = buildRawScenarioSnapshot();
    const firstEdge = raw.edges[0];
    if (firstEdge === undefined) return expect.unreachable("the fixture has no edges");
    raw.edges.push(structuredClone(firstEdge));

    const failure = readFailureOrUnreachable(parseGraphSnapshot(raw), "a duplicate edge id");
    expect(failure.message).toContain("duplicate relationship id");
  });
});

// ---------------------------------------------------------------------------
// Refusals: properties and versions
// ---------------------------------------------------------------------------

describe("parseGraphSnapshot refuses properties the model does not declare", () => {
  test("a node missing a registry property, or carrying an extra one", () => {
    const raw = buildRawScenarioSnapshot();
    const nodeIndex = raw.nodes.findIndex((node) => node.label === "Version");
    const versionNode = raw.nodes[nodeIndex];
    if (versionNode === undefined) return expect.unreachable("the fixture has no Version node");
    delete versionNode.properties.has_install_script;
    versionNode.properties.dependent_count = 4;

    const failure = readFailureOrUnreachable(parseGraphSnapshot(raw), "a property mismatch");
    expect(failure.message).toContain(`nodes.${nodeIndex}.properties.has_install_script`);
    expect(failure.message).toContain(`nodes.${nodeIndex}.properties.dependent_count`);
  });

  test("an edge missing a registry property", () => {
    const raw = buildRawScenarioSnapshot();
    const edgeIndex = raw.edges.findIndex((edge) => edge.relType === "RESOLVED");
    const resolvedEdge = raw.edges[edgeIndex];
    if (resolvedEdge === undefined) return expect.unreachable("the fixture has no RESOLVED edge");
    delete resolvedEdge.properties.resolved_at_ms;

    const failure = readFailureOrUnreachable(parseGraphSnapshot(raw), "a missing edge property");
    expect(failure.message).toContain(`edges.${edgeIndex}.properties.resolved_at_ms`);
    expect(failure.message).toContain("RESOLVED relationship");
  });

  test("a node whose key selector is unusable", () => {
    const raw = buildRawScenarioSnapshot();
    const firstNode = raw.nodes[0];
    if (firstNode === undefined) return expect.unreachable("the fixture has no nodes");
    firstNode.properties.key = "";

    const failure = readFailureOrUnreachable(parseGraphSnapshot(raw), "an empty key");
    expect(failure.message).toContain("nodes.0.properties.key");
    expect(failure.message).toContain("key selector");
  });

  test("a property value that is not a scalar", () => {
    const snapshot = buildScenarioSnapshot();
    const raw = {
      ...structuredClone(snapshot),
      nodes: [{ id: 1, label: "Service", properties: { key: { name: "checkout-api" } } }],
      edges: [],
    };

    const failure = readFailureOrUnreachable(parseGraphSnapshot(raw), "a nested property value");
    expect(failure.message).toContain("nodes.0.properties.key");
    expect(failure.message).toContain("string, number or boolean");
  });

  test("a format version this reader does not understand", () => {
    const raw = buildRawScenarioSnapshot();
    raw.formatVersion = GRAPH_SNAPSHOT_FORMAT_VERSION + 1;

    const failure = readFailureOrUnreachable(parseGraphSnapshot(raw), "a newer format");
    expect(failure.message).toContain("formatVersion");
    expect(failure.message).toContain("format version");
  });

  test("a field the format does not declare", () => {
    const raw = { ...buildRawScenarioSnapshot(), typosquatEdges: [] };

    const failure = readFailureOrUnreachable(parseGraphSnapshot(raw), "an unknown field");
    expect(failure.message).toContain("typosquatEdges");
  });
});

describe("parseGraphSnapshot refuses a snapshot without usable coverage", () => {
  test("a snapshot with no manifest at all", () => {
    const { formatVersion, generatedAtMs, source, nodes, edges } = buildScenarioSnapshot();
    const withoutManifest = { formatVersion, generatedAtMs, source, nodes, edges };

    const failure = readFailureOrUnreachable(
      parseGraphSnapshot(withoutManifest),
      "a snapshot stripped of its manifest",
    );
    expect(failure.reason).toBe("invalid_input");
    expect(failure.message).toContain("manifest");
  });

  test("a manifest written by a different manifest version", () => {
    const raw = buildRawScenarioSnapshot();
    raw.manifest.version = SLICE_MANIFEST_VERSION + 1;

    const failure = readFailureOrUnreachable(parseGraphSnapshot(raw), "a newer manifest");
    expect(failure.message).toContain("manifest.version");
    expect(failure.message).toContain(`version ${SLICE_MANIFEST_VERSION}`);
  });
});

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

describe("loadGraphSnapshot", () => {
  test("reports a missing file as not_found", async () => {
    await withTemporaryDirectory(async (directory) => {
      const failure = readFailureOrUnreachable(
        await loadGraphSnapshot(join(directory, "absent.json")),
        "a missing snapshot",
      );
      expect(failure.reason).toBe("not_found");
    });
  });

  test("refuses a path that is a directory", async () => {
    await withTemporaryDirectory(async (directory) => {
      const failure = readFailureOrUnreachable(await loadGraphSnapshot(directory), "a directory");
      expect(failure.reason).toBe("invalid_input");
      expect(failure.message).toContain("is not a file");
    });
  });

  test("refuses a file over the byte cap without reading it", async () => {
    await withTemporaryDirectory(async (directory) => {
      const path = join(directory, "snapshot.json");
      readValueOrUnreachable(
        await writeGraphSnapshot(buildScenarioSnapshot(), path),
        "write the scenario snapshot",
      );

      const failure = readFailureOrUnreachable(
        await loadGraphSnapshot(path, { maxBytes: 64 }),
        "an oversized snapshot",
      );
      expect(failure.reason).toBe("invalid_input");
      expect(failure.message).toContain("over the 64 byte cap");
    });
  });

  test("refuses a file that is not JSON", async () => {
    await withTemporaryDirectory(async (directory) => {
      const path = join(directory, "snapshot.json");
      await writeFile(path, "{ not json", "utf8");

      const failure = readFailureOrUnreachable(await loadGraphSnapshot(path), "malformed JSON");
      expect(failure.reason).toBe("invalid_input");
      expect(failure.message).toContain("is not valid JSON");
    });
  });

  test("refuses JSON that is not an object", async () => {
    await withTemporaryDirectory(async (directory) => {
      const path = join(directory, "snapshot.json");
      await writeFile(path, "[]\n", "utf8");

      const failure = readFailureOrUnreachable(await loadGraphSnapshot(path), "a JSON array");
      expect(failure.reason).toBe("invalid_input");
      expect(failure.message).toContain(path);
      expect(failure.message).toContain("(root)");
    });
  });
});

describe("writeGraphSnapshot", () => {
  test("refuses a corrupt snapshot and leaves no file behind", async () => {
    await withTemporaryDirectory(async (directory) => {
      const snapshot = structuredClone(buildScenarioSnapshot());
      const firstEdge = snapshot.edges[0];
      if (firstEdge === undefined) return expect.unreachable("the fixture has no edges");
      firstEdge.toNodeId = ABSENT_NODE_ID;

      const path = join(directory, "snapshot.json");
      const failure = readFailureOrUnreachable(
        await writeGraphSnapshot(snapshot, path),
        "writing a dangling edge",
      );
      expect(failure.reason).toBe("invalid_input");
      expect(failure.message).toContain(String(ABSENT_NODE_ID));
      // A refused write must not leave a file every later load would reject.
      expect(await fileExists(path)).toBe(false);
    });
  });

  test("writes indented JSON ending in a newline", async () => {
    await withTemporaryDirectory(async (directory) => {
      const path = join(directory, "snapshot.json");
      const snapshot = buildScenarioSnapshot();
      const written = readValueOrUnreachable(
        await writeGraphSnapshot(snapshot, path),
        "write the scenario snapshot",
      );

      const text = await readFile(path, "utf8");
      expect(text.endsWith("\n")).toBe(true);
      expect(text).toBe(`${JSON.stringify(snapshot, null, 2)}\n`);
      expect(written.byteSize).toBe(Buffer.byteLength(text, "utf8"));
    });
  });
});
