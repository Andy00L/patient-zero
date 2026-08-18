import type { GraphProperties, GraphPropertyValue } from "@/lib/graph/gateway";
import type { MemoryGraph, StoredEdge, StoredNode } from "@/lib/graph/memory-gateway";
import {
  NODE_LABELS,
  type NodeLabel,
  REL_TYPES,
  SELECTOR_PROPERTY,
  UNKNOWN_NUMERIC_VALUE,
} from "@/lib/graph/model";
import {
  type Coverage,
  SLICE_MANIFEST_VERSION,
  type SliceCounts,
  type SliceManifest,
} from "@/lib/graph/slice-manifest";
import {
  buildGraphSnapshot,
  type GraphSnapshot,
  type GraphSnapshotNode,
  restoreGraphFromSnapshot,
} from "@/lib/graph/snapshot";
import { type Failure, fail, type Result, succeed } from "@/lib/result";

/**
 * Merges two graph snapshots into one, keyed on natural keys rather than on node ids.
 *
 * WHY THIS EXISTS. The demo graph is assembled from two producers that each hold half of
 * the answer. The incident seed (`seed-incidents`) carries Service nodes and their RESOLVED
 * lockfile edges, which is the only thing that can answer "who pinned this while the
 * payload was live", and it carries no dependency closure at all. The registry ingest
 * (`ingest-slice`) carries DEPENDS_ON, RESOLVES_TO and MAINTAINS, which is the only thing
 * that can answer blast radius and maintainer surface, and it carries no service. Loading
 * either one alone gives a product where half the questions abstain.
 *
 * WHY IDS CANNOT BE OFFSET. Both files number their nodes from 0, so their ids collide, but
 * shifting one file's ids by a constant is the wrong repair: `npm:event-stream` is a Package
 * in both files, and an offset would put two disconnected copies of it in the merged graph.
 * The seed copy would hold the service resolutions, the ingest copy would hold the
 * dependency edges, and every traversal would return half an answer while looking perfectly
 * well formed. Identity here is the natural key (`SELECTOR_PROPERTY`, scoped per label), the
 * same identity every query selects on, so the merge unifies on that and translates the
 * second snapshot's edge endpoints through the unification.
 *
 * WHAT IT REFUSES TO GUESS. Two sources that read one property differently are never
 * silently reconciled: the first snapshot's value is kept and the disagreement is reported
 * so a human can look at it. A value no source ever reported is not a reading, so it never
 * outranks one: where one side carries `UNKNOWN_NUMERIC_VALUE` or an empty string and the
 * other carries a real value, the real value wins whichever side holds it and nothing is
 * reported, because the two sides do not disagree, one of them had nothing to say. Keeping
 * the placeholder there would make the graph report an absence of information that is not
 * absent, which is the same class of error as overstating coverage. A node with no usable key
 * cannot be identified, so it is added rather than unified and counted in the report.
 * Coverage merges to the weaker of the two claims, never the stronger, because a graph that
 * reports a clean answer over data it never fully read is the exact failure this project
 * exists to prevent.
 *
 * Pure by construction: no clock, no filesystem, no logging. The caller states the instant
 * and the source, and `scripts/build-demo-graph.ts` does the input and output.
 */

/**
 * Coverage claims ordered weakest first, so merging two claims is an index comparison.
 * sourceRef: src/lib/graph/slice-manifest.ts Coverage.
 */
const COVERAGE_WEAKEST_FIRST: readonly Coverage[] = ["absent", "partial", "closed"];

/** Separator inside the "label + key" identity used to unify nodes. */
const IDENTITY_SEPARATOR = " ";

export type MergeGraphSnapshotsInput = {
  /** The snapshot whose node ids are kept, and whose reading wins when both sides read one. */
  first: GraphSnapshot;
  /** The snapshot folded into the first one. Its ids are translated, never trusted. */
  second: GraphSnapshot;
  /** Epoch milliseconds for the merged snapshot and its manifest. Stated by the caller. */
  generatedAtMs: number;
  /** Which writer produced the merged file, for example "build-demo-graph". Log safe. */
  source: string;
};

/**
 * One property both snapshots read, and read differently. The first snapshot's value is kept.
 *
 * A property only one side ever read is not a conflict and never appears here: see
 * `isUnreportedValue`.
 */
export type PropertyConflict = {
  label: NodeLabel;
  /** The node's natural key, or "node <id>" for a node that carries none. */
  key: string;
  property: string;
  /** The value that survived the merge: always the first snapshot's. */
  keptValue: GraphPropertyValue;
  /** The value that was dropped, from the second snapshot. */
  discardedValue: GraphPropertyValue;
};

export type MergeReport = {
  firstNodeCount: number;
  firstEdgeCount: number;
  secondNodeCount: number;
  secondEdgeCount: number;
  mergedNodeCount: number;
  mergedEdgeCount: number;
  /** Nodes of the second snapshot that turned out to be a node the first one already had. */
  unifiedNodes: number;
  /** Nodes of the second snapshot added under a fresh id. */
  addedNodes: number;
  addedEdges: number;
  /** Edges of the second snapshot already present with the same type, endpoints and properties. */
  skippedDuplicateEdges: number;
  /**
   * Properties the second snapshot supplied for a unified node that held none: absent from
   * the first side, or present there only as a value its source never reported.
   */
  filledProperties: number;
  /** Nodes on either side with no usable key, so none of them could be unified. */
  unkeyedNodes: number;
  conflicts: PropertyConflict[];
};

export type MergedGraphSnapshot = {
  snapshot: GraphSnapshot;
  report: MergeReport;
};

/**
 * Folds `second` into `first` and returns the merged snapshot with a report of what the
 * merge had to decide.
 *
 * The only failure is corruption the caller handed in: an edge in the second snapshot whose
 * endpoint is not among its own nodes. That is refused rather than dropped, for the same
 * reason the snapshot reader refuses it, because a dropped edge is an exposure path that
 * disappears from the answer without a trace.
 */
export function mergeGraphSnapshots(
  input: MergeGraphSnapshotsInput,
): Result<MergedGraphSnapshot, Failure> {
  // The first snapshot is replayed through the shared restorer, so the merged graph is built
  // by the same code path the app uses to load one, adjacency and key index included.
  const graph = restoreGraphFromSnapshot(input.first);

  const nodesById = new Map<number, StoredNode>();
  for (const node of graph.listNodes()) nodesById.set(node.id, node);

  const edgesByIdentity = new Set<string>();
  for (const edge of graph.listEdges()) edgesByIdentity.add(describeEdgeIdentity(edge));

  let nextNodeId = findHighestId(graph.listNodes()) + 1;
  let nextEdgeId = findHighestId(graph.listEdges()) + 1;

  const conflicts: PropertyConflict[] = [];
  let unifiedNodes = 0;
  let addedNodes = 0;
  let filledProperties = 0;
  let unkeyedNodes = countUnkeyedNodes(input.first.nodes);

  /** Second snapshot node id to the id it holds in the merged graph. */
  const mergedNodeIdBySecondId = new Map<number, number>();

  for (const incoming of input.second.nodes) {
    const naturalKey = readNaturalKey(incoming.properties);

    // No key means no identity. Guessing one (by name, by position) would be how two
    // different packages become one node, so an unkeyed node is added and counted instead.
    const existingId =
      naturalKey === null ? null : graph.findNodeIdByKey(incoming.label, naturalKey);

    if (existingId === null) {
      if (naturalKey === null) unkeyedNodes += 1;

      const added: StoredNode = {
        id: nextNodeId,
        label: incoming.label,
        properties: { ...incoming.properties },
      };
      // addNode indexes the key, so a second occurrence of this key inside the same
      // snapshot unifies onto this node rather than adding a third copy.
      graph.addNode(added);
      nodesById.set(added.id, added);
      mergedNodeIdBySecondId.set(incoming.id, added.id);
      nextNodeId += 1;
      addedNodes += 1;
      continue;
    }

    const existing = nodesById.get(existingId);
    if (existing === undefined) {
      return fail(
        "internal",
        `[mergeGraphSnapshots] the key index resolved ${incoming.label} "${naturalKey ?? ""}" to ` +
          `node ${existingId}, which the merged graph does not hold`,
      );
    }

    filledProperties += mergeNodeProperties(existing, incoming.properties, conflicts);
    mergedNodeIdBySecondId.set(incoming.id, existingId);
    unifiedNodes += 1;
  }

  let addedEdges = 0;
  let skippedDuplicateEdges = 0;

  for (const incoming of input.second.edges) {
    const fromNodeId = mergedNodeIdBySecondId.get(incoming.fromNodeId);
    const toNodeId = mergedNodeIdBySecondId.get(incoming.toNodeId);

    if (fromNodeId === undefined || toNodeId === undefined) {
      const missingField = fromNodeId === undefined ? "fromNodeId" : "toNodeId";
      const missingId = fromNodeId === undefined ? incoming.fromNodeId : incoming.toNodeId;
      return fail(
        "invalid_input",
        `[mergeGraphSnapshots] ${incoming.relType} relationship ${incoming.id} of the second snapshot ` +
          `points at node ${missingId} through ${missingField}, and that snapshot declares no such node. ` +
          `A dangling edge is refused rather than dropped, because a dropped edge is an exposure path ` +
          `that disappears.`,
      );
    }

    const identity = describeEdgeIdentity({ ...incoming, fromNodeId, toNodeId });

    if (edgesByIdentity.has(identity)) {
      // The same statement, already in the graph. Re-running the merge therefore cannot
      // double an edge, and merging two files that overlap keeps one row per fact.
      skippedDuplicateEdges += 1;
      continue;
    }

    const added: StoredEdge = {
      id: nextEdgeId,
      relType: incoming.relType,
      fromNodeId,
      toNodeId,
      properties: { ...incoming.properties },
    };
    graph.addEdge(added);
    edgesByIdentity.add(identity);
    nextEdgeId += 1;
    addedEdges += 1;
  }

  const manifest = mergeManifests({
    first: input.first,
    second: input.second,
    graph,
    generatedAtMs: input.generatedAtMs,
    conflictCount: conflicts.length,
  });

  const snapshot = buildGraphSnapshot({
    graph,
    manifest,
    generatedAtMs: input.generatedAtMs,
    source: input.source,
  });

  return succeed({
    snapshot,
    report: {
      firstNodeCount: input.first.nodes.length,
      firstEdgeCount: input.first.edges.length,
      secondNodeCount: input.second.nodes.length,
      secondEdgeCount: input.second.edges.length,
      mergedNodeCount: snapshot.nodes.length,
      mergedEdgeCount: snapshot.edges.length,
      unifiedNodes,
      addedNodes,
      addedEdges,
      skippedDuplicateEdges,
      filledProperties,
      unkeyedNodes,
      conflicts,
    },
  });
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

/**
 * Folds the second snapshot's properties into a node the first one already held, and
 * returns how many properties were filled in.
 *
 * Four cases, and none of them loses a reading quietly: a property only the second side
 * carries is filled in, a property both sides state identically is left alone, a property
 * one side never reported takes the other side's reading whichever side that is, and a
 * property both sides genuinely read differently keeps the first side's value and is
 * reported.
 */
function mergeNodeProperties(
  existing: StoredNode,
  incomingProperties: GraphProperties,
  conflicts: PropertyConflict[],
): number {
  const naturalKey = readNaturalKey(existing.properties);
  let filledProperties = 0;

  for (const [property, incomingValue] of Object.entries(incomingProperties)) {
    if (!Object.hasOwn(existing.properties, property)) {
      existing.properties[property] = incomingValue;
      filledProperties += 1;
      continue;
    }

    const keptValue = existing.properties[property];
    if (keptValue === incomingValue) continue;

    if (isUnreportedValue(keptValue)) {
      // Neither source reported this one, so there is nothing to choose between and
      // nothing to report. The placeholder stands.
      if (isUnreportedValue(incomingValue)) continue;

      // The first side had nothing to say and the second side took a reading. That is not
      // a disagreement, so the reading wins and no conflict is raised: reporting "the
      // registry gave no download count" while another input holds the figure is the
      // failure this file exists to prevent.
      existing.properties[property] = incomingValue;
      filledProperties += 1;
      continue;
    }

    // The mirror image: the reading already held stands over the second side's placeholder.
    if (isUnreportedValue(incomingValue)) continue;

    conflicts.push({
      label: existing.label,
      key: naturalKey ?? `node ${existing.id}`,
      property,
      keptValue,
      discardedValue: incomingValue,
    });
  }

  return filledProperties;
}

/**
 * True when a value carries no reading from its source, so the other side's value is not a
 * competing claim but the only one.
 *
 * Two forms, both taken from the writers rather than assumed here: `UNKNOWN_NUMERIC_VALUE`
 * for a number, and the empty string for text, which states nothing whichever property
 * holds it (an Advisory with no summary is not an Advisory summarised as blank).
 *
 * A boolean has neither form, and cannot be given one: `has_install_script: false` is
 * written both where a packument was read and showed no install hook and where no manifest
 * was fetched at all (src/lib/ingest/graph-builder.ts stageNodes, scripts/seed-incidents.ts
 * mapService), and this function cannot tell those apart. So a boolean is compared as the
 * reading it claims to be, a disagreement between two `has_install_script` values is
 * reported for a human, and the never-inspected case stays where the writers put it: the
 * manifest marks that package partial. Preferring `true` here because it is the riskier
 * value would invent an install script the graph was never told about.
 */
function isUnreportedValue(value: GraphPropertyValue): boolean {
  if (typeof value === "number") return value === UNKNOWN_NUMERIC_VALUE;
  if (typeof value === "string") return value.length === 0;
  return false;
}

/** The node's natural key, or null when it carries none a selector could ever match. */
function readNaturalKey(properties: GraphProperties): string | null {
  const value = properties[SELECTOR_PROPERTY];
  if (typeof value !== "string" || value.length === 0) return null;
  return value;
}

function countUnkeyedNodes(nodes: readonly GraphSnapshotNode[]): number {
  let count = 0;
  for (const node of nodes) if (readNaturalKey(node.properties) === null) count += 1;
  return count;
}

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

/**
 * An edge's identity for dedup: its type, both endpoints in the merged id space, and its
 * properties.
 *
 * The properties are part of the identity on purpose. The producers already write parallel
 * edges between one pair of nodes, because a pair of nodes can be connected by more than one
 * fact: `ingest-slice` writes 113 AFFECTS rows over 78 advisory and package pairs, since an
 * advisory states several affected ranges for one package, and a service can pin one version
 * at two different instants (RESOLVED.resolved_at_ms). Keying on the endpoints alone would
 * fold those separate facts into whichever arrived first, which narrows an affected range with
 * no trace left in the graph. Two rows that state the same thing still collapse into one, so a
 * re-run of the merge cannot double an edge, which is what the dedup exists for.
 *
 * Property values are serialised with their JSON type, so the string "1" and the number 1 are
 * two facts rather than one, and names are sorted so insertion order cannot change an
 * identity.
 */
function describeEdgeIdentity(
  edge: Pick<StoredEdge, "relType" | "fromNodeId" | "toNodeId" | "properties">,
): string {
  const properties = Object.keys(edge.properties)
    .sort()
    .map((name) => `${name}=${JSON.stringify(edge.properties[name])}`)
    .join(",");
  return [edge.relType, edge.fromNodeId, edge.toNodeId, properties].join(IDENTITY_SEPARATOR);
}

/** Highest id in a list, or -1 when the list is empty, so the next id is 0. */
function findHighestId(rows: readonly { id: number }[]): number {
  let highest = -1;
  for (const row of rows) if (row.id > highest) highest = row.id;
  return highest;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

type MergeManifestsInput = {
  first: GraphSnapshot;
  second: GraphSnapshot;
  /** The merged graph, because dedup makes the sum of the two count sets wrong. */
  graph: MemoryGraph;
  generatedAtMs: number;
  conflictCount: number;
};

/**
 * Merges the two slice manifests.
 *
 * Counts are recomputed from the merged graph rather than added up, because a package both
 * snapshots hold is one node and a summed count would overstate the slice.
 *
 * Coverage takes the weaker of the two claims. "absent" is not a claim, it is what a
 * manifest says about every key it never heard of, so a subject only one side describes
 * keeps that side's claim; a subject both sides describe takes the weaker of the two, which
 * is what makes "partial on one side, closed on the other" resolve to partial. Overstating
 * coverage would turn an empty traversal into a clean `not_exposed` over a graph that never
 * held the dependents.
 */
function mergeManifests(input: MergeManifestsInput): SliceManifest {
  const firstManifest = input.first.manifest;
  const secondManifest = input.second.manifest;

  const packageCoverage = mergeCoverageClaims(
    readPackageClaims(firstManifest),
    readPackageClaims(secondManifest),
  );

  const closedPackageKeys: string[] = [];
  const partialPackageKeys: string[] = [];
  for (const [packageKeyValue, coverage] of [...packageCoverage].sort(compareByKey)) {
    if (coverage === "closed") closedPackageKeys.push(packageKeyValue);
    else if (coverage === "partial") partialPackageKeys.push(packageKeyValue);
  }

  // A service manifest has one list, so the only claim it can make is "closed" and the
  // weaker-wins rule has nothing to weaken: the merged list is the union of the two.
  const closedServiceKeys = dedupe([
    ...firstManifest.closedServiceKeys,
    ...secondManifest.closedServiceKeys,
  ]).sort();

  const notes = dedupe([...firstManifest.notes, ...secondManifest.notes]);
  notes.push(
    `this graph is the merge of the "${input.first.source}" and "${input.second.source}" snapshots, ` +
      `unified on natural keys`,
  );
  if (input.conflictCount > 0) {
    notes.push(
      `${input.conflictCount} propert${input.conflictCount === 1 ? "y" : "ies"} disagreed between the ` +
        `two snapshots, and the "${input.first.source}" value was kept in each case`,
    );
  }

  return {
    version: SLICE_MANIFEST_VERSION,
    generatedAtMs: input.generatedAtMs,
    ecosystems: dedupe([...firstManifest.ecosystems, ...secondManifest.ecosystems]),
    closedPackageKeys,
    partialPackageKeys,
    closedServiceKeys,
    counts: countMergedSlice(input.graph),
    notes,
  };
}

/** The coverage each manifest claims per package key. Keys it never names are absent. */
function readPackageClaims(manifest: SliceManifest): Map<string, Coverage> {
  const claims = new Map<string, Coverage>();

  for (const packageKeyValue of manifest.closedPackageKeys) claims.set(packageKeyValue, "closed");
  for (const packageKeyValue of manifest.partialPackageKeys) {
    const stated = claims.get(packageKeyValue);
    // A manifest that lists one key as both closed and partial is claiming two things at
    // once, so the weaker claim is what this graph can defend.
    const merged = stated === undefined ? "partial" : weakerCoverage(stated, "partial");
    claims.set(packageKeyValue, merged);
  }

  return claims;
}

function mergeCoverageClaims(
  firstClaims: ReadonlyMap<string, Coverage>,
  secondClaims: ReadonlyMap<string, Coverage>,
): Map<string, Coverage> {
  const merged = new Map<string, Coverage>(firstClaims);

  for (const [subject, secondCoverage] of secondClaims) {
    const firstCoverage = merged.get(subject);
    merged.set(
      subject,
      firstCoverage === undefined ? secondCoverage : weakerCoverage(firstCoverage, secondCoverage),
    );
  }

  return merged;
}

function weakerCoverage(left: Coverage, right: Coverage): Coverage {
  return COVERAGE_WEAKEST_FIRST.indexOf(left) <= COVERAGE_WEAKEST_FIRST.indexOf(right)
    ? left
    : right;
}

/** Node and edge counts of the merged graph, in the shape the manifest declares. */
function countMergedSlice(graph: MemoryGraph): SliceCounts {
  const countByLabel = new Map<NodeLabel, number>();
  for (const label of Object.values(NODE_LABELS)) countByLabel.set(label, 0);
  for (const node of graph.listNodes()) {
    countByLabel.set(node.label, (countByLabel.get(node.label) ?? 0) + 1);
  }

  // The manifest's resolutionEdges counts every edge that says "this artifact resolved to
  // that exact version", which is both kinds: RESOLVES_TO for a dependency resolution and
  // RESOLVED for a lockfile pin. Counting only RESOLVES_TO made a graph built from
  // lockfiles alone report itself as holding no resolutions at all.
  // sourceRef: src/lib/ingest/graph-builder.ts countResolutionEdges, which sums the same two.
  //
  // This count is exact where the builder's is an upper bound: it walks the merged graph
  // after the writer has already suppressed duplicate edges, so there is nothing left to
  // over-count.
  let resolutionEdges = 0;
  for (const edge of graph.listEdges()) {
    if (edge.relType === REL_TYPES.resolvesTo || edge.relType === REL_TYPES.resolved) {
      resolutionEdges += 1;
    }
  }

  return {
    packages: countByLabel.get(NODE_LABELS.package) ?? 0,
    versions: countByLabel.get(NODE_LABELS.version) ?? 0,
    maintainers: countByLabel.get(NODE_LABELS.maintainer) ?? 0,
    services: countByLabel.get(NODE_LABELS.service) ?? 0,
    advisories: countByLabel.get(NODE_LABELS.advisory) ?? 0,
    resolutionEdges,
  };
}

function compareByKey(
  left: readonly [string, Coverage],
  right: readonly [string, Coverage],
): number {
  return left[0].localeCompare(right[0]);
}

/** Keeps the first occurrence of every value, so the merged order stays deterministic. */
function dedupe<TValue>(values: readonly TValue[]): TValue[] {
  return [...new Set(values)];
}
