import { expect, test } from "bun:test";

import type { GraphProperties, GraphPropertyValue } from "@/lib/graph/gateway";
import {
  mergeGraphSnapshots,
  type MergedGraphSnapshot,
  type PropertyConflict,
} from "@/lib/graph/merge-snapshots";
import {
  advisoryKey,
  maintainerKey,
  packageKey,
  serviceKey,
  UNKNOWN_NUMERIC_VALUE,
  versionKey,
} from "@/lib/graph/model";
import { SLICE_MANIFEST_VERSION, type SliceManifest } from "@/lib/graph/slice-manifest";
import {
  buildGraphSnapshot,
  GRAPH_SNAPSHOT_FORMAT_VERSION,
  type GraphSnapshot,
  type GraphSnapshotEdge,
  type GraphSnapshotNode,
} from "@/lib/graph/snapshot";
import type { Failure, Result } from "@/lib/result";

import { buildFixtureGraph, dependencyEdge, lockfileEdge } from "./fixtures/graph";

/**
 * Merge tests.
 *
 * One thing is being defended here above all others: the two snapshots the demo is built
 * from both describe `npm:event-stream`, and both number their nodes from 0. A merge that
 * unified on ids, or offset them, would leave two disconnected copies of that package, one
 * holding the service resolutions and one holding the dependency edges. Every query would
 * then return half an answer and look healthy doing it, which is worse than refusing to
 * answer. So the first test asserts that the shared package is one node and that the same
 * node carries both halves of its edges.
 *
 * The rest cover what the merge must never decide quietly: an endpoint silently repointed, a
 * second run doubling the graph, a real disagreement swallowed, a placeholder outranking a
 * reading the other input was holding, coverage merged upward into a claim neither side made,
 * and a node with no key folded into an unrelated one.
 */

/** November 2018, inside the real event-stream incident window. Unit: epoch milliseconds. */
const PUBLISHED_AT_MS = 1_542_844_800_000;

/** Fixed clocks, so no assertion depends on when the suite runs. Unit: epoch milliseconds. */
const MANIFEST_GENERATED_AT_MS = 1_543_017_600_000;
const MERGE_GENERATED_AT_MS = 1_543_104_000_000;

const MERGE_SOURCE = "merge-test";

/** The download count only the registry half reports. The incident half never reads one. */
const INGEST_WEEKLY_DOWNLOADS = 4200;

/** Two download counts that are both real readings, so they disagree rather than abstain. */
const FIRST_REAL_WEEKLY_DOWNLOADS = 1_900_000;
const SECOND_REAL_WEEKLY_DOWNLOADS = 5_273_980;

/** Two advisory summaries, both stated. The real inputs disagree here 48 times over. */
const ADVISORY_SUMMARY = "event-stream 3.3.6 depends on flatmap-stream, which ships a payload";
const OTHER_ADVISORY_SUMMARY = "Critical severity vulnerability in event-stream";

/**
 * What one side of a property test reads. Every field is optional: an omitted property takes
 * the fixture default, which is identical on both sides and so cannot become a conflict the
 * test did not ask for. Property names are the ones stored in the graph.
 */
type PropertyReadings = {
  weekly_downloads?: number;
  has_install_script?: boolean;
  summary?: string;
};

const PATIENT_ZERO_PACKAGE_KEY = packageKey("npm", "event-stream");
const PATIENT_ZERO_VERSION_KEY = versionKey("npm", "event-stream", "3.3.6");
const PAYLOAD_PACKAGE_KEY = packageKey("npm", "flatmap-stream");
const PAYLOAD_VERSION_KEY = versionKey("npm", "flatmap-stream", "0.1.1");
const SERVICE_KEY = serviceKey("svc:checkout");
const ADVISORY_KEY = advisoryKey("GHSA-test-0001");
const MAINTAINER_KEY = maintainerKey("npm", "right9ctrl");

function readValueOrUnreachable<TValue>(result: Result<TValue, Failure>, context: string): TValue {
  if (result.ok) return result.value;
  return expect.unreachable(`${context}: ${result.failure.message}`);
}

function buildManifest(overrides: Partial<SliceManifest> = {}): SliceManifest {
  return {
    version: SLICE_MANIFEST_VERSION,
    generatedAtMs: MANIFEST_GENERATED_AT_MS,
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

/**
 * The incident half: one compromised version, the service that pinned it, and the advisory.
 * No dependency edge, exactly like the real `seed-incidents` snapshot.
 */
function buildIncidentSnapshot(manifest: SliceManifest = buildManifest()): GraphSnapshot {
  const fixture = buildFixtureGraph({
    packages: [{ name: "event-stream", weekly_downloads: UNKNOWN_NUMERIC_VALUE }],
    versions: [{ name: "event-stream", version: "3.3.6", published_at_ms: PUBLISHED_AT_MS }],
    services: [{ name: "svc:checkout" }],
    advisories: [{ ghsa_id: "GHSA-test-0001" }],
    edges: [
      {
        relType: "VERSION_OF",
        fromKey: PATIENT_ZERO_VERSION_KEY,
        toKey: PATIENT_ZERO_PACKAGE_KEY,
        properties: {},
      },
      lockfileEdge("svc:checkout", PATIENT_ZERO_VERSION_KEY),
      {
        relType: "AFFECTS_VERSION",
        fromKey: ADVISORY_KEY,
        toKey: PATIENT_ZERO_VERSION_KEY,
        properties: {},
      },
    ],
  });

  expect(fixture.danglingEdges).toEqual([]);
  return buildGraphSnapshot({
    graph: fixture.graph,
    manifest,
    generatedAtMs: MANIFEST_GENERATED_AT_MS,
    source: "seed-incidents-test",
  });
}

/**
 * The registry half: the same package and version, plus the dependency closure, the
 * maintainer and the advisory range edge. No service, exactly like the real `ingest-slice`
 * snapshot. Its node ids start at 1 again, so they collide with the incident half.
 */
function buildIngestSnapshot(manifest: SliceManifest = buildManifest()): GraphSnapshot {
  const fixture = buildFixtureGraph({
    packages: [
      { name: "event-stream", weekly_downloads: INGEST_WEEKLY_DOWNLOADS },
      { name: "flatmap-stream" },
    ],
    versions: [
      { name: "event-stream", version: "3.3.6", published_at_ms: PUBLISHED_AT_MS },
      { name: "flatmap-stream", version: "0.1.1", published_at_ms: PUBLISHED_AT_MS },
    ],
    maintainers: [{ username: "right9ctrl" }],
    advisories: [{ ghsa_id: "GHSA-test-0001" }],
    edges: [
      {
        relType: "VERSION_OF",
        fromKey: PATIENT_ZERO_VERSION_KEY,
        toKey: PATIENT_ZERO_PACKAGE_KEY,
        properties: {},
      },
      {
        relType: "VERSION_OF",
        fromKey: PAYLOAD_VERSION_KEY,
        toKey: PAYLOAD_PACKAGE_KEY,
        properties: {},
      },
      {
        relType: "DEPENDS_ON",
        fromKey: PATIENT_ZERO_VERSION_KEY,
        toKey: PAYLOAD_PACKAGE_KEY,
        properties: { version_range: "^0.1.1" },
      },
      { relType: "MAINTAINS", fromKey: MAINTAINER_KEY, toKey: PATIENT_ZERO_PACKAGE_KEY, properties: {} },
      dependencyEdge(PATIENT_ZERO_VERSION_KEY, PAYLOAD_VERSION_KEY),
      {
        relType: "AFFECTS",
        fromKey: ADVISORY_KEY,
        toKey: PATIENT_ZERO_PACKAGE_KEY,
        properties: { introduced: "3.3.6", fixed: "" },
      },
    ],
  });

  expect(fixture.danglingEdges).toEqual([]);
  return buildGraphSnapshot({
    graph: fixture.graph,
    manifest,
    generatedAtMs: MANIFEST_GENERATED_AT_MS,
    source: "ingest-slice-test",
  });
}

function mergeDemoHalves(
  first: GraphSnapshot = buildIncidentSnapshot(),
  second: GraphSnapshot = buildIngestSnapshot(),
): MergedGraphSnapshot {
  return readValueOrUnreachable(
    mergeGraphSnapshots({
      first,
      second,
      generatedAtMs: MERGE_GENERATED_AT_MS,
      source: MERGE_SOURCE,
    }),
    "merging the two demo halves",
  );
}

function findNodeByKey(snapshot: GraphSnapshot, key: string): GraphSnapshotNode {
  const matches = snapshot.nodes.filter((node) => node.properties.key === key);
  expect(matches.length, `expected exactly one node for ${key}`).toBe(1);
  const node = matches[0];
  if (node === undefined) return expect.unreachable(`no node for ${key}`);
  return node;
}

function findEdgesByType(snapshot: GraphSnapshot, relType: string): GraphSnapshotEdge[] {
  return snapshot.edges.filter((edge) => edge.relType === relType);
}

function findSingleEdge(snapshot: GraphSnapshot, relType: string): GraphSnapshotEdge {
  const edges = findEdgesByType(snapshot, relType);
  expect(edges.length, `expected exactly one ${relType} edge`).toBe(1);
  const edge = edges[0];
  if (edge === undefined) return expect.unreachable(`no ${relType} edge`);
  return edge;
}

test("a package in both inputs becomes one node that carries both sides' edges", () => {
  const merged = mergeDemoHalves();

  // One node per identity: three of the ingest half's six nodes were the same entities.
  expect(merged.report.unifiedNodes).toBe(3);
  expect(merged.report.addedNodes).toBe(3);
  expect(merged.snapshot.nodes.length).toBe(7);

  const patientZeroPackage = findNodeByKey(merged.snapshot, PATIENT_ZERO_PACKAGE_KEY);
  const patientZeroVersion = findNodeByKey(merged.snapshot, PATIENT_ZERO_VERSION_KEY);

  // The incident half's ids are the ones that survive, so the package and version the
  // service already pointed at are the same rows the dependency edges attach to.
  const versionOfEdges = findEdgesByType(merged.snapshot, "VERSION_OF");
  const patientZeroVersionOf = versionOfEdges.filter(
    (edge) => edge.toNodeId === patientZeroPackage.id,
  );
  expect(patientZeroVersionOf.length).toBe(1);
  expect(patientZeroVersionOf[0]?.fromNodeId).toBe(patientZeroVersion.id);

  // The seed half: a service pinned this exact version.
  const resolved = findSingleEdge(merged.snapshot, "RESOLVED");
  expect(resolved.toNodeId).toBe(patientZeroVersion.id);
  expect(resolved.fromNodeId).toBe(findNodeByKey(merged.snapshot, SERVICE_KEY).id);

  // The ingest half: the same version declares and resolves a dependency, and the same
  // package carries a maintainer. Both halves now hang off one identity.
  expect(findSingleEdge(merged.snapshot, "DEPENDS_ON").fromNodeId).toBe(patientZeroVersion.id);
  expect(findSingleEdge(merged.snapshot, "RESOLVES_TO").fromNodeId).toBe(patientZeroVersion.id);
  expect(findSingleEdge(merged.snapshot, "MAINTAINS").toNodeId).toBe(patientZeroPackage.id);

  // The duplicate VERSION_OF the ingest half also stated was recognised, not doubled.
  expect(merged.report.skippedDuplicateEdges).toBe(1);
  expect(merged.report.addedEdges).toBe(6);
  expect(merged.snapshot.edges.length).toBe(9);

  expect(merged.snapshot.manifest.counts).toEqual({
    packages: 2,
    versions: 2,
    maintainers: 1,
    services: 1,
    advisories: 1,
    resolutionEdges: 1,
  });
});

test("an edge whose endpoints both existed in the first input points at the first input's ids", () => {
  const incident = buildIncidentSnapshot();
  const merged = mergeDemoHalves(incident);

  const advisoryInFirst = findNodeByKey(incident, ADVISORY_KEY);
  const packageInFirst = findNodeByKey(incident, PATIENT_ZERO_PACKAGE_KEY);

  // AFFECTS comes from the ingest half, where both endpoints carry different ids.
  const affects = findSingleEdge(merged.snapshot, "AFFECTS");
  expect(affects.fromNodeId).toBe(advisoryInFirst.id);
  expect(affects.toNodeId).toBe(packageInFirst.id);
  expect(affects.properties).toEqual({ introduced: "3.3.6", fixed: "" });
});

test("merging the same pair twice adds nothing the first merge did not", () => {
  const ingest = buildIngestSnapshot();
  const once = mergeDemoHalves(buildIncidentSnapshot(), ingest);
  const twice = mergeDemoHalves(once.snapshot, ingest);

  expect(twice.snapshot.nodes.length).toBe(once.snapshot.nodes.length);
  expect(twice.snapshot.edges.length).toBe(once.snapshot.edges.length);
  expect(twice.report.addedNodes).toBe(0);
  expect(twice.report.addedEdges).toBe(0);
  expect(twice.report.unifiedNodes).toBe(ingest.nodes.length);
  expect(twice.report.skippedDuplicateEdges).toBe(ingest.edges.length);
});

test("a download count the incident half never read takes the registry half's reading", () => {
  const merged = mergeDemoHalves();

  // The incident half is the first input and carries the unknown sentinel for this package.
  // That is not a competing claim, so the registry half's figure is not a disagreement to
  // resolve by input order: it is the only reading either side took.
  expect(merged.report.conflicts).toEqual([]);
  expect(merged.report.filledProperties).toBe(1);

  const patientZeroPackage = findNodeByKey(merged.snapshot, PATIENT_ZERO_PACKAGE_KEY);
  expect(patientZeroPackage.properties.weekly_downloads).toBe(INGEST_WEEKLY_DOWNLOADS);

  // Nothing to disclose, because nothing was dropped.
  const conflictNote = merged.snapshot.manifest.notes.find((note) => note.includes("disagreed"));
  expect(conflictNote).toBeUndefined();
});

test("an unreported value loses to a reading whichever input holds it", () => {
  const unreported = buildReadingsSnapshot("unreported-side", {
    weekly_downloads: UNKNOWN_NUMERIC_VALUE,
    summary: "",
  });
  const reported = buildReadingsSnapshot("reported-side", {
    weekly_downloads: INGEST_WEEKLY_DOWNLOADS,
    summary: ADVISORY_SUMMARY,
  });

  // The sentinel arrives first and is overwritten.
  const sentinelFirst = mergeDemoHalves(unreported, reported);
  expect(sentinelFirst.report.conflicts).toEqual([]);
  expect(readWeeklyDownloads(sentinelFirst)).toBe(INGEST_WEEKLY_DOWNLOADS);
  expect(readAdvisorySummary(sentinelFirst)).toBe(ADVISORY_SUMMARY);
  expect(sentinelFirst.report.filledProperties).toBe(2);

  // The sentinel arrives second and is ignored. Same graph either way, which is the point:
  // input order decides between two readings, never between a reading and a placeholder.
  const sentinelSecond = mergeDemoHalves(reported, unreported);
  expect(sentinelSecond.report.conflicts).toEqual([]);
  expect(readWeeklyDownloads(sentinelSecond)).toBe(INGEST_WEEKLY_DOWNLOADS);
  expect(readAdvisorySummary(sentinelSecond)).toBe(ADVISORY_SUMMARY);
  expect(sentinelSecond.report.filledProperties).toBe(0);
});

test("two readings that disagree stay a conflict the first input wins", () => {
  const first = buildReadingsSnapshot("first-side", {
    weekly_downloads: FIRST_REAL_WEEKLY_DOWNLOADS,
    has_install_script: true,
    summary: ADVISORY_SUMMARY,
  });
  const second = buildReadingsSnapshot("second-side", {
    weekly_downloads: SECOND_REAL_WEEKLY_DOWNLOADS,
    has_install_script: false,
    summary: OTHER_ADVISORY_SUMMARY,
  });

  const merged = mergeDemoHalves(first, second);

  // Three properties both sides genuinely read, and read differently. Every one is kept from
  // the first input and reported, so a human sees all three.
  const expectedConflicts: PropertyConflict[] = [
    {
      label: "Package",
      key: PATIENT_ZERO_PACKAGE_KEY,
      property: "weekly_downloads",
      keptValue: FIRST_REAL_WEEKLY_DOWNLOADS,
      discardedValue: SECOND_REAL_WEEKLY_DOWNLOADS,
    },
    {
      label: "Version",
      key: PATIENT_ZERO_VERSION_KEY,
      property: "has_install_script",
      keptValue: true,
      discardedValue: false,
    },
    {
      label: "Advisory",
      key: ADVISORY_KEY,
      property: "summary",
      keptValue: ADVISORY_SUMMARY,
      discardedValue: OTHER_ADVISORY_SUMMARY,
    },
  ];
  expect(merged.report.conflicts).toEqual(expectedConflicts);
  expect(merged.report.filledProperties).toBe(0);
  expect(merged.snapshot.manifest.notes.find((note) => note.includes("disagreed"))).toBeDefined();

  // has_install_script has no sentinel: a stated false is a reading, so input order is what
  // decides it. Reversing the inputs keeps false, and the merge never prefers true for being
  // the riskier value, which would invent an install script no source reported.
  const reversed = mergeDemoHalves(second, first);
  expect(reversed.report.conflicts.length).toBe(3);
  expect(findNodeByKey(reversed.snapshot, PATIENT_ZERO_VERSION_KEY).properties.has_install_script).toBe(
    false,
  );
});

test("a value neither input reported stays unreported and is not a conflict", () => {
  const merged = mergeDemoHalves(
    buildReadingsSnapshot("first-side", { weekly_downloads: UNKNOWN_NUMERIC_VALUE, summary: "" }),
    buildReadingsSnapshot("second-side", { weekly_downloads: UNKNOWN_NUMERIC_VALUE, summary: "" }),
  );

  expect(merged.report.conflicts).toEqual([]);
  expect(merged.report.filledProperties).toBe(0);
  expect(readWeeklyDownloads(merged)).toBe(UNKNOWN_NUMERIC_VALUE);
  expect(readAdvisorySummary(merged)).toBe("");
});

/**
 * One package, one version and one advisory, with the properties the merge has to decide
 * about stated per side. Everything the caller leaves out takes the fixture default, so the
 * two sides of a test differ in exactly the properties that test is about.
 */
function buildReadingsSnapshot(source: string, readings: PropertyReadings): GraphSnapshot {
  const fixture = buildFixtureGraph({
    packages: [{ name: "event-stream", weekly_downloads: readings.weekly_downloads }],
    versions: [
      {
        name: "event-stream",
        version: "3.3.6",
        published_at_ms: PUBLISHED_AT_MS,
        has_install_script: readings.has_install_script,
      },
    ],
    advisories: [{ ghsa_id: "GHSA-test-0001", summary: readings.summary }],
    edges: [
      {
        relType: "VERSION_OF",
        fromKey: PATIENT_ZERO_VERSION_KEY,
        toKey: PATIENT_ZERO_PACKAGE_KEY,
        properties: {},
      },
      {
        relType: "AFFECTS_VERSION",
        fromKey: ADVISORY_KEY,
        toKey: PATIENT_ZERO_VERSION_KEY,
        properties: {},
      },
    ],
  });

  expect(fixture.danglingEdges).toEqual([]);
  return buildGraphSnapshot({
    graph: fixture.graph,
    manifest: buildManifest(),
    generatedAtMs: MANIFEST_GENERATED_AT_MS,
    source,
  });
}

function readWeeklyDownloads(merged: MergedGraphSnapshot): GraphPropertyValue | undefined {
  return findNodeByKey(merged.snapshot, PATIENT_ZERO_PACKAGE_KEY).properties.weekly_downloads;
}

function readAdvisorySummary(merged: MergedGraphSnapshot): GraphPropertyValue | undefined {
  return findNodeByKey(merged.snapshot, ADVISORY_KEY).properties.summary;
}

test("merged coverage is the weaker of the two claims", () => {
  const merged = mergeDemoHalves(
    buildIncidentSnapshot(
      buildManifest({
        partialPackageKeys: [PATIENT_ZERO_PACKAGE_KEY],
        closedPackageKeys: [packageKey("npm", "chalk"), packageKey("npm", "left-pad")],
        closedServiceKeys: [SERVICE_KEY],
      }),
    ),
    buildIngestSnapshot(
      buildManifest({
        // The ingest half read this package's closure in full, the incident half did not.
        closedPackageKeys: [PATIENT_ZERO_PACKAGE_KEY, packageKey("npm", "chalk")],
        partialPackageKeys: [PAYLOAD_PACKAGE_KEY],
      }),
    ),
  );

  const manifest = merged.snapshot.manifest;
  // closed on one side and partial on the other resolves to partial, never to closed.
  expect(manifest.partialPackageKeys).toEqual([PATIENT_ZERO_PACKAGE_KEY, PAYLOAD_PACKAGE_KEY]);
  // closed on both sides stays closed; closed on the only side that names it stays closed.
  expect(manifest.closedPackageKeys).toEqual([packageKey("npm", "chalk"), packageKey("npm", "left-pad")]);
  expect(manifest.closedServiceKeys).toEqual([SERVICE_KEY]);
  expect(manifest.generatedAtMs).toBe(MERGE_GENERATED_AT_MS);
});

test("two ranges between one advisory and one package survive, an identical row does not double", () => {
  // An advisory that states two affected ranges for one package writes two AFFECTS edges
  // between the same pair of nodes, which is why the endpoints alone cannot be an edge's
  // identity: folding them would narrow the affected range with no trace in the graph.
  const firstRange = { introduced: "3.3.6", fixed: "" };
  const secondRange = { introduced: "4.0.0", fixed: "4.0.1" };

  const merged = mergeDemoHalves(
    buildAdvisorySnapshot("advisory-first", [firstRange]),
    buildAdvisorySnapshot("advisory-second", [firstRange, secondRange]),
  );

  const affects = findEdgesByType(merged.snapshot, "AFFECTS");
  expect(affects.length).toBe(2);
  expect(affects.map((edge) => edge.properties)).toEqual([firstRange, secondRange]);
  expect(merged.report.skippedDuplicateEdges).toBe(1);
  expect(merged.report.addedEdges).toBe(1);
  expect(merged.report.conflicts).toEqual([]);
});

/** One advisory, one package, and one AFFECTS edge per stated range. */
function buildAdvisorySnapshot(
  source: string,
  ranges: readonly { introduced: string; fixed: string }[],
): GraphSnapshot {
  const fixture = buildFixtureGraph({
    packages: [{ name: "event-stream", weekly_downloads: UNKNOWN_NUMERIC_VALUE }],
    advisories: [{ ghsa_id: "GHSA-test-0001" }],
    edges: ranges.map((range) => ({
      relType: "AFFECTS",
      fromKey: ADVISORY_KEY,
      toKey: PATIENT_ZERO_PACKAGE_KEY,
      properties: range,
    })),
  });

  expect(fixture.danglingEdges).toEqual([]);
  return buildGraphSnapshot({
    graph: fixture.graph,
    manifest: buildManifest(),
    generatedAtMs: MANIFEST_GENERATED_AT_MS,
    source,
  });
}

test("a node with no natural key is added rather than unified, and counted", () => {
  const unkeyedProperties: GraphProperties = {
    ecosystem: "npm",
    name: "event-stream",
    weekly_downloads: INGEST_WEEKLY_DOWNLOADS,
  };
  const first = buildRawSnapshot("first-raw", [
    {
      id: 0,
      label: "Package",
      properties: {
        key: PATIENT_ZERO_PACKAGE_KEY,
        ecosystem: "npm",
        name: "event-stream",
        weekly_downloads: UNKNOWN_NUMERIC_VALUE,
      },
    },
  ]);
  const second = buildRawSnapshot("second-raw", [
    { id: 0, label: "Package", properties: unkeyedProperties },
  ]);

  const merged = mergeDemoHalves(first, second);

  // No key means no identity, so it cannot be folded into the package it resembles.
  expect(merged.report.unkeyedNodes).toBe(1);
  expect(merged.report.unifiedNodes).toBe(0);
  expect(merged.report.addedNodes).toBe(1);
  expect(merged.snapshot.nodes.length).toBe(2);
  expect(merged.report.conflicts).toEqual([]);
});

/**
 * A snapshot built from node rows directly, for the cases the fixture builder cannot express
 * because it always writes a natural key.
 */
function buildRawSnapshot(source: string, nodes: readonly GraphSnapshotNode[]): GraphSnapshot {
  return {
    formatVersion: GRAPH_SNAPSHOT_FORMAT_VERSION,
    generatedAtMs: MANIFEST_GENERATED_AT_MS,
    source,
    manifest: buildManifest(),
    nodes: [...nodes],
    edges: [],
  };
}
