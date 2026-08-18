import { describe, expect, test } from "bun:test";

import {
  type DecodedPath,
  asDecodedPath,
  decodeRow,
  decodeWireValue,
} from "@/lib/hydra/wire";

/**
 * The HTTP wire decoder, against responses captured verbatim from a running engine.
 *
 * This file exists because of a defect that every static check passed: the decoder read a path
 * node's property map with the cell decoder, which looks for a `type` key. A property value has
 * no `type` key, so every property of every node of every path was reported as unsupported and
 * every traversal against a live engine failed, while the whole suite stayed green because no
 * test had ever fed the decoder raw HTTP JSON.
 *
 * The engine emits two taggings, and the reason they differ is a serde container attribute that
 * is present on one type and absent on the other, so no amount of reading one of them tells you
 * about the other:
 *
 *   a result cell   internally tagged, snake_case:  {"type": "string", "value": "npm"}
 *   a property      externally tagged, PascalCase:  {"String": "npm"}
 *
 * Every fixture below is a response body copied out of a live `POST /v1/graphs/default/query`,
 * not a shape written from the Rust source. That is deliberate: the bug was a wrong belief about
 * the wire, and a fixture written from the same belief would have reproduced it.
 * sourceRef: src/lib/hydra/wire.ts, docs/HYDRADB.md section 4.
 */

/**
 * `CALL algo.SSpaths({sourceNode: 182, relTypes: ["RESOLVED"], relDirection: "outgoing",
 * maxLen: 1, pathCount: 4}) YIELD path RETURN path`, first row, verbatim.
 *
 * Both taggings appear in it, which is what makes it the fixture worth keeping: the cell is
 * `{"type": "path", "value": ...}`, the node ids inside are bare JSON numbers with no envelope
 * at all, and the properties are one-key PascalCase objects.
 */
const CAPTURED_PATH_CELL = {
  type: "path",
  value: {
    nodes: [
      {
        id: 182,
        labels: ["Service"],
        properties: {
          key: { String: "svc:build-agent" },
          name: { String: "build-agent" },
          source: { String: "seed" },
        },
      },
      {
        id: 56,
        labels: ["Version"],
        properties: {
          ecosystem: { String: "npm" },
          has_install_script: { Bool: false },
          key: { String: "npm:event-stream:3.3.6" },
          name: { String: "event-stream" },
          published_at_ms: { Integer: 1536481739503 },
          version: { String: "3.3.6" },
        },
      },
    ],
    relationships: [
      {
        id: 726,
        edge_type: "RESOLVED",
        src: 182,
        dst: 56,
        properties: {
          id: { Integer: 130 },
          resolved_at_ms: { Integer: 1538489111000 },
        },
      },
    ],
  },
};

/**
 * `MATCH (v:Version {key: "npm:event-stream:3.3.6"}) RETURN v.id AS id, v.key AS key,
 * v.published_at_ms AS at, v.has_install_script AS hook, v.nope AS missing`, verbatim.
 *
 * The last cell is the one to notice: an absent property comes back as `{"type": "null"}` with
 * no `value` key whatsoever, so a decoder that read `value` before switching on the tag would
 * be reading a key that is not there.
 */
const CAPTURED_SCALAR_ROW = {
  columns: ["id", "key", "at", "hook", "missing"],
  cells: [
    { type: "vertex_id", value: 56 },
    { type: "string", value: "npm:event-stream:3.3.6" },
    { type: "integer", value: 1536481739503 },
    { type: "boolean", value: false },
    { type: "null" },
  ],
};

/** `MATCH (s:Service) RETURN collect(s.key) AS keys`, first three entries of the list cell. */
const CAPTURED_LIST_CELL = {
  type: "list",
  value: [
    { type: "string", value: "svc:jobs-runner" },
    { type: "string", value: "svc:build-agent" },
    { type: "string", value: "svc:asset-pipeline" },
  ],
};

function decodePathOrFail(raw: unknown): DecodedPath {
  const decoded = decodeWireValue(raw, "captured");
  if (!decoded.ok) throw new Error(`the captured path did not decode: ${decoded.failure.message}`);
  const path = asDecodedPath(decoded.value);
  if (path === null) throw new Error("the captured path decoded to something that is not a path");
  return path;
}

describe("a captured path cell", () => {
  test("decodes into the nodes, the edge, and every property of both taggings", () => {
    const path = decodePathOrFail(CAPTURED_PATH_CELL);

    expect(path.nodes.map((node) => node.id)).toEqual([182, 56]);
    expect(path.nodes.map((node) => node.labels)).toEqual([["Service"], ["Version"]]);

    // The three property types the graph actually writes, each read off the PascalCase form.
    // A string, because keys are how every answer names a package; a bool, because
    // has_install_script decides whether a payload ran at install time; and an epoch, because
    // the whole bitemporal claim rests on it.
    expect(path.nodes[0]?.properties.key).toBe("svc:build-agent");
    expect(path.nodes[1]?.properties.has_install_script).toBe(false);
    expect(path.nodes[1]?.properties.published_at_ms).toBe(1536481739503);

    expect(path.relationships).toHaveLength(1);
    expect(path.relationships[0]?.relType).toBe("RESOLVED");
    expect(path.relationships[0]?.sourceNodeId).toBe(182);
    expect(path.relationships[0]?.targetNodeId).toBe(56);
    // The instant the lockfile pinned this version. Resolved-while-live is decided from it, so
    // a property that decoded to null here would turn a real exposure into an abstention.
    expect(path.relationships[0]?.properties.resolved_at_ms).toBe(1538489111000);
  });

  test("keeps the engine's own relationship id apart from the id the ingest wrote", () => {
    const path = decodePathOrFail(CAPTURED_PATH_CELL);

    // The wire `id` is the engine's, assigned on write. The `properties.id` is the ingest's own
    // and is a different number on the same edge. Reading one where the other is meant would be
    // silent, so the capture keeps both and this states which is which.
    expect(path.relationships[0]?.id).toBe(726);
    expect(path.relationships[0]?.properties.id).toBe(130);
  });
});

describe("the two taggings are two formats", () => {
  test("a property value refuses to decode as a result cell", () => {
    // The exact defect, stated as a test. `{"String": "npm"}` is a valid property value and is
    // not a cell, and the cell decoder has to say so rather than pass it through as an object.
    const decoded = decodeWireValue({ String: "npm" }, "cell");

    expect(decoded.ok).toBe(false);
    expect(decoded.ok ? "" : decoded.failure.reason).toBe("graph_rejected");
    expect(decoded.ok ? "" : decoded.failure.message).toContain("no type tag");
  });

  test("a property naming a variant this build does not know is refused, not emptied", () => {
    const decoded = decodeWireValue(
      { type: "path", value: { nodes: [{ id: 1, labels: [], properties: { x: { Bytes: [] } } }], relationships: [] } },
      "cell",
    );

    // Refused rather than decoded to `{}`: a property that quietly becomes an empty object
    // reaches a surface as a rendered value with no reading in it, which is worse than an error.
    expect(decoded.ok).toBe(false);
    expect(decoded.ok ? "" : decoded.failure.message).toContain("Bytes");
  });
});

describe("a captured scalar row", () => {
  test("decodes every cell tagging the engine emitted, including a null with no value key", () => {
    const row = decodeRow(CAPTURED_SCALAR_ROW.columns, CAPTURED_SCALAR_ROW.cells, 0);
    if (!row.ok) throw new Error(`the captured row did not decode: ${row.failure.message}`);

    expect(row.value).toEqual({
      id: 56,
      key: "npm:event-stream:3.3.6",
      at: 1536481739503,
      hook: false,
      // Null, not undefined and not absent: the column was returned and its answer is "no
      // reading", which is a different claim from a column the query never asked for.
      missing: null,
    });
  });

  test("a row whose cell count disagrees with its columns is refused", () => {
    const row = decodeRow(["a", "b"], [{ type: "integer", value: 1 }], 7);

    expect(row.ok).toBe(false);
    expect(row.ok ? "" : row.failure.message).toContain("row 7");
  });
});

describe("a captured list cell", () => {
  test("decodes its entries with the cell tagging, not the property tagging", () => {
    const decoded = decodeWireValue(CAPTURED_LIST_CELL, "cell");
    if (!decoded.ok) throw new Error(`the captured list did not decode: ${decoded.failure.message}`);

    expect(decoded.value).toEqual(["svc:jobs-runner", "svc:build-agent", "svc:asset-pipeline"]);
  });
});

describe("integers that would lose precision", () => {
  test("a vertex id above the safe range is refused rather than rounded", () => {
    // A rounded node id is a node id that points at a different package, so this is refused
    // even though our own ids are sequential and could never reach it. A shared graph can.
    const decoded = decodeWireValue({ type: "vertex_id", value: 9007199254740993 }, "cell");

    expect(decoded.ok).toBe(false);
    expect(decoded.ok ? "" : decoded.failure.message).toContain("not a safe integer");
  });

  test("a u64 sent as a string is read, so long as it is exact", () => {
    const decoded = decodeWireValue({ type: "integer", value: "1536481739503" }, "cell");

    expect(decoded.ok ? decoded.value : null).toBe(1536481739503);
  });
});
