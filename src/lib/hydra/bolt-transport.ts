import neo4j, { type Driver } from "neo4j-driver";

import type { HydraConfig } from "@/lib/hydra/config";
import {
  type GraphStatement,
  type GraphTransport,
  refuseOversizedStatement,
} from "@/lib/hydra/transport";
import type {
  DecodedPath,
  DecodedPathNode,
  DecodedPathRelationship,
  DecodedRow,
  DecodedValue,
} from "@/lib/hydra/wire";
import { type Failure, type Result, fail, succeed } from "@/lib/result";

/**
 * The Bolt transport.
 *
 * HydraDB speaks Bolt 5.1 through 5.4 on port 7687 with basic auth where only the
 * credential is checked, so the principal is a placeholder and the token is the
 * password. It has no request body cap, which makes it the better choice for large
 * ingest batches.
 *
 * The HTTP transport is the default and the one the tests exercise, because Bolt
 * requires the driver and the server to negotiate a shared protocol version and this
 * project has no way to verify that negotiation without a running server. If
 * neo4j-driver offers only versions above 5.4 the handshake fails, and the failure
 * surfaces here as graph_unavailable with the driver's own message rather than as a
 * silent fallback.
 *
 * sourceRef: docs/HYDRADB.md, section "Bolt".
 */
export class BoltTransport implements GraphTransport {
  private driver: Driver | null = null;

  constructor(private readonly config: HydraConfig) {}

  async run(statement: GraphStatement): Promise<Result<DecodedRow[], Failure>> {
    // Guarded here too, on the measured HTTP limit. Whether Bolt shares it was never
    // measured, so this is the conservative side of that gap: an unmeasured cap costs
    // large reads extra round trips, and skipping the check would leave a second path
    // on which a statement is silently truncated instead of refused.
    const oversized = refuseOversizedStatement("BoltTransport.run", statement);
    if (oversized !== null) return { ok: false, failure: oversized };

    const driver = this.ensureDriver();
    if (!driver.ok) return driver;

    try {
      const result = await driver.value.executeQuery(statement.text, statement.parameters, {
        database: this.config.database,
      });

      const rows: DecodedRow[] = [];
      for (let rowIndex = 0; rowIndex < result.records.length; rowIndex += 1) {
        const record = result.records[rowIndex];
        if (record === undefined) continue;

        const row: DecodedRow = {};
        for (const key of record.keys) {
          const columnName = String(key);
          const converted = convertBoltValue(
            record.get(columnName),
            `row[${rowIndex}].${columnName}`,
          );
          if (!converted.ok) return converted;
          row[columnName] = converted.value;
        }
        rows.push(row);
      }

      return succeed(rows);
    } catch (caught) {
      return classifyBoltFailure(caught, statement.text);
    }
  }

  async close(): Promise<void> {
    const driver = this.driver;
    this.driver = null;
    if (driver !== null) await driver.close();
  }

  describe(): string {
    return `bolt ${this.config.boltUri} database=${this.config.database}`;
  }

  private ensureDriver(): Result<Driver, Failure> {
    if (this.driver !== null) return succeed(this.driver);

    try {
      // The principal is not checked by the server, only the credential. Sending a
      // recognisable placeholder makes it obvious in a capture that the username
      // carries no meaning here.
      this.driver = neo4j.driver(
        this.config.boltUri,
        neo4j.auth.basic("hydra", this.config.authToken),
        {
          // Plain JavaScript numbers instead of the driver's Integer wrapper. Every
          // id in this graph is a small sequential integer, so there is nothing for
          // the lossless representation to protect.
          disableLosslessIntegers: true,
          connectionTimeout: CONNECTION_TIMEOUT_MS,
          maxConnectionPoolSize: MAX_CONNECTION_POOL_SIZE,
        },
      );
      return succeed(this.driver);
    } catch (caught) {
      return fail(
        "graph_unavailable",
        `[BoltTransport.ensureDriver] cannot construct a Bolt driver for ${this.config.boltUri}: ${describeThrownMessage(caught)}`,
      );
    }
  }
}

const CONNECTION_TIMEOUT_MS = 10_000;
const MAX_CONNECTION_POOL_SIZE = 16;

/**
 * Converts a Bolt value into the same decoded shape the HTTP transport produces, so
 * the gateway above cannot tell which transport answered.
 */
function convertBoltValue(value: unknown, path: string): Result<DecodedValue, Failure> {
  if (value === null || value === undefined) return succeed(null);

  const primitive = typeof value;
  if (primitive === "string" || primitive === "boolean") {
    return succeed(value as string | boolean);
  }
  if (primitive === "number") {
    const numberValue = value as number;
    return Number.isFinite(numberValue)
      ? succeed(numberValue)
      : fail("graph_rejected", `[convertBoltValue] ${path} is a non-finite number`);
  }
  if (primitive === "bigint") {
    const bigintValue = value as bigint;
    return bigintValue <= BigInt(Number.MAX_SAFE_INTEGER) &&
      bigintValue >= BigInt(Number.MIN_SAFE_INTEGER)
      ? succeed(Number(bigintValue))
      : fail("graph_rejected", `[convertBoltValue] ${path} exceeds the safe integer range`);
  }

  if (Array.isArray(value)) {
    const values: DecodedValue[] = [];
    for (let entryIndex = 0; entryIndex < value.length; entryIndex += 1) {
      const converted = convertBoltValue(value[entryIndex], `${path}[${entryIndex}]`);
      if (!converted.ok) return converted;
      values.push(converted.value);
    }
    return succeed(values);
  }

  if (primitive !== "object") {
    return fail("graph_rejected", `[convertBoltValue] ${path} has unsupported type ${primitive}`);
  }

  const record = value as Record<string, unknown>;

  // The driver's Integer wrapper, when lossless integers are left enabled.
  if (typeof record.low === "number" && typeof record.high === "number") {
    return convertIntegerParts(record.low, record.high, path);
  }

  if (Array.isArray(record.segments)) return convertBoltPath(record, path);

  return fail(
    "graph_rejected",
    `[convertBoltValue] ${path} is an object shape this transport does not decode`,
  );
}

function convertIntegerParts(
  low: number,
  high: number,
  path: string,
): Result<number, Failure> {
  // Two's complement 64 bit split into two 32 bit halves.
  const combined = high * 0x1_0000_0000 + (low >>> 0);
  return Number.isSafeInteger(combined)
    ? succeed(combined)
    : fail("graph_rejected", `[convertIntegerParts] ${path} exceeds the safe integer range`);
}

/**
 * Flattens a Bolt path into ordered nodes and relationships. The driver models a
 * path as segments of (start, relationship, end), so the node list is the first
 * segment's start followed by every segment's end.
 */
function convertBoltPath(
  record: Record<string, unknown>,
  path: string,
): Result<DecodedPath, Failure> {
  const segments = record.segments;
  if (!Array.isArray(segments)) {
    return fail("graph_rejected", `[convertBoltPath] ${path} has no segments`);
  }

  const nodes: DecodedPathNode[] = [];
  const relationships: DecodedPathRelationship[] = [];

  const startNode = convertBoltNode(record.start, `${path}.start`);
  if (!startNode.ok) return startNode;
  nodes.push(startNode.value);

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    if (typeof segment !== "object" || segment === null) {
      return fail("graph_rejected", `[convertBoltPath] ${path}.segments[${segmentIndex}] is not an object`);
    }
    const segmentRecord = segment as Record<string, unknown>;

    const relationship = convertBoltRelationship(
      segmentRecord.relationship,
      `${path}.segments[${segmentIndex}].relationship`,
    );
    if (!relationship.ok) return relationship;
    relationships.push(relationship.value);

    const endNode = convertBoltNode(segmentRecord.end, `${path}.segments[${segmentIndex}].end`);
    if (!endNode.ok) return endNode;
    nodes.push(endNode.value);
  }

  return succeed({ nodes, relationships });
}

function convertBoltNode(raw: unknown, path: string): Result<DecodedPathNode, Failure> {
  if (typeof raw !== "object" || raw === null) {
    return fail("graph_rejected", `[convertBoltNode] ${path} is not a node`);
  }
  const record = raw as Record<string, unknown>;

  const identity = convertBoltValue(record.identity, `${path}.identity`);
  if (!identity.ok) return identity;
  if (typeof identity.value !== "number") {
    return fail("graph_rejected", `[convertBoltNode] ${path} has no numeric identity`);
  }

  const labels: string[] = [];
  if (Array.isArray(record.labels)) {
    for (const label of record.labels) if (typeof label === "string") labels.push(label);
  }

  const properties = convertBoltProperties(record.properties, `${path}.properties`);
  if (!properties.ok) return properties;

  return succeed({ id: identity.value, labels, properties: properties.value });
}

function convertBoltRelationship(
  raw: unknown,
  path: string,
): Result<DecodedPathRelationship, Failure> {
  if (typeof raw !== "object" || raw === null) {
    return fail("graph_rejected", `[convertBoltRelationship] ${path} is not a relationship`);
  }
  const record = raw as Record<string, unknown>;

  const relType = record.type;
  if (typeof relType !== "string") {
    return fail("graph_rejected", `[convertBoltRelationship] ${path} has no type`);
  }

  const identity = convertBoltValue(record.identity, `${path}.identity`);
  if (!identity.ok) return identity;

  const start = convertBoltValue(record.start, `${path}.start`);
  if (!start.ok) return start;

  const end = convertBoltValue(record.end, `${path}.end`);
  if (!end.ok) return end;

  if (typeof start.value !== "number" || typeof end.value !== "number") {
    return fail("graph_rejected", `[convertBoltRelationship] ${path} has non-numeric endpoints`);
  }

  const properties = convertBoltProperties(record.properties, `${path}.properties`);
  if (!properties.ok) return properties;

  return succeed({
    id: typeof identity.value === "number" ? identity.value : null,
    relType,
    sourceNodeId: start.value,
    targetNodeId: end.value,
    properties: properties.value,
  });
}

function convertBoltProperties(
  raw: unknown,
  path: string,
): Result<Record<string, DecodedValue>, Failure> {
  if (raw === null || raw === undefined) return succeed({});
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return fail("graph_rejected", `[convertBoltProperties] ${path} is not a property map`);
  }

  const properties: Record<string, DecodedValue> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const converted = convertBoltValue(value, `${path}.${name}`);
    if (!converted.ok) return converted;
    properties[name] = converted.value;
  }
  return succeed(properties);
}

/**
 * Maps a driver error onto a failure reason. The driver reports server rejections as
 * a Neo4jError carrying a status code, and reports transport problems as an error
 * with a code of its own, so both are read from `code`.
 */
function classifyBoltFailure(caught: unknown, queryText: string): Result<never, Failure> {
  const message = describeThrownMessage(caught);
  const code = readErrorCode(caught);
  const context = { queryPrefix: queryText.slice(0, 120), ...(code === null ? {} : { code }) };

  const lowered = `${code ?? ""} ${message}`.toLowerCase();

  if (lowered.includes("unauthor") || lowered.includes("authenticat")) {
    return fail(
      "graph_unavailable",
      "[classifyBoltFailure] HydraDB rejected the credentials, check HYDRA_AUTH_TOKEN",
      { context: code === null ? {} : { code } },
    );
  }
  if (lowered.includes("serviceunavailable") || lowered.includes("econnrefused")) {
    return fail(
      "graph_unavailable",
      `[classifyBoltFailure] cannot reach HydraDB over Bolt: ${message}`,
      { context },
    );
  }
  if (lowered.includes("sessionexpired") || lowered.includes("timeout") || lowered.includes("timed out")) {
    return fail("timeout", `[classifyBoltFailure] Bolt query timed out: ${message}`, { context });
  }
  if (lowered.includes("budget") || lowered.includes("admission") || lowered.includes("exceed")) {
    return fail(
      "query_budget_exceeded",
      `[classifyBoltFailure] traversal exceeded an engine budget: ${message}`,
      { context },
    );
  }
  if (lowered.includes("syntax") || lowered.includes("unsupported") || lowered.includes("invalid")) {
    return fail("graph_rejected", `[classifyBoltFailure] HydraDB rejected the query: ${message}`, {
      context,
    });
  }

  return fail("internal", `[classifyBoltFailure] Bolt query failed: ${message}`, { context });
}

function readErrorCode(caught: unknown): string | null {
  if (typeof caught !== "object" || caught === null || !("code" in caught)) return null;
  const code = (caught as { code: unknown }).code;
  return typeof code === "string" ? code : null;
}

function describeThrownMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : "unknown Bolt failure";
}
