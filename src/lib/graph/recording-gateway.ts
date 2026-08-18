import type {
  GraphGateway,
  GraphNodeRecord,
  GraphPath,
  ListNodeIdsRequest,
  MultiSourcePathRequest,
  NeighborEdge,
  NeighborRequest,
  PathRequest,
  ReadNodesRequest,
  ResolveNodeIdsRequest,
} from "@/lib/graph/gateway";
import type { NodeLabel, RelType } from "@/lib/graph/model";
import { isRecording, recordOperation } from "@/lib/graph/statements";
import type { Failure, Result } from "@/lib/result";

/**
 * A gateway that writes down what it was asked, then delegates.
 *
 * This is the engine-agnostic half of the operation record. It wraps whichever gateway
 * answered, so the account of what the graph did is the same shape whether HydraDB or the
 * in-process graph produced it: which semantic operation ran, over which relationship types,
 * in which direction, how long it took, and how much came back.
 *
 * It deliberately records the SEMANTIC operation rather than a query. The Cypher text, where
 * there is any, is recorded one layer lower by the recording transport, which sees the real
 * statement instead of reconstructing it. Wrapping both means a live answer carries the
 * statements and an in-process answer carries the operations, and neither pretends to be the
 * other. sourceRef: src/lib/hydra/recording-transport.ts.
 *
 * Outside an open scope this class costs one function call and one `getStore()` per operation,
 * which is why the ingest and the test suites can use it without opting out.
 */
export class RecordingGateway implements GraphGateway {
  constructor(private readonly inner: GraphGateway) {}

  pathsFromSource(request: PathRequest): Promise<Result<GraphPath[], Failure>> {
    return this.observe(
      "pathsFromSource",
      () =>
        `node ${request.sourceNodeId} over ${request.relTypes.join(", ")}, ${request.direction}, up to ${request.maxLength} hops${describeTarget(request.targetLabel)}`,
      () => this.inner.pathsFromSource(request),
      (paths) => paths.length,
    );
  }

  pathsFromSources(request: MultiSourcePathRequest): Promise<Result<GraphPath[], Failure>> {
    return this.observe(
      "pathsFromSources",
      () =>
        `${request.sourceKeys.length} ${request.sourceLabel} keys over ${request.relTypes.join(", ")}, ${request.direction}, up to ${request.maxLength} hops${describeTarget(request.targetLabel)}`,
      () => this.inner.pathsFromSources(request),
      (paths) => paths.length,
    );
  }

  readNodes(request: ReadNodesRequest): Promise<Result<GraphNodeRecord[], Failure>> {
    return this.observe(
      "readNodes",
      () => `${request.nodeIds.length} ${request.label} ids`,
      () => this.inner.readNodes(request),
      (records) => records.length,
    );
  }

  resolveNodeIds(request: ResolveNodeIdsRequest): Promise<Result<Map<string, number>, Failure>> {
    return this.observe(
      "resolveNodeIds",
      () => `${request.keys.length} ${request.label} keys`,
      () => this.inner.resolveNodeIds(request),
      (resolved) => resolved.size,
    );
  }

  listNodeIds(request: ListNodeIdsRequest): Promise<Result<number[], Failure>> {
    return this.observe(
      "listNodeIds",
      () => `every ${request.label}, capped at ${request.limit}`,
      () => this.inner.listNodeIds(request),
      (nodeIds) => nodeIds.length,
    );
  }

  neighbors(request: NeighborRequest): Promise<Result<NeighborEdge[], Failure>> {
    return this.observe(
      "neighbors",
      () =>
        `${request.nodeLabel} ${request.nodeId} over ${request.relType}, ${request.direction}${describeWindow(request)}, capped at ${request.limit}`,
      () => this.inner.neighbors(request),
      (edges) => edges.length,
    );
  }

  countNodes(label: NodeLabel): Promise<Result<number, Failure>> {
    return this.observe(
      "countNodes",
      () => `${label} nodes`,
      () => this.inner.countNodes(label),
      // One aggregate row. The count itself is the answer, not the size of the result.
      () => 1,
    );
  }

  countEdges(relType: RelType): Promise<Result<number, Failure>> {
    return this.observe(
      "countEdges",
      () => `${relType} relationships`,
      () => this.inner.countEdges(relType),
      () => 1,
    );
  }

  describe(): string {
    return this.inner.describe();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  /**
   * Times one delegated call and records it.
   *
   * `detail` is a thunk so the string is not built when no scope is open, and the duration is
   * measured around the inner call only, so the cost of building the detail never lands in the
   * number. A failed call is recorded with its reason and a negative one count, because "it
   * returned nothing" and "it did not return" are different facts about the graph.
   */
  private async observe<TValue>(
    operation: string,
    detail: () => string,
    run: () => Promise<Result<TValue, Failure>>,
    countOf: (value: TValue) => number,
  ): Promise<Result<TValue, Failure>> {
    if (!isRecording()) return run();

    const startedAt = performance.now();
    const result = await run();
    const durationMs = performance.now() - startedAt;

    recordOperation({
      operation,
      detail: detail(),
      statement: null,
      durationMs,
      resultCount: result.ok ? countOf(result.value) : -1,
      failureReason: result.ok ? null : result.failure.reason,
    });

    return result;
  }
}

function describeTarget(targetLabel: NodeLabel | undefined): string {
  return targetLabel === undefined ? "" : `, ending at a ${targetLabel}`;
}

function describeWindow(request: NeighborRequest): string {
  const window = request.propertyWindow;
  if (window === undefined) return "";
  return `, ${window.property} in [${window.fromInclusive}, ${window.toExclusive})`;
}
