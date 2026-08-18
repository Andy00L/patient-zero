import {
  type GraphGateway,
  type GraphNodeRecord,
  type GraphPath,
  type GraphPathEdge,
  type GraphPathNode,
  type GraphProperties,
  type GraphPropertyValue,
  type ListNodeIdsRequest,
  type MultiSourcePathRequest,
  type NeighborEdge,
  type NeighborRequest,
  type PathRequest,
  type ReadNodesRequest,
  type ResolveNodeIdsRequest,
} from "@/lib/graph/gateway";
import {
  NODE_PROPERTY_NAMES,
  REL_PROPERTY_NAMES,
  SELECTOR_PROPERTY,
  type NodeLabel,
  type RelType,
} from "@/lib/graph/model";
import {
  buildCountStatement,
  buildEdgeCountStatement,
  buildIdListStatement,
  buildMultiSourcePathStatement,
  buildNeighborStatement,
  buildReadNodesStatement,
  buildResolveKeysStatement,
  buildSingleSourcePathStatement,
  packStatements,
} from "@/lib/hydra/cypher";
import { MAX_QUERY_RESULT_VERTICES } from "@/lib/hydra/config";
import type { GraphTransport } from "@/lib/hydra/transport";
import { type DecodedPath, type DecodedValue, asDecodedPath } from "@/lib/hydra/wire";
import { type Failure, type Result, fail, succeed } from "@/lib/result";

/**
 * The HydraDB-backed gateway.
 *
 * Everything engine-specific ends here. Above it, the analysis layer sees only the
 * GraphGateway contract and cannot tell HydraDB from the in-memory fixture graph.
 *
 * Three engine behaviours shape this class:
 *
 *   1. Path procedures DO take a direction: relDirection accepts "incoming",
 *      "outgoing", or "both". The ingest still materialises DEPENDED_ON_BY next to
 *      RESOLVES_TO, but as an index shape rather than a workaround, and every request
 *      states its direction explicitly rather than leaning on the default.
 *      sourceRef: docs/HYDRADB.md section 4.
 *
 *   2. algo.SSpaths and algo.MSpaths reject every target selector, so a targetLabel
 *      is applied client side. That costs nothing, because the engine hydrates each
 *      path node's complete label set on the way out.
 *
 *   3. Selector values and id lists become query TEXT, and the engine accepts at most
 *      1,024 bytes of it. Neither read is therefore issued as one statement: both are
 *      packed into as many statements as their text needs, by packStatements, and the
 *      results are merged. The chunk size is measured off the built text rather than
 *      chosen, because the same item count produces very different text lengths across
 *      the five labels. sourceRef: src/lib/hydra/config.ts MAX_QUERY_TEXT_BYTES.
 *
 *      The byte budget also settles the two budgets that used to bound these chunks. A
 *      statement under 1,024 bytes cannot name enough selector values to approach the
 *      250,000 candidate ceiling, and cannot carry a request body near 1 MiB unless its
 *      parameters do, which only the batch writers' `$rows` does.
 */
export class HydraGateway implements GraphGateway {
  constructor(private readonly transport: GraphTransport) {}

  async pathsFromSource(request: PathRequest): Promise<Result<GraphPath[], Failure>> {
    const built = buildSingleSourcePathStatement({
      sourceNodeId: request.sourceNodeId,
      relTypes: request.relTypes,
      direction: request.direction,
      maxLength: request.maxLength,
      pathCount: request.pathCount,
    });
    if (!built.ok) return built;

    const rows = await this.transport.run(built.value);
    if (!rows.ok) return rows;

    return decodePathRows(rows.value, request.targetLabel);
  }

  async pathsFromSources(request: MultiSourcePathRequest): Promise<Result<GraphPath[], Failure>> {
    if (request.sourceKeys.length === 0) return succeed([]);

    // Each statement gets the full path budget rather than a share of it: the caller's
    // pathCount is a per-request cap, and splitting it across statements would make the
    // answer depend on how the keys happened to be grouped.
    const packed = packStatements("HydraGateway.pathsFromSources", request.sourceKeys, (chunk) =>
      buildMultiSourcePathStatement({
        sourceLabel: request.sourceLabel,
        sourceProperty: SELECTOR_PROPERTY,
        sourceValues: chunk,
        relTypes: request.relTypes,
        direction: request.direction,
        maxLength: request.maxLength,
        pathCount: request.pathCount,
      }),
    );
    if (!packed.ok) return packed;

    const paths: GraphPath[] = [];

    for (const statement of packed.value) {
      const rows = await this.transport.run(statement);
      if (!rows.ok) return rows;

      const decoded = decodePathRows(rows.value, request.targetLabel);
      if (!decoded.ok) return decoded;

      paths.push(...decoded.value);

      if (paths.length >= MAX_QUERY_RESULT_VERTICES) {
        return fail(
          "query_budget_exceeded",
          `[HydraGateway.pathsFromSources] accumulated ${paths.length} paths across selector chunks, at the engine result ceiling`,
          { context: { sourceKeyCount: request.sourceKeys.length } },
        );
      }
    }

    return succeed(paths);
  }

  async readNodes(request: ReadNodesRequest): Promise<Result<GraphNodeRecord[], Failure>> {
    if (request.nodeIds.length === 0) return succeed([]);

    const propertyNames = NODE_PROPERTY_NAMES[request.label];
    const packed = packStatements("HydraGateway.readNodes", request.nodeIds, (chunk) =>
      buildReadNodesStatement(request.label, propertyNames, chunk),
    );
    if (!packed.ok) return packed;

    const records: GraphNodeRecord[] = [];

    for (const statement of packed.value) {
      const rows = await this.transport.run(statement);
      if (!rows.ok) return rows;

      for (const row of rows.value) {
        const id = row.id;
        if (typeof id !== "number") {
          return fail("graph_rejected", "[HydraGateway.readNodes] a row has no numeric id");
        }
        records.push({
          id,
          label: request.label,
          properties: toGraphProperties(row, ["id"]),
        });
      }
    }

    return succeed(records);
  }

  /**
   * Resolves natural keys to node ids.
   *
   * One key per request, deliberately. The engine picks a node pattern's candidates
   * from the pattern alone, so `MATCH (n:Version {key: $key})` is answered from the
   * automatic per-property vertex index, while an OR chain over several keys degrades
   * to a full label scan. A handful of index seeks beats one scan of every Version in
   * the slice, and the analysis layer only ever resolves a small set of subjects.
   * sourceRef: docs/HYDRADB.md section 2.3.
   */
  async resolveNodeIds(
    request: ResolveNodeIdsRequest,
  ): Promise<Result<Map<string, number>, Failure>> {
    const resolved = new Map<string, number>();

    for (const key of request.keys) {
      if (resolved.has(key)) continue;

      const built = buildResolveKeysStatement(request.label, [key]);
      if (!built.ok) return built;

      const rows = await this.transport.run(built.value);
      if (!rows.ok) return rows;

      const row = rows.value[0];
      if (row === undefined) continue;

      const id = row.id;
      if (typeof id !== "number") {
        return fail(
          "graph_rejected",
          `[HydraGateway.resolveNodeIds] the row for a ${request.label} key has no numeric id`,
        );
      }
      resolved.set(key, id);
    }

    return succeed(resolved);
  }

  async listNodeIds(request: ListNodeIdsRequest): Promise<Result<number[], Failure>> {
    const built = buildIdListStatement(request.label, request.limit);
    if (!built.ok) return built;

    const rows = await this.transport.run(built.value);
    if (!rows.ok) return rows;

    const nodeIds: number[] = [];
    for (const row of rows.value) {
      const id = row.id;
      if (typeof id !== "number") {
        return fail("graph_rejected", "[HydraGateway.listNodeIds] a row has no numeric id");
      }
      nodeIds.push(id);
    }

    return succeed(nodeIds);
  }

  async neighbors(request: NeighborRequest): Promise<Result<NeighborEdge[], Failure>> {
    const built = buildNeighborStatement({
      nodeId: request.nodeId,
      fromLabel: request.nodeLabel,
      relType: request.relType,
      direction: request.direction,
      propertyNames: REL_PROPERTY_NAMES[request.relType],
      ...(request.propertyWindow === undefined
        ? {}
        : { propertyWindow: request.propertyWindow }),
      limit: request.limit,
    });
    if (!built.ok) return built;

    const rows = await this.transport.run(built.value);
    if (!rows.ok) return rows;

    const edges: NeighborEdge[] = [];
    for (const row of rows.value) {
      const otherNodeId = row.other_id;
      if (typeof otherNodeId !== "number") {
        return fail("graph_rejected", "[HydraGateway.neighbors] a row has no numeric other_id");
      }
      edges.push({
        relType: request.relType,
        otherNodeId,
        properties: toGraphProperties(row, ["other_id"]),
      });
    }

    return succeed(edges);
  }

  /**
   * Counts nodes with a label.
   *
   * Tries the aggregate first and falls back to counting returned ids, because the
   * Cypher subset documents no aggregate support beyond what the parser happens to
   * accept. A degraded count still answers the health check; a hard failure would
   * make the app look unreachable when it is merely terse.
   */
  async countNodes(label: NodeLabel): Promise<Result<number, Failure>> {
    const aggregate = buildCountStatement(label);
    if (!aggregate.ok) return aggregate;

    const aggregateRows = await this.transport.run(aggregate.value);
    if (aggregateRows.ok) {
      const total = aggregateRows.value[0]?.total;
      if (typeof total === "number") return succeed(total);
    }

    const idList = buildIdListStatement(label, MAX_QUERY_RESULT_VERTICES);
    if (!idList.ok) return idList;

    const idRows = await this.transport.run(idList.value);
    if (!idRows.ok) return idRows;

    return succeed(idRows.value.length);
  }

  /**
   * Counts relationships of one type.
   *
   * No fallback, unlike `countNodes`: an edge id cannot be projected in this subset, so
   * there is no id list to count client side and a rejected aggregate is the answer. The
   * caller gets the transport's own failure, which names whether the engine refused the
   * statement or never answered.
   */
  async countEdges(relType: RelType): Promise<Result<number, Failure>> {
    const aggregate = buildEdgeCountStatement(relType);
    if (!aggregate.ok) return aggregate;

    const rows = await this.transport.run(aggregate.value);
    if (!rows.ok) return rows;

    const total = rows.value[0]?.total;
    if (typeof total !== "number") {
      return fail(
        "graph_rejected",
        `[HydraGateway.countEdges] the ${relType} count returned no numeric total`,
        { context: { relType, rowCount: rows.value.length } },
      );
    }
    return succeed(total);
  }

  describe(): string {
    return this.transport.describe();
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}

function decodePathRows(
  rows: readonly Record<string, DecodedValue>[],
  targetLabel: NodeLabel | undefined,
): Result<GraphPath[], Failure> {
  const paths: GraphPath[] = [];

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (row === undefined) continue;

    const decodedPath = asDecodedPath(row.path ?? null);
    if (decodedPath === null) {
      return fail(
        "graph_rejected",
        `[decodePathRows] row ${rowIndex} has no path column, columns were ${Object.keys(row).join(", ")}`,
      );
    }

    const path = toGraphPath(decodedPath);
    if (path.nodes.length === 0) continue;

    if (targetLabel !== undefined) {
      const target = path.nodes[path.nodes.length - 1];
      if (target === undefined || !target.labels.includes(targetLabel)) continue;
    }

    paths.push(path);
  }

  return succeed(paths);
}

function toGraphPath(decoded: DecodedPath): GraphPath {
  const nodes: GraphPathNode[] = decoded.nodes.map((node) => ({
    id: node.id,
    labels: node.labels,
    properties: toGraphProperties(node.properties, []),
  }));

  const relationships: GraphPathEdge[] = decoded.relationships.map((relationship) => ({
    id: relationship.id,
    relType: relationship.relType,
    sourceNodeId: relationship.sourceNodeId,
    targetNodeId: relationship.targetNodeId,
    properties: toGraphProperties(relationship.properties, []),
  }));

  return { nodes, relationships, hopCount: relationships.length };
}

/**
 * Narrows decoded values to the scalar property set. A non-scalar property cannot be
 * stored by HydraDB, so one appearing here would be a protocol surprise rather than
 * data, and dropping it is safer than widening the property type for every consumer.
 */
function toGraphProperties(
  source: Record<string, DecodedValue>,
  skipNames: readonly string[],
): GraphProperties {
  const properties: GraphProperties = {};
  for (const [name, value] of Object.entries(source)) {
    if (skipNames.includes(name)) continue;
    const scalar = asScalar(value);
    if (scalar !== null) properties[name] = scalar;
  }
  return properties;
}

function asScalar(value: DecodedValue): GraphPropertyValue | null {
  const kind = typeof value;
  return kind === "string" || kind === "number" || kind === "boolean"
    ? (value as GraphPropertyValue)
    : null;
}
