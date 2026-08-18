import {
  type GraphGateway,
  type GraphNodeRecord,
  type GraphPath,
  type GraphPathEdge,
  type GraphPathNode,
  type GraphProperties,
  type ListNodeIdsRequest,
  type MultiSourcePathRequest,
  type NeighborEdge,
  type NeighborRequest,
  type PathRequest,
  type ReadNodesRequest,
  type ResolveNodeIdsRequest,
} from "@/lib/graph/gateway";
import type { NodeLabel, RelType } from "@/lib/graph/model";
import { type Failure, type Result, fail, succeed } from "@/lib/result";

/**
 * An in-process graph that implements the same gateway contract as HydraDB.
 *
 * It exists for two reasons:
 *   1. The correctness fixtures in test/ need a graph with a hand-known answer, so a
 *      blast-radius bug fails a test instead of being masked by a server.
 *   2. The app can answer queries from an exported snapshot when no HydraDB is
 *      reachable, which keeps the UI honest about its data source instead of
 *      rendering an empty state that looks like "nothing is exposed".
 *
 * It deliberately mirrors the engine's constraints rather than being permissive:
 * traversal is bounded by maxLength, results are capped by pathCount, and an
 * exploration budget produces the same query_budget_exceeded failure the engine
 * would produce. Analysis code that passes here is not relying on behaviour the real
 * engine will not give it.
 */
export class MemoryGraph implements GraphGateway {
  private readonly nodesById = new Map<number, StoredNode>();
  private readonly edgesById = new Map<number, StoredEdge>();
  private readonly outgoingByNodeId = new Map<number, number[]>();
  private readonly incomingByNodeId = new Map<number, number[]>();
  /** Mirrors HydraDB's automatic per-property vertex index, for key selectors. */
  private readonly nodeIdsByLabelAndKey = new Map<string, number>();

  /**
   * Mirrors HydraDB's max_query_scan_edges default of 1,000,000 so a traversal that
   * would blow the engine's budget also fails here.
   * sourceRef: HydraDB src/core/config.rs GraphLimits.
   */
  private static readonly MAX_EDGE_EXPANSIONS = 1_000_000;

  get nodeCount(): number {
    return this.nodesById.size;
  }

  get edgeCount(): number {
    return this.edgesById.size;
  }

  addNode(node: StoredNode): void {
    this.nodesById.set(node.id, node);
    const key = node.properties.key;
    if (typeof key === "string") {
      this.nodeIdsByLabelAndKey.set(`${node.label}|${key}`, node.id);
    }
  }

  addEdge(edge: StoredEdge): void {
    this.edgesById.set(edge.id, edge);
    pushInto(this.outgoingByNodeId, edge.fromNodeId, edge.id);
    pushInto(this.incomingByNodeId, edge.toNodeId, edge.id);
  }

  /** Resolves a natural key the way the engine's property index does. */
  findNodeIdByKey(label: NodeLabel, key: string): number | null {
    return this.nodeIdsByLabelAndKey.get(`${label}|${key}`) ?? null;
  }

  async pathsFromSource(request: PathRequest): Promise<Result<GraphPath[], Failure>> {
    return this.enumeratePaths([request.sourceNodeId], request);
  }

  async pathsFromSources(request: MultiSourcePathRequest): Promise<Result<GraphPath[], Failure>> {
    const sourceNodeIds: number[] = [];
    for (const key of request.sourceKeys) {
      const nodeId = this.findNodeIdByKey(request.sourceLabel, key);
      // A key that is not in the graph is skipped rather than failing the request:
      // the engine's selector scan behaves the same way, and the caller decides what
      // an absent source means through the slice manifest.
      if (nodeId !== null) sourceNodeIds.push(nodeId);
    }
    return this.enumeratePaths(sourceNodeIds, request);
  }

  async readNodes(request: ReadNodesRequest): Promise<Result<GraphNodeRecord[], Failure>> {
    const records: GraphNodeRecord[] = [];
    for (const nodeId of request.nodeIds) {
      const stored = this.nodesById.get(nodeId);
      if (stored === undefined || stored.label !== request.label) continue;
      records.push({ id: stored.id, label: stored.label, properties: stored.properties });
    }
    return succeed(records);
  }

  async resolveNodeIds(
    request: ResolveNodeIdsRequest,
  ): Promise<Result<Map<string, number>, Failure>> {
    const resolved = new Map<string, number>();
    for (const key of request.keys) {
      const nodeId = this.findNodeIdByKey(request.label, key);
      if (nodeId !== null) resolved.set(key, nodeId);
    }
    return succeed(resolved);
  }

  async listNodeIds(request: ListNodeIdsRequest): Promise<Result<number[], Failure>> {
    if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
      return fail("invalid_input", `[MemoryGraph.listNodeIds] limit ${request.limit} must be positive`);
    }
    const nodeIds: number[] = [];
    for (const node of this.nodesById.values()) {
      if (node.label !== request.label) continue;
      nodeIds.push(node.id);
      if (nodeIds.length >= request.limit) break;
    }
    return succeed(nodeIds);
  }

  async neighbors(request: NeighborRequest): Promise<Result<NeighborEdge[], Failure>> {
    const origin = this.nodesById.get(request.nodeId);
    if (origin === undefined || origin.label !== request.nodeLabel) return succeed([]);

    const edges: NeighborEdge[] = [];

    for (const edge of this.edgesFrom(request.nodeId, request.direction)) {
      if (edge.relType !== request.relType) continue;

      const window = request.propertyWindow;
      if (window !== undefined) {
        const value = edge.properties[window.property];
        if (typeof value !== "number") continue;
        if (value < window.fromInclusive || value >= window.toExclusive) continue;
      }

      edges.push({
        relType: edge.relType,
        otherNodeId: edge.fromNodeId === request.nodeId ? edge.toNodeId : edge.fromNodeId,
        properties: edge.properties,
      });

      if (edges.length >= request.limit) break;
    }

    return succeed(edges);
  }

  async countNodes(label: NodeLabel): Promise<Result<number, Failure>> {
    let count = 0;
    for (const node of this.nodesById.values()) if (node.label === label) count += 1;
    return succeed(count);
  }

  describe(): string {
    return `memory ${this.nodesById.size} nodes ${this.edgesById.size} edges`;
  }

  async close(): Promise<void> {
    // Nothing to release: the graph lives in this process.
  }

  /** Exposed for the snapshot exporter and for assertions in fixtures. */
  listNodes(): StoredNode[] {
    return [...this.nodesById.values()];
  }

  listEdges(): StoredEdge[] {
    return [...this.edgesById.values()];
  }

  /**
   * Breadth-first simple-path enumeration.
   *
   * Simple-path semantics, meaning a node never repeats inside one path, is what
   * keeps dependency cycles from producing infinite walks. Breadth-first ordering
   * means shorter paths are emitted first, so a pathCount cut keeps the most direct
   * routes rather than an arbitrary subset.
   */
  private enumeratePaths(
    sourceNodeIds: readonly number[],
    request: Omit<PathRequest, "sourceNodeId">,
  ): Result<GraphPath[], Failure> {
    if (request.maxLength < 1) {
      return fail("invalid_input", "[MemoryGraph.enumeratePaths] maxLength must be at least 1");
    }
    if (request.pathCount < 1) {
      return fail("invalid_input", "[MemoryGraph.enumeratePaths] pathCount must be at least 1");
    }

    const allowedRelTypes = new Set<string>(request.relTypes);
    const found: GraphPath[] = [];
    let expansions = 0;

    let frontier: PartialPath[] = [];
    for (const sourceNodeId of sourceNodeIds) {
      const stored = this.nodesById.get(sourceNodeId);
      if (stored === undefined) continue;
      frontier.push({
        nodes: [toPathNode(stored)],
        relationships: [],
        visited: new Set<number>([sourceNodeId]),
      });
    }

    for (let hop = 0; hop < request.maxLength && frontier.length > 0; hop += 1) {
      const nextFrontier: PartialPath[] = [];

      for (const partial of frontier) {
        const tailNode = partial.nodes[partial.nodes.length - 1];
        if (tailNode === undefined) continue;

        for (const edge of this.edgesFrom(tailNode.id, request.direction)) {
          expansions += 1;
          if (expansions > MemoryGraph.MAX_EDGE_EXPANSIONS) {
            return fail(
              "query_budget_exceeded",
              "[MemoryGraph.enumeratePaths] exceeded the 1,000,000 edge expansion budget",
            );
          }

          if (!allowedRelTypes.has(edge.relType)) continue;

          const nextNodeId = edge.fromNodeId === tailNode.id ? edge.toNodeId : edge.fromNodeId;
          if (partial.visited.has(nextNodeId)) continue;

          const nextStored = this.nodesById.get(nextNodeId);
          if (nextStored === undefined) continue;

          const extended: PartialPath = {
            nodes: [...partial.nodes, toPathNode(nextStored)],
            relationships: [...partial.relationships, toPathEdge(edge)],
            visited: new Set(partial.visited).add(nextNodeId),
          };

          if (request.targetLabel === undefined || nextStored.label === request.targetLabel) {
            found.push({
              nodes: extended.nodes,
              relationships: extended.relationships,
              hopCount: extended.relationships.length,
            });
            if (found.length >= request.pathCount) return succeed(found);
          }

          nextFrontier.push(extended);
        }
      }

      frontier = nextFrontier;
    }

    return succeed(found);
  }

  private *edgesFrom(
    nodeId: number,
    direction: "incoming" | "outgoing" | "both",
  ): Generator<StoredEdge> {
    if (direction === "outgoing" || direction === "both") {
      for (const edgeId of this.outgoingByNodeId.get(nodeId) ?? []) {
        const edge = this.edgesById.get(edgeId);
        if (edge !== undefined) yield edge;
      }
    }
    if (direction === "incoming" || direction === "both") {
      for (const edgeId of this.incomingByNodeId.get(nodeId) ?? []) {
        const edge = this.edgesById.get(edgeId);
        if (edge !== undefined) yield edge;
      }
    }
  }
}

export type StoredNode = {
  id: number;
  label: NodeLabel;
  properties: GraphProperties;
};

export type StoredEdge = {
  id: number;
  relType: RelType;
  fromNodeId: number;
  toNodeId: number;
  properties: GraphProperties;
};

type PartialPath = {
  nodes: GraphPathNode[];
  relationships: GraphPathEdge[];
  visited: Set<number>;
};

function toPathNode(stored: StoredNode): GraphPathNode {
  return { id: stored.id, labels: [stored.label], properties: stored.properties };
}

function toPathEdge(edge: StoredEdge): GraphPathEdge {
  return {
    id: edge.id,
    relType: edge.relType,
    sourceNodeId: edge.fromNodeId,
    targetNodeId: edge.toNodeId,
    properties: edge.properties,
  };
}

function pushInto(index: Map<number, number[]>, key: number, value: number): void {
  const existing = index.get(key);
  if (existing === undefined) index.set(key, [value]);
  else existing.push(value);
}
