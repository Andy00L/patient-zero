import { describe, expect, test } from "bun:test";

import type { AbstainingAnswer } from "@/lib/analysis/abstention";
import {
  type BlastRadiusEvidence,
  type BlastRadiusRequest,
  type ExposurePath,
  computeBlastRadius,
} from "@/lib/analysis/blast-radius";
import { MemoryGraph } from "@/lib/graph/memory-gateway";
import { packageKey, serviceKey, versionKey } from "@/lib/graph/model";
import type { Failure } from "@/lib/result";

import {
  EVENT_STREAM_KEYS,
  FIXTURE_RESOLVED_AT_MS,
  buildEventStreamCoverage,
  buildEventStreamScenario,
  buildFixtureGraph,
  buildSliceCoverage,
  dependencyEdge,
  findFixtureModelViolations,
  lockfileEdge,
} from "./fixtures/graph";

/**
 * Blast radius is the answer the project exists to give, and it is answered on a graph
 * whose shape is easy to get subtly wrong: the walk runs over the materialised reverse
 * type, hop counts are measured in two different units (version distance for the
 * traversal, service distance for the answer), and a diamond produces several routes to
 * the same node.
 *
 * So these tests assert on graphs whose answer was worked out by hand, and the one that
 * matters most is the negative: a graph where nothing depends on the compromised version
 * must produce not_exposed, and the same graph with a slice that never ingested the
 * package must not.
 */

const COMPROMISED = EVENT_STREAM_KEYS.flatmapStreamVersion;

async function answerOrUnreachable(
  request: BlastRadiusRequest,
): Promise<AbstainingAnswer<BlastRadiusEvidence>> {
  const result = await computeBlastRadius(request);
  if (result.ok) return result.value;
  return expect.unreachable(`blast radius failed: ${result.failure.message}`);
}

async function failureOrUnreachable(request: BlastRadiusRequest): Promise<Failure> {
  const result = await computeBlastRadius(request);
  if (result.ok) return expect.unreachable("expected a Failure, received an answer");
  return result.failure;
}

function limitKinds(answer: AbstainingAnswer<BlastRadiusEvidence>): string[] {
  return answer.limits.map((limit) => limit.kind);
}

function stepKeys(path: ExposurePath): string[] {
  return path.steps.map((step) => step.key);
}

/**
 * ExposurePath documents `steps.length === hopCount + 1`. It is checked here rather than
 * once per test because both halves of the answer build their paths through different
 * functions, and a UI that indexes steps by hop count breaks silently if either drifts.
 */
function expectPathShapes(
  exposures: readonly { hopCount: number; shortestPath: ExposurePath }[],
): void {
  for (const exposure of exposures) {
    expect(exposure.shortestPath.steps.length).toBe(exposure.shortestPath.hopCount + 1);
    expect(exposure.shortestPath.hopCount).toBe(exposure.hopCount);
    // Simple paths only: a repeated key would mean a cycle was walked twice.
    expect(new Set(stepKeys(exposure.shortestPath)).size).toBe(
      exposure.shortestPath.steps.length,
    );
  }
}

describe("the event-stream scenario", () => {
  test("the fixture agrees with the graph model", () => {
    // Every other test in this file rests on this: a mislabelled endpoint or a mistyped
    // property would still traverse, and the assertions would then be about data the
    // real writer could never produce.
    expect(findFixtureModelViolations(buildEventStreamScenario())).toEqual([]);
  });

  test("a service two hops away is exposed, with the path read service first", async () => {
    const answer = await answerOrUnreachable({
      gateway: buildEventStreamScenario().graph,
      coverage: buildEventStreamCoverage(),
      versionKey: COMPROMISED,
    });

    const checkout = answer.evidence.exposedServices.find(
      (exposure) => exposure.serviceKey === EVENT_STREAM_KEYS.checkoutApiService,
    );
    expect(checkout).toBeDefined();
    if (checkout === undefined) return;

    expect(checkout.hopCount).toBe(2);
    expect(checkout.isDirectDependency).toBe(false);
    expect(stepKeys(checkout.shortestPath)).toEqual([
      EVENT_STREAM_KEYS.checkoutApiService,
      EVENT_STREAM_KEYS.eventStreamVersion,
      COMPROMISED,
    ]);

    const steps = checkout.shortestPath.steps;
    expect(steps[0].nodeKind).toBe("service");
    expect(steps[0].viaRelType).toBeNull();
    // The resolved edge is the one the lockfile proves, so its timestamp belongs on the
    // step the service resolved and nowhere else on the path.
    expect(steps[1].viaRelType).toBe("RESOLVED");
    expect(steps[1].resolvedAtMs).toBe(FIXTURE_RESOLVED_AT_MS);
    expect(steps[2].viaRelType).toBe("RESOLVES_TO");
    expect(steps[2].resolvedAtMs).toBeNull();
    expect(steps[2].displayName).toBe("flatmap-stream@0.1.1");
  });

  test("a service four hops away names every version between it and the payload", async () => {
    const answer = await answerOrUnreachable({
      gateway: buildEventStreamScenario().graph,
      coverage: buildEventStreamCoverage(),
      versionKey: COMPROMISED,
    });

    const wallet = answer.evidence.exposedServices.find(
      (exposure) => exposure.serviceKey === EVENT_STREAM_KEYS.walletWebService,
    );
    expect(wallet).toBeDefined();
    if (wallet === undefined) return;

    expect(wallet.hopCount).toBe(4);
    expect(stepKeys(wallet.shortestPath)).toEqual([
      EVENT_STREAM_KEYS.walletWebService,
      EVENT_STREAM_KEYS.nodemonVersion,
      EVENT_STREAM_KEYS.psTreeVersion,
      EVENT_STREAM_KEYS.eventStreamVersion,
      COMPROMISED,
    ]);
  });

  test("a service on none of the routes is absent from the answer", async () => {
    const answer = await answerOrUnreachable({
      gateway: buildEventStreamScenario().graph,
      coverage: buildEventStreamCoverage(),
      versionKey: COMPROMISED,
    });

    // docs-site resolved chalk only. A traversal that leaked into other edge types, or
    // an exposure list built from every service instead of the reached ones, shows up
    // here and nowhere else.
    expect(answer.evidence.exposedServices.map((exposure) => exposure.serviceKey)).toEqual([
      EVENT_STREAM_KEYS.checkoutApiService,
      EVENT_STREAM_KEYS.walletWebService,
    ]);
    expect(answer.evidence.servicesConsidered).toBe(3);
  });

  test("exposed versions are ordered by depth and maxHopReached is a version distance", async () => {
    const answer = await answerOrUnreachable({
      gateway: buildEventStreamScenario().graph,
      coverage: buildEventStreamCoverage(),
      versionKey: COMPROMISED,
    });

    expect(
      answer.evidence.exposedVersions.map((exposure) => [exposure.versionKey, exposure.hopCount]),
    ).toEqual([
      [EVENT_STREAM_KEYS.eventStreamVersion, 1],
      [EVENT_STREAM_KEYS.psTreeVersion, 2],
      [EVENT_STREAM_KEYS.nodemonVersion, 3],
    ]);
    // Three version hops, four service hops. Conflating the two units is the mistake
    // this assertion exists to catch.
    expect(answer.evidence.maxHopReached).toBe(3);
  });

  test("the verdict is exposed with no limits, and every path keeps its shape", async () => {
    const answer = await answerOrUnreachable({
      gateway: buildEventStreamScenario().graph,
      coverage: buildEventStreamCoverage(),
      versionKey: COMPROMISED,
    });

    expect(answer.verdict).toBe("exposed");
    expect(answer.limits).toEqual([]);
    expect(answer.rationale).toContain("ran to completion");
    expectPathShapes(answer.evidence.exposedServices);
    expectPathShapes(answer.evidence.exposedVersions);
  });
});

describe("direct dependency", () => {
  test("a service that resolved the compromised version itself is one hop", async () => {
    const fixture = buildFixtureGraph({
      packages: [{ name: "flatmap-stream" }],
      versions: [{ name: "flatmap-stream", version: "0.1.1" }],
      services: [{ name: "checkout-api" }],
      edges: [lockfileEdge("checkout-api", COMPROMISED)],
    });

    const answer = await answerOrUnreachable({
      gateway: fixture.graph,
      coverage: buildSliceCoverage({
        closedPackageKeys: [EVENT_STREAM_KEYS.flatmapStreamPackage],
        closedServiceKeys: [serviceKey("checkout-api")],
      }),
      versionKey: COMPROMISED,
    });

    expect(answer.verdict).toBe("exposed");
    expect(answer.evidence.exposedServices).toHaveLength(1);

    const exposure = answer.evidence.exposedServices[0];
    expect(exposure.hopCount).toBe(1);
    expect(exposure.isDirectDependency).toBe(true);
    expect(exposure.pathCount).toBe(1);
    expect(stepKeys(exposure.shortestPath)).toEqual([serviceKey("checkout-api"), COMPROMISED]);
    expect(exposure.shortestPath.steps[1].viaRelType).toBe("RESOLVED");
    expect(exposure.shortestPath.steps[1].resolvedAtMs).toBe(FIXTURE_RESOLVED_AT_MS);
    // No dependent versions exist, so the whole answer rests on the service side.
    expect(answer.evidence.exposedVersions).toEqual([]);
    expect(answer.evidence.maxHopReached).toBe(0);
  });
});

describe("several routes to the same dependent", () => {
  /**
   * nodemon depends on the payload twice over: directly, and through event-stream.
   *
   *     flatmap-stream <- event-stream <- nodemon
   *     flatmap-stream <----------------- nodemon
   *
   * so nodemon is reachable at one hop and at two, and wallet-web is two hops from the
   * payload rather than three.
   */
  function buildDiamond(): MemoryGraph {
    return buildFixtureGraph({
      packages: [{ name: "flatmap-stream" }, { name: "event-stream" }, { name: "nodemon" }],
      versions: [
        { name: "flatmap-stream", version: "0.1.1" },
        { name: "event-stream", version: "3.3.6" },
        { name: "nodemon", version: "1.18.7" },
      ],
      services: [{ name: "wallet-web" }],
      edges: [
        dependencyEdge(EVENT_STREAM_KEYS.eventStreamVersion, COMPROMISED),
        dependencyEdge(EVENT_STREAM_KEYS.nodemonVersion, EVENT_STREAM_KEYS.eventStreamVersion),
        dependencyEdge(EVENT_STREAM_KEYS.nodemonVersion, COMPROMISED),
        lockfileEdge("wallet-web", EVENT_STREAM_KEYS.nodemonVersion),
      ],
    }).graph;
  }

  test("the shortest route is the one explained, and the others are still counted", async () => {
    const answer = await answerOrUnreachable({
      gateway: buildDiamond(),
      coverage: buildSliceCoverage({
        closedPackageKeys: [
          EVENT_STREAM_KEYS.flatmapStreamPackage,
          EVENT_STREAM_KEYS.eventStreamPackage,
          EVENT_STREAM_KEYS.nodemonPackage,
        ],
      }),
      versionKey: COMPROMISED,
    });

    expect(answer.evidence.exposedServices).toHaveLength(1);
    const exposure = answer.evidence.exposedServices[0];

    expect(exposure.hopCount).toBe(2);
    expect(stepKeys(exposure.shortestPath)).toEqual([
      serviceKey("wallet-web"),
      EVENT_STREAM_KEYS.nodemonVersion,
      COMPROMISED,
    ]);
    // Both routes reach nodemon, and the count is what tells a reader the exposure is
    // not a single fragile edge.
    expect(exposure.pathCount).toBe(2);

    const nodemon = answer.evidence.exposedVersions.find(
      (version) => version.versionKey === EVENT_STREAM_KEYS.nodemonVersion,
    );
    expect(nodemon).toBeDefined();
    expect(nodemon?.hopCount).toBe(1);
    expect(answer.evidence.exposedVersions).toHaveLength(2);
  });
});

describe("the negative answer", () => {
  /** A real package nobody depends on, in a graph that also holds unrelated data. */
  function buildUnusedPackageGraph(): MemoryGraph {
    return buildFixtureGraph({
      packages: [{ name: "flatmap-stream" }, { name: "chalk" }],
      versions: [
        { name: "flatmap-stream", version: "0.1.1" },
        { name: "chalk", version: "5.3.1" },
      ],
      services: [{ name: "docs-site" }],
      edges: [lockfileEdge("docs-site", EVENT_STREAM_KEYS.chalkVersion)],
    }).graph;
  }

  test("nothing depends on it and its closure was ingested, so this is a real negative", async () => {
    const answer = await answerOrUnreachable({
      gateway: buildUnusedPackageGraph(),
      coverage: buildSliceCoverage({
        closedPackageKeys: [
          EVENT_STREAM_KEYS.flatmapStreamPackage,
          EVENT_STREAM_KEYS.chalkPackage,
        ],
        closedServiceKeys: [serviceKey("docs-site")],
      }),
      versionKey: COMPROMISED,
    });

    expect(answer.verdict).toBe("not_exposed");
    // A limit here would be a false negative in the making: it would mean the traversal
    // stopped early and the verdict claimed completeness anyway.
    expect(answer.limits).toEqual([]);
    expect(answer.evidence.exposedServices).toEqual([]);
    expect(answer.evidence.exposedVersions).toEqual([]);
  });

  test("the same graph with the package outside the slice cannot answer", async () => {
    const answer = await answerOrUnreachable({
      gateway: buildUnusedPackageGraph(),
      coverage: buildSliceCoverage({ closedPackageKeys: [EVENT_STREAM_KEYS.chalkPackage] }),
      versionKey: COMPROMISED,
    });

    // Same graph, same empty traversal, opposite verdict. This pair is the abstention
    // model earning its keep.
    expect(answer.verdict).toBe("unknown");
    expect(limitKinds(answer)).toEqual(["package_absent"]);
    expect(answer.rationale).toContain(COMPROMISED);
  });
});

describe("abstention rather than a failure", () => {
  test("a version that is not a node is unknown, not an error", async () => {
    const answer = await answerOrUnreachable({
      gateway: buildEventStreamScenario().graph,
      coverage: buildEventStreamCoverage(),
      versionKey: versionKey("npm", "flatmap-stream", "0.1.2"),
    });

    // The package is closed in the manifest and the graph is populated, yet this exact
    // version was never ingested. Answering not_exposed here would be a lie about a
    // version nobody looked at.
    expect(answer.verdict).toBe("unknown");
    expect(limitKinds(answer)).toEqual(["package_absent"]);
    expect(answer.evidence.compromised.nodeId).toBeNull();
  });

  test("an empty graph reports only that it is empty", async () => {
    const answer = await answerOrUnreachable({
      gateway: new MemoryGraph(),
      coverage: buildSliceCoverage({ closedPackageKeys: [EVENT_STREAM_KEYS.flatmapStreamPackage] }),
      versionKey: COMPROMISED,
    });

    expect(answer.verdict).toBe("unknown");
    expect(limitKinds(answer)).toEqual(["empty_graph"]);
    expect(answer.rationale).toContain("ingest");
  });

  for (const malformed of [
    "flatmap-stream@0.1.1",
    "npm:flatmap-stream",
    "cargo:serde:1.0.0",
    "npm::0.1.1",
    "",
  ]) {
    test(`"${malformed}" is rejected as invalid input`, async () => {
      const failure = await failureOrUnreachable({
        gateway: buildEventStreamScenario().graph,
        coverage: buildEventStreamCoverage(),
        versionKey: malformed,
      });

      // A malformed key is the caller's bug, not an unanswerable question, so it is a
      // Failure rather than an abstention.
      expect(failure.reason).toBe("invalid_input");
    });
  }
});

describe("truncation is recorded, never smoothed over", () => {
  test("a hop ceiling that cuts the walk is reported and the deep service disappears", async () => {
    const answer = await answerOrUnreachable({
      gateway: buildEventStreamScenario().graph,
      coverage: buildEventStreamCoverage(),
      versionKey: COMPROMISED,
      options: { maxHops: 1 },
    });

    expect(limitKinds(answer)).toContain("hop_limit");
    expect(answer.verdict).not.toBe("not_exposed");
    expect(answer.verdict).toBe("exposed");
    // Only the one hop dependent survives the ceiling, so wallet-web is missing from an
    // answer that says out loud it stopped early.
    expect(answer.evidence.exposedServices.map((exposure) => exposure.serviceKey)).toEqual([
      EVENT_STREAM_KEYS.checkoutApiService,
    ]);
    expect(answer.rationale).toContain("at least this large");
  });

  test("a service scan cap is reported with what it examined", async () => {
    const answer = await answerOrUnreachable({
      gateway: buildEventStreamScenario().graph,
      coverage: buildEventStreamCoverage(),
      versionKey: COMPROMISED,
      options: { maxServices: 1 },
    });

    expect(answer.limits).toEqual([{ kind: "scan_capped", examined: 1, total: 1 }]);
    expect(answer.evidence.servicesConsidered).toBe(1);
    // Services are enumerated in insertion order, so the cap keeps checkout-api.
    expect(answer.evidence.exposedServices.map((exposure) => exposure.serviceKey)).toEqual([
      EVENT_STREAM_KEYS.checkoutApiService,
    ]);
  });
});

describe("cycles", () => {
  test("a dependency cycle terminates and counts each version once", async () => {
    // event-stream and ps-tree depend on each other, which a real resolution graph does
    // produce through dev dependencies. Simple-path semantics is what keeps this finite.
    const fixture = buildFixtureGraph({
      packages: [{ name: "flatmap-stream" }, { name: "event-stream" }, { name: "ps-tree" }],
      versions: [
        { name: "flatmap-stream", version: "0.1.1" },
        { name: "event-stream", version: "3.3.6" },
        { name: "ps-tree", version: "1.2.0" },
      ],
      edges: [
        dependencyEdge(EVENT_STREAM_KEYS.eventStreamVersion, COMPROMISED),
        dependencyEdge(EVENT_STREAM_KEYS.psTreeVersion, EVENT_STREAM_KEYS.eventStreamVersion),
        dependencyEdge(EVENT_STREAM_KEYS.eventStreamVersion, EVENT_STREAM_KEYS.psTreeVersion),
      ],
    });

    const answer = await answerOrUnreachable({
      gateway: fixture.graph,
      coverage: buildSliceCoverage({
        closedPackageKeys: [
          EVENT_STREAM_KEYS.flatmapStreamPackage,
          EVENT_STREAM_KEYS.eventStreamPackage,
          packageKey("npm", "ps-tree"),
        ],
      }),
      versionKey: COMPROMISED,
    });

    expect(answer.verdict).toBe("exposed");
    expect(
      answer.evidence.exposedVersions.map((exposure) => [exposure.versionKey, exposure.hopCount]),
    ).toEqual([
      [EVENT_STREAM_KEYS.eventStreamVersion, 1],
      [EVENT_STREAM_KEYS.psTreeVersion, 2],
    ]);
    expectPathShapes(answer.evidence.exposedVersions);
  });
});
