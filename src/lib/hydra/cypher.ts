import { MAX_TRAVERSAL_HOPS } from "@/lib/hydra/config";
import type { GraphStatement, StatementParameterValue } from "@/lib/hydra/transport";
import type { TraversalDirection } from "@/lib/graph/gateway";
import { SELECTOR_PROPERTY, type NodeLabel, type RelType } from "@/lib/graph/model";
import { type Failure, type Result, fail, succeed } from "@/lib/result";

/**
 * Every Cypher string in this project is built here.
 *
 * HydraDB accepts a deliberately small OpenCypher subset, and the shapes below are
 * the ones its parser recognises, not the ones a Neo4j habit would produce. The
 * constraints that shape this file:
 *
 *   - One statement per request. No semicolons, no multi-statement scripts.
 *   - Batch writes must match one of two exact UNWIND forms (see the builders).
 *   - Any query containing UNWIND has to lower to one of the engine's fixed batch
 *     shapes. There is no general UNWIND-then-MATCH read, so UNWIND is not a stand-in
 *     for the missing IN operator on a read.
 *   - A read MATCH selects its candidates from the PATTERN alone. WHERE is a
 *     post-filter, so `{id: N}` or `{key: $k}` in the pattern is what turns a query
 *     into a seek instead of a label scan.
 *   - No IN, no min, no max, no CONTAINS, no ENDS WITH, no IS NULL.
 *   - WITH is pass-through only, so no aggregation pipeline.
 *   - Variable-length patterns must carry a maximum.
 *   - Labels, relationship types, property names, and LIMIT counts are part of the
 *     query TEXT and cannot be parameters. algo.MSpaths selector values must also
 *     be string literals.
 *
 * That last constraint is the one with a security consequence. Package and
 * maintainer names come from public registries, so they are untrusted input that
 * ends up inside query text. Rather than escaping them, every literal goes through
 * an allowlist (encodeStringLiteral) that rejects anything outside a known-safe
 * character set. A rejected name produces a Failure the caller must handle; it
 * never produces a query.
 *
 * sourceRef: docs/HYDRADB.md records where each of these facts was read in the
 * HydraDB source.
 */

/** Row column names the batch write forms require. Fixed by the engine's parser. */
export const BATCH_COLUMNS = {
  /** Node id, in the node batch form. */
  vertex: "vertex",
  /** Source node id, in the edge batch form. */
  sourceVertex: "source_vertex",
  /** Target node id, in the edge batch form. */
  destinationVertex: "destination_vertex",
  /** Relationship id, in the edge batch form. */
  relationshipVertex: "relationship_vertex",
} as const;

export type NodeBatchRow = { readonly [key: string]: StatementParameterValue };

export type NodeBatchSpec = {
  label: NodeLabel;
  /**
   * Property names to assign, in a stable order. They become literal text in the
   * statement, so the same spec must be reused for every row of a batch.
   */
  propertyNames: readonly string[];
};

export type EdgeBatchSpec = {
  fromLabel: NodeLabel;
  relType: RelType;
  toLabel: NodeLabel;
  /** Relationship property names, in a stable order. May be empty. */
  propertyNames: readonly string[];
};

/**
 * The node batch write.
 *
 * MERGE on the id makes the write idempotent, which matters because an interrupted
 * ingest is resumed by replaying the batches it had not confirmed.
 *
 * Produces, for a Package batch carrying package_key and ecosystem:
 *
 *   UNWIND $rows AS row MERGE (n {id: row.vertex}) SET n:Package,
 *     n.package_key = row.package_key, n.ecosystem = row.ecosystem
 */
export function buildNodeBatchStatement(
  spec: NodeBatchSpec,
  rows: readonly NodeBatchRow[],
): Result<GraphStatement, Failure> {
  const label = validateLabel(spec.label);
  if (!label.ok) return label;

  const assignments: string[] = [];
  for (const propertyName of spec.propertyNames) {
    const validated = validatePropertyName(propertyName);
    if (!validated.ok) return validated;
    assignments.push(`n.${validated.value} = row.${validated.value}`);
  }

  const setClause =
    assignments.length === 0
      ? `SET n:${label.value}`
      : `SET n:${label.value}, ${assignments.join(", ")}`;

  return succeed({
    text: `UNWIND $rows AS row MERGE (n {id: row.${BATCH_COLUMNS.vertex}}) ${setClause}`,
    parameters: { rows: rows as readonly StatementParameterValue[] },
  });
}

/**
 * The edge batch write.
 *
 * CREATE rather than MERGE, because the id-map assigns each relationship a distinct
 * id and replaying a batch after a partial failure would otherwise be ambiguous.
 * Re-running an ingest starts from a clean graph; resumption replays unconfirmed
 * batches only.
 *
 * Produces, for Service -[:RESOLVED {resolved_at_ms}]-> Version:
 *
 *   UNWIND $rows AS row
 *     MATCH (s:Service {id: row.source_vertex}), (d:Version {id: row.destination_vertex})
 *     CREATE (s)-[:RESOLVED {id: row.relationship_vertex, resolved_at_ms: row.resolved_at_ms}]->(d)
 */
export function buildEdgeBatchStatement(
  spec: EdgeBatchSpec,
  rows: readonly NodeBatchRow[],
): Result<GraphStatement, Failure> {
  const fromLabel = validateLabel(spec.fromLabel);
  if (!fromLabel.ok) return fromLabel;

  const toLabel = validateLabel(spec.toLabel);
  if (!toLabel.ok) return toLabel;

  const relType = validateRelType(spec.relType);
  if (!relType.ok) return relType;

  const relProperties = [`id: row.${BATCH_COLUMNS.relationshipVertex}`];
  for (const propertyName of spec.propertyNames) {
    const validated = validatePropertyName(propertyName);
    if (!validated.ok) return validated;
    relProperties.push(`${validated.value}: row.${validated.value}`);
  }

  const text =
    `UNWIND $rows AS row ` +
    `MATCH (s:${fromLabel.value} {id: row.${BATCH_COLUMNS.sourceVertex}}), ` +
    `(d:${toLabel.value} {id: row.${BATCH_COLUMNS.destinationVertex}}) ` +
    `CREATE (s)-[:${relType.value} {${relProperties.join(", ")}}]->(d)`;

  return succeed({ text, parameters: { rows: rows as readonly StatementParameterValue[] } });
}

/**
 * Reads named properties for a set of node ids.
 *
 * There is no `node` wire type, so properties are returned as explicit scalar
 * columns rather than as a node object.
 *
 * The shape is dictated by how the engine picks node candidates. A node pattern is
 * resolved from the PATTERN alone, never from the WHERE clause: a pattern property
 * `{id: N}` becomes a direct id seek, a bare label becomes a label scan, and the
 * predicate is a post-filter applied to whatever the scan produced. So:
 *
 *   one id    MATCH (n:Version {id: 41}) RETURN n.id AS id, n.version AS version
 *   many ids  MATCH (n:Version) WHERE n.id = 41 OR n.id = 42 RETURN ...
 *
 * The many-id form costs one label scan for the whole batch, which is why the ids go
 * into one OR chain rather than one request each.
 *
 * An earlier version of this builder used `UNWIND $ids AS wanted MATCH (n:Label {id:
 * wanted})`. The engine rejects it: any query containing UNWIND has to lower to one of
 * its fixed batch shapes, and the only read-shaped batch is a one-hop neighbour
 * expansion. sourceRef: docs/HYDRADB.md section 2.7.
 *
 * Node ids are inlined as integer literals rather than sent as parameters. They are
 * internal integers, never user text, and inlining removes any dependence on how the
 * engine infers a numeric parameter's type.
 */
export function buildReadNodesStatement(
  label: NodeLabel,
  propertyNames: readonly string[],
  nodeIds: readonly number[],
): Result<GraphStatement, Failure> {
  const validatedLabel = validateLabel(label);
  if (!validatedLabel.ok) return validatedLabel;

  const ids = validateNodeIds(nodeIds);
  if (!ids.ok) return ids;

  const projections = ["n.id AS id"];
  for (const propertyName of propertyNames) {
    const validated = validatePropertyName(propertyName);
    if (!validated.ok) return validated;
    projections.push(`n.${validated.value} AS ${validated.value}`);
  }

  const [firstId] = ids.value;
  if (ids.value.length === 1 && firstId !== undefined) {
    return succeed({
      text: `MATCH (n:${validatedLabel.value} {id: ${firstId}}) RETURN ${projections.join(", ")}`,
      parameters: {},
    });
  }

  const conditions = ids.value.map((nodeId) => `n.id = ${nodeId}`).join(" OR ");
  return succeed({
    text:
      `MATCH (n:${validatedLabel.value}) WHERE ${conditions} ` +
      `RETURN ${projections.join(", ")}`,
    parameters: {},
  });
}

/**
 * Resolves natural keys to integer node ids.
 *
 * This is the read side of the id map. The ingest owns the key-to-id assignment, but
 * the app reads a graph it did not necessarily write in the same process, so it needs
 * to ask the engine.
 *
 * A single key uses the pattern-property form, which the optimiser answers from the
 * automatic per-property vertex index rather than by scanning the label. Several keys
 * fall back to a label scan with an OR chain, because candidate selection ignores the
 * WHERE clause. Callers that resolve one key at a time therefore get the index; a
 * caller resolving a large set pays one scan for the batch.
 *
 * Keys come from public registries, so they travel as parameters and never as query
 * text. That is the one place in this file where a value is not put through the
 * literal allowlist, and it is safe precisely because it is not concatenated.
 */
export function buildResolveKeysStatement(
  label: NodeLabel,
  keys: readonly string[],
): Result<GraphStatement, Failure> {
  const validatedLabel = validateLabel(label);
  if (!validatedLabel.ok) return validatedLabel;

  if (keys.length === 0) {
    return fail("invalid_input", "[buildResolveKeysStatement] no keys given");
  }

  for (const key of keys) {
    if (key.length === 0) {
      return fail("invalid_input", "[buildResolveKeysStatement] a key is empty");
    }
    if (key.length > MAX_LITERAL_LENGTH) {
      return fail(
        "invalid_input",
        `[buildResolveKeysStatement] a key of ${key.length} characters exceeds ${MAX_LITERAL_LENGTH}`,
      );
    }
  }

  const projections = `n.id AS id, n.${SELECTOR_PROPERTY} AS ${SELECTOR_PROPERTY}`;

  const [firstKey] = keys;
  if (keys.length === 1 && firstKey !== undefined) {
    return succeed({
      text:
        `MATCH (n:${validatedLabel.value} {${SELECTOR_PROPERTY}: $key0}) ` +
        `RETURN ${projections} LIMIT 1`,
      parameters: { key0: firstKey },
    });
  }

  const parameters: Record<string, StatementParameterValue> = {};
  const conditions: string[] = [];
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) continue;
    const name = `key${index}`;
    parameters[name] = key;
    conditions.push(`n.${SELECTOR_PROPERTY} = $${name}`);
  }

  return succeed({
    text:
      `MATCH (n:${validatedLabel.value}) WHERE ${conditions.join(" OR ")} ` +
      `RETURN ${projections}`,
    parameters,
  });
}

export type NeighborStatementSpec = {
  nodeId: number;
  fromLabel: NodeLabel;
  relType: RelType;
  direction: "incoming" | "outgoing";
  /** Relationship property names to return. */
  propertyNames: readonly string[];
  /** Half-open window on a numeric relationship property, pushed into the WHERE. */
  propertyWindow?: { property: string; fromInclusive: number; toExclusive: number };
  limit: number;
};

/**
 * One-hop expansion with relationship properties.
 *
 * The numeric window is pushed into the WHERE clause rather than filtered client
 * side: the bitemporal question asks which lockfile resolutions were live inside a
 * time window, and a service with years of history has far more edges outside the
 * window than inside it.
 *
 * LIMIT is inlined as a literal because the subset does not accept a parameter
 * there. The value is validated as a positive integer first, and it is never user
 * text: it comes from the analysis layer's own budget.
 */
export function buildNeighborStatement(
  spec: NeighborStatementSpec,
): Result<GraphStatement, Failure> {
  const label = validateLabel(spec.fromLabel);
  if (!label.ok) return label;

  const relType = validateRelType(spec.relType);
  if (!relType.ok) return relType;

  if (!Number.isSafeInteger(spec.nodeId) || spec.nodeId < 0) {
    return fail("invalid_input", `[buildNeighborStatement] nodeId ${spec.nodeId} is not a node id`);
  }
  if (!Number.isSafeInteger(spec.limit) || spec.limit < 1) {
    return fail("invalid_input", `[buildNeighborStatement] limit ${spec.limit} must be positive`);
  }

  const pattern =
    spec.direction === "outgoing"
      ? `(n:${label.value} {id: $nodeId})-[edge:${relType.value}]->(other)`
      : `(n:${label.value} {id: $nodeId})<-[edge:${relType.value}]-(other)`;

  // No relationship id column. `edge.id` on a relationship binding is not merely
  // unindexed, it is a hard rejection: binding_property returns UnsupportedQuery for
  // property == "id" on any relationship, so a statement carrying that column answers
  // 400 and the whole expansion returns nothing. The ingest still writes an `id`
  // property on every relationship because the batch CREATE form needs it, but it is
  // readable only through algo.*paths, which hydrates relationship metadata itself.
  // sourceRef: .scratch/hydradb-src/src/shard/query.rs binding_property.
  const projections = ["other.id AS other_id"];
  for (const propertyName of spec.propertyNames) {
    const validated = validatePropertyName(propertyName);
    if (!validated.ok) return validated;
    projections.push(`edge.${validated.value} AS ${validated.value}`);
  }

  const parameters: Record<string, StatementParameterValue> = { nodeId: spec.nodeId };
  let whereClause = "";

  const window = spec.propertyWindow;
  if (window !== undefined) {
    const validated = validatePropertyName(window.property);
    if (!validated.ok) return validated;
    if (!Number.isFinite(window.fromInclusive) || !Number.isFinite(window.toExclusive)) {
      return fail("invalid_input", "[buildNeighborStatement] window bounds must be finite numbers");
    }
    whereClause =
      ` WHERE edge.${validated.value} >= $windowFrom AND edge.${validated.value} < $windowTo`;
    parameters.windowFrom = window.fromInclusive;
    parameters.windowTo = window.toExclusive;
  }

  return succeed({
    text:
      `MATCH ${pattern}${whereClause} RETURN ${projections.join(", ")} LIMIT ${spec.limit}`,
    parameters,
  });
}

/**
 * Counts nodes carrying a label.
 *
 * `count(*)` and not `count(n)`. An aggregate argument is lowered by
 * lower_row_expression, which accepts `<binding>.id`, `<binding>.<property>`, or a
 * scalar literal; a bare binding falls through to scalar_property_value and is
 * rejected, so `count(n)` never parses. RETURN's own error message names the two
 * accepted forms: `<binding>.<property>` or `count(*)`.
 * sourceRef: .scratch/hydradb-src/src/query/opencypher.rs lower_row_expression,
 * and the upstream test at src/tests.rs "MATCH (n:Source) RETURN count(*) AS total".
 *
 * The aggregate is computed after every binding row is materialised, and the label
 * scan behind it is metered against max_query_index_candidates, so this is a health
 * check and a README figure, never a hot path.
 */
export function buildCountStatement(label: NodeLabel): Result<GraphStatement, Failure> {
  const validated = validateLabel(label);
  if (!validated.ok) return validated;
  return succeed({
    text: `MATCH (n:${validated.value}) RETURN count(*) AS total`,
    parameters: {},
  });
}

/** The fallback for buildCountStatement: ids only, counted client side. */
export function buildIdListStatement(
  label: NodeLabel,
  limit: number,
): Result<GraphStatement, Failure> {
  const validated = validateLabel(label);
  if (!validated.ok) return validated;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    return fail("invalid_input", `[buildIdListStatement] limit ${limit} must be positive`);
  }
  return succeed({
    text: `MATCH (n:${validated.value}) RETURN n.id AS id LIMIT ${limit}`,
    parameters: {},
  });
}

export type SingleSourcePathSpec = {
  sourceNodeId: number;
  relTypes: readonly RelType[];
  /** Which way to expand. Sent explicitly rather than relying on the default. */
  direction: TraversalDirection;
  maxLength: number;
  pathCount: number;
};

/**
 * Single-source path enumeration.
 *
 * algo.SSpaths takes `sourceNode` and rejects `targetNode`, `targetLabel`, and
 * every multi-source key, so target filtering happens client side in
 * hydra-gateway.ts. maxLen is optional and defaults to max_traversal_hops, but it
 * is always sent explicitly: an unstated 16-hop walk over a dependency graph is not
 * a query anyone intended.
 *
 * Direction IS a procedure argument: relDirection accepts "incoming", "outgoing", or
 * "both", case-insensitively, and defaults to outgoing.
 * sourceRef: .scratch/hydradb-src/src/query/path_procedure.rs relDirection.
 *
 * The ingest still materialises DEPENDED_ON_BY next to RESOLVES_TO, but as an index
 * shape rather than a workaround: an outgoing walk over a stored reverse type uses the
 * forward adjacency, while relDirection: "incoming" drives the reverse index.
 * scripts/measure-traversal.ts is what decides which one this slice should use.
 *
 *   CALL algo.SSpaths({sourceNode: 12, relTypes: ["DEPENDED_ON_BY"],
 *     relDirection: "outgoing", maxLen: 8, pathCount: 5000}) YIELD path RETURN path
 */
export function buildSingleSourcePathStatement(
  spec: SingleSourcePathSpec,
): Result<GraphStatement, Failure> {
  if (!Number.isSafeInteger(spec.sourceNodeId) || spec.sourceNodeId < 0) {
    return fail(
      "invalid_input",
      `[buildSingleSourcePathStatement] sourceNodeId ${spec.sourceNodeId} is not a node id`,
    );
  }

  const relTypes = encodeRelTypeList(spec.relTypes);
  if (!relTypes.ok) return relTypes;

  const bounds = validateTraversalBounds(spec.maxLength, spec.pathCount);
  if (!bounds.ok) return bounds;

  return succeed({
    text:
      `CALL algo.SSpaths({sourceNode: ${spec.sourceNodeId}, relTypes: ${relTypes.value}, ` +
      `relDirection: "${spec.direction}", ` +
      `maxLen: ${bounds.value.maxLength}, pathCount: ${bounds.value.pathCount}}) ` +
      `YIELD path RETURN path`,
    parameters: {},
  });
}

export type MultiSourcePathSpec = {
  sourceLabel: NodeLabel;
  /** The property the selector matches on. Must be indexed for the engine to use it. */
  sourceProperty: string;
  /** Natural key values, one per source node. */
  sourceValues: readonly string[];
  relTypes: readonly RelType[];
  direction: TraversalDirection;
  maxLength: number;
  pathCount: number;
};

/**
 * Multi-source path enumeration, which is what makes the maintainer leaderboard one
 * server-side pass instead of one request per maintainer.
 *
 * algo.MSpaths rejects `sourceNode` and selects by sourceLabel plus sourceProperty
 * plus sourceValues. Those values must be string literals in the query text, not
 * parameters, so they are the one place untrusted registry names reach Cypher. Every
 * value goes through the allowlist in encodeStringLiteral; a name outside it fails
 * the build rather than being escaped.
 *
 *   CALL algo.MSpaths({sourceLabel: "Maintainer", sourceProperty: "key",
 *     sourceValues: ["npm:sindresorhus", "npm:isaacs"], relTypes: ["MAINTAINS"],
 *     relDirection: "outgoing", maxLen: 4, pathCount: 50000}) YIELD path RETURN path
 */
export function buildMultiSourcePathStatement(
  spec: MultiSourcePathSpec,
): Result<GraphStatement, Failure> {
  const label = validateLabel(spec.sourceLabel);
  if (!label.ok) return label;

  const sourceProperty = validatePropertyName(spec.sourceProperty);
  if (!sourceProperty.ok) return sourceProperty;

  if (spec.sourceValues.length === 0) {
    return fail("invalid_input", "[buildMultiSourcePathStatement] sourceValues is empty");
  }

  const encodedValues: string[] = [];
  for (const value of spec.sourceValues) {
    const encoded = encodeStringLiteral(value);
    if (!encoded.ok) return encoded;
    encodedValues.push(encoded.value);
  }

  const relTypes = encodeRelTypeList(spec.relTypes);
  if (!relTypes.ok) return relTypes;

  const bounds = validateTraversalBounds(spec.maxLength, spec.pathCount);
  if (!bounds.ok) return bounds;

  return succeed({
    text:
      `CALL algo.MSpaths({sourceLabel: "${label.value}", ` +
      `sourceProperty: "${sourceProperty.value}", ` +
      `sourceValues: [${encodedValues.join(", ")}], ` +
      `relTypes: ${relTypes.value}, relDirection: "${spec.direction}", ` +
      `maxLen: ${bounds.value.maxLength}, ` +
      `pathCount: ${bounds.value.pathCount}}) YIELD path RETURN path`,
    parameters: {},
  });
}

/**
 * The allowlist for string literals that go into query text.
 *
 * Covers every character npm and PyPI names, semver versions, and our composite
 * keys can legitimately contain: letters, digits, dot, underscore, dash, plus,
 * tilde, at sign, slash, and the colon our keys use as a separator. A quote, a
 * backslash, a brace, a newline, or anything else is rejected.
 *
 * This is an allowlist rather than an escape routine on purpose. Escaping has to be
 * exactly right against a parser this project cannot exhaustively test; rejecting
 * an unexpected character fails closed instead.
 */
const SAFE_LITERAL_PATTERN = /^[A-Za-z0-9._~+@/:-]+$/;

/** Longest literal accepted. npm caps names at 214 characters; keys add a little. */
const MAX_LITERAL_LENGTH = 512;

export function encodeStringLiteral(value: string): Result<string, Failure> {
  if (value.length === 0) {
    return fail("invalid_input", "[encodeStringLiteral] empty string literal");
  }
  if (value.length > MAX_LITERAL_LENGTH) {
    return fail(
      "invalid_input",
      `[encodeStringLiteral] literal of ${value.length} characters exceeds ${MAX_LITERAL_LENGTH}`,
    );
  }
  if (!SAFE_LITERAL_PATTERN.test(value)) {
    return fail(
      "invalid_input",
      `[encodeStringLiteral] literal contains a character outside the safe set: "${describeUnsafe(value)}"`,
    );
  }
  return succeed(`"${value}"`);
}

/** Node labels are a closed set in model.ts; this guards against a future typo. */
function validateLabel(label: NodeLabel): Result<string, Failure> {
  return /^[A-Z][A-Za-z]*$/.test(label)
    ? succeed(label)
    : fail("invalid_input", `[validateLabel] "${label}" is not a valid label`);
}

function validateRelType(relType: RelType): Result<string, Failure> {
  return /^[A-Z][A-Z_]*$/.test(relType)
    ? succeed(relType)
    : fail("invalid_input", `[validateRelType] "${relType}" is not a valid relationship type`);
}

function validatePropertyName(propertyName: string): Result<string, Failure> {
  return /^[a-z][a-z0-9_]*$/.test(propertyName)
    ? succeed(propertyName)
    : fail("invalid_input", `[validatePropertyName] "${propertyName}" is not a valid property name`);
}

function encodeRelTypeList(relTypes: readonly RelType[]): Result<string, Failure> {
  if (relTypes.length === 0) {
    return fail("invalid_input", "[encodeRelTypeList] relTypes is empty, which would match nothing");
  }
  const encoded: string[] = [];
  for (const relType of relTypes) {
    const validated = validateRelType(relType);
    if (!validated.ok) return validated;
    encoded.push(`"${validated.value}"`);
  }
  return succeed(`[${encoded.join(", ")}]`);
}

function validateNodeIds(nodeIds: readonly number[]): Result<number[], Failure> {
  if (nodeIds.length === 0) {
    return fail("invalid_input", "[validateNodeIds] no node ids given");
  }
  const validated: number[] = [];
  for (const nodeId of nodeIds) {
    if (!Number.isSafeInteger(nodeId) || nodeId < 0) {
      return fail("invalid_input", `[validateNodeIds] ${nodeId} is not a node id`);
    }
    validated.push(nodeId);
  }
  return succeed(validated);
}

function validateTraversalBounds(
  maxLength: number,
  pathCount: number,
): Result<{ maxLength: number; pathCount: number }, Failure> {
  if (!Number.isSafeInteger(maxLength) || maxLength < 1) {
    return fail("invalid_input", `[validateTraversalBounds] maxLength ${maxLength} must be positive`);
  }
  if (maxLength > MAX_TRAVERSAL_HOPS) {
    return fail(
      "invalid_input",
      `[validateTraversalBounds] maxLength ${maxLength} exceeds the engine limit of ${MAX_TRAVERSAL_HOPS}`,
    );
  }
  if (!Number.isSafeInteger(pathCount) || pathCount < 1) {
    return fail(
      "invalid_input",
      `[validateTraversalBounds] pathCount ${pathCount} must be positive`,
    );
  }
  return succeed({ maxLength, pathCount });
}

/** Names the first offending character without echoing the whole untrusted string. */
function describeUnsafe(value: string): string {
  for (const character of value) {
    if (!SAFE_LITERAL_PATTERN.test(character)) {
      return `U+${character.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0") ?? "????"}`;
    }
  }
  return "unknown";
}
