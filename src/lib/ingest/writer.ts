import { Buffer } from "node:buffer";

import { MemoryGraph } from "@/lib/graph/memory-gateway";
import type { GraphProperties } from "@/lib/graph/gateway";
import {
  type AdvisoryNode,
  type AffectsProps,
  type DependsOnProps,
  type MaintainerNode,
  NODE_PROPERTY_NAMES,
  type NodeLabel,
  type PackageNode,
  REL_ENDPOINTS,
  REL_PROPERTY_NAMES,
  type RelType,
  type ResolvedProps,
  type ServiceNode,
  type TyposquatProps,
  type VersionNode,
  advisoryKey,
  maintainerKey,
  packageKey,
  serviceKey,
  versionKey,
} from "@/lib/graph/model";
import { HTTP_BATCH_BUDGET_BYTES } from "@/lib/hydra/config";
import {
  BATCH_COLUMNS,
  type EdgeBatchSpec,
  type NodeBatchRow,
  type NodeBatchSpec,
  buildEdgeBatchStatement,
  buildNodeBatchStatement,
} from "@/lib/hydra/cypher";
import type { IdMap, IdMapPaths } from "@/lib/hydra/id-map";
import type { GraphTransport, StatementParameterValue } from "@/lib/hydra/transport";
import { type Failure, type Result, fail, succeed } from "@/lib/result";

/**
 * The batch writer: the only code in this project that writes to the graph.
 *
 * Four engine rules decide its shape, all recorded in docs/HYDRADB.md section 3:
 *
 *   1. A node batch carries exactly one label, and the label is required. So rows are
 *      grouped by label, never mixed.
 *   2. Every SET value must read a field off the row, and every field the statement
 *      names must be present in every row holding a scalar. So rows are projected from
 *      the property registry in model.ts and an incomplete row fails before it is sent.
 *   3. An edge's endpoints must already exist and already carry the stated label. So
 *      every pending node batch is written before any edge batch, and an edge whose
 *      endpoint was never staged fails locally instead of costing a round trip.
 *   4. The HTTP body cap is 1 MiB, and every traversal and row budget arrives as a 429
 *      rather than a 400. So batches are split by measured byte size, and a batch the
 *      engine still refuses is halved and retried rather than abandoned.
 *
 * Writes go through a GraphSink rather than straight to a transport, because the
 * project has to be able to build a full graph with no server running: Docker is not
 * available on every machine this was developed on, and a seed run that only works
 * against a live engine is a seed run nobody can reproduce.
 */

/** Where a batch of rows ends up. */
export type GraphSink = {
  writeNodeBatch(spec: NodeBatchSpec, rows: readonly NodeBatchRow[]): Promise<Result<void, Failure>>;
  writeEdgeBatch(spec: EdgeBatchSpec, rows: readonly NodeBatchRow[]): Promise<Result<void, Failure>>;
  /** Log-safe description of the destination. Never holds a secret. */
  describe(): string;
};

/** A node identified the way the graph identifies it: by label plus natural key. */
export type NodeRef = {
  label: NodeLabel;
  key: string;
};

export function packageRef(ecosystem: PackageNode["ecosystem"], name: string): NodeRef {
  return { label: "Package", key: packageKey(ecosystem, name) };
}

export function versionRef(
  ecosystem: VersionNode["ecosystem"],
  name: string,
  version: string,
): NodeRef {
  return { label: "Version", key: versionKey(ecosystem, name, version) };
}

export function maintainerRef(ecosystem: MaintainerNode["ecosystem"], username: string): NodeRef {
  return { label: "Maintainer", key: maintainerKey(ecosystem, username) };
}

export function serviceRef(name: string): NodeRef {
  return { label: "Service", key: serviceKey(name) };
}

export function advisoryRef(ghsaId: string): NodeRef {
  return { label: "Advisory", key: advisoryKey(ghsaId) };
}

/**
 * Staged node shapes.
 *
 * `id` is absent because the id-map assigns it, and `key` is absent because the writer
 * derives it from the other fields. Deriving rather than accepting it removes the one
 * mistake that would be invisible at write time and wrong at query time: a node whose
 * `key` property disagrees with its own name and version, which the selector would
 * then fail to find while the node sits in the graph looking correct.
 *
 * Service is the exception, and the note on `StagedService` says why: its key is composed
 * of nothing, so there is nothing to derive it from.
 */
export type StagedPackage = Omit<PackageNode, "id" | "key">;
export type StagedVersion = Omit<VersionNode, "id" | "key">;
export type StagedMaintainer = Omit<MaintainerNode, "id" | "key">;
/**
 * Service is the one label whose key is stated rather than composed: `serviceKey` is the
 * identity function, so there is no ecosystem and version to derive a key from. When the
 * source states a key, pass it and the readable `name` is free to differ, which is the
 * whole point of the two properties: the key "svc:ledger-api" is what a selector matches
 * and "Ledger API" is what a rail renders. Omitting it keeps the older behaviour, where
 * the name doubles as the key. sourceRef: src/lib/graph/model.ts serviceKey.
 */
export type StagedService = Omit<ServiceNode, "id" | "key"> & { key?: string };
export type StagedAdvisory = Omit<AdvisoryNode, "id" | "key">;

/**
 * Relationship property shapes, keyed by type, so `stageEdge` can demand exactly the
 * properties its relationship type declares in REL_PROPERTY_NAMES. A type with no
 * properties takes `{}` and rejects anything else.
 */
export type RelPropertiesByType = {
  VERSION_OF: EmptyProperties;
  DEPENDS_ON: DependsOnProps;
  RESOLVES_TO: EmptyProperties;
  DEPENDED_ON_BY: EmptyProperties;
  MAINTAINS: EmptyProperties;
  RESOLVED: ResolvedProps;
  AFFECTS: AffectsProps;
  AFFECTS_VERSION: EmptyProperties;
  TYPOSQUAT_OF: TyposquatProps;
};

export type EmptyProperties = Record<string, never>;

export type WriteStats = {
  nodesWritten: number;
  edgesWritten: number;
  nodeBatches: number;
  edgeBatches: number;
  /** Edges staged more than once with identical endpoints and properties. */
  duplicateEdgesSkipped: number;
  /** How often a batch the engine refused had to be halved and retried. */
  batchSplits: number;
  /** Degradations worth disclosing in the ingest report. Never a silent condition. */
  notes: string[];
};

export type GraphWriterOptions = {
  /**
   * Byte ceiling for one batch's rows. Defaults to the HTTP budget, which is 90
   * percent of the engine's 1 MiB body cap. A Bolt sink has no body cap and can be
   * given a larger value.
   */
  batchBudgetBytes?: number;
  /** When set, the id-map is persisted on every flush so an interrupted ingest resumes. */
  idMapPaths?: IdMapPaths;
  /** Upper bound on remembered edge identities, see MAX_TRACKED_EDGE_KEYS. */
  maxTrackedEdgeKeys?: number;
};

/**
 * Remembered edge identities, for duplicate suppression.
 *
 * Node writes are a MERGE on the id and so are idempotent, but edge writes are a
 * CREATE: staging the same edge twice would put two indistinguishable relationships
 * in the graph and double every path that crosses it, which inflates a blast radius
 * without changing any count that would look wrong.
 *
 * The identity includes the properties, because a service legitimately resolves the
 * same version at two different times and those two RESOLVED edges are exactly what
 * the bitemporal query reads.
 *
 * Bounded at half a million entries, roughly 50 MB of keys. Past that the writer stops
 * tracking and records a note rather than growing without limit or failing a working
 * ingest.
 */
const MAX_TRACKED_EDGE_KEYS = 500_000;

/** How many times a batch the engine refused may be halved before giving up. */
const MAX_BATCH_SPLIT_DEPTH = 6;

/** Allowance per row for the comma the JSON array serialiser puts between rows. */
const ROW_SEPARATOR_BYTES = 1;

export class GraphWriter {
  private readonly pendingNodeBatches = new Map<NodeLabel, PendingBatch>();
  private readonly pendingEdgeBatches = new Map<RelType, PendingBatch>();
  private readonly writtenEdgeKeys = new Set<string>();
  private readonly batchBudgetBytes: number;
  private readonly maxTrackedEdgeKeys: number;
  private readonly idMapPaths: IdMapPaths | null;
  private trackingEdgeKeys = true;

  private readonly counters: WriteStats = {
    nodesWritten: 0,
    edgesWritten: 0,
    nodeBatches: 0,
    edgeBatches: 0,
    duplicateEdgesSkipped: 0,
    batchSplits: 0,
    notes: [],
  };

  constructor(
    private readonly sink: GraphSink,
    private readonly idMap: IdMap,
    options: GraphWriterOptions = {},
  ) {
    this.batchBudgetBytes = options.batchBudgetBytes ?? HTTP_BATCH_BUDGET_BYTES;
    this.maxTrackedEdgeKeys = options.maxTrackedEdgeKeys ?? MAX_TRACKED_EDGE_KEYS;
    this.idMapPaths = options.idMapPaths ?? null;
  }

  /** A snapshot of what has been written so far. */
  get stats(): WriteStats {
    return { ...this.counters, notes: [...this.counters.notes] };
  }

  describe(): string {
    return this.sink.describe();
  }

  async stagePackage(node: StagedPackage): Promise<Result<number, Failure>> {
    return await this.stageNode("Package", packageKey(node.ecosystem, node.name), {
      ecosystem: node.ecosystem,
      name: node.name,
      weekly_downloads: node.weekly_downloads,
    });
  }

  async stageVersion(node: StagedVersion): Promise<Result<number, Failure>> {
    return await this.stageNode("Version", versionKey(node.ecosystem, node.name, node.version), {
      ecosystem: node.ecosystem,
      name: node.name,
      version: node.version,
      published_at_ms: node.published_at_ms,
      has_install_script: node.has_install_script,
    });
  }

  async stageMaintainer(node: StagedMaintainer): Promise<Result<number, Failure>> {
    return await this.stageNode("Maintainer", maintainerKey(node.ecosystem, node.username), {
      ecosystem: node.ecosystem,
      username: node.username,
    });
  }

  async stageService(node: StagedService): Promise<Result<number, Failure>> {
    return await this.stageNode("Service", serviceKey(node.key ?? node.name), {
      name: node.name,
      source: node.source,
    });
  }

  async stageAdvisory(node: StagedAdvisory): Promise<Result<number, Failure>> {
    return await this.stageNode("Advisory", advisoryKey(node.ghsa_id), {
      ghsa_id: node.ghsa_id,
      published_at_ms: node.published_at_ms,
      modified_at_ms: node.modified_at_ms,
      summary: node.summary,
    });
  }

  /**
   * Stages one relationship.
   *
   * Both endpoints must already have been staged, because the engine verifies that
   * they exist and carry the stated label. Resolving them here turns an engine round
   * trip into a local failure that names the missing key.
   */
  async stageEdge<TRelType extends RelType>(
    relType: TRelType,
    from: NodeRef,
    to: NodeRef,
    properties: RelPropertiesByType[TRelType],
  ): Promise<Result<void, Failure>> {
    const endpoints = REL_ENDPOINTS[relType];
    if (from.label !== endpoints.from || to.label !== endpoints.to) {
      return fail(
        "invalid_input",
        `[GraphWriter.stageEdge] ${relType} connects ${endpoints.from} to ${endpoints.to}, ` +
          `not ${from.label} to ${to.label}`,
      );
    }

    const sourceNodeId = this.idMap.resolve(from.label, from.key);
    if (sourceNodeId === null) {
      return fail(
        "invalid_input",
        `[GraphWriter.stageEdge] ${relType} source ${from.label} "${from.key}" was never staged`,
      );
    }

    const destinationNodeId = this.idMap.resolve(to.label, to.key);
    if (destinationNodeId === null) {
      return fail(
        "invalid_input",
        `[GraphWriter.stageEdge] ${relType} target ${to.label} "${to.key}" was never staged`,
      );
    }

    const propertyNames = REL_PROPERTY_NAMES[relType];
    const projected = projectProperties(propertyNames, properties, `${relType} relationship`);
    if (!projected.ok) return projected;

    const identity = describeEdgeIdentity(relType, sourceNodeId, destinationNodeId, projected.value);
    if (this.trackingEdgeKeys) {
      if (this.writtenEdgeKeys.has(identity)) {
        this.counters.duplicateEdgesSkipped += 1;
        return succeed(undefined);
      }
      this.writtenEdgeKeys.add(identity);
      if (this.writtenEdgeKeys.size >= this.maxTrackedEdgeKeys) {
        this.trackingEdgeKeys = false;
        this.addNote(
          `duplicate edge suppression stopped after ${this.maxTrackedEdgeKeys} tracked edges, later duplicates are written as separate relationships`,
        );
      }
    }

    const row: Record<string, StatementParameterValue> = {
      [BATCH_COLUMNS.sourceVertex]: sourceNodeId,
      [BATCH_COLUMNS.destinationVertex]: destinationNodeId,
      [BATCH_COLUMNS.relationshipVertex]: this.idMap.assignRelationshipId(),
      ...projected.value,
    };

    return await this.appendEdgeRow(relType, row);
  }

  /**
   * Writes everything staged and persists the id map.
   *
   * Node batches go first, unconditionally, because an edge whose endpoint node has
   * not reached the engine yet fails the whole edge batch with a 400.
   */
  async flush(): Promise<Result<WriteStats, Failure>> {
    const nodesFlushed = await this.flushPendingNodes();
    if (!nodesFlushed.ok) return nodesFlushed;

    const edgesFlushed = await this.flushPendingEdges();
    if (!edgesFlushed.ok) return edgesFlushed;

    if (this.idMapPaths !== null) {
      const persisted = await this.idMap.flush(this.idMapPaths);
      if (!persisted.ok) return persisted;
    }

    return succeed(this.stats);
  }

  private async stageNode(
    label: NodeLabel,
    key: string,
    properties: GraphProperties,
  ): Promise<Result<number, Failure>> {
    // Validation runs before the id is assigned, and the order is the whole point. An
    // id handed out for a row that then fails validation stays resolvable forever, so a
    // later edge naming that key builds cleanly here and only fails when the batch
    // reaches the engine, pointing at the edge instead of at the node that was never
    // staged. Validating first keeps the id map holding exactly the nodes that were
    // accepted, which is what lets a bad endpoint fail locally with the real reason.
    const propertyNames = NODE_PROPERTY_NAMES[label];
    const projected = projectProperties(propertyNames, { key, ...properties }, `${label} node`);
    if (!projected.ok) return projected;

    const nodeId = this.idMap.assign(label, key);

    const row: Record<string, StatementParameterValue> = {
      [BATCH_COLUMNS.vertex]: nodeId,
      ...projected.value,
    };

    const appended = await this.appendNodeRow(label, row);
    if (!appended.ok) return appended;

    return succeed(nodeId);
  }

  private async appendNodeRow(
    label: NodeLabel,
    row: NodeBatchRow,
  ): Promise<Result<void, Failure>> {
    const measured = measureRow(row, this.batchBudgetBytes, `${label} node`);
    if (!measured.ok) return measured;

    const pending = this.pendingNodeBatches.get(label) ?? { rows: [], byteSize: 0 };

    if (pending.rows.length > 0 && pending.byteSize + measured.value > this.batchBudgetBytes) {
      const written = await this.writeNodeRows(label, pending.rows, 0);
      if (!written.ok) return written;
      pending.rows = [];
      pending.byteSize = 0;
    }

    pending.rows.push(row);
    pending.byteSize += measured.value;
    this.pendingNodeBatches.set(label, pending);

    return succeed(undefined);
  }

  private async appendEdgeRow(relType: RelType, row: NodeBatchRow): Promise<Result<void, Failure>> {
    const measured = measureRow(row, this.batchBudgetBytes, `${relType} relationship`);
    if (!measured.ok) return measured;

    const pending = this.pendingEdgeBatches.get(relType) ?? { rows: [], byteSize: 0 };

    if (pending.rows.length > 0 && pending.byteSize + measured.value > this.batchBudgetBytes) {
      // Every staged node has to reach the engine before any edge does, so a full
      // node flush comes first even though only this one edge batch is over budget.
      const nodesFlushed = await this.flushPendingNodes();
      if (!nodesFlushed.ok) return nodesFlushed;

      const written = await this.writeEdgeRows(relType, pending.rows, 0);
      if (!written.ok) return written;
      pending.rows = [];
      pending.byteSize = 0;
    }

    pending.rows.push(row);
    pending.byteSize += measured.value;
    this.pendingEdgeBatches.set(relType, pending);

    return succeed(undefined);
  }

  private async flushPendingNodes(): Promise<Result<void, Failure>> {
    for (const [label, pending] of this.pendingNodeBatches) {
      if (pending.rows.length === 0) continue;
      const written = await this.writeNodeRows(label, pending.rows, 0);
      if (!written.ok) return written;
      pending.rows = [];
      pending.byteSize = 0;
    }
    return succeed(undefined);
  }

  private async flushPendingEdges(): Promise<Result<void, Failure>> {
    for (const [relType, pending] of this.pendingEdgeBatches) {
      if (pending.rows.length === 0) continue;
      const written = await this.writeEdgeRows(relType, pending.rows, 0);
      if (!written.ok) return written;
      pending.rows = [];
      pending.byteSize = 0;
    }
    return succeed(undefined);
  }

  /**
   * Writes one node batch, halving it and retrying when the engine refuses on a
   * budget.
   *
   * The byte budget above bounds the request body, but the engine also meters rows
   * against max_query_intermediate_rows and reports that as a 429, so a batch can be
   * small enough to send and still too large to execute. Halving converges in a few
   * attempts and is far better than the alternative, which is an operator manually
   * guessing a batch size.
   */
  private async writeNodeRows(
    label: NodeLabel,
    rows: readonly NodeBatchRow[],
    splitDepth: number,
  ): Promise<Result<void, Failure>> {
    const spec: NodeBatchSpec = { label, propertyNames: NODE_PROPERTY_NAMES[label] };
    const written = await this.sink.writeNodeBatch(spec, rows);

    if (written.ok) {
      this.counters.nodeBatches += 1;
      this.counters.nodesWritten += rows.length;
      return succeed(undefined);
    }

    const halves = this.splitForRetry(written.failure, rows, splitDepth, `${label} node`);
    if (!halves.ok) return halves;

    for (const half of halves.value) {
      const halfWritten = await this.writeNodeRows(label, half, splitDepth + 1);
      if (!halfWritten.ok) return halfWritten;
    }
    return succeed(undefined);
  }

  private async writeEdgeRows(
    relType: RelType,
    rows: readonly NodeBatchRow[],
    splitDepth: number,
  ): Promise<Result<void, Failure>> {
    const endpoints = REL_ENDPOINTS[relType];
    const spec: EdgeBatchSpec = {
      fromLabel: endpoints.from,
      relType,
      toLabel: endpoints.to,
      propertyNames: REL_PROPERTY_NAMES[relType],
    };
    const written = await this.sink.writeEdgeBatch(spec, rows);

    if (written.ok) {
      this.counters.edgeBatches += 1;
      this.counters.edgesWritten += rows.length;
      return succeed(undefined);
    }

    const halves = this.splitForRetry(written.failure, rows, splitDepth, `${relType} relationship`);
    if (!halves.ok) return halves;

    for (const half of halves.value) {
      const halfWritten = await this.writeEdgeRows(relType, half, splitDepth + 1);
      if (!halfWritten.ok) return halfWritten;
    }
    return succeed(undefined);
  }

  /**
   * Decides whether a rejected batch is worth retrying smaller, and splits it.
   *
   * Only a budget rejection is retried. A rejected query shape or a mislabelled
   * endpoint fails identically at every size, so retrying it would only turn one clear
   * error into six.
   */
  private splitForRetry(
    failure: Failure,
    rows: readonly NodeBatchRow[],
    splitDepth: number,
    subject: string,
  ): Result<Array<readonly NodeBatchRow[]>, Failure> {
    const retryable = failure.reason === "query_budget_exceeded";
    if (!retryable || rows.length < 2 || splitDepth >= MAX_BATCH_SPLIT_DEPTH) {
      return { ok: false, failure };
    }

    this.counters.batchSplits += 1;
    this.addNote(
      `a ${subject} batch of ${rows.length} rows was refused on a budget and retried in halves`,
    );

    const midpoint = Math.ceil(rows.length / 2);
    return succeed([rows.slice(0, midpoint), rows.slice(midpoint)]);
  }

  private addNote(note: string): void {
    if (!this.counters.notes.includes(note)) this.counters.notes.push(note);
  }
}

type PendingBatch = {
  rows: NodeBatchRow[];
  byteSize: number;
};

/**
 * Projects exactly the properties a label or relationship type declares.
 *
 * Both directions are checked. A missing property fails because the engine rejects a
 * batch whose row lacks a field the statement names, and it reports only a row index.
 * An extra property fails because it would be dropped silently, and a property the
 * caller believed it had written is worse than a batch that refused to run.
 */
function projectProperties(
  propertyNames: readonly string[],
  properties: Readonly<Record<string, unknown>>,
  subject: string,
): Result<Record<string, StatementParameterValue>, Failure> {
  const projected: Record<string, StatementParameterValue> = {};

  for (const propertyName of propertyNames) {
    const value = properties[propertyName];
    if (value === undefined || value === null) {
      return fail(
        "invalid_input",
        `[projectProperties] ${subject} is missing the property "${propertyName}". ` +
          `HydraDB rejects a batch row with an absent field, so write an explicit sentinel instead.`,
      );
    }
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      return fail(
        "invalid_input",
        `[projectProperties] ${subject} property "${propertyName}" is not a scalar`,
      );
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      return fail(
        "invalid_input",
        `[projectProperties] ${subject} property "${propertyName}" is not a finite number`,
      );
    }
    projected[propertyName] = value;
  }

  for (const givenName of Object.keys(properties)) {
    if (!propertyNames.includes(givenName)) {
      return fail(
        "invalid_input",
        `[projectProperties] ${subject} was given the property "${givenName}", which is not in the registry for it`,
      );
    }
  }

  return succeed(projected);
}

/** Measures a row as UTF-8 bytes, because advisory summaries are free text. */
function measureRow(
  row: NodeBatchRow,
  budgetBytes: number,
  subject: string,
): Result<number, Failure> {
  const size = Buffer.byteLength(JSON.stringify(row), "utf8") + ROW_SEPARATOR_BYTES;
  if (size > budgetBytes) {
    return fail(
      "invalid_input",
      `[measureRow] a single ${subject} row is ${size} bytes, over the ${budgetBytes} byte batch budget. ` +
        `Shorten the longest property before staging it.`,
    );
  }
  return succeed(size);
}

/**
 * The identity used for duplicate suppression. Properties are included in a stable
 * order so two edges that differ only in a timestamp stay distinct.
 */
function describeEdgeIdentity(
  relType: RelType,
  sourceNodeId: number,
  destinationNodeId: number,
  properties: Record<string, StatementParameterValue>,
): string {
  const propertyPart = REL_PROPERTY_NAMES[relType]
    .map((propertyName) => `${propertyName}=${String(properties[propertyName])}`)
    .join("|");
  return `${relType}|${sourceNodeId}|${destinationNodeId}|${propertyPart}`;
}

/**
 * Writes batches to a running HydraDB through the statement builders.
 *
 * Thin on purpose: the Cypher shapes live in cypher.ts and the batching policy lives
 * in GraphWriter, so this class only ties the two together.
 */
export class TransportSink implements GraphSink {
  constructor(private readonly transport: GraphTransport) {}

  async writeNodeBatch(
    spec: NodeBatchSpec,
    rows: readonly NodeBatchRow[],
  ): Promise<Result<void, Failure>> {
    const built = buildNodeBatchStatement(spec, rows);
    if (!built.ok) return built;

    const ran = await this.transport.run(built.value);
    return ran.ok ? succeed(undefined) : ran;
  }

  async writeEdgeBatch(
    spec: EdgeBatchSpec,
    rows: readonly NodeBatchRow[],
  ): Promise<Result<void, Failure>> {
    const built = buildEdgeBatchStatement(spec, rows);
    if (!built.ok) return built;

    const ran = await this.transport.run(built.value);
    return ran.ok ? succeed(undefined) : ran;
  }

  describe(): string {
    return this.transport.describe();
  }
}

/**
 * Writes batches into an in-process MemoryGraph.
 *
 * This is what makes a full ingest reproducible without a server: the seed script
 * builds the same graph, from the same staging calls, and exports it as a snapshot the
 * app can answer from. It also mirrors the engine's endpoint check, so a mislabelled
 * edge fails in the fixture exactly as it would fail against HydraDB rather than
 * quietly producing a graph the real engine would have refused.
 */
export class MemorySink implements GraphSink {
  private readonly labelByNodeId = new Map<number, NodeLabel>();

  constructor(private readonly graph: MemoryGraph) {
    for (const node of graph.listNodes()) this.labelByNodeId.set(node.id, node.label);
  }

  async writeNodeBatch(
    spec: NodeBatchSpec,
    rows: readonly NodeBatchRow[],
  ): Promise<Result<void, Failure>> {
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      if (row === undefined) continue;

      const nodeId = readRowId(row, BATCH_COLUMNS.vertex, rowIndex);
      if (!nodeId.ok) return nodeId;

      const properties = readRowProperties(row, spec.propertyNames, rowIndex);
      if (!properties.ok) return properties;

      // A full property set is written every time, so replacing the node matches the
      // engine's MERGE plus SET rather than diverging from it.
      this.graph.addNode({ id: nodeId.value, label: spec.label, properties: properties.value });
      this.labelByNodeId.set(nodeId.value, spec.label);
    }
    return succeed(undefined);
  }

  async writeEdgeBatch(
    spec: EdgeBatchSpec,
    rows: readonly NodeBatchRow[],
  ): Promise<Result<void, Failure>> {
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      if (row === undefined) continue;

      const sourceNodeId = readRowId(row, BATCH_COLUMNS.sourceVertex, rowIndex);
      if (!sourceNodeId.ok) return sourceNodeId;

      const destinationNodeId = readRowId(row, BATCH_COLUMNS.destinationVertex, rowIndex);
      if (!destinationNodeId.ok) return destinationNodeId;

      const relationshipId = readRowId(row, BATCH_COLUMNS.relationshipVertex, rowIndex);
      if (!relationshipId.ok) return relationshipId;

      const sourceLabelChecked = this.requireLabel(sourceNodeId.value, spec.fromLabel, rowIndex);
      if (!sourceLabelChecked.ok) return sourceLabelChecked;

      const targetLabelChecked = this.requireLabel(destinationNodeId.value, spec.toLabel, rowIndex);
      if (!targetLabelChecked.ok) return targetLabelChecked;

      const properties = readRowProperties(row, spec.propertyNames, rowIndex);
      if (!properties.ok) return properties;

      this.graph.addEdge({
        id: relationshipId.value,
        relType: spec.relType,
        fromNodeId: sourceNodeId.value,
        toNodeId: destinationNodeId.value,
        properties: properties.value,
      });
    }
    return succeed(undefined);
  }

  describe(): string {
    return this.graph.describe();
  }

  private requireLabel(
    nodeId: number,
    expected: NodeLabel,
    rowIndex: number,
  ): Result<void, Failure> {
    const actual = this.labelByNodeId.get(nodeId);
    if (actual === expected) return succeed(undefined);
    return fail(
      "graph_rejected",
      `[MemorySink.writeEdgeBatch] row ${rowIndex} endpoint ${nodeId} is ` +
        `${actual ?? "absent"}, not ${expected}. HydraDB refuses this batch for the same reason.`,
    );
  }
}

function readRowId(
  row: NodeBatchRow,
  fieldName: string,
  rowIndex: number,
): Result<number, Failure> {
  const value = row[fieldName];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return fail(
      "invalid_input",
      `[readRowId] row ${rowIndex} field "${fieldName}" is not a non-negative integer id`,
    );
  }
  return succeed(value);
}

function readRowProperties(
  row: NodeBatchRow,
  propertyNames: readonly string[],
  rowIndex: number,
): Result<GraphProperties, Failure> {
  const properties: GraphProperties = {};
  for (const propertyName of propertyNames) {
    const value = row[propertyName];
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      return fail(
        "invalid_input",
        `[readRowProperties] row ${rowIndex} property "${propertyName}" is absent or not a scalar`,
      );
    }
    properties[propertyName] = value;
  }
  return succeed(properties);
}
