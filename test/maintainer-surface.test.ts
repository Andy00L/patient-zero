import { describe, expect, test } from "bun:test";

import {
  HOP_TWO_ASSUMPTION,
  computeMaintainerSurface,
  rankMaintainerSurfaces,
} from "@/lib/analysis/maintainer-surface";
import type { GraphProperties } from "@/lib/graph/gateway";
import { MemoryGraph } from "@/lib/graph/memory-gateway";
import {
  type Ecosystem,
  type NodeLabel,
  type RelType,
  maintainerKey,
  packageKey,
  serviceKey,
  versionKey,
} from "@/lib/graph/model";
import {
  EMPTY_SLICE_COUNTS,
  SLICE_MANIFEST_VERSION,
  SliceCoverage,
  type SliceManifest,
} from "@/lib/graph/slice-manifest";

/**
 * Correctness fixtures for the maintainer infection surface.
 *
 * Each fixture is a hand-built graph whose answer is known by inspection, so a wrong
 * number fails here instead of being explained away by a live engine. The properties
 * pinned down are the ones that would mislead a reader if they broke: a service counted
 * twice inflates a rank, the -1 download sentinel silently subtracts from a total, a
 * hop-2 guess presented as a measurement is a false claim, and an account outside the
 * slice has to abstain rather than rank last with a zero.
 */

const NPM: Ecosystem = "npm";

/** A fixed point in time, so no assertion depends on the clock. */
const FIXTURE_GENERATED_AT_MS = 1_700_000_000_000;

/**
 * A graph builder for the fixtures below.
 *
 * Node ids are handed out in insertion order, which is all MemoryGraph needs, and every
 * natural key comes from the model's key builders so a change to the key format breaks
 * these fixtures loudly instead of making the nodes quietly unreachable.
 */
function createFixture(): Fixture {
  const graph = new MemoryGraph();
  let nextNodeId = 1;
  let nextEdgeId = 1;

  const addNode = (label: NodeLabel, properties: GraphProperties): number => {
    const nodeId = nextNodeId;
    nextNodeId += 1;
    graph.addNode({ id: nodeId, label, properties });
    return nodeId;
  };

  const connect = (relType: RelType, fromNodeId: number, toNodeId: number): void => {
    graph.addEdge({ id: nextEdgeId, relType, fromNodeId, toNodeId, properties: {} });
    nextEdgeId += 1;
  };

  return {
    graph,
    addMaintainer(username: string): number {
      return addNode("Maintainer", {
        key: maintainerKey(NPM, username),
        ecosystem: NPM,
        username,
      });
    },
    addPackage(name: string, weeklyDownloads: number): number {
      return addNode("Package", {
        key: packageKey(NPM, name),
        ecosystem: NPM,
        name,
        weekly_downloads: weeklyDownloads,
      });
    },
    addVersion(name: string, version: string, hasInstallScript = false): number {
      return addNode("Version", {
        key: versionKey(NPM, name, version),
        ecosystem: NPM,
        name,
        version,
        published_at_ms: FIXTURE_GENERATED_AT_MS,
        has_install_script: hasInstallScript,
      });
    },
    addService(name: string): number {
      return addNode("Service", { key: serviceKey(name), name, source: "fixture" });
    },
    maintains(maintainerNodeId: number, packageNodeId: number): void {
      connect("MAINTAINS", maintainerNodeId, packageNodeId);
    },
    versionOf(versionNodeId: number, packageNodeId: number): void {
      connect("VERSION_OF", versionNodeId, packageNodeId);
    },
    dependedOnBy(dependencyNodeId: number, dependentNodeId: number): void {
      // The materialised reverse of RESOLVES_TO: "this version is depended on by that
      // one", which is the only direction a HydraDB path procedure can walk.
      connect("DEPENDED_ON_BY", dependencyNodeId, dependentNodeId);
    },
    resolved(serviceNodeId: number, versionNodeId: number): void {
      connect("RESOLVED", serviceNodeId, versionNodeId);
    },
  };
}

type Fixture = {
  graph: MemoryGraph;
  addMaintainer(username: string): number;
  addPackage(name: string, weeklyDownloads: number): number;
  addVersion(name: string, version: string, hasInstallScript?: boolean): number;
  addService(name: string): number;
  maintains(maintainerNodeId: number, packageNodeId: number): void;
  versionOf(versionNodeId: number, packageNodeId: number): void;
  dependedOnBy(dependencyNodeId: number, dependentNodeId: number): void;
  resolved(serviceNodeId: number, versionNodeId: number): void;
};

/** A manifest for a fixture, written out rather than loaded from disk. */
function buildCoverage(input: {
  closedPackages: readonly string[];
  closedServices: readonly string[];
  versionCount: number;
}): SliceCoverage {
  const manifest: SliceManifest = {
    version: SLICE_MANIFEST_VERSION,
    generatedAtMs: FIXTURE_GENERATED_AT_MS,
    ecosystems: [NPM],
    closedPackageKeys: [...input.closedPackages],
    partialPackageKeys: [],
    closedServiceKeys: [...input.closedServices],
    counts: { ...EMPTY_SLICE_COUNTS, versions: input.versionCount },
    notes: [],
  };
  return new SliceCoverage(manifest);
}

const SLICE_CAVEAT_PHRASE = "lower bound on the slice";

describe("computeMaintainerSurface", () => {
  test("reports the packages an account publishes to and the service that would run the poison", async () => {
    const fixture = createFixture();
    const alice = fixture.addMaintainer("alice");
    const leftPad = fixture.addPackage("left-pad", 1_000_000);
    const leftPadVersion = fixture.addVersion("left-pad", "1.0.0");
    const appPackage = fixture.addPackage("app", 400);
    const appVersion = fixture.addVersion("app", "2.0.0");
    const checkout = fixture.addService("checkout");

    fixture.maintains(alice, leftPad);
    fixture.versionOf(leftPadVersion, leftPad);
    fixture.versionOf(appVersion, appPackage);
    fixture.dependedOnBy(leftPadVersion, appVersion);
    fixture.resolved(checkout, appVersion);

    const answer = await computeMaintainerSurface({
      gateway: fixture.graph,
      coverage: buildCoverage({
        closedPackages: [packageKey(NPM, "left-pad"), packageKey(NPM, "app")],
        closedServices: [serviceKey("checkout")],
        versionCount: 2,
      }),
      maintainerKey: maintainerKey(NPM, "alice"),
    });

    expect(answer.ok).toBe(true);
    if (!answer.ok) return;

    expect(answer.value.verdict).toBe("exposed");
    // No limit at all is the assertion that matters here: a one-hop MAINTAINS pass must
    // not register as a hop limit, or every answer this module gives would look cut.
    expect(answer.value.limits).toEqual([]);
    expect(answer.value.rationale).toContain(SLICE_CAVEAT_PHRASE);

    const surface = answer.value.evidence;
    expect(surface.subject.username).toBe("alice");
    expect(surface.subject.nodeId).toBe(alice);
    expect(surface.direct.packages).toEqual([
      {
        packageKey: packageKey(NPM, "left-pad"),
        ecosystem: NPM,
        name: "left-pad",
        weeklyDownloads: 1_000_000,
        versionCount: 1,
      },
    ]);
    expect(surface.direct.versionCount).toBe(1);
    expect(surface.direct.dependentVersionCount).toBe(1);
    expect(surface.direct.dependentPackageCount).toBe(1);
    expect(surface.direct.reachableWeeklyDownloads).toBe(1_000_000);
    // The service resolved a direct dependent of the poisoned version, so it sits two
    // hops out. One would mean the service resolved the poisoned version itself.
    expect(surface.direct.reachedServices).toEqual([
      { serviceKey: serviceKey("checkout"), serviceName: "checkout", hopCount: 2 },
    ]);
  });

  test("counts a service once when two of the account's packages reach it", async () => {
    const fixture = createFixture();
    const alice = fixture.addMaintainer("alice");
    const leftPad = fixture.addPackage("left-pad", 500);
    const rightPad = fixture.addPackage("right-pad", 700);
    const leftPadVersion = fixture.addVersion("left-pad", "1.0.0");
    const rightPadVersion = fixture.addVersion("right-pad", "1.0.0");
    const appOne = fixture.addPackage("app-one", 10);
    const appTwo = fixture.addPackage("app-two", 20);
    const appOneVersion = fixture.addVersion("app-one", "1.0.0");
    const appTwoVersion = fixture.addVersion("app-two", "1.0.0");
    const checkout = fixture.addService("checkout");

    fixture.maintains(alice, leftPad);
    fixture.maintains(alice, rightPad);
    fixture.versionOf(leftPadVersion, leftPad);
    fixture.versionOf(rightPadVersion, rightPad);
    fixture.versionOf(appOneVersion, appOne);
    fixture.versionOf(appTwoVersion, appTwo);
    fixture.dependedOnBy(leftPadVersion, appOneVersion);
    fixture.dependedOnBy(rightPadVersion, appTwoVersion);
    // The same service reaches the account through three routes: two dependents and one
    // direct resolution. It is one service either way.
    fixture.resolved(checkout, appOneVersion);
    fixture.resolved(checkout, appTwoVersion);
    fixture.resolved(checkout, rightPadVersion);

    const answer = await computeMaintainerSurface({
      gateway: fixture.graph,
      coverage: buildCoverage({
        closedPackages: [
          packageKey(NPM, "left-pad"),
          packageKey(NPM, "right-pad"),
          packageKey(NPM, "app-one"),
          packageKey(NPM, "app-two"),
        ],
        closedServices: [serviceKey("checkout")],
        versionCount: 4,
      }),
      maintainerKey: maintainerKey(NPM, "alice"),
    });

    expect(answer.ok).toBe(true);
    if (!answer.ok) return;

    const surface = answer.value.evidence;
    expect(surface.direct.packages.map((entry) => entry.packageKey)).toEqual([
      packageKey(NPM, "left-pad"),
      packageKey(NPM, "right-pad"),
    ]);
    expect(surface.direct.versionCount).toBe(2);
    expect(surface.direct.dependentVersionCount).toBe(2);
    expect(surface.direct.dependentPackageCount).toBe(2);
    // Counted once, at the shortest of the three routes.
    expect(surface.direct.reachedServices).toEqual([
      { serviceKey: serviceKey("checkout"), serviceName: "checkout", hopCount: 1 },
    ]);
    expect(surface.direct.reachableWeeklyDownloads).toBe(1_200);
  });

  test("keeps the hop-2 model out of every hop-1 number and marks it as modelled", async () => {
    const fixture = createFixture();
    const alice = fixture.addMaintainer("alice");
    const leftPad = fixture.addPackage("left-pad", 500);
    const ownTool = fixture.addPackage("own-tool", 100);
    const leftPadVersion = fixture.addVersion("left-pad", "1.0.0");
    const ownToolVersion = fixture.addVersion("own-tool", "1.0.0");
    // A version of the account's own package that arrived as a dependent without its
    // VERSION_OF edge, which is what a closure cut short at ingest time looks like. It
    // is a dependent, but poisoning a package the account already controls is not
    // propagation, so it must not appear as a hop-2 candidate.
    const ownToolStrayVersion = fixture.addVersion("own-tool", "2.0.0");
    const appOne = fixture.addPackage("app-one", 9_000_000);
    const appTwo = fixture.addPackage("app-two", 30);
    const appOneVersion = fixture.addVersion("app-one", "1.0.0", true);
    const appTwoVersion = fixture.addVersion("app-two", "1.0.0");

    fixture.maintains(alice, leftPad);
    fixture.maintains(alice, ownTool);
    fixture.versionOf(leftPadVersion, leftPad);
    fixture.versionOf(ownToolVersion, ownTool);
    fixture.versionOf(appOneVersion, appOne);
    fixture.versionOf(appTwoVersion, appTwo);
    fixture.dependedOnBy(leftPadVersion, ownToolVersion);
    fixture.dependedOnBy(leftPadVersion, ownToolStrayVersion);
    fixture.dependedOnBy(leftPadVersion, appOneVersion);
    fixture.dependedOnBy(appOneVersion, appTwoVersion);

    const answer = await computeMaintainerSurface({
      gateway: fixture.graph,
      coverage: buildCoverage({
        closedPackages: [packageKey(NPM, "left-pad"), packageKey(NPM, "own-tool")],
        closedServices: [],
        versionCount: 5,
      }),
      maintainerKey: maintainerKey(NPM, "alice"),
    });

    expect(answer.ok).toBe(true);
    if (!answer.ok) return;

    const surface = answer.value.evidence;
    // own-tool 1.0.0 is a version the account publishes, so it stays a seed at hop 0 and
    // is not counted as a dependent even though a dependent edge reaches it.
    expect(surface.direct.versionCount).toBe(2);
    expect(surface.direct.dependentVersionCount).toBe(3);
    expect(surface.direct.dependentPackageCount).toBe(3);
    // The downstream package has nine million weekly downloads and none of them belong
    // in the account's own volume.
    expect(surface.direct.reachableWeeklyDownloads).toBe(600);

    expect(surface.modelled.isModelled).toBe(true);
    expect(surface.modelled.assumption).toBe(HOP_TWO_ASSUMPTION);
    // The stray own-tool version drops out of the candidate counts, so the modelled
    // numbers are strictly smaller than the measured dependent counts.
    expect(surface.modelled.candidateVersionCount).toBe(2);
    expect(surface.modelled.candidatePackageCount).toBe(2);
    expect(surface.modelled.candidateVersionsWithInstallScript).toBe(1);
    expect(surface.modelled.candidatePackagesWithInstallScript).toBe(1);
  });

  test("keeps the missing download sentinel out of the volume total", async () => {
    const fixture = createFixture();
    const alice = fixture.addMaintainer("alice");
    const leftPad = fixture.addPackage("left-pad", 1_000_000);
    // -1 is how the graph records a registry that reported no download count. Summing it
    // raw would quietly subtract from the rank.
    const quietPad = fixture.addPackage("quiet-pad", -1);
    const leftPadVersion = fixture.addVersion("left-pad", "1.0.0");
    const quietPadVersion = fixture.addVersion("quiet-pad", "1.0.0");

    fixture.maintains(alice, leftPad);
    fixture.maintains(alice, quietPad);
    fixture.versionOf(leftPadVersion, leftPad);
    fixture.versionOf(quietPadVersion, quietPad);

    const answer = await computeMaintainerSurface({
      gateway: fixture.graph,
      coverage: buildCoverage({
        closedPackages: [packageKey(NPM, "left-pad"), packageKey(NPM, "quiet-pad")],
        closedServices: [],
        versionCount: 2,
      }),
      maintainerKey: maintainerKey(NPM, "alice"),
    });

    expect(answer.ok).toBe(true);
    if (!answer.ok) return;

    const surface = answer.value.evidence;
    expect(surface.direct.reachableWeeklyDownloads).toBe(1_000_000);
    expect(surface.direct.packagesWithoutDownloadCount).toBe(1);
    expect(
      surface.direct.packages.find((entry) => entry.name === "quiet-pad")?.weeklyDownloads,
    ).toBeNull();
  });

  test("abstains when the account is not in the slice", async () => {
    const fixture = createFixture();
    const alice = fixture.addMaintainer("alice");
    const leftPad = fixture.addPackage("left-pad", 10);
    const leftPadVersion = fixture.addVersion("left-pad", "1.0.0");
    fixture.maintains(alice, leftPad);
    fixture.versionOf(leftPadVersion, leftPad);

    const answer = await computeMaintainerSurface({
      gateway: fixture.graph,
      coverage: buildCoverage({
        closedPackages: [packageKey(NPM, "left-pad")],
        closedServices: [],
        versionCount: 1,
      }),
      maintainerKey: maintainerKey(NPM, "ghost"),
    });

    expect(answer.ok).toBe(true);
    if (!answer.ok) return;

    expect(answer.value.verdict).toBe("unknown");
    expect(answer.value.limits).toContainEqual({
      kind: "package_absent",
      subjectKey: maintainerKey(NPM, "ghost"),
    });
    expect(answer.value.evidence.subject.nodeId).toBeNull();
    expect(answer.value.evidence.direct.packages).toEqual([]);
    expect(answer.value.rationale).toContain(SLICE_CAVEAT_PHRASE);
  });

  test("abstains on an empty graph instead of reporting a surface of zero", async () => {
    const fixture = createFixture();
    fixture.addMaintainer("alice");

    const answer = await computeMaintainerSurface({
      gateway: fixture.graph,
      coverage: buildCoverage({ closedPackages: [], closedServices: [], versionCount: 0 }),
      maintainerKey: maintainerKey(NPM, "alice"),
    });

    expect(answer.ok).toBe(true);
    if (!answer.ok) return;

    expect(answer.value.verdict).toBe("unknown");
    expect(answer.value.limits[0]).toEqual({ kind: "empty_graph" });
  });
});

describe("rankMaintainerSurfaces", () => {
  test("ranks accounts by reachable services, then by download volume", async () => {
    const fixture = createFixture();
    const alice = fixture.addMaintainer("alice");
    const bob = fixture.addMaintainer("bob");
    const carol = fixture.addMaintainer("carol");

    const leftPad = fixture.addPackage("left-pad", 900);
    const rightPad = fixture.addPackage("right-pad", 100);
    const bobTool = fixture.addPackage("bob-tool", 5_000);
    const carolTool = fixture.addPackage("carol-tool", 50);

    const leftPadVersion = fixture.addVersion("left-pad", "1.0.0");
    const rightPadVersion = fixture.addVersion("right-pad", "1.0.0");
    const bobToolVersion = fixture.addVersion("bob-tool", "1.0.0");
    const carolToolVersion = fixture.addVersion("carol-tool", "1.0.0");

    const checkout = fixture.addService("checkout");
    const billing = fixture.addService("billing");

    fixture.maintains(alice, leftPad);
    fixture.maintains(alice, rightPad);
    fixture.maintains(bob, bobTool);
    fixture.maintains(carol, carolTool);

    fixture.versionOf(leftPadVersion, leftPad);
    fixture.versionOf(rightPadVersion, rightPad);
    fixture.versionOf(bobToolVersion, bobTool);
    fixture.versionOf(carolToolVersion, carolTool);

    // alice reaches both services, bob and carol reach one each, so the download volume
    // breaks the tie between bob and carol.
    fixture.resolved(checkout, leftPadVersion);
    fixture.resolved(billing, rightPadVersion);
    fixture.resolved(checkout, bobToolVersion);
    fixture.resolved(billing, carolToolVersion);

    const answer = await rankMaintainerSurfaces({
      gateway: fixture.graph,
      coverage: buildCoverage({
        closedPackages: [
          packageKey(NPM, "left-pad"),
          packageKey(NPM, "right-pad"),
          packageKey(NPM, "bob-tool"),
          packageKey(NPM, "carol-tool"),
        ],
        closedServices: [serviceKey("checkout"), serviceKey("billing")],
        versionCount: 4,
      }),
      maintainerKeys: [
        maintainerKey(NPM, "carol"),
        maintainerKey(NPM, "bob"),
        maintainerKey(NPM, "alice"),
      ],
    });

    expect(answer.ok).toBe(true);
    if (!answer.ok) return;

    expect(answer.value.verdict).toBe("exposed");
    const leaderboard = answer.value.evidence;
    expect(leaderboard.rows.map((row) => row.subject.username)).toEqual([
      "alice",
      "bob",
      "carol",
    ]);
    expect(leaderboard.maintainersRequested).toBe(3);
    expect(leaderboard.unrankedMaintainerKeys).toEqual([]);
    expect(leaderboard.servicesConsidered).toBe(2);

    // Attribution from one batched MAINTAINS pass: the packages have to land on the
    // account that publishes them, not on whichever seed the engine walked first.
    const [first, second, third] = leaderboard.rows;
    expect(first?.subject.nodeId).toBe(alice);
    expect(first?.direct.packages.map((entry) => entry.packageKey)).toEqual([
      packageKey(NPM, "left-pad"),
      packageKey(NPM, "right-pad"),
    ]);
    expect(first?.direct.reachedServices.map((reached) => reached.serviceKey)).toEqual([
      serviceKey("billing"),
      serviceKey("checkout"),
    ]);
    expect(second?.subject.nodeId).toBe(bob);
    expect(second?.direct.packages.map((entry) => entry.packageKey)).toEqual([
      packageKey(NPM, "bob-tool"),
    ]);
    expect(third?.subject.nodeId).toBe(carol);
    expect(third?.direct.packages.map((entry) => entry.packageKey)).toEqual([
      packageKey(NPM, "carol-tool"),
    ]);
  });

  test("carries the slice lower-bound caveat and holds no rank for an account without publish rights", async () => {
    const fixture = createFixture();
    const alice = fixture.addMaintainer("alice");
    const leftPad = fixture.addPackage("left-pad", 900);
    const leftPadVersion = fixture.addVersion("left-pad", "1.0.0");
    const checkout = fixture.addService("checkout");

    fixture.maintains(alice, leftPad);
    fixture.versionOf(leftPadVersion, leftPad);
    fixture.resolved(checkout, leftPadVersion);

    const answer = await rankMaintainerSurfaces({
      gateway: fixture.graph,
      coverage: buildCoverage({
        closedPackages: [packageKey(NPM, "left-pad")],
        closedServices: [serviceKey("checkout")],
        versionCount: 1,
      }),
      // The same key twice, plus an account with nothing ingested under it.
      maintainerKeys: [
        maintainerKey(NPM, "alice"),
        maintainerKey(NPM, "alice"),
        maintainerKey(NPM, "ghost"),
      ],
    });

    expect(answer.ok).toBe(true);
    if (!answer.ok) return;

    const leaderboard = answer.value.evidence;
    expect(leaderboard.isSliceLowerBound).toBe(true);
    expect(answer.value.rationale).toContain(SLICE_CAVEAT_PHRASE);
    expect(leaderboard.maintainersRequested).toBe(2);
    expect(leaderboard.rows).toHaveLength(1);
    expect(leaderboard.unrankedMaintainerKeys).toEqual([maintainerKey(NPM, "ghost")]);
    // An unranked account means the ranking itself is incomplete, which has to show up
    // as a limit rather than as a confident leaderboard.
    expect(answer.value.limits).toContainEqual({
      kind: "package_partial",
      subjectKey: "The requested maintainer set",
    });
  });
});
