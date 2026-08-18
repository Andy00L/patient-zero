import type { NodeLabel, RelType } from "@/lib/graph/model";
import { type Failure, type Result, succeed } from "@/lib/result";

/**
 * The graph gateway: the only surface the analysis layer talks to.
 *
 * Two implementations exist and must behave identically:
 *   - src/lib/hydra/hydra-gateway.ts  translates these calls into OpenCypher and
 *     algo.* path procedures against a running HydraDB.
 *   - src/lib/graph/memory-gateway.ts an in-process adjacency graph used by the
 *     correctness fixtures.
 *
 * The interface is deliberately semantic rather than a raw query pipe. HydraDB
 * accepts a small Cypher subset (one statement per request, no IN, no min or max,
 * pass-through WITH), so multi-step composition has to live in TypeScript anyway.
 * Naming those steps here keeps the composition testable and keeps every Cypher
 * string in one file.
 */
export type GraphGateway = {
  /**
   * All paths reachable from one node, over the given relationship types. Maps onto
   * algo.SSpaths.
   */
  pathsFromSource(request: PathRequest): Promise<Result<GraphPath[], Failure>>;

  /**
   * All paths reachable from several nodes at once, selected by natural key. Maps
   * onto algo.MSpaths, which is what makes the maintainer leaderboard one
   * server-side pass instead of one request per maintainer.
   */
  pathsFromSources(request: MultiSourcePathRequest): Promise<Result<GraphPath[], Failure>>;

  /** Reads node properties for a set of integer ids. */
  readNodes(request: ReadNodesRequest): Promise<Result<GraphNodeRecord[], Failure>>;

  /**
   * Resolves natural keys to integer node ids.
   *
   * A key absent from the result is a key that is not in the graph. The gateway does
   * not decide what that means, because "not ingested" and "does not exist" are
   * different answers and only the slice manifest can tell them apart.
   */
  resolveNodeIds(request: ResolveNodeIdsRequest): Promise<Result<Map<string, number>, Failure>>;

  /**
   * Every node id carrying a label, up to a limit.
   *
   * This exists because RESOLVED runs Service to Version and has no materialised reverse
   * type, so "which services resolved this version" is not answered by asking for one.
   * Instead the analysis layer enumerates the Service nodes, which are few and known, and
   * expands each one forward. Walking from the small side turns the request count into the
   * number of services rather than the number of reachable versions; an incoming walk over
   * RESOLVED would need one call per version instead.
   */
  listNodeIds(request: ListNodeIdsRequest): Promise<Result<number[], Failure>>;

  /**
   * One-hop expansion with the relationship properties attached, and an optional
   * half-open numeric window on one of those properties. The window is pushed down
   * into the query rather than filtered client side, because the bitemporal answer
   * would otherwise pull every lockfile edge over the wire.
   */
  neighbors(request: NeighborRequest): Promise<Result<NeighborEdge[], Failure>>;

  /** Counts nodes carrying a label. Used by the health check and the README numbers. */
  countNodes(label: NodeLabel): Promise<Result<number, Failure>>;

  /** A log-safe description of where this gateway reads from. Never holds a secret. */
  describe(): string;

  /** Releases any driver resources. Safe to call more than once. */
  close(): Promise<void>;
};

/**
 * Traversal direction.
 *
 * All three values reach the engine: the native path procedures take a `relDirection`
 * argument accepting "incoming", "outgoing", or "both", and one-hop patterns express
 * direction with the arrow. The ingest still materialises DEPENDED_ON_BY alongside
 * RESOLVES_TO, because an outgoing walk over a stored reverse type and an incoming walk
 * over the forward type read different indexes and do not cost the same;
 * scripts/measure-traversal.ts is what settles which one a given slice should use.
 */
export type TraversalDirection = "incoming" | "outgoing" | "both";

export type PathRequest = {
  sourceNodeId: number;
  relTypes: readonly RelType[];
  direction: TraversalDirection;
  /**
   * Maximum hops. Required, because an omitted bound silently becomes the engine's
   * own 16 hop ceiling, and a 16 hop walk over a dependency graph is not a query
   * anyone intended.
   */
  maxLength: number;
  /** Upper bound on returned paths, to stay inside the engine's result budget. */
  pathCount: number;
  /**
   * When set, only paths whose final node carries this label are returned. Filtered
   * client side: the path procedures reject every target selector, and they hydrate
   * each node's full label set, so the filter costs nothing extra.
   */
  targetLabel?: NodeLabel;
};

/**
 * Multi-source traversal selects its sources by natural key, not by integer id:
 * algo.MSpaths rejects sourceNode and matches on a string property instead.
 */
export type MultiSourcePathRequest = Omit<PathRequest, "sourceNodeId"> & {
  sourceLabel: NodeLabel;
  /** Natural key values, as stored in the `key` property of each source node. */
  sourceKeys: readonly string[];
};

export type ReadNodesRequest = {
  nodeIds: readonly number[];
  label: NodeLabel;
};

export type ResolveNodeIdsRequest = {
  label: NodeLabel;
  /** Natural keys as stored in the `key` property. */
  keys: readonly string[];
};

export type ListNodeIdsRequest = {
  label: NodeLabel;
  /**
   * Upper bound on returned ids. Required, so a caller cannot accidentally ask for
   * every Version in the slice. Reaching it means the answer was truncated, which the
   * abstention model records rather than hides.
   */
  limit: number;
};

export type NeighborRequest = {
  nodeId: number;
  /** The label of the node being expanded. Required by the Cypher pattern. */
  nodeLabel: NodeLabel;
  relType: RelType;
  direction: Exclude<TraversalDirection, "both">;
  /** Half-open window [fromInclusive, toExclusive) on a numeric edge property. */
  propertyWindow?: {
    property: string;
    fromInclusive: number;
    toExclusive: number;
  };
  limit: number;
};

/**
 * A traversal result.
 *
 * Nodes and relationships arrive fully hydrated: HydraDB's path procedures return
 * each node's complete label set and property map rather than a projection, so the
 * analysis layer can filter, group, and explain a path without a second read. That
 * is why this type carries records instead of bare ids.
 *
 * `nodes` has length `hopCount + 1`; index 0 is the source.
 */
export type GraphPath = {
  nodes: GraphPathNode[];
  relationships: GraphPathEdge[];
  hopCount: number;
};

export type GraphPathNode = {
  id: number;
  /** Every label the node carries. Empty only for a node written without metadata. */
  labels: string[];
  properties: GraphProperties;
};

export type GraphPathEdge = {
  /** null when the relationship was written without an explicit id property. */
  id: number | null;
  relType: string;
  sourceNodeId: number;
  targetNodeId: number;
  properties: GraphProperties;
};

/** A node as read back from the graph by id. */
export type GraphNodeRecord = {
  id: number;
  label: NodeLabel;
  properties: GraphProperties;
};

/**
 * A one-hop edge as seen from the node being expanded.
 *
 * There is no relationship id here on purpose. HydraDB rejects `edge.id` outright in a
 * row query (binding_property answers UnsupportedQuery for property "id" on any
 * relationship binding), so the field could only ever be null from the live gateway
 * while the memory gateway filled it in, and the two implementations are required to
 * behave identically. Relationship identity is reachable through the path procedures,
 * which hydrate it themselves. sourceRef: docs/HYDRADB.md section 2.4.
 */
export type NeighborEdge = {
  relType: RelType;
  /** The node at the far end of the edge, relative to the requested node. */
  otherNodeId: number;
  properties: GraphProperties;
};

/**
 * Property values HydraDB stores and returns. Kept to the scalar set the engine
 * accepts so no code path can try to write a nested object into a property.
 */
export type GraphPropertyValue = string | number | boolean;
export type GraphProperties = Record<string, GraphPropertyValue>;

/** The node a path ends at, which is the one every blast-radius answer counts. */
export function pathTargetNode(path: GraphPath): GraphPathNode | null {
  return path.nodes[path.nodes.length - 1] ?? null;
}

export function pathSourceNode(path: GraphPath): GraphPathNode | null {
  return path.nodes[0] ?? null;
}

export function pathNodeIds(path: GraphPath): number[] {
  return path.nodes.map((node) => node.id);
}

export function nodeHasLabel(node: GraphPathNode, label: NodeLabel): boolean {
  return node.labels.includes(label);
}

export function readStringProperty(properties: GraphProperties, name: string): string | null {
  const value = properties[name];
  return typeof value === "string" ? value : null;
}

export function readNumberProperty(properties: GraphProperties, name: string): number | null {
  const value = properties[name];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function readBooleanProperty(properties: GraphProperties, name: string): boolean | null {
  const value = properties[name];
  return typeof value === "boolean" ? value : null;
}

/**
 * Distinguishes "no ingest has run" from "nothing depends on this".
 *
 * Counting Version nodes is the cheapest question that separates the two, and the answer
 * changes an abstaining verdict from not_exposed to unknown, so it is worth one request.
 * Every analysis module needs it, which is why it lives next to the gateway contract
 * rather than being reimplemented per question.
 */
export async function isGraphEmpty(gateway: GraphGateway): Promise<Result<boolean, Failure>> {
  const count = await gateway.countNodes("Version");
  if (!count.ok) return count;
  return succeed(count.value === 0);
}
