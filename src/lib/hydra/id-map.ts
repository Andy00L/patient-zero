import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { type NodeLabel, mapKey } from "@/lib/graph/model";
import { type Failure, type Result, fail, fromThrowing, succeed } from "@/lib/result";

/**
 * The key-to-id map.
 *
 * HydraDB addresses nodes and relationships by non-negative integer ids, and its
 * Cypher subset matches on that id rather than on a natural key. Every write and
 * every query in this project therefore goes through this map: it is the single
 * translation layer between "npm:chalk:5.3.1" and the integer the engine knows.
 *
 * Ids are assigned sequentially in first-seen order rather than hashed, for two
 * reasons: a hash can collide and would silently merge two unrelated nodes, and a
 * dense id space keeps the engine's compiled adjacency generations compact.
 *
 * Persistence is an append-only TSV so an interrupted ingest can resume without
 * rewriting megabytes, and so a crash cannot truncate previously assigned ids.
 */
export class IdMap {
  private readonly idByMapKey = new Map<string, number>();
  private readonly mapKeyById = new Map<number, string>();
  private nextNodeId: number;
  private nextRelationshipId: number;
  /** Entries assigned since the last flush, in assignment order. */
  private pendingEntries: Array<{ id: number; mapKey: string }> = [];

  constructor(options?: { nextNodeId?: number; nextRelationshipId?: number }) {
    this.nextNodeId = options?.nextNodeId ?? 0;
    this.nextRelationshipId = options?.nextRelationshipId ?? 0;
  }

  /** Number of nodes with an assigned id. */
  get nodeCount(): number {
    return this.idByMapKey.size;
  }

  /** The next relationship id that `assignRelationshipId` will hand out. */
  get relationshipCursor(): number {
    return this.nextRelationshipId;
  }

  get pendingCount(): number {
    return this.pendingEntries.length;
  }

  /**
   * Returns the integer id for a node, or null when the node was never ingested.
   * A null here is what drives the "Unknown" abstention state: the caller must
   * not read it as "not exposed".
   */
  resolve(label: NodeLabel, key: string): number | null {
    return this.idByMapKey.get(mapKey(label, key)) ?? null;
  }

  /** Assigns an id if the node is new, or returns the existing one. Idempotent. */
  assign(label: NodeLabel, key: string): number {
    const composite = mapKey(label, key);
    const existing = this.idByMapKey.get(composite);
    if (existing !== undefined) return existing;

    const assigned = this.nextNodeId;
    this.nextNodeId += 1;
    this.idByMapKey.set(composite, assigned);
    this.mapKeyById.set(assigned, composite);
    this.pendingEntries.push({ id: assigned, mapKey: composite });
    return assigned;
  }

  /** Reverse lookup, used to label query results and paths. */
  describeId(id: number): { label: NodeLabel; key: string } | null {
    const composite = this.mapKeyById.get(id);
    if (composite === undefined) return null;

    const separator = composite.indexOf("|");
    if (separator <= 0) return null;

    return {
      label: composite.slice(0, separator) as NodeLabel,
      key: composite.slice(separator + 1),
    };
  }

  /** Hands out the next relationship id. Relationships need their own id space. */
  assignRelationshipId(): number {
    const assigned = this.nextRelationshipId;
    this.nextRelationshipId += 1;
    return assigned;
  }

  /** Hands out `count` consecutive relationship ids, for batch writes. */
  assignRelationshipIds(count: number): number[] {
    const ids: number[] = [];
    for (let offset = 0; offset < count; offset += 1) ids.push(this.assignRelationshipId());
    return ids;
  }

  /** Used by the loader; does not mark the entry pending. */
  private adopt(id: number, composite: string): void {
    this.idByMapKey.set(composite, id);
    this.mapKeyById.set(id, composite);
    if (id >= this.nextNodeId) this.nextNodeId = id + 1;
  }

  /** Appends everything assigned since the last flush and clears the pending list. */
  async flush(paths: IdMapPaths): Promise<Result<{ appended: number }, Failure>> {
    if (this.pendingEntries.length === 0) {
      return await this.writeState(paths).then((stateResult) =>
        stateResult.ok ? succeed({ appended: 0 }) : stateResult,
      );
    }

    const lines = this.pendingEntries
      .map((entry) => `${entry.id}\t${entry.mapKey}`)
      .join("\n");

    const ensured = await ensureDirectory(paths.nodeIdsFile);
    if (!ensured.ok) return ensured;

    const appended = await fromThrowing("internal", "[IdMap.flush] append failed", () =>
      appendFile(paths.nodeIdsFile, `${lines}\n`, "utf8"),
    );
    if (!appended.ok) return appended;

    const appendedCount = this.pendingEntries.length;
    this.pendingEntries = [];

    const stateWritten = await this.writeState(paths);
    if (!stateWritten.ok) return stateWritten;

    return succeed({ appended: appendedCount });
  }

  private async writeState(paths: IdMapPaths): Promise<Result<void, Failure>> {
    const state: PersistedIngestState = {
      version: ID_MAP_FORMAT_VERSION,
      nextNodeId: this.nextNodeId,
      nextRelationshipId: this.nextRelationshipId,
    };

    const ensured = await ensureDirectory(paths.stateFile);
    if (!ensured.ok) return ensured;

    return await fromThrowing("internal", "[IdMap.writeState] write failed", () =>
      writeFile(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8"),
    );
  }

  /** Rebuilds the in-memory map from the append-only file. */
  static async load(paths: IdMapPaths): Promise<Result<IdMap, Failure>> {
    const stateResult = await readIngestState(paths.stateFile);
    if (!stateResult.ok) return stateResult;

    const idMap = new IdMap({
      nextNodeId: stateResult.value?.nextNodeId ?? 0,
      nextRelationshipId: stateResult.value?.nextRelationshipId ?? 0,
    });

    const rawResult = await readOptionalFile(paths.nodeIdsFile);
    if (!rawResult.ok) return rawResult;
    if (rawResult.value === null) return succeed(idMap);

    let lineNumber = 0;
    for (const line of rawResult.value.split("\n")) {
      lineNumber += 1;
      if (line.length === 0) continue;

      const separator = line.indexOf("\t");
      if (separator <= 0) {
        return fail("invalid_input", `[IdMap.load] malformed line ${lineNumber}: no tab separator`);
      }

      const parsedId = Number.parseInt(line.slice(0, separator), 10);
      if (!Number.isInteger(parsedId) || parsedId < 0) {
        return fail("invalid_input", `[IdMap.load] malformed id on line ${lineNumber}`);
      }

      idMap.adopt(parsedId, line.slice(separator + 1));
    }

    return succeed(idMap);
  }
}

/** Bumped when the on-disk format changes in a way old files cannot satisfy. */
export const ID_MAP_FORMAT_VERSION = 1;

export type IdMapPaths = {
  /** Append-only TSV: "<integer id>\t<Label>|<natural key>". */
  nodeIdsFile: string;
  /** Small JSON sidecar holding the id cursors. */
  stateFile: string;
};

export const DEFAULT_ID_MAP_PATHS: IdMapPaths = {
  nodeIdsFile: "data/graph/node-ids.tsv",
  stateFile: "data/graph/ingest-state.json",
};

type PersistedIngestState = {
  version: number;
  nextNodeId: number;
  nextRelationshipId: number;
};

async function readIngestState(
  path: string,
): Promise<Result<PersistedIngestState | null, Failure>> {
  const rawResult = await readOptionalFile(path);
  if (!rawResult.ok) return rawResult;
  if (rawResult.value === null) return succeed(null);

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawResult.value);
  } catch {
    return fail("invalid_input", `[readIngestState] ${path} is not valid JSON`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    return fail("invalid_input", `[readIngestState] ${path} is not an object`);
  }

  const record = parsed as Record<string, unknown>;
  const version = record.version;
  const nextNodeId = record.nextNodeId;
  const nextRelationshipId = record.nextRelationshipId;

  if (typeof version !== "number" || version !== ID_MAP_FORMAT_VERSION) {
    return fail(
      "invalid_input",
      `[readIngestState] ${path} has format version ${String(version)}, expected ${ID_MAP_FORMAT_VERSION}`,
    );
  }
  if (typeof nextNodeId !== "number" || typeof nextRelationshipId !== "number") {
    return fail("invalid_input", `[readIngestState] ${path} is missing id cursors`);
  }

  return succeed({ version, nextNodeId, nextRelationshipId });
}

/** Reads a file, returning null when it does not exist yet (a cold ingest). */
async function readOptionalFile(path: string): Promise<Result<string | null, Failure>> {
  try {
    return succeed(await readFile(path, "utf8"));
  } catch (caught) {
    if (isMissingFile(caught)) return succeed(null);
    return fail("internal", `[readOptionalFile] cannot read ${path}`);
  }
}

function isMissingFile(caught: unknown): boolean {
  return (
    typeof caught === "object" &&
    caught !== null &&
    "code" in caught &&
    (caught as { code: unknown }).code === "ENOENT"
  );
}

async function ensureDirectory(filePath: string): Promise<Result<void, Failure>> {
  return await fromThrowing("internal", `[ensureDirectory] cannot create ${dirname(filePath)}`, () =>
    mkdir(dirname(filePath), { recursive: true }).then(() => undefined),
  );
}
