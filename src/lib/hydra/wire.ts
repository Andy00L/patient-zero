import { type Failure, type Result, fail, succeed } from "@/lib/result";

/**
 * Decoding HydraDB's tagged wire values.
 *
 * The HTTP query API does not return bare JSON scalars. Every cell is a tagged
 * object, because JSON cannot tell a u64 vertex id from a signed integer from a
 * float, and the engine refuses to guess:
 *
 *   {"type": "vertex_id", "value": 42}
 *   {"type": "string", "value": "npm:chalk"}
 *   {"type": "list", "value": [{"type": "integer", "value": 1}]}
 *
 * A path cell carries a SECOND, different tagging inside it, and the difference is not
 * cosmetic. The cell envelope above is a serde container attribute on the response type
 * (`#[serde(tag = "type", content = "value", rename_all = "snake_case")]` on
 * HttpQueryValue), but a path node's property map is a BTreeMap of VertexPropertyValue,
 * which carries no such attribute and so serialises with serde's default external
 * tagging: a one-key object whose key is the Rust variant name, in PascalCase, with no
 * "value" field at all.
 *
 *   "properties": {"ecosystem": {"String": "npm"}, "published_at_ms": {"Integer": 1536481739503}}
 *
 * Both taggings are decoded here, by two functions, because they are two formats that
 * happen to both be objects. Reading a property value with the cell decoder gets an
 * object with no "type" key and reports the property as unsupported, which is what this
 * module used to do: every traversal against a live engine failed on the first property
 * of the first node of the first path.
 *
 * The module also fails loudly on the one case that matters: a u64 larger than
 * Number.MAX_SAFE_INTEGER would lose precision silently, and a silently wrong node id
 * would attach a vulnerability to the wrong package. Ids are assigned sequentially by the
 * id-map so this cannot happen with our own data, but a shared graph could hand us
 * anything.
 *
 * Bolt does not come through here. It converts through the driver's own value types in
 * bolt-transport.ts, so this module is the HTTP decoder specifically.
 *
 * sourceRef: HydraDB src/client/http.rs (HttpQueryValue), src/query/algebra.rs
 * (QueryPath, QueryPathNode, QueryPathRelationship), src/core/model.rs
 * (VertexPropertyValue).
 */

/** The tag names the engine emits, as a closed set. */
const WIRE_TAGS = [
  "null",
  "vertex_id",
  "integer",
  "signed_integer",
  "float",
  "boolean",
  "string",
  "list",
  "path",
] as const;

export type WireTag = (typeof WIRE_TAGS)[number];

/** A decoded cell. `path` cells decode into DecodedPath, everything else is scalar. */
export type DecodedValue =
  | null
  | number
  | boolean
  | string
  | DecodedValue[]
  | DecodedPath;

export type DecodedPath = {
  nodes: DecodedPathNode[];
  relationships: DecodedPathRelationship[];
};

export type DecodedPathNode = {
  id: number;
  labels: string[];
  properties: Record<string, DecodedValue>;
};

export type DecodedPathRelationship = {
  /** The engine may omit a relationship id for a synthesised edge. */
  id: number | null;
  relType: string;
  sourceNodeId: number;
  targetNodeId: number;
  properties: Record<string, DecodedValue>;
};

/** One row of a query result, keyed by the column names the response declares. */
export type DecodedRow = Record<string, DecodedValue>;

export function decodeWireValue(raw: unknown, path: string): Result<DecodedValue, Failure> {
  // A bare scalar. Result cells are always tagged, so this is tolerance for a shape the
  // engine does not currently emit rather than a case that arrives today. Property values
  // inside a path are NOT decoded here: they use a different tagging and go through
  // decodePropertyValue.
  if (raw === null || raw === undefined) return succeed(null);
  if (typeof raw === "boolean" || typeof raw === "string") return succeed(raw);
  if (typeof raw === "number") {
    return Number.isFinite(raw)
      ? succeed(raw)
      : fail("graph_rejected", `[decodeWireValue] ${path} is a non-finite number`);
  }

  if (Array.isArray(raw)) return decodeList(raw, path);

  if (typeof raw !== "object") {
    return fail("graph_rejected", `[decodeWireValue] ${path} has unsupported type ${typeof raw}`);
  }

  const record = raw as Record<string, unknown>;
  const tag = record.type;
  if (typeof tag !== "string") {
    return fail("graph_rejected", `[decodeWireValue] ${path} is an object with no type tag`);
  }
  if (!isWireTag(tag)) {
    return fail("graph_rejected", `[decodeWireValue] ${path} has unknown type tag "${tag}"`);
  }

  const value = record.value;

  switch (tag) {
    case "null":
      return succeed(null);

    case "boolean":
      return typeof value === "boolean"
        ? succeed(value)
        : fail("graph_rejected", `[decodeWireValue] ${path} boolean carries ${typeof value}`);

    case "string":
      return typeof value === "string"
        ? succeed(value)
        : fail("graph_rejected", `[decodeWireValue] ${path} string carries ${typeof value}`);

    case "float":
      return typeof value === "number" && Number.isFinite(value)
        ? succeed(value)
        : fail("graph_rejected", `[decodeWireValue] ${path} float carries ${String(value)}`);

    case "vertex_id":
    case "integer":
    case "signed_integer":
      return decodeInteger(value, `${path}.${tag}`);

    case "list":
      return Array.isArray(value)
        ? decodeList(value, path)
        : fail("graph_rejected", `[decodeWireValue] ${path} list carries ${typeof value}`);

    case "path":
      return decodePath(value, path);
  }
}

export function decodeRow(
  columns: readonly string[],
  cells: readonly unknown[],
  rowIndex: number,
): Result<DecodedRow, Failure> {
  if (columns.length !== cells.length) {
    return fail(
      "graph_rejected",
      `[decodeRow] row ${rowIndex} has ${cells.length} cells for ${columns.length} columns`,
    );
  }

  const row: DecodedRow = {};
  for (let cellIndex = 0; cellIndex < cells.length; cellIndex += 1) {
    const columnName = columns[cellIndex] ?? `column${cellIndex}`;
    const decoded = decodeWireValue(cells[cellIndex], `row[${rowIndex}].${columnName}`);
    if (!decoded.ok) return decoded;
    row[columnName] = decoded.value;
  }
  return succeed(row);
}

/** Narrows a decoded cell to a path, for the algo.* procedures that yield one. */
export function asDecodedPath(value: DecodedValue): DecodedPath | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return "nodes" in value && "relationships" in value ? value : null;
}

export function asNumber(value: DecodedValue): number | null {
  return typeof value === "number" ? value : null;
}

export function asString(value: DecodedValue): string | null {
  return typeof value === "string" ? value : null;
}

function decodeList(entries: readonly unknown[], path: string): Result<DecodedValue[], Failure> {
  const values: DecodedValue[] = [];
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const decoded = decodeWireValue(entries[entryIndex], `${path}[${entryIndex}]`);
    if (!decoded.ok) return decoded;
    values.push(decoded.value);
  }
  return succeed(values);
}

/**
 * Integers arrive as JSON numbers, or as strings when a u64 exceeds what JSON
 * numbers hold exactly. Both are accepted; anything that would lose precision is
 * rejected rather than rounded, because a rounded node id points at a different
 * package.
 */
function decodeInteger(value: unknown, path: string): Result<number, Failure> {
  if (typeof value === "number") {
    return Number.isSafeInteger(value)
      ? succeed(value)
      : fail("graph_rejected", `[decodeInteger] ${path} is not a safe integer: ${value}`);
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed)
      ? succeed(parsed)
      : fail("graph_rejected", `[decodeInteger] ${path} string "${value}" is not a safe integer`);
  }

  return fail("graph_rejected", `[decodeInteger] ${path} carries ${typeof value}`);
}

function decodePath(value: unknown, path: string): Result<DecodedPath, Failure> {
  if (typeof value !== "object" || value === null) {
    return fail("graph_rejected", `[decodePath] ${path} path carries ${typeof value}`);
  }

  const record = value as Record<string, unknown>;
  const rawNodes = record.nodes;
  const rawRelationships = record.relationships;

  if (!Array.isArray(rawNodes)) {
    return fail("graph_rejected", `[decodePath] ${path} has no nodes array`);
  }
  if (!Array.isArray(rawRelationships)) {
    return fail("graph_rejected", `[decodePath] ${path} has no relationships array`);
  }

  const nodes: DecodedPathNode[] = [];
  for (let nodeIndex = 0; nodeIndex < rawNodes.length; nodeIndex += 1) {
    const decoded = decodePathNode(rawNodes[nodeIndex], `${path}.nodes[${nodeIndex}]`);
    if (!decoded.ok) return decoded;
    nodes.push(decoded.value);
  }

  const relationships: DecodedPathRelationship[] = [];
  for (let edgeIndex = 0; edgeIndex < rawRelationships.length; edgeIndex += 1) {
    const decoded = decodePathRelationship(
      rawRelationships[edgeIndex],
      `${path}.relationships[${edgeIndex}]`,
    );
    if (!decoded.ok) return decoded;
    relationships.push(decoded.value);
  }

  return succeed({ nodes, relationships });
}

function decodePathNode(raw: unknown, path: string): Result<DecodedPathNode, Failure> {
  if (typeof raw !== "object" || raw === null) {
    return fail("graph_rejected", `[decodePathNode] ${path} is not an object`);
  }
  const record = raw as Record<string, unknown>;

  const id = decodeInteger(unwrapTagged(record.id), `${path}.id`);
  if (!id.ok) return id;

  const labels: string[] = [];
  if (Array.isArray(record.labels)) {
    for (const label of record.labels) {
      if (typeof label === "string") labels.push(label);
    }
  }

  const properties = decodeProperties(record.properties, `${path}.properties`);
  if (!properties.ok) return properties;

  return succeed({ id: id.value, labels, properties: properties.value });
}

function decodePathRelationship(
  raw: unknown,
  path: string,
): Result<DecodedPathRelationship, Failure> {
  if (typeof raw !== "object" || raw === null) {
    return fail("graph_rejected", `[decodePathRelationship] ${path} is not an object`);
  }
  const record = raw as Record<string, unknown>;

  const rawId = unwrapTagged(record.id);
  let relationshipId: number | null = null;
  if (rawId !== null && rawId !== undefined) {
    const decodedId = decodeInteger(rawId, `${path}.id`);
    if (!decodedId.ok) return decodedId;
    relationshipId = decodedId.value;
  }

  const relType = record.edge_type;
  if (typeof relType !== "string") {
    return fail("graph_rejected", `[decodePathRelationship] ${path} has no edge_type`);
  }

  const sourceNodeId = decodeInteger(unwrapTagged(record.src), `${path}.src`);
  if (!sourceNodeId.ok) return sourceNodeId;

  const targetNodeId = decodeInteger(unwrapTagged(record.dst), `${path}.dst`);
  if (!targetNodeId.ok) return targetNodeId;

  const properties = decodeProperties(record.properties, `${path}.properties`);
  if (!properties.ok) return properties;

  return succeed({
    id: relationshipId,
    relType,
    sourceNodeId: sourceNodeId.value,
    targetNodeId: targetNodeId.value,
    properties: properties.value,
  });
}

function decodeProperties(
  raw: unknown,
  path: string,
): Result<Record<string, DecodedValue>, Failure> {
  if (raw === null || raw === undefined) return succeed({});
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return fail("graph_rejected", `[decodeProperties] ${path} is not a property map`);
  }

  const properties: Record<string, DecodedValue> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const decoded = decodePropertyValue(value, `${path}.${name}`);
    if (!decoded.ok) return decoded;
    properties[name] = decoded.value;
  }
  return succeed(properties);
}

/**
 * One property value of a path node or relationship, externally tagged by variant name.
 *
 * Five variants, which is the whole of VertexPropertyValue: a graph property is a scalar
 * and cannot be a list or a nested map. An unrecognised variant name is refused rather
 * than passed through as an object, because a property that silently decodes to `{}`
 * would reach a surface as a rendered value with no reading in it.
 *
 * A bare scalar is accepted as well, for the same reason decodeWireValue accepts one: it
 * is unambiguous. An object is not, so it must name a variant this build knows.
 */
function decodePropertyValue(raw: unknown, path: string): Result<DecodedValue, Failure> {
  if (raw === null || raw === undefined) return succeed(null);
  if (typeof raw === "boolean" || typeof raw === "string") return succeed(raw);
  if (typeof raw === "number") {
    return Number.isFinite(raw)
      ? succeed(raw)
      : fail("graph_rejected", `[decodePropertyValue] ${path} is a non-finite number`);
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return fail(
      "graph_rejected",
      `[decodePropertyValue] ${path} is a ${Array.isArray(raw) ? "list" : typeof raw}, which is not a property value`,
    );
  }

  const entries = Object.entries(raw as Record<string, unknown>);
  const [entry] = entries;
  if (entries.length !== 1 || entry === undefined) {
    return fail(
      "graph_rejected",
      `[decodePropertyValue] ${path} carries ${entries.length} keys, so it names no single variant`,
    );
  }

  const [variant, payload] = entry;
  switch (variant) {
    case "String":
      return typeof payload === "string"
        ? succeed(payload)
        : fail("graph_rejected", `[decodePropertyValue] ${path} String carries ${typeof payload}`);

    case "Bool":
      return typeof payload === "boolean"
        ? succeed(payload)
        : fail("graph_rejected", `[decodePropertyValue] ${path} Bool carries ${typeof payload}`);

    case "Float":
      return typeof payload === "number" && Number.isFinite(payload)
        ? succeed(payload)
        : fail(
            "graph_rejected",
            `[decodePropertyValue] ${path} Float carries ${String(payload)}`,
          );

    case "Integer":
    case "SignedInteger":
      return decodeInteger(payload, `${path}.${variant}`);

    default:
      return fail(
        "graph_rejected",
        `[decodePropertyValue] ${path} names variant "${variant}", which VertexPropertyValue does not have`,
      );
  }
}

/** Accepts a value that may or may not be wrapped in a {type, value} envelope. */
function unwrapTagged(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  return typeof record.type === "string" && "value" in record ? record.value : raw;
}

function isWireTag(candidate: string): candidate is WireTag {
  return (WIRE_TAGS as readonly string[]).includes(candidate);
}
