import { describe, expect, test } from "bun:test";

import { computeIntroducedVersion } from "@/lib/analysis/introduced-version";
import { MemoryGraph } from "@/lib/graph/memory-gateway";
import { type Ecosystem, advisoryKey, packageKey, versionKey } from "@/lib/graph/model";
import {
  type SliceManifest,
  EMPTY_SLICE_COUNTS,
  SLICE_MANIFEST_VERSION,
  SliceCoverage,
} from "@/lib/graph/slice-manifest";

/**
 * The introduced version answer is an ordering claim, so every fixture here publishes
 * its versions out of order: a test that only ever inserted them oldest first would
 * pass against code that returns the first edge it reads.
 *
 * The graph is built inline with hand-assigned node ids so each assertion can be read
 * against the numbers in the test itself.
 */

const GHSA_ID = "GHSA-3xq7-9c4h-2vpm";
const ADVISORY_SUMMARY = "Malicious code in the published tarball";
/** Advisory disclosure time. Unit: epoch milliseconds. */
const ADVISORY_PUBLISHED_AT_MS = 1_757_000_000_000;
/** Slice build time. Unit: epoch milliseconds. */
const MANIFEST_GENERATED_AT_MS = 1_757_100_000_000;

/** What the model writes when the registry had no timestamp. sourceRef: src/lib/graph/model.ts */
const MISSING_PUBLISH_TIME = -1;

const ADVISORY_NODE_ID = 1;
const CHALK_PACKAGE_NODE_ID = 2;
const DEBUG_PACKAGE_NODE_ID = 3;
const URLLIB3_PACKAGE_NODE_ID = 4;
const FIRST_VERSION_NODE_ID = 10;

/**
 * Edge ids are derived from the far endpoint's node id, which keeps them unique across
 * every edge a fixture writes without threading a counter through the helpers.
 */
const AFFECTS_VERSION_EDGE_ID_OFFSET = 1_000;
const AFFECTS_EDGE_ID_OFFSET = 2_000;

const CHALK_PACKAGE_KEY = packageKey("npm", "chalk");
const DEBUG_PACKAGE_KEY = packageKey("npm", "debug");
const URLLIB3_PACKAGE_KEY = packageKey("pypi", "urllib3");

/** Publish times for the chalk fixture, a decade apart so no assertion is off by one. */
const CHALK_5_0_0_PUBLISHED_AT_MS = 1_700_000_000_000;
const CHALK_5_1_0_PUBLISHED_AT_MS = 1_710_000_000_000;
const CHALK_5_2_0_PUBLISHED_AT_MS = 1_720_000_000_000;

type VersionFixture = {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  publishedAtMs: number;
  hasInstallScript?: boolean;
};

function addAdvisory(graph: MemoryGraph): void {
  graph.addNode({
    id: ADVISORY_NODE_ID,
    label: "Advisory",
    properties: {
      key: advisoryKey(GHSA_ID),
      ghsa_id: GHSA_ID,
      published_at_ms: ADVISORY_PUBLISHED_AT_MS,
      modified_at_ms: ADVISORY_PUBLISHED_AT_MS,
      summary: ADVISORY_SUMMARY,
    },
  });
}

function addPackage(
  graph: MemoryGraph,
  nodeId: number,
  ecosystem: Ecosystem,
  name: string,
): void {
  graph.addNode({
    id: nodeId,
    label: "Package",
    properties: {
      key: packageKey(ecosystem, name),
      ecosystem,
      name,
      weekly_downloads: 1_000,
    },
  });
}

/** The advisory's stated range for one package, as the ingest writes it. */
function addAffects(
  graph: MemoryGraph,
  packageNodeId: number,
  introduced: string,
  fixed: string,
): void {
  graph.addEdge({
    id: AFFECTS_EDGE_ID_OFFSET + packageNodeId,
    relType: "AFFECTS",
    fromNodeId: ADVISORY_NODE_ID,
    toNodeId: packageNodeId,
    properties: { introduced, fixed },
  });
}

/**
 * Writes one Version node per fixture plus the AFFECTS_VERSION edge that places it in
 * the advisory's range. Node ids run from FIRST_VERSION_NODE_ID in fixture order, and
 * MemoryGraph expands edges in insertion order, so a test that caps the expansion knows
 * exactly which versions survive the cap.
 */
function addAffectedVersions(graph: MemoryGraph, fixtures: readonly VersionFixture[]): void {
  for (let index = 0; index < fixtures.length; index += 1) {
    const fixture = fixtures[index];
    if (fixture === undefined) continue;

    const nodeId = FIRST_VERSION_NODE_ID + index;
    graph.addNode({
      id: nodeId,
      label: "Version",
      properties: {
        key: versionKey(fixture.ecosystem, fixture.name, fixture.version),
        ecosystem: fixture.ecosystem,
        name: fixture.name,
        version: fixture.version,
        published_at_ms: fixture.publishedAtMs,
        has_install_script: fixture.hasInstallScript ?? false,
      },
    });
    graph.addEdge({
      id: AFFECTS_VERSION_EDGE_ID_OFFSET + nodeId,
      relType: "AFFECTS_VERSION",
      fromNodeId: ADVISORY_NODE_ID,
      toNodeId: nodeId,
      properties: {},
    });
  }
}

/** A manifest carrying only what this module reads: package coverage. */
function buildCoverage(closedPackageKeys: readonly string[]): SliceCoverage {
  const manifest: SliceManifest = {
    version: SLICE_MANIFEST_VERSION,
    generatedAtMs: MANIFEST_GENERATED_AT_MS,
    ecosystems: ["npm", "pypi"],
    closedPackageKeys: [...closedPackageKeys],
    partialPackageKeys: [],
    closedServiceKeys: [],
    counts: { ...EMPTY_SLICE_COUNTS, packages: 1, versions: 3, advisories: 1 },
    notes: [],
  };
  return new SliceCoverage(manifest);
}

/** The chalk fixture: three affected versions, inserted newest first. */
function buildChalkGraph(): MemoryGraph {
  const graph = new MemoryGraph();
  addAdvisory(graph);
  addPackage(graph, CHALK_PACKAGE_NODE_ID, "npm", "chalk");
  addAffects(graph, CHALK_PACKAGE_NODE_ID, "5.0.0", "5.3.0");
  addAffectedVersions(graph, [
    {
      ecosystem: "npm",
      name: "chalk",
      version: "5.2.0",
      publishedAtMs: CHALK_5_2_0_PUBLISHED_AT_MS,
      hasInstallScript: true,
    },
    {
      ecosystem: "npm",
      name: "chalk",
      version: "5.0.0",
      publishedAtMs: CHALK_5_0_0_PUBLISHED_AT_MS,
    },
    {
      ecosystem: "npm",
      name: "chalk",
      version: "5.1.0",
      publishedAtMs: CHALK_5_1_0_PUBLISHED_AT_MS,
    },
  ]);
  return graph;
}

describe("computeIntroducedVersion ordering", () => {
  test("names the earliest published affected version and the stated range", async () => {
    const result = await computeIntroducedVersion({
      gateway: buildChalkGraph(),
      coverage: buildCoverage([CHALK_PACKAGE_KEY]),
      advisoryKey: advisoryKey(GHSA_ID),
      packageKey: CHALK_PACKAGE_KEY,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const answer = result.value;
    expect(answer.verdict).toBe("exposed");
    expect(answer.limits).toEqual([]);
    expect(answer.evidence.introducingVersion?.version).toBe("5.0.0");
    expect(answer.evidence.introducingVersion?.publishedAtMs).toBe(CHALK_5_0_0_PUBLISHED_AT_MS);
    expect(answer.evidence.affectedVersions.map((fact) => fact.version)).toEqual([
      "5.0.0",
      "5.1.0",
      "5.2.0",
    ]);
    // The install script flag travels with the version it was read from, not with the
    // introducing one: 5.2.0 is the fixture that declares a script.
    expect(answer.evidence.affectedVersions.map((fact) => fact.hasInstallScript)).toEqual([
      false,
      false,
      true,
    ]);
    expect(answer.evidence.undecidableVersionCount).toBe(0);
    expect(answer.evidence.statedRange).toEqual({
      introduced: "5.0.0",
      fixed: "5.3.0",
      hasStatedFix: true,
    });
    expect(answer.evidence.advisory.ghsaId).toBe(GHSA_ID);
    expect(answer.evidence.advisory.summary).toBe(ADVISORY_SUMMARY);
    expect(answer.evidence.advisory.publishedAtMs).toBe(ADVISORY_PUBLISHED_AT_MS);
    expect(answer.rationale).toContain("chalk@5.0.0");
  });

  test("orders by semver precedence when the registry gave no publish time", async () => {
    const graph = new MemoryGraph();
    addAdvisory(graph);
    addPackage(graph, DEBUG_PACKAGE_NODE_ID, "npm", "debug");
    addAffects(graph, DEBUG_PACKAGE_NODE_ID, "", "");
    // 1.10.0 sorts before 1.9.0 as text, so a string comparison would name it first.
    addAffectedVersions(graph, [
      { ecosystem: "npm", name: "debug", version: "1.10.0", publishedAtMs: MISSING_PUBLISH_TIME },
      { ecosystem: "npm", name: "debug", version: "1.9.0", publishedAtMs: MISSING_PUBLISH_TIME },
    ]);

    const result = await computeIntroducedVersion({
      gateway: graph,
      coverage: buildCoverage([DEBUG_PACKAGE_KEY]),
      advisoryKey: advisoryKey(GHSA_ID),
      packageKey: DEBUG_PACKAGE_KEY,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.verdict).toBe("exposed");
    expect(result.value.evidence.introducingVersion?.version).toBe("1.9.0");
    expect(result.value.evidence.introducingVersion?.publishedAtMs).toBeNull();
    expect(result.value.evidence.affectedVersions.map((fact) => fact.version)).toEqual([
      "1.9.0",
      "1.10.0",
    ]);
    // An open ended advisory states no fix, and nothing invents one from the versions.
    expect(result.value.evidence.statedRange).toEqual({
      introduced: "",
      fixed: "",
      hasStatedFix: false,
    });
    expect(result.value.evidence.undecidableVersionCount).toBe(0);
  });

  test("breaks a publish-time tie by semver precedence", async () => {
    const graph = new MemoryGraph();
    addAdvisory(graph);
    addPackage(graph, CHALK_PACKAGE_NODE_ID, "npm", "chalk");
    addAffects(graph, CHALK_PACKAGE_NODE_ID, "2.0.0", "");
    // Two releases stamped with the same millisecond, inserted newest first.
    addAffectedVersions(graph, [
      { ecosystem: "npm", name: "chalk", version: "2.0.1", publishedAtMs: CHALK_5_0_0_PUBLISHED_AT_MS },
      { ecosystem: "npm", name: "chalk", version: "2.0.0", publishedAtMs: CHALK_5_0_0_PUBLISHED_AT_MS },
    ]);

    const result = await computeIntroducedVersion({
      gateway: graph,
      coverage: buildCoverage([CHALK_PACKAGE_KEY]),
      advisoryKey: advisoryKey(GHSA_ID),
      packageKey: CHALK_PACKAGE_KEY,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.evidence.introducingVersion?.version).toBe("2.0.0");
    expect(result.value.evidence.affectedVersions.map((fact) => fact.version)).toEqual([
      "2.0.0",
      "2.0.1",
    ]);
  });

  test("keeps only the versions of the requested package", async () => {
    const graph = new MemoryGraph();
    addAdvisory(graph);
    addPackage(graph, CHALK_PACKAGE_NODE_ID, "npm", "chalk");
    addPackage(graph, DEBUG_PACKAGE_NODE_ID, "npm", "debug");
    addAffects(graph, CHALK_PACKAGE_NODE_ID, "5.0.0", "5.3.0");
    addAffects(graph, DEBUG_PACKAGE_NODE_ID, "4.0.0", "4.0.1");
    // debug@4.0.0 was published first, so a missing package filter would name it as the
    // version that introduced the advisory into chalk.
    addAffectedVersions(graph, [
      { ecosystem: "npm", name: "debug", version: "4.0.0", publishedAtMs: CHALK_5_0_0_PUBLISHED_AT_MS },
      { ecosystem: "npm", name: "chalk", version: "5.1.0", publishedAtMs: CHALK_5_1_0_PUBLISHED_AT_MS },
      { ecosystem: "npm", name: "chalk", version: "5.2.0", publishedAtMs: CHALK_5_2_0_PUBLISHED_AT_MS },
    ]);

    const result = await computeIntroducedVersion({
      gateway: graph,
      coverage: buildCoverage([CHALK_PACKAGE_KEY, DEBUG_PACKAGE_KEY]),
      advisoryKey: advisoryKey(GHSA_ID),
      packageKey: CHALK_PACKAGE_KEY,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.evidence.introducingVersion?.version).toBe("5.1.0");
    expect(result.value.evidence.affectedVersions.map((fact) => fact.versionKey)).toEqual([
      versionKey("npm", "chalk", "5.1.0"),
      versionKey("npm", "chalk", "5.2.0"),
    ]);
    // The stated range read must follow the same filter as the version list.
    expect(result.value.evidence.statedRange?.fixed).toBe("5.3.0");
  });

  test("reports a version it cannot place as undecidable", async () => {
    const graph = new MemoryGraph();
    addAdvisory(graph);
    addPackage(graph, URLLIB3_PACKAGE_NODE_ID, "pypi", "urllib3");
    addAffects(graph, URLLIB3_PACKAGE_NODE_ID, "1.0.0", "2.0.0");
    // A PyPI epoch version is not semver, and with no publish time it has no defensible
    // position in the order at all.
    addAffectedVersions(graph, [
      { ecosystem: "pypi", name: "urllib3", version: "1!2.0", publishedAtMs: MISSING_PUBLISH_TIME },
      { ecosystem: "pypi", name: "urllib3", version: "1.0.0", publishedAtMs: MISSING_PUBLISH_TIME },
    ]);

    const result = await computeIntroducedVersion({
      gateway: graph,
      coverage: buildCoverage([URLLIB3_PACKAGE_KEY]),
      advisoryKey: advisoryKey(GHSA_ID),
      packageKey: URLLIB3_PACKAGE_KEY,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.evidence.undecidableVersionCount).toBe(1);
    expect(result.value.limits).toContainEqual({ kind: "undecidable_versions", count: 1 });
    expect(result.value.evidence.introducingVersion?.version).toBe("1.0.0");
    // The unplaceable version is still listed, last, and marked as unranked.
    expect(result.value.evidence.affectedVersions.map((fact) => fact.isOrdered)).toEqual([
      true,
      false,
    ]);
    expect(result.value.verdict).toBe("exposed");
    expect(result.value.rationale).toContain("search stopped early");
  });
});

describe("computeIntroducedVersion abstention", () => {
  test("returns unknown when the advisory is not in the slice", async () => {
    const graph = new MemoryGraph();
    addPackage(graph, CHALK_PACKAGE_NODE_ID, "npm", "chalk");
    // A Version node so the graph is not empty: an empty graph is a different verdict.
    addAffectedVersions(graph, [
      { ecosystem: "npm", name: "chalk", version: "5.0.0", publishedAtMs: CHALK_5_0_0_PUBLISHED_AT_MS },
    ]);

    const result = await computeIntroducedVersion({
      gateway: graph,
      coverage: buildCoverage([CHALK_PACKAGE_KEY]),
      advisoryKey: advisoryKey(GHSA_ID),
      packageKey: CHALK_PACKAGE_KEY,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.verdict).toBe("unknown");
    expect(result.value.limits).toEqual([{ kind: "package_absent", subjectKey: GHSA_ID }]);
    expect(result.value.rationale).toContain(GHSA_ID);
    expect(result.value.evidence.affectedVersions).toEqual([]);
    expect(result.value.evidence.advisory.nodeId).toBeNull();
  });

  test("returns not_exposed when a closed package has no affected version", async () => {
    const graph = new MemoryGraph();
    addAdvisory(graph);
    addPackage(graph, CHALK_PACKAGE_NODE_ID, "npm", "chalk");
    // The advisory states a 6.x range, and the slice holds a 5.x version that the
    // ingest did not connect, so nothing published falls in the range.
    addAffects(graph, CHALK_PACKAGE_NODE_ID, "6.0.0", "6.0.1");
    graph.addNode({
      id: FIRST_VERSION_NODE_ID,
      label: "Version",
      properties: {
        key: versionKey("npm", "chalk", "5.0.0"),
        ecosystem: "npm",
        name: "chalk",
        version: "5.0.0",
        published_at_ms: CHALK_5_0_0_PUBLISHED_AT_MS,
        has_install_script: false,
      },
    });

    const result = await computeIntroducedVersion({
      gateway: graph,
      coverage: buildCoverage([CHALK_PACKAGE_KEY]),
      advisoryKey: advisoryKey(GHSA_ID),
      packageKey: CHALK_PACKAGE_KEY,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.verdict).toBe("not_exposed");
    expect(result.value.limits).toEqual([]);
    expect(result.value.evidence.introducingVersion).toBeNull();
    expect(result.value.evidence.affectedVersions).toEqual([]);
    expect(result.value.rationale).toContain("falls in the range stated by");
    // The stated bounds are still reported: they are what makes the negative readable.
    expect(result.value.evidence.statedRange?.introduced).toBe("6.0.0");
  });

  test("returns unknown when the package is outside the slice", async () => {
    const result = await computeIntroducedVersion({
      gateway: buildChalkGraph(),
      coverage: buildCoverage([DEBUG_PACKAGE_KEY]),
      advisoryKey: advisoryKey(GHSA_ID),
      packageKey: CHALK_PACKAGE_KEY,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.verdict).toBe("unknown");
    expect(result.value.limits).toEqual([
      { kind: "package_absent", subjectKey: CHALK_PACKAGE_KEY },
    ]);
    // The evidence is still handed back: the manifest is what abstains, not the read.
    expect(result.value.evidence.affectedVersions).toHaveLength(3);
  });

  test("records a scan cap when the affected version expansion is truncated", async () => {
    const result = await computeIntroducedVersion({
      gateway: buildChalkGraph(),
      coverage: buildCoverage([CHALK_PACKAGE_KEY]),
      advisoryKey: advisoryKey(GHSA_ID),
      packageKey: CHALK_PACKAGE_KEY,
      options: { maxAffectedVersions: 2 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.limits).toContainEqual({ kind: "scan_capped", examined: 2, total: 2 });
    // The cap keeps the first two edges written, which are 5.2.0 and 5.0.0, so the
    // answer names 5.0.0 while saying an earlier version may exist.
    expect(result.value.evidence.affectedVersions.map((fact) => fact.version)).toEqual([
      "5.0.0",
      "5.2.0",
    ]);
    expect(result.value.verdict).toBe("exposed");
    expect(result.value.rationale).toContain("an earlier affected version may exist");
  });

  test("returns unknown over an empty graph", async () => {
    const result = await computeIntroducedVersion({
      gateway: new MemoryGraph(),
      coverage: buildCoverage([CHALK_PACKAGE_KEY]),
      advisoryKey: advisoryKey(GHSA_ID),
      packageKey: CHALK_PACKAGE_KEY,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.verdict).toBe("unknown");
    expect(result.value.limits[0]).toEqual({ kind: "empty_graph" });
    expect(result.value.rationale).toContain("Run an ingest first");
  });

  test("refuses a malformed package key without touching the graph", async () => {
    const result = await computeIntroducedVersion({
      gateway: new MemoryGraph(),
      coverage: buildCoverage([CHALK_PACKAGE_KEY]),
      advisoryKey: advisoryKey(GHSA_ID),
      packageKey: "chalk",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe("invalid_input");
  });
});
