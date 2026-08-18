import { describe, expect, test } from "bun:test";

import { packageKey, serviceKey } from "@/lib/graph/model";
import {
  SLICE_MANIFEST_VERSION,
  type SliceManifest,
  mergeSliceCoverage,
} from "@/lib/graph/slice-manifest";

/**
 * The coverage rule, tested directly because it now has two callers that reach it from opposite
 * directions.
 *
 * The snapshot merge unions two files and its own suite covers that path end to end. The live
 * seed unions what it just pushed with whatever the previous ingest into the same engine
 * recorded, and there the two records are deliberately lopsided: the registry ingest observes no
 * service at all, and the incident packs observe no closure over the registry. A rule that let
 * either side's silence overwrite the other side's claim would either erase 30 services or
 * report a closure nobody read.
 *
 * Weaker-wins is the direction that matters. A claim that is too weak makes an answer abstain,
 * which is visible and recoverable. A claim that is too strong makes an empty traversal read as
 * `not_exposed`, which is the one failure this project exists to prevent.
 * sourceRef: src/lib/graph/coverage-record.ts recordLiveGraphCoverage.
 */

const GENERATED_AT_MS = 1_787_007_692_504;

const EVENT_STREAM = packageKey("npm", "event-stream");
const CHALK = packageKey("npm", "chalk");
const FLATMAP = packageKey("npm", "flatmap-stream");
const REQUESTS = packageKey("pypi", "requests");

const LEDGER_API = serviceKey("ledger-api");
const CHECKOUT_API = serviceKey("checkout-api");

function buildManifest(overrides: Partial<SliceManifest> = {}): SliceManifest {
  return {
    version: SLICE_MANIFEST_VERSION,
    generatedAtMs: GENERATED_AT_MS,
    ecosystems: ["npm"],
    closedPackageKeys: [],
    partialPackageKeys: [],
    closedServiceKeys: [],
    counts: {
      packages: 0,
      versions: 0,
      maintainers: 0,
      services: 0,
      advisories: 0,
      resolutionEdges: 0,
    },
    notes: [],
    ...overrides,
  };
}

/** What the registry ingest records: closure over packages, and no service anywhere. */
const INGEST_RECORD = buildManifest({
  ecosystems: ["npm", "pypi"],
  closedPackageKeys: [CHALK, EVENT_STREAM],
  partialPackageKeys: [REQUESTS],
  closedServiceKeys: [],
});

/** What an incident seed records: the services its packs pin, and no registry closure. */
const SEED_RECORD = buildManifest({
  ecosystems: ["npm"],
  closedPackageKeys: [],
  partialPackageKeys: [EVENT_STREAM, FLATMAP],
  closedServiceKeys: [LEDGER_API, CHECKOUT_API],
});

describe("merging two records of one graph", () => {
  test("a claim only one side makes survives, and a claim both make takes the weaker one", () => {
    const merged = mergeSliceCoverage(INGEST_RECORD, SEED_RECORD);

    // Closed on the ingest side, partial on the seed side: partial wins. The ingest read the
    // package's dependency closure; the seed only knows the versions its packs name.
    expect(merged.partialPackageKeys).toEqual([EVENT_STREAM, FLATMAP, REQUESTS]);
    // Named by one side only, so its claim stands: absence is not a claim about a key.
    expect(merged.closedPackageKeys).toEqual([CHALK]);
    // The defect this fixes: the ingest record names no service, and merging it must not
    // erase the services the seed pinned.
    expect(merged.closedServiceKeys).toEqual([CHECKOUT_API, LEDGER_API]);
    expect(merged.ecosystems).toEqual(["npm", "pypi"]);
  });

  test("the outcome does not depend on which record arrives first", () => {
    const forward = mergeSliceCoverage(INGEST_RECORD, SEED_RECORD);
    const backward = mergeSliceCoverage(SEED_RECORD, INGEST_RECORD);

    // Order is not a property of the graph. The ingest runs before the seed on one machine and
    // after it on another, and a coverage claim that changed with the run order would make the
    // same graph answer two different ways.
    expect(backward.closedPackageKeys).toEqual(forward.closedPackageKeys);
    expect(backward.partialPackageKeys).toEqual(forward.partialPackageKeys);
    expect(backward.closedServiceKeys).toEqual(forward.closedServiceKeys);
    expect([...backward.ecosystems].sort()).toEqual([...forward.ecosystems].sort());
  });

  test("merging a record with nothing in it changes no claim", () => {
    // The first live seed into a fresh engine finds no manifest on disk and merges against an
    // empty one. That has to be identity, or a first seed would report weaker coverage than the
    // second seed of the same packs.
    const merged = mergeSliceCoverage(buildManifest({ ecosystems: [] }), SEED_RECORD);

    expect(merged.closedPackageKeys).toEqual([]);
    expect(merged.partialPackageKeys).toEqual([EVENT_STREAM, FLATMAP]);
    expect(merged.closedServiceKeys).toEqual([CHECKOUT_API, LEDGER_API]);
    expect(merged.ecosystems).toEqual(["npm"]);
  });

  test("a key claimed twice on the same side is stated once", () => {
    const duplicated = buildManifest({
      closedPackageKeys: [CHALK, CHALK],
      closedServiceKeys: [LEDGER_API, LEDGER_API],
    });
    const merged = mergeSliceCoverage(duplicated, duplicated);

    // Two rows for one key would make a count of covered packages read high, and the counts
    // beside them are read off the graph, so the two would disagree.
    expect(merged.closedPackageKeys).toEqual([CHALK]);
    expect(merged.closedServiceKeys).toEqual([LEDGER_API]);
  });
});
