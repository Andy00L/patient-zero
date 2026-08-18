import { describe, expect, test } from "bun:test";

import { NODE_PROPERTY_NAMES, type NodeLabel } from "@/lib/graph/model";
import { MAX_QUERY_TEXT_BYTES } from "@/lib/hydra/config";
import {
  buildMultiSourcePathStatement,
  buildReadNodesStatement,
  packStatements,
} from "@/lib/hydra/cypher";
import {
  type GraphStatement,
  measureQueryTextBytes,
  refuseOversizedStatement,
} from "@/lib/hydra/transport";
import { fail, succeed } from "@/lib/result";

/**
 * The query text limit, from both sides: the guard that refuses an oversized statement and
 * the packer that keeps one from being built.
 *
 * This limit is the reason five surfaces once answered "could not be ranked" against a live
 * engine while every static check passed. Over 1,024 bytes the engine parses a statement
 * truncated rather than refusing it, so the failure arrives as a parse error about wherever
 * the cut landed, which is a different message for every statement and never mentions length.
 * sourceRef: src/lib/hydra/config.ts MAX_QUERY_TEXT_BYTES.
 *
 * The assertions that matter are the two that a chunk-size constant would pass while still
 * being wrong: every statement the packer emits fits, and no chunk could hold one more item.
 * The first catches a budget that is too generous for one label, the second catches a bisect
 * that closes chunks early, which costs round trips and shows up in nothing but latency.
 */

/** A statement whose text is exactly `bytes` long, padded where padding changes nothing. */
function statementOfLength(bytes: number): GraphStatement {
  const prefix = "MATCH (n:Package {id: 1}) RETURN n.id AS id";
  return { text: prefix.padEnd(bytes, " "), parameters: {} };
}

describe("refuseOversizedStatement", () => {
  test("accepts the measured limit and refuses one byte past it", () => {
    expect(refuseOversizedStatement("test", statementOfLength(MAX_QUERY_TEXT_BYTES))).toBeNull();

    const refused = refuseOversizedStatement("test", statementOfLength(MAX_QUERY_TEXT_BYTES + 1));
    expect(refused?.reason).toBe("query_budget_exceeded");
    expect(refused?.context?.queryTextBytes).toBe(MAX_QUERY_TEXT_BYTES + 1);
  });

  test("names the byte count without quoting the statement", () => {
    const refused = refuseOversizedStatement("test", statementOfLength(2_000));
    expect(refused?.message).toContain("2000 bytes");
    // Package names from a registry travel inside statement text, and this message reaches a
    // browser. The count is what a caller acts on; the text is not.
    expect(refused?.message).not.toContain("MATCH");
  });
});

describe("packStatements", () => {
  const NODE_IDS = Array.from({ length: 400 }, (_, index) => index * 977 + 1);

  /** The packer over the real read builder, for the label with the widest projection list. */
  function packRead(label: NodeLabel, nodeIds: readonly number[]) {
    return packStatements("test", nodeIds, (chunk) =>
      buildReadNodesStatement(label, NODE_PROPERTY_NAMES[label], chunk),
    );
  }

  test("emits nothing for an empty list", () => {
    const packed = packRead("Package", []);
    expect(packed.ok && packed.value).toEqual([]);
  });

  test.each(Object.keys(NODE_PROPERTY_NAMES) as NodeLabel[])(
    "packs a %s read into statements the engine accepts",
    (label) => {
      const packed = packRead(label, NODE_IDS);
      if (!packed.ok) throw new Error(packed.failure.message);

      expect(packed.value.length).toBeGreaterThan(1);
      for (const statement of packed.value) {
        expect(measureQueryTextBytes(statement.text)).toBeLessThanOrEqual(MAX_QUERY_TEXT_BYTES);
      }
    },
  );

  test("covers every id exactly once, in order", () => {
    const packed = packRead("Advisory", NODE_IDS);
    if (!packed.ok) throw new Error(packed.failure.message);

    // Read back off the emitted text rather than off the chunk sizes: a packer that dropped
    // the tail of a chunk would still report the right counts.
    const seen = packed.value.flatMap((statement) =>
      [...statement.text.matchAll(/n\.id = (\d+)|\{id: (\d+)\}/g)].map((match) =>
        Number(match[1] ?? match[2]),
      ),
    );
    expect(seen).toEqual(NODE_IDS);
  });

  test("fills each statement, so no chunk could hold one more id", () => {
    const packed = packRead("Advisory", NODE_IDS);
    if (!packed.ok) throw new Error(packed.failure.message);

    let consumed = 0;
    for (const [index, statement] of packed.value.entries()) {
      const idCount = [...statement.text.matchAll(/n\.id = \d+/g)].length || 1;
      consumed += idCount;
      const isLast = index === packed.value.length - 1;
      if (isLast) break;

      const oneMore = buildReadNodesStatement(
        "Advisory",
        NODE_PROPERTY_NAMES.Advisory,
        NODE_IDS.slice(consumed - idCount, consumed + 1),
      );
      if (!oneMore.ok) throw new Error(oneMore.failure.message);
      expect(measureQueryTextBytes(oneMore.value.text)).toBeGreaterThan(MAX_QUERY_TEXT_BYTES);
    }
    expect(consumed).toBe(NODE_IDS.length);
  });

  test("refuses a list whose first item cannot fit on its own", () => {
    const packed = packStatements("test", [1, 2], () => succeed(statementOfLength(2_000)));
    expect(packed.ok).toBe(false);
    if (packed.ok) return;
    expect(packed.failure.reason).toBe("query_budget_exceeded");
    expect(packed.failure.context?.itemIndex).toBe(0);
  });

  test("returns a build failure as it stands rather than shrinking the chunk", () => {
    const packed = packStatements("test", [1, 2, 3], () =>
      fail("invalid_input", "[test] a literal outside the allowlist"),
    );
    expect(packed.ok).toBe(false);
    if (packed.ok) return;
    expect(packed.failure.reason).toBe("invalid_input");
  });

  test("packs the worm pack's source keys, which one statement cannot carry", () => {
    // 84 compromised artifacts is the shipped worm pack, and the traversal inlines every key
    // as a string literal. This is the demo's cold open. sourceRef: data/incidents.
    const sourceKeys = Array.from(
      { length: 84 },
      (_, index) => `npm:@scope/compromised-package-${index}@1.2.${index}`,
    );

    const packed = packStatements("test", sourceKeys, (chunk) =>
      buildMultiSourcePathStatement({
        sourceLabel: "Version",
        sourceProperty: "key",
        sourceValues: chunk,
        relTypes: ["DEPENDED_ON_BY", "RESOLVED"],
        direction: "incoming",
        maxLength: 8,
        pathCount: 64,
      }),
    );
    if (!packed.ok) throw new Error(packed.failure.message);

    expect(packed.value.length).toBeGreaterThan(1);
    for (const statement of packed.value) {
      expect(measureQueryTextBytes(statement.text)).toBeLessThanOrEqual(MAX_QUERY_TEXT_BYTES);
    }

    // Each statement keeps the full path budget: the caller's pathCount is a per-request cap,
    // not a total to divide by however the keys happened to group.
    for (const statement of packed.value) expect(statement.text).toContain("pathCount: 64");

    const inlined = packed.value.flatMap((statement) =>
      [...statement.text.matchAll(/"(npm:[^"]+)"/g)].map((match) => match[1]),
    );
    expect(inlined).toEqual(sourceKeys);
  });
});
