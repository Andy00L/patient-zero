import { describe, expect, test } from "bun:test";

import { RecordingGateway } from "@/lib/graph/recording-gateway";
import {
  NO_OPERATIONS,
  isRecording,
  recordOperation,
  withStatementLog,
} from "@/lib/graph/statements";
import { RecordingTransport } from "@/lib/hydra/recording-transport";
import { type GraphStatement, type GraphTransport, parameterised } from "@/lib/hydra/transport";
import type { DecodedRow } from "@/lib/hydra/wire";
import type { Failure, Result } from "@/lib/result";
import { succeed } from "@/lib/result";

import { buildFixtureGraph } from "./fixtures/graph";

/**
 * The operation record is what turns "a graph engine answered this" from a claim into
 * something a reader can check, so these tests are about the three properties that make it
 * trustworthy rather than about its formatting.
 *
 *   1. A scope records the operations that ran, in order, and says `statement: null` when no
 *      engine was contacted. A record that invented a query for the in-process graph would be
 *      worse than no record at all.
 *   2. Two scopes running at once do not see each other's operations. The gateway is cached at
 *      module scope and shared by every concurrent request, so this is the property the whole
 *      AsyncLocalStorage design exists to hold.
 *   3. Outside a scope, recording costs nothing and changes nothing, which is what lets the
 *      ingest scripts and the rest of the suite use the same gateway untouched.
 */

const OPERATION_CAP = 200;
const STATEMENT_CAP = 1200;

/** A minimal graph. These tests assert on the record, not on what the graph contains. */
function buildGraph() {
  return buildFixtureGraph({
    packages: [{ name: "left" }, { name: "right" }],
    versions: [{ name: "left", version: "1.0.0" }],
  }).graph;
}

/** One entry, with only the field under test varied. */
function entry(overrides: Partial<Parameters<typeof recordOperation>[0]> = {}) {
  return {
    operation: "cypher",
    detail: "no parameters",
    statement: "MATCH (n:Version) RETURN count(*)",
    durationMs: 1,
    resultCount: 1,
    failureReason: null,
    ...overrides,
  };
}

describe("the operation record", () => {
  test("records what ran, in order, with no statement for an in-process answer", async () => {
    const gateway = new RecordingGateway(buildGraph());

    const { value, record } = await withStatementLog(async () => {
      const counted = await gateway.countNodes("Package");
      const listed = await gateway.listNodeIds({ label: "Version", limit: 10 });
      return { counted, listed };
    });

    expect(value.counted.ok).toBe(true);
    expect(value.listed.ok).toBe(true);

    expect(record.operations.map((operation) => operation.operation)).toEqual([
      "countNodes",
      "listNodeIds",
    ]);
    expect(record.operations.map((operation) => operation.sequence)).toEqual([1, 2]);
    // The in-process graph speaks no Cypher, and the record says so rather than printing a
    // statement no engine ever received.
    expect(record.operations.every((operation) => operation.statement === null)).toBe(true);
    expect(record.operations.every((operation) => operation.failureReason === null)).toBe(true);
    expect(record.wasCapped).toBe(false);
  });

  test("carries the failure reason and a negative count when a call fails", async () => {
    const gateway = new RecordingGateway(buildGraph());

    // A limit of zero is rejected rather than answered with an empty list, which is the one
    // failure the in-process graph can raise on its own.
    const { value, record } = await withStatementLog(() =>
      gateway.listNodeIds({ label: "Package", limit: 0 }),
    );

    expect(value.ok).toBe(false);
    expect(record.operations).toHaveLength(1);
    // Negative one rather than zero: a failed call returned no rows, and zero rows is a
    // reading a successful call can also produce.
    expect(record.operations[0]?.resultCount).toBe(-1);
    expect(record.operations[0]?.failureReason).toBe("invalid_input");
  });

  test("keeps concurrent scopes apart", async () => {
    const gateway = new RecordingGateway(buildGraph());

    const readOne = withStatementLog(async () => {
      await gateway.countNodes("Package");
      // Yields to the other scope mid-answer, which is exactly when a process-wide buffer
      // would start attributing one reader's queries to the other's answer.
      await Promise.resolve();
      await gateway.countNodes("Version");
    });
    const readTwo = withStatementLog(() => gateway.listNodeIds({ label: "Package", limit: 5 }));

    const [first, second] = await Promise.all([readOne, readTwo]);

    expect(first.record.operations.map((operation) => operation.operation)).toEqual([
      "countNodes",
      "countNodes",
    ]);
    expect(second.record.operations.map((operation) => operation.operation)).toEqual([
      "listNodeIds",
    ]);
  });

  test("records nothing, and reports nothing, outside a scope", async () => {
    const gateway = new RecordingGateway(buildGraph());

    expect(isRecording()).toBe(false);
    recordOperation(entry());

    const counted = await gateway.countNodes("Package");
    expect(counted.ok).toBe(true);

    // The only observable effect of being outside a scope: the next scope opened is clean.
    const { record } = await withStatementLog(async () => undefined);
    expect(record).toEqual(NO_OPERATIONS);
  });

  test("caps the list and says that it did", async () => {
    const { record } = await withStatementLog(async () => {
      for (let index = 0; index < OPERATION_CAP + 3; index += 1) {
        recordOperation(entry({ detail: `read ${index}` }));
      }
    });

    expect(record.operations).toHaveLength(OPERATION_CAP);
    expect(record.wasCapped).toBe(true);
    expect(record.totalDurationMs).toBe(OPERATION_CAP);
  });

  test("collapses whitespace and truncates a long statement with a marker", async () => {
    const longChain = `MATCH (n:Package)\n  WHERE ${"n.key = 'npm:a' OR ".repeat(200)}false`;
    expect(longChain.length).toBeGreaterThan(STATEMENT_CAP);

    const { record } = await withStatementLog(async () => {
      recordOperation(entry({ statement: "MATCH (n:Version)\n  RETURN count(*)" }));
      recordOperation(entry({ statement: longChain }));
    });

    expect(record.operations[0]?.statement).toBe("MATCH (n:Version) RETURN count(*)");

    const truncated = record.operations[1]?.statement ?? "";
    expect(truncated.endsWith(" ... (truncated)")).toBe(true);
    expect(truncated).toContain("MATCH (n:Package) WHERE n.key = 'npm:a'");
    expect(truncated.length).toBe(STATEMENT_CAP + " ... (truncated)".length);
  });
});

/**
 * A transport that answers nothing and remembers what it was asked.
 *
 * Deliberately not a mock of the real transports: what is under test is the recording, and a
 * transport that reached a socket would test the socket instead.
 */
class SilentTransport implements GraphTransport {
  readonly received: GraphStatement[] = [];

  async run(statement: GraphStatement): Promise<Result<DecodedRow[], Failure>> {
    this.received.push(statement);
    return succeed([]);
  }

  async close(): Promise<void> {}

  describe(): string {
    return "silent";
  }
}

describe("the recording transport", () => {
  test("records the statement it sent and the names of its parameters, never their values", async () => {
    const inner = new SilentTransport();
    const transport = new RecordingTransport(inner);
    const secret = "s3cret-looking-payload";

    const { record } = await withStatementLog(() =>
      transport.run(
        parameterised("MATCH (n:Package) WHERE n.key = $key RETURN n.key", {
          key: secret,
          limit: 10,
        }),
      ),
    );

    expect(inner.received).toHaveLength(1);
    expect(record.operations).toHaveLength(1);

    const operation = record.operations[0];
    expect(operation?.operation).toBe("cypher");
    expect(operation?.statement).toBe("MATCH (n:Package) WHERE n.key = $key RETURN n.key");
    // Sorted, so the line reads the same whichever order the builder happened to insert them.
    expect(operation?.detail).toBe("parameters key, limit");
    // The one assertion this test exists for: a parameter value never reaches the record, so
    // an ingest payload cannot arrive on a page through the provenance panel.
    expect(JSON.stringify(record)).not.toContain(secret);
  });

  test("delegates untouched when no scope is open", async () => {
    const inner = new SilentTransport();
    const transport = new RecordingTransport(inner);

    const ran = await transport.run(parameterised("RETURN 1", {}));

    expect(ran.ok).toBe(true);
    expect(inner.received).toHaveLength(1);
    expect(transport.describe()).toBe("silent");
  });
});
