import { Buffer } from "node:buffer";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import type { GraphProperties } from "@/lib/graph/gateway";
import { MemoryGraph, type StoredEdge, type StoredNode } from "@/lib/graph/memory-gateway";
import {
  ECOSYSTEMS,
  NODE_LABELS,
  NODE_PROPERTY_NAMES,
  type NodeLabel,
  REL_ENDPOINTS,
  REL_PROPERTY_NAMES,
  REL_TYPES,
  SELECTOR_PROPERTY,
} from "@/lib/graph/model";
import { SLICE_MANIFEST_VERSION, type SliceManifest } from "@/lib/graph/slice-manifest";
import { describeSchemaIssues } from "@/lib/ingest/fetch-json";
import {
  type Failure,
  type Result,
  fail,
  fromThrowing,
  fromThrowingSync,
  succeed,
} from "@/lib/result";

/**
 * Graph snapshots: the on-disk form of a built graph, and the data source the app answers
 * from when no HydraDB is reachable.
 *
 * A snapshot carries the graph and its slice manifest in one file, on purpose. Coverage is
 * not metadata here, it is part of the answer: the abstention model reports `unknown`
 * rather than `not_exposed` exactly when the manifest says the queried package or service
 * was never ingested (plan section 9). A snapshot that lost its manifest would let the UI
 * present "no path found" over a slice that never held the dependents, which is the one
 * failure this project cannot ship. Keeping both in one file means the two cannot be
 * separated, copied apart, or version skewed.
 *
 * Three rules follow from that, and they are why this file is strict:
 *
 *   1. Corruption fails loudly. A dangling edge, an unknown label, a duplicate id, a
 *      property the model registry does not declare: each one is a Failure naming the
 *      offending row, never a skipped row. A silently dropped edge is an exposure path
 *      that disappears, and the resulting answer looks clean rather than broken.
 *   2. Output is deterministic. Nodes and edges are sorted by id and property keys are
 *      written in registry order, so two serialisations of one graph are byte identical
 *      and a snapshot diff reads as a change in the data rather than a reshuffle.
 *   3. Errors are values. The throwing boundaries here are the filesystem and JSON.parse,
 *      and both are wrapped at the call site.
 *
 * Timestamps arrive as arguments. Nothing in this file reads a clock, so a snapshot is a
 * pure function of the graph, the manifest, and the instant the caller states.
 */

/**
 * On-disk format version. Bumped when the shape below stops being readable by a reader
 * written against this version, so a newer file is refused by name instead of being
 * partly understood.
 */
export const GRAPH_SNAPSHOT_FORMAT_VERSION = 1;

/**
 * Where the app looks for a snapshot by default.
 * sourceRef: .env.example HYDRA_SNAPSHOT_PATH, docs/RUNNING.md section 5.
 */
export const DEFAULT_GRAPH_SNAPSHOT_PATH = "data/graph/snapshot.json";

/**
 * Ceiling on a snapshot file, in bytes: 256 MiB.
 *
 * Sized from the two numbers that bound it. The planned slice is 50,000 to 200,000
 * Version nodes and a few hundred thousand edges (plan section 5), which at roughly 260
 * bytes per pretty-printed row is about 115 MB for the largest planned slice. The hard
 * ceiling above it is the runtime: Node 22 caps one string at
 * `buffer.constants.MAX_STRING_LENGTH`, measured as 536,870,888 bytes, so a file near
 * half a gigabyte could not be read into memory to be parsed at all. 256 MiB sits above
 * the largest slice this project builds and below the size where reading itself fails.
 */
export const MAX_SNAPSHOT_FILE_BYTES = 268_435_456;

/** Indent used for the JSON, matching slice-manifest.ts so both files diff the same way. */
const SNAPSHOT_JSON_INDENT = 2;

/** Upper bound on the `source` label. Long enough to name a script, short enough to log. */
const SNAPSHOT_SOURCE_MAX_LENGTH = 64;

// ---------------------------------------------------------------------------
// Field schemas
// ---------------------------------------------------------------------------

/**
 * Labels and relationship types come from the model registries rather than fresh literal
 * unions, so a type the graph can write and this reader would reject cannot exist.
 */
const NODE_LABEL_SCHEMA = z.enum(NODE_LABELS);
const REL_TYPE_SCHEMA = z.enum(REL_TYPES);
const ECOSYSTEM_SCHEMA = z.enum(ECOSYSTEMS);

/**
 * HydraDB addresses every node and every relationship by a non-negative integer id, and
 * `z.int()` rejects anything outside the safe integer range, which is where an id that
 * lost precision on the way through JSON would land. sourceRef: docs/HYDRADB.md,
 * src/lib/ingest/writer.ts readRowId.
 */
const GRAPH_ID_SCHEMA = z.int().nonnegative();

/** Epoch milliseconds. An integer clock, so a nanosecond timestamp fails instead of parsing. */
const EPOCH_MS_SCHEMA = z.int();

const COUNT_SCHEMA = z.int().nonnegative();

/** The scalar set the engine stores. sourceRef: src/lib/graph/gateway.ts GraphPropertyValue. */
const PROPERTY_VALUE_SCHEMA = z.union(
  [z.string(), z.number(), z.boolean()],
  "must be a string, number or boolean, the only property values HydraDB stores",
);

const PROPERTIES_SCHEMA = z.record(z.string(), PROPERTY_VALUE_SCHEMA);

// ---------------------------------------------------------------------------
// Object schemas
// ---------------------------------------------------------------------------

/**
 * A node and an edge as MemoryGraph holds them, so a reader replays them straight through
 * addNode and addEdge with no translation layer that could drift. Strict objects
 * throughout: an unrecognised field means a file written against a shape this reader does
 * not understand, and reading it anyway is how a snapshot gets half loaded.
 */
const SNAPSHOT_NODE_SCHEMA = z.strictObject({
  id: GRAPH_ID_SCHEMA,
  label: NODE_LABEL_SCHEMA,
  properties: PROPERTIES_SCHEMA,
});

const SNAPSHOT_EDGE_SCHEMA = z.strictObject({
  /** Relationships have their own id space. sourceRef: src/lib/hydra/id-map.ts. */
  id: GRAPH_ID_SCHEMA,
  relType: REL_TYPE_SCHEMA,
  fromNodeId: GRAPH_ID_SCHEMA,
  toNodeId: GRAPH_ID_SCHEMA,
  properties: PROPERTIES_SCHEMA,
});

const SLICE_COUNTS_SCHEMA = z.strictObject({
  packages: COUNT_SCHEMA,
  versions: COUNT_SCHEMA,
  maintainers: COUNT_SCHEMA,
  services: COUNT_SCHEMA,
  advisories: COUNT_SCHEMA,
  resolutionEdges: COUNT_SCHEMA,
});

/**
 * Typed as returning boolean on purpose, rather than as an inline arrow. TypeScript infers
 * `candidate is 1` for a comparison against a literal constant, zod then narrows the
 * parsed field to that literal, and a plain SliceManifest (whose version is a number)
 * stops being assignable to the schema's own type. The mirror below only catches drift
 * while it stays assignable in both directions.
 */
function isSupportedManifestVersion(candidate: number): boolean {
  return candidate === SLICE_MANIFEST_VERSION;
}

/**
 * The slice manifest, mirrored as a schema.
 *
 * slice-manifest.ts owns the type and validates its own standalone file, but it exports no
 * validator for an already-decoded manifest, so there is nothing to reuse for an embedded
 * one. The mirror cannot drift silently: buildGraphSnapshot assigns a `SliceManifest` into
 * this shape and loadGraphSnapshot hands this shape back as a `SliceManifest`, so a field
 * added, dropped, or retyped on either side fails to compile.
 */
const SLICE_MANIFEST_SCHEMA = z.strictObject({
  version: z.int().refine(isSupportedManifestVersion, {
    message: `must be slice manifest version ${SLICE_MANIFEST_VERSION}`,
  }),
  generatedAtMs: EPOCH_MS_SCHEMA,
  ecosystems: z.array(ECOSYSTEM_SCHEMA),
  closedPackageKeys: z.array(z.string()),
  partialPackageKeys: z.array(z.string()),
  closedServiceKeys: z.array(z.string()),
  counts: SLICE_COUNTS_SCHEMA,
  notes: z.array(z.string()),
});

const GRAPH_SNAPSHOT_FIELDS_SCHEMA = z.strictObject({
  formatVersion: z.literal(
    GRAPH_SNAPSHOT_FORMAT_VERSION,
    `must be snapshot format version ${GRAPH_SNAPSHOT_FORMAT_VERSION}, which is the only shape this reader understands`,
  ),
  /** When the snapshot was serialised, epoch milliseconds. Stated by the caller. */
  generatedAtMs: EPOCH_MS_SCHEMA,
  /** Which writer produced it, for example "seed-incidents". Log safe, never a path. */
  source: z.string().min(1).max(SNAPSHOT_SOURCE_MAX_LENGTH),
  /** What the graph covers. Absent coverage would make every negative answer a guess. */
  manifest: SLICE_MANIFEST_SCHEMA,
  nodes: z.array(SNAPSHOT_NODE_SCHEMA),
  edges: z.array(SNAPSHOT_EDGE_SCHEMA),
});

/**
 * The full schema: field rules, then the graph-wide integrity rules that only make sense
 * once every row has parsed (ids are unique, endpoints exist and carry the label the model
 * declares, properties match the registry).
 */
export const GRAPH_SNAPSHOT_SCHEMA = GRAPH_SNAPSHOT_FIELDS_SCHEMA.superRefine(
  (snapshot, context) => {
    for (const issue of findGraphIntegrityIssues(snapshot)) {
      context.addIssue({
        code: "custom",
        path: [...issue.path],
        message: issue.message,
        continue: true,
      });
    }
  },
);

// ---------------------------------------------------------------------------
// Types, derived from the schemas so the two cannot drift
// ---------------------------------------------------------------------------

export type GraphSnapshot = z.infer<typeof GRAPH_SNAPSHOT_SCHEMA>;
export type GraphSnapshotNode = z.infer<typeof SNAPSHOT_NODE_SCHEMA>;
export type GraphSnapshotEdge = z.infer<typeof SNAPSHOT_EDGE_SCHEMA>;

export type GraphSnapshotInput = {
  graph: MemoryGraph;
  /** What the graph covers, round-tripped verbatim. */
  manifest: SliceManifest;
  /** Epoch milliseconds, passed in so serialisation reads no clock of its own. */
  generatedAtMs: number;
  /** Which writer produced it. Log safe: never a path, a URL, or a token. */
  source: string;
};

/** A snapshot read back from disk, ready to answer queries. */
export type LoadedGraphSnapshot = {
  graph: MemoryGraph;
  manifest: SliceManifest;
  generatedAtMs: number;
  source: string;
  /** The file this came from, for the "which source answered" line in the UI. */
  path: string;
};

export type WrittenGraphSnapshot = {
  path: string;
  byteSize: number;
  nodeCount: number;
  edgeCount: number;
};

export type LoadGraphSnapshotOptions = {
  /**
   * Byte ceiling for the file, defaulting to MAX_SNAPSHOT_FILE_BYTES. Injectable so the
   * cap is exercised by a test without writing a 256 MiB file, and so a caller reading a
   * snapshot it did not produce can tighten it.
   */
  maxBytes?: number;
};

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/**
 * Serialises a graph and its manifest into a snapshot.
 *
 * Deterministic by construction: rows are sorted by id, property keys are written in the
 * order the model registry declares, and every field of the manifest is copied rather than
 * aliased, so a later mutation of the caller's manifest cannot rewrite a snapshot that was
 * already built.
 */
export function buildGraphSnapshot(input: GraphSnapshotInput): GraphSnapshot {
  const nodes = [...input.graph.listNodes()].sort(compareById).map(projectNode);
  const edges = [...input.graph.listEdges()].sort(compareById).map(projectEdge);

  return {
    formatVersion: GRAPH_SNAPSHOT_FORMAT_VERSION,
    generatedAtMs: input.generatedAtMs,
    source: input.source,
    manifest: copyManifest(input.manifest),
    nodes,
    edges,
  };
}

/** Validates an already-decoded snapshot. `subject` names the file or origin in failures. */
export function parseGraphSnapshot(
  raw: unknown,
  subject: string = "the graph snapshot",
): Result<GraphSnapshot, Failure> {
  const parsed = GRAPH_SNAPSHOT_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    return fail(
      "invalid_input",
      `[parseGraphSnapshot] ${subject} is not a valid graph snapshot: ${describeSchemaIssues(parsed.error)}`,
    );
  }
  return succeed(parsed.data);
}

/**
 * Replays a parsed snapshot into a graph that is ready to answer queries.
 *
 * MemoryGraph rebuilds its adjacency and its key index as rows arrive, so nothing else is
 * needed to make traversal and key selectors work. Properties are copied, so a later
 * mutation through the graph cannot rewrite the parsed snapshot.
 */
export function restoreGraphFromSnapshot(snapshot: GraphSnapshot): MemoryGraph {
  const graph = new MemoryGraph();

  for (const node of snapshot.nodes) {
    graph.addNode({ id: node.id, label: node.label, properties: { ...node.properties } });
  }
  for (const edge of snapshot.edges) {
    graph.addEdge({
      id: edge.id,
      relType: edge.relType,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      properties: { ...edge.properties },
    });
  }

  return graph;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * Reads a snapshot file into a graph and its manifest.
 *
 * The size check runs on the directory entry, before any read, so an oversized file costs
 * one stat rather than an allocation the runtime may not be able to make. Every failure is
 * a value: the file is missing (`not_found`), it is over the cap or not JSON or not a
 * valid snapshot (`invalid_input`, naming the offending row).
 */
export async function loadGraphSnapshot(
  path: string = DEFAULT_GRAPH_SNAPSHOT_PATH,
  options: LoadGraphSnapshotOptions = {},
): Promise<Result<LoadedGraphSnapshot, Failure>> {
  const maxBytes = options.maxBytes ?? MAX_SNAPSHOT_FILE_BYTES;

  const entry = await fromThrowing("not_found", `[loadGraphSnapshot] cannot read ${path}`, () =>
    stat(path),
  );
  if (!entry.ok) return entry;

  if (!entry.value.isFile()) {
    return fail("invalid_input", `[loadGraphSnapshot] ${path} is not a file`);
  }
  if (entry.value.size > maxBytes) {
    return fail(
      "invalid_input",
      `[loadGraphSnapshot] ${path} is ${entry.value.size} bytes, over the ${maxBytes} byte cap. ` +
        `Re-export the slice or raise the cap deliberately; a file this size is refused rather than partly read.`,
    );
  }

  const text = await fromThrowing("not_found", `[loadGraphSnapshot] cannot read ${path}`, () =>
    readFile(path, "utf8"),
  );
  if (!text.ok) return text;

  const decoded = fromThrowingSync(
    "invalid_input",
    `[loadGraphSnapshot] ${path} is not valid JSON`,
    (): unknown => JSON.parse(text.value),
  );
  if (!decoded.ok) return decoded;

  const parsed = parseGraphSnapshot(decoded.value, path);
  if (!parsed.ok) return parsed;

  return succeed({
    graph: restoreGraphFromSnapshot(parsed.value),
    manifest: parsed.value.manifest,
    generatedAtMs: parsed.value.generatedAtMs,
    source: parsed.value.source,
    path,
  });
}

/**
 * Writes a snapshot, creating its directory if needed.
 *
 * The snapshot is validated before anything reaches the disk. A producer that built a
 * graph with a dangling edge should learn it at the write, where the ingest that caused it
 * is still on screen, rather than leaving a file that every later load refuses. The size
 * check mirrors the loader's, so this never writes a file the loader would reject.
 */
export async function writeGraphSnapshot(
  snapshot: GraphSnapshot,
  path: string = DEFAULT_GRAPH_SNAPSHOT_PATH,
): Promise<Result<WrittenGraphSnapshot, Failure>> {
  const validated = parseGraphSnapshot(snapshot, path);
  if (!validated.ok) return validated;

  const text = `${JSON.stringify(snapshot, null, SNAPSHOT_JSON_INDENT)}\n`;
  const byteSize = Buffer.byteLength(text, "utf8");
  if (byteSize > MAX_SNAPSHOT_FILE_BYTES) {
    return fail(
      "invalid_input",
      `[writeGraphSnapshot] the snapshot is ${byteSize} bytes, over the ${MAX_SNAPSHOT_FILE_BYTES} byte cap, ` +
        `so no reader could load it. Export a smaller slice.`,
    );
  }

  const directory = dirname(path);
  const ensured = await fromThrowing(
    "internal",
    `[writeGraphSnapshot] cannot create ${directory}`,
    () => mkdir(directory, { recursive: true }).then(() => undefined),
  );
  if (!ensured.ok) return ensured;

  const written = await fromThrowing("internal", `[writeGraphSnapshot] cannot write ${path}`, () =>
    writeFile(path, text, "utf8"),
  );
  if (!written.ok) return written;

  return succeed({
    path,
    byteSize,
    nodeCount: snapshot.nodes.length,
    edgeCount: snapshot.edges.length,
  });
}

// ---------------------------------------------------------------------------
// Integrity rules
// ---------------------------------------------------------------------------

/** One problem, with the field path zod reports it under. */
type IntegrityIssue = {
  path: readonly (string | number)[];
  message: string;
};

/**
 * Every graph-wide rule, as a list of issues.
 *
 * Written as a pure function rather than inside the refinement so each rule is readable on
 * its own and the caller decides how issues are reported. Field-level validation has
 * already passed by the time this runs, which is why it can index rows without guarding
 * their shapes.
 */
function findGraphIntegrityIssues(snapshot: GraphSnapshot): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const nodeIndexById = new Map<number, number>();
  const labelByNodeId = new Map<number, NodeLabel>();

  snapshot.nodes.forEach((node, nodeIndex) => {
    const firstIndex = nodeIndexById.get(node.id);
    if (firstIndex === undefined) {
      nodeIndexById.set(node.id, nodeIndex);
      labelByNodeId.set(node.id, node.label);
    } else {
      issues.push({
        path: ["nodes", nodeIndex, "id"],
        message:
          `duplicate node id ${node.id}, already declared by nodes[${firstIndex}]. ` +
          `Replaying both would keep one node and silently drop the other.`,
      });
    }

    issues.push(
      ...findPropertyNameIssues(
        node.properties,
        NODE_PROPERTY_NAMES[node.label],
        `${node.label} node ${node.id}`,
        ["nodes", nodeIndex, "properties"],
      ),
    );

    // A node whose `key` is present but unusable is worse than one that fails a name
    // check: every multi-source traversal selects its sources by this property, so the
    // node would sit in the graph and be invisible to algo.MSpaths.
    // sourceRef: src/lib/graph/model.ts SELECTOR_PROPERTY, memory-gateway.ts findNodeIdByKey.
    if (Object.hasOwn(node.properties, SELECTOR_PROPERTY)) {
      const selectorValue = node.properties[SELECTOR_PROPERTY];
      if (typeof selectorValue !== "string" || selectorValue.length === 0) {
        issues.push({
          path: ["nodes", nodeIndex, "properties", SELECTOR_PROPERTY],
          message:
            `${node.label} node ${node.id} has no usable "${SELECTOR_PROPERTY}" value, ` +
            `so no key selector could ever find it`,
        });
      }
    }
  });

  const edgeIndexById = new Map<number, number>();

  snapshot.edges.forEach((edge, edgeIndex) => {
    const firstIndex = edgeIndexById.get(edge.id);
    if (firstIndex === undefined) {
      edgeIndexById.set(edge.id, edgeIndex);
    } else {
      issues.push({
        path: ["edges", edgeIndex, "id"],
        message:
          `duplicate relationship id ${edge.id} on ${describeEdge(edge)}, already declared by ` +
          `edges[${firstIndex}]. On replay one of the two would replace the other and an ` +
          `exposure path would disappear.`,
      });
    }

    const endpoints = REL_ENDPOINTS[edge.relType];
    issues.push(...findEndpointIssues(edge, edgeIndex, "fromNodeId", endpoints.from, labelByNodeId));
    issues.push(...findEndpointIssues(edge, edgeIndex, "toNodeId", endpoints.to, labelByNodeId));

    issues.push(
      ...findPropertyNameIssues(
        edge.properties,
        REL_PROPERTY_NAMES[edge.relType],
        describeEdge(edge),
        ["edges", edgeIndex, "properties"],
      ),
    );
  });

  return issues;
}

/**
 * Checks one endpoint of an edge.
 *
 * An endpoint absent from the node list is corruption, not an edge to skip: dropping it
 * removes a dependency hop, and the blast radius that follows is smaller than the truth
 * while looking perfectly well formed. A mislabelled endpoint is refused for the same
 * reason MemorySink refuses it on the write side, since HydraDB would reject the batch.
 */
function findEndpointIssues(
  edge: GraphSnapshotEdge,
  edgeIndex: number,
  field: "fromNodeId" | "toNodeId",
  expectedLabel: NodeLabel,
  labelByNodeId: ReadonlyMap<number, NodeLabel>,
): IntegrityIssue[] {
  const nodeId = edge[field];
  const actualLabel = labelByNodeId.get(nodeId);

  if (actualLabel === undefined) {
    return [
      {
        path: ["edges", edgeIndex, field],
        message:
          `${describeEdge(edge)} points at node ${nodeId}, which this snapshot does not declare. ` +
          `A dangling edge is refused rather than dropped, because a dropped edge is an ` +
          `exposure path that disappears.`,
      },
    ];
  }

  if (actualLabel !== expectedLabel) {
    return [
      {
        path: ["edges", edgeIndex, field],
        message:
          `${describeEdge(edge)} needs a ${expectedLabel} at ${field} and node ${nodeId} is a ` +
          `${actualLabel}. HydraDB refuses this relationship for the same reason.`,
      },
    ];
  }

  return [];
}

/**
 * Compares one property map against the registry for its label or relationship type.
 *
 * Both directions matter. A missing name breaks every reader that projects by name, and an
 * extra name is a value the writer could never have produced, so accepting it would hide
 * whichever step invented it. The registries are the same ones the batch writer projects
 * from, so a snapshot written by this project always passes.
 *
 * test/fixtures/graph.ts has a similar check, but it reports sentences about an in-memory
 * fixture; this one reports zod issue paths into a decoded file, so neither can stand in
 * for the other.
 */
function findPropertyNameIssues(
  properties: GraphProperties,
  registryNames: readonly string[],
  subject: string,
  path: readonly (string | number)[],
): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];

  for (const name of registryNames) {
    if (Object.hasOwn(properties, name)) continue;
    issues.push({
      path: [...path, name],
      message: `${subject} is missing the property "${name}" that the model registry declares`,
    });
  }

  for (const name of Object.keys(properties)) {
    if (registryNames.includes(name)) continue;
    issues.push({
      path: [...path, name],
      message: `${subject} carries the property "${name}", which the model registry does not declare`,
    });
  }

  return issues;
}

/** Names an edge the way a failure message should: type, id, and both endpoints. */
function describeEdge(edge: GraphSnapshotEdge): string {
  return `${edge.relType} relationship ${edge.id} from node ${edge.fromNodeId} to node ${edge.toNodeId}`;
}

// ---------------------------------------------------------------------------
// Projection helpers
// ---------------------------------------------------------------------------

function compareById(left: { id: number }, right: { id: number }): number {
  return left.id - right.id;
}

function projectNode(node: StoredNode): GraphSnapshotNode {
  return {
    id: node.id,
    label: node.label,
    properties: orderPropertyKeys(node.properties, NODE_PROPERTY_NAMES[node.label]),
  };
}

function projectEdge(edge: StoredEdge): GraphSnapshotEdge {
  return {
    id: edge.id,
    relType: edge.relType,
    fromNodeId: edge.fromNodeId,
    toNodeId: edge.toNodeId,
    properties: orderPropertyKeys(edge.properties, REL_PROPERTY_NAMES[edge.relType]),
  };
}

/**
 * Rewrites a property map in a fixed key order: the registry order first, then any name
 * the registry does not declare, sorted.
 *
 * Fixed order is what makes two serialisations of one graph byte identical whatever order
 * the properties were inserted in. Off-registry names are kept rather than dropped, so
 * validation refuses them by name instead of this step quietly losing a value.
 */
function orderPropertyKeys(
  properties: GraphProperties,
  registryNames: readonly string[],
): GraphProperties {
  const ordered: GraphProperties = {};

  for (const name of registryNames) {
    if (Object.hasOwn(properties, name)) ordered[name] = properties[name];
  }
  for (const name of Object.keys(properties).sort()) {
    if (registryNames.includes(name)) continue;
    ordered[name] = properties[name];
  }

  return ordered;
}

/** Copies every field of the manifest, so the snapshot shares no array with the caller. */
function copyManifest(manifest: SliceManifest): SliceManifest {
  return {
    version: manifest.version,
    generatedAtMs: manifest.generatedAtMs,
    ecosystems: [...manifest.ecosystems],
    closedPackageKeys: [...manifest.closedPackageKeys],
    partialPackageKeys: [...manifest.partialPackageKeys],
    closedServiceKeys: [...manifest.closedServiceKeys],
    counts: { ...manifest.counts },
    notes: [...manifest.notes],
  };
}
