import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { type Ecosystem, isEcosystem } from "@/lib/graph/model";
import { type Failure, type Result, fail, fromThrowing, succeed } from "@/lib/result";

/**
 * The slice manifest: what the ingested graph actually covers.
 *
 * This project answers questions over a curated slice of npm, not over all of it.
 * Without a record of what was ingested, an empty traversal result is ambiguous:
 * it could mean "nothing depends on this" or "we never loaded the dependents". The
 * manifest is what lets the abstention model tell those two apart, so it is not
 * bookkeeping, it is a correctness requirement.
 *
 * Written by the ingest scripts, read by the analysis layer.
 */

/** How completely one package or service is represented in the graph. */
export type Coverage =
  /** The full transitive closure was resolved and loaded. A negative answer is real. */
  | "closed"
  /** Present, but the closure was cut short by a depth or budget limit. */
  | "partial"
  /**
   * The manifest makes no coverage claim about it, so every answer about it is unknown.
   *
   * This is not the same as "not in the graph". A dependency expansion that stops at its depth
   * budget still writes a stub node for the package it stopped at, so the shipped slice holds
   * hundreds of Package nodes the ingest never fetched: they exist, they carry a key, and they
   * have no out-edges. Their emptiness is the budget, not the registry. Reporting them as absent
   * is what keeps a traversal that ends on one of them from reading as a real negative.
   */
  | "absent";

export type SliceManifest = {
  version: number;
  /** When this slice was built, epoch milliseconds. */
  generatedAtMs: number;
  ecosystems: Ecosystem[];
  /** Natural package keys whose full closure was ingested, e.g. "npm:chalk". */
  closedPackageKeys: string[];
  /** Natural package keys present with a truncated closure. */
  partialPackageKeys: string[];
  /** Natural service keys whose lockfile was fully resolved into the graph. */
  closedServiceKeys: string[];
  counts: SliceCounts;
  /** Ingestion problems worth disclosing in the UI and the README. */
  notes: string[];
};

export type SliceCounts = {
  packages: number;
  versions: number;
  maintainers: number;
  services: number;
  advisories: number;
  resolutionEdges: number;
};

export const SLICE_MANIFEST_VERSION = 1;
export const DEFAULT_SLICE_MANIFEST_PATH = "data/graph/slice-manifest.json";

export const EMPTY_SLICE_COUNTS: SliceCounts = {
  packages: 0,
  versions: 0,
  maintainers: 0,
  services: 0,
  advisories: 0,
  resolutionEdges: 0,
};

/**
 * Membership lookups over a manifest. Built once and reused, because a linear scan
 * of a 10,000 entry array on every query would dominate the query cost it is
 * supposed to qualify.
 */
export class SliceCoverage {
  private readonly closedPackages: Set<string>;
  private readonly partialPackages: Set<string>;
  private readonly closedServices: Set<string>;

  constructor(private readonly manifest: SliceManifest) {
    this.closedPackages = new Set(manifest.closedPackageKeys);
    this.partialPackages = new Set(manifest.partialPackageKeys);
    this.closedServices = new Set(manifest.closedServiceKeys);
  }

  get counts(): SliceCounts {
    return this.manifest.counts;
  }

  get generatedAtMs(): number {
    return this.manifest.generatedAtMs;
  }

  get notes(): readonly string[] {
    return this.manifest.notes;
  }

  get ecosystems(): readonly Ecosystem[] {
    return this.manifest.ecosystems;
  }

  describePackageCoverage(packageKey: string): Coverage {
    if (this.closedPackages.has(packageKey)) return "closed";
    if (this.partialPackages.has(packageKey)) return "partial";
    return "absent";
  }

  describeServiceCoverage(serviceKey: string): Coverage {
    return this.closedServices.has(serviceKey) ? "closed" : "absent";
  }

  /** True when the graph holds no data at all, so every answer must abstain. */
  get isEmpty(): boolean {
    return this.manifest.counts.versions === 0;
  }
}

/** The coverage half of a manifest: which subjects it claims, and how completely. */
export type SliceCoverageClaims = {
  ecosystems: Ecosystem[];
  closedPackageKeys: string[];
  partialPackageKeys: string[];
  closedServiceKeys: string[];
};

/**
 * Merges the coverage claims of two manifests that describe one graph.
 *
 * Called from two places that both hold two records of the same graph: the snapshot merge,
 * which unions two files, and the live seed, which unions what it just pushed with whatever
 * the last ingest into that engine recorded. One implementation, because two copies of a
 * rule about how strong a claim may be would eventually disagree about it.
 *
 * A subject only one side names keeps that side's claim: "absent" is not a claim, it is what
 * a manifest says about every key it never heard of. A subject both sides name takes the
 * WEAKER claim, so "partial here, closed there" resolves to partial. Never the stronger: a
 * graph that reports a clean negative over data it never fully read is the one failure this
 * project exists to prevent, and coverage is the only thing standing between an empty
 * traversal and a false `not_exposed`.
 *
 * Services have one list, so the only claim expressible about them is "closed" and the
 * weaker-wins rule has nothing to weaken. Their merged list is the union.
 */
export function mergeSliceCoverage(
  first: SliceManifest,
  second: SliceManifest,
): SliceCoverageClaims {
  const claims = readPackageClaims(first);
  for (const [subject, secondCoverage] of readPackageClaims(second)) {
    const firstCoverage = claims.get(subject);
    claims.set(
      subject,
      firstCoverage === undefined ? secondCoverage : weakerCoverage(firstCoverage, secondCoverage),
    );
  }

  const closedPackageKeys: string[] = [];
  const partialPackageKeys: string[] = [];
  for (const [subject, coverage] of [...claims].sort((left, right) =>
    left[0].localeCompare(right[0]),
  )) {
    if (coverage === "closed") closedPackageKeys.push(subject);
    else if (coverage === "partial") partialPackageKeys.push(subject);
  }

  return {
    ecosystems: dedupe([...first.ecosystems, ...second.ecosystems]),
    closedPackageKeys,
    partialPackageKeys,
    closedServiceKeys: dedupe([
      ...first.closedServiceKeys,
      ...second.closedServiceKeys,
    ]).sort(),
  };
}

/** The coverage each manifest claims per package key. Keys it never names are absent. */
function readPackageClaims(manifest: SliceManifest): Map<string, Coverage> {
  const claims = new Map<string, Coverage>();

  for (const packageKeyValue of manifest.closedPackageKeys) claims.set(packageKeyValue, "closed");
  for (const packageKeyValue of manifest.partialPackageKeys) {
    const stated = claims.get(packageKeyValue);
    // A manifest that lists one key as both closed and partial is claiming two things at
    // once, so the weaker claim is what this graph can defend.
    claims.set(packageKeyValue, stated === undefined ? "partial" : weakerCoverage(stated, "partial"));
  }

  return claims;
}

/**
 * Coverage claims ordered weakest first, so merging two claims is an index comparison.
 */
const COVERAGE_WEAKEST_FIRST: readonly Coverage[] = ["absent", "partial", "closed"];

function weakerCoverage(left: Coverage, right: Coverage): Coverage {
  return COVERAGE_WEAKEST_FIRST.indexOf(left) <= COVERAGE_WEAKEST_FIRST.indexOf(right)
    ? left
    : right;
}

/** Keeps the first occurrence of every value, so a merged order stays deterministic. */
function dedupe<TValue>(values: readonly TValue[]): TValue[] {
  return [...new Set(values)];
}

/** A manifest describing an empty graph. Used before the first ingest runs. */
export function buildEmptySliceManifest(generatedAtMs: number): SliceManifest {
  return {
    version: SLICE_MANIFEST_VERSION,
    generatedAtMs,
    ecosystems: [],
    closedPackageKeys: [],
    partialPackageKeys: [],
    closedServiceKeys: [],
    counts: { ...EMPTY_SLICE_COUNTS },
    notes: ["No ingest has run yet, so every answer abstains."],
  };
}

export async function loadSliceManifest(
  path: string = DEFAULT_SLICE_MANIFEST_PATH,
): Promise<Result<SliceManifest, Failure>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (caught) {
    if (isMissingFile(caught)) {
      return fail("not_found", `[loadSliceManifest] no manifest at ${path}, the graph is not ingested`);
    }
    return fail("internal", `[loadSliceManifest] cannot read ${path}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("invalid_input", `[loadSliceManifest] ${path} is not valid JSON`);
  }

  return validateSliceManifest(parsed, path);
}

export async function saveSliceManifest(
  manifest: SliceManifest,
  path: string = DEFAULT_SLICE_MANIFEST_PATH,
): Promise<Result<void, Failure>> {
  const ensured = await fromThrowing(
    "internal",
    `[saveSliceManifest] cannot create ${dirname(path)}`,
    () => mkdir(dirname(path), { recursive: true }).then(() => undefined),
  );
  if (!ensured.ok) return ensured;

  return await fromThrowing("internal", `[saveSliceManifest] cannot write ${path}`, () =>
    writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
  );
}

function validateSliceManifest(parsed: unknown, path: string): Result<SliceManifest, Failure> {
  if (typeof parsed !== "object" || parsed === null) {
    return fail("invalid_input", `[validateSliceManifest] ${path} is not an object`);
  }

  const record = parsed as Record<string, unknown>;
  if (record.version !== SLICE_MANIFEST_VERSION) {
    return fail(
      "invalid_input",
      `[validateSliceManifest] ${path} has version ${String(record.version)}, expected ${SLICE_MANIFEST_VERSION}`,
    );
  }

  const generatedAtMs = record.generatedAtMs;
  if (typeof generatedAtMs !== "number" || !Number.isFinite(generatedAtMs)) {
    return fail("invalid_input", `[validateSliceManifest] ${path} has no generatedAtMs`);
  }

  const ecosystems = readStringArray(record.ecosystems);
  const closedPackageKeys = readStringArray(record.closedPackageKeys);
  const partialPackageKeys = readStringArray(record.partialPackageKeys);
  const closedServiceKeys = readStringArray(record.closedServiceKeys);
  const notes = readStringArray(record.notes);
  if (
    ecosystems === null ||
    closedPackageKeys === null ||
    partialPackageKeys === null ||
    closedServiceKeys === null ||
    notes === null
  ) {
    return fail("invalid_input", `[validateSliceManifest] ${path} has a malformed string array`);
  }

  const unknownEcosystem = ecosystems.find((candidate) => !isEcosystem(candidate));
  if (unknownEcosystem !== undefined) {
    return fail(
      "invalid_input",
      `[validateSliceManifest] ${path} names an unknown ecosystem "${unknownEcosystem}"`,
    );
  }

  const counts = readCounts(record.counts);
  if (counts === null) {
    return fail("invalid_input", `[validateSliceManifest] ${path} has malformed counts`);
  }

  return succeed({
    version: SLICE_MANIFEST_VERSION,
    generatedAtMs,
    ecosystems: ecosystems.filter(isEcosystem),
    closedPackageKeys,
    partialPackageKeys,
    closedServiceKeys,
    counts,
    notes,
  });
}

function readStringArray(candidate: unknown): string[] | null {
  if (!Array.isArray(candidate)) return null;
  const values: string[] = [];
  for (const entry of candidate) {
    if (typeof entry !== "string") return null;
    values.push(entry);
  }
  return values;
}

function readCounts(candidate: unknown): SliceCounts | null {
  if (typeof candidate !== "object" || candidate === null) return null;
  const record = candidate as Record<string, unknown>;

  const counts: SliceCounts = { ...EMPTY_SLICE_COUNTS };
  for (const field of Object.keys(EMPTY_SLICE_COUNTS) as Array<keyof SliceCounts>) {
    const value = record[field];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
    counts[field] = value;
  }
  return counts;
}

function isMissingFile(caught: unknown): boolean {
  return (
    typeof caught === "object" &&
    caught !== null &&
    "code" in caught &&
    (caught as { code: unknown }).code === "ENOENT"
  );
}
