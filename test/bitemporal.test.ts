import { describe, expect, test } from "bun:test";

import {
  type ResolvedWhileLiveRequest,
  buildExposureTimeline,
  computeResolvedWhileLive,
} from "@/lib/analysis/bitemporal";
import { MemoryGraph } from "@/lib/graph/memory-gateway";
import { SliceCoverage, type SliceManifest } from "@/lib/graph/slice-manifest";

/**
 * The bitemporal answer is the one question in this project where a wrong boundary is
 * invisible. Every case below therefore pins the two clocks to exact instants and asserts
 * on the verdict, not only on the victim list: reporting "no victims" where the honest
 * answer is "we could not tell" is the failure this module exists to prevent.
 *
 * Fixtures are built inline against MemoryGraph because the pushed-down property window is
 * part of what is under test, and the memory gateway applies it with the same half-open
 * semantics the engine does.
 */

const ADVISORY_KEY = "GHSA-mh6f-8j2x-4483";
const ABSENT_ADVISORY_KEY = "GHSA-0000-0000-0000";
const COMPROMISED_VERSION_KEY = "npm:chalk:5.3.1";
const COMPROMISED_PACKAGE_KEY = "npm:chalk";

/** Unit: milliseconds. */
const HOUR_MS = 60 * 60 * 1_000;

/** Valid time: 2025-03-01T00:00:00Z, when the compromised version became installable. */
const VERSION_PUBLISHED_MS = Date.UTC(2025, 2, 1);
/** Known time: 2025-03-08T00:00:00Z, when the advisory made the compromise public. */
const ADVISORY_PUBLISHED_MS = Date.UTC(2025, 2, 8);

const ADVISORY_NODE_ID = 1;
const COMPROMISED_VERSION_NODE_ID = 2;
/** A version of the same package that was never compromised. */
const CLEAN_VERSION_NODE_ID = 3;
const FIRST_SERVICE_NODE_ID = 10;
const FIRST_EDGE_ID = 100;

const CHECKOUT_SERVICE = { key: "svc:checkout-api", name: "checkout-api" };
const ANALYTICS_SERVICE = { key: "svc:analytics-api", name: "analytics-api" };
const BILLING_SERVICE = { key: "svc:billing-worker", name: "billing-worker" };

/** One harvested lockfile line: this service pinned this version at this instant. */
type ResolutionFixture = {
  service: { key: string; name: string };
  versionNodeId: number;
  resolvedAtMs: number;
};

type GraphFixture = {
  advisoryPublishedAtMs?: number;
  versionPublishedAtMs?: number;
  resolutions: readonly ResolutionFixture[];
};

/**
 * Builds an advisory, two versions of one package, and one RESOLVED edge per resolution.
 * Edges keep fixture order, which is what lets the truncation case decide which edge a
 * capped read returns.
 */
function buildGraph(fixture: GraphFixture): MemoryGraph {
  const graph = new MemoryGraph();

  graph.addNode({
    id: ADVISORY_NODE_ID,
    label: "Advisory",
    properties: {
      key: ADVISORY_KEY,
      ghsa_id: ADVISORY_KEY,
      published_at_ms: fixture.advisoryPublishedAtMs ?? ADVISORY_PUBLISHED_MS,
      modified_at_ms: ADVISORY_PUBLISHED_MS + HOUR_MS,
      summary: "chalk 5.3.1 shipped a credential reader in its postinstall script.",
    },
  });

  graph.addNode({
    id: COMPROMISED_VERSION_NODE_ID,
    label: "Version",
    properties: {
      key: COMPROMISED_VERSION_KEY,
      ecosystem: "npm",
      name: "chalk",
      version: "5.3.1",
      published_at_ms: fixture.versionPublishedAtMs ?? VERSION_PUBLISHED_MS,
      has_install_script: true,
    },
  });

  graph.addNode({
    id: CLEAN_VERSION_NODE_ID,
    label: "Version",
    properties: {
      key: "npm:chalk:5.3.0",
      ecosystem: "npm",
      name: "chalk",
      version: "5.3.0",
      published_at_ms: VERSION_PUBLISHED_MS - 30 * 24 * HOUR_MS,
      has_install_script: false,
    },
  });

  const serviceNodeIdByKey = new Map<string, number>();
  let nextServiceNodeId = FIRST_SERVICE_NODE_ID;
  let nextEdgeId = FIRST_EDGE_ID;

  for (const resolution of fixture.resolutions) {
    let serviceNodeId = serviceNodeIdByKey.get(resolution.service.key);
    if (serviceNodeId === undefined) {
      serviceNodeId = nextServiceNodeId;
      nextServiceNodeId += 1;
      serviceNodeIdByKey.set(resolution.service.key, serviceNodeId);
      graph.addNode({
        id: serviceNodeId,
        label: "Service",
        properties: {
          key: resolution.service.key,
          name: resolution.service.name,
          source: "seed",
        },
      });
    }

    graph.addEdge({
      id: nextEdgeId,
      relType: "RESOLVED",
      fromNodeId: serviceNodeId,
      toNodeId: resolution.versionNodeId,
      properties: { resolved_at_ms: resolution.resolvedAtMs },
    });
    nextEdgeId += 1;
  }

  return graph;
}

/** A manifest that closes the door on abstention, so a negative verdict is a real one. */
function buildClosedCoverage(): SliceCoverage {
  const manifest: SliceManifest = {
    version: 1,
    generatedAtMs: ADVISORY_PUBLISHED_MS + 24 * HOUR_MS,
    ecosystems: ["npm"],
    closedPackageKeys: [COMPROMISED_PACKAGE_KEY],
    partialPackageKeys: [],
    closedServiceKeys: [CHECKOUT_SERVICE.key, ANALYTICS_SERVICE.key, BILLING_SERVICE.key],
    counts: {
      packages: 1,
      versions: 2,
      maintainers: 0,
      services: 3,
      advisories: 1,
      resolutionEdges: 3,
    },
    notes: [],
  };
  return new SliceCoverage(manifest);
}

function computeAnswer(
  graph: MemoryGraph,
  overrides: Partial<Pick<ResolvedWhileLiveRequest, "advisoryKey" | "versionKey" | "options">> = {},
) {
  return computeResolvedWhileLive({
    gateway: graph,
    coverage: buildClosedCoverage(),
    advisoryKey: ADVISORY_KEY,
    versionKey: COMPROMISED_VERSION_KEY,
    ...overrides,
  });
}

describe("computeResolvedWhileLive", () => {
  test("reports every in-window resolution as a victim, earliest first", async () => {
    const graph = buildGraph({
      resolutions: [
        {
          service: CHECKOUT_SERVICE,
          versionNodeId: COMPROMISED_VERSION_NODE_ID,
          resolvedAtMs: VERSION_PUBLISHED_MS + 30 * HOUR_MS,
        },
        {
          service: ANALYTICS_SERVICE,
          versionNodeId: COMPROMISED_VERSION_NODE_ID,
          resolvedAtMs: VERSION_PUBLISHED_MS + 6 * HOUR_MS,
        },
      ],
    });

    const answered = await computeAnswer(graph);
    if (!answered.ok) return expect.unreachable(answered.failure.message);

    expect(answered.value.verdict).toBe("exposed");
    expect(answered.value.limits).toEqual([]);
    expect(answered.value.evidence.victims.map((victim) => victim.serviceKey)).toEqual([
      ANALYTICS_SERVICE.key,
      CHECKOUT_SERVICE.key,
    ]);

    const patientZero = answered.value.evidence.victims[0];
    expect(patientZero?.serviceName).toBe(ANALYTICS_SERVICE.name);
    expect(patientZero?.resolvedAtMs).toBe(VERSION_PUBLISHED_MS + 6 * HOUR_MS);
    expect(patientZero?.msBeforeDisclosure).toBe(
      ADVISORY_PUBLISHED_MS - (VERSION_PUBLISHED_MS + 6 * HOUR_MS),
    );

    expect(answered.value.evidence.window).toEqual({
      fromMs: VERSION_PUBLISHED_MS,
      toExclusiveMs: ADVISORY_PUBLISHED_MS,
      durationMs: ADVISORY_PUBLISHED_MS - VERSION_PUBLISHED_MS,
    });
    expect(answered.value.evidence.servicesConsidered).toBe(2);
  });

  test("ignores a resolution made before the version existed", async () => {
    const graph = buildGraph({
      resolutions: [
        {
          service: CHECKOUT_SERVICE,
          versionNodeId: COMPROMISED_VERSION_NODE_ID,
          resolvedAtMs: VERSION_PUBLISHED_MS - HOUR_MS,
        },
      ],
    });

    const answered = await computeAnswer(graph);
    if (!answered.ok) return expect.unreachable(answered.failure.message);

    expect(answered.value.evidence.victims).toEqual([]);
    expect(answered.value.verdict).toBe("not_exposed");
  });

  test("ignores a resolution made after disclosure", async () => {
    // Installing a version the world already knew was malicious is a different and less
    // interesting failure, so it is deliberately outside this answer.
    const graph = buildGraph({
      resolutions: [
        {
          service: CHECKOUT_SERVICE,
          versionNodeId: COMPROMISED_VERSION_NODE_ID,
          resolvedAtMs: ADVISORY_PUBLISHED_MS + 3 * HOUR_MS,
        },
      ],
    });

    const answered = await computeAnswer(graph);
    if (!answered.ok) return expect.unreachable(answered.failure.message);

    expect(answered.value.evidence.victims).toEqual([]);
    expect(answered.value.verdict).toBe("not_exposed");
  });

  test("treats the window as half-open: the opening instant counts, the closing one does not", async () => {
    const graph = buildGraph({
      resolutions: [
        {
          service: ANALYTICS_SERVICE,
          versionNodeId: COMPROMISED_VERSION_NODE_ID,
          resolvedAtMs: VERSION_PUBLISHED_MS,
        },
        {
          service: BILLING_SERVICE,
          versionNodeId: COMPROMISED_VERSION_NODE_ID,
          resolvedAtMs: ADVISORY_PUBLISHED_MS,
        },
      ],
    });

    const answered = await computeAnswer(graph);
    if (!answered.ok) return expect.unreachable(answered.failure.message);

    expect(answered.value.verdict).toBe("exposed");
    expect(answered.value.evidence.victims.map((victim) => victim.serviceKey)).toEqual([
      ANALYTICS_SERVICE.key,
    ]);
  });

  test("decides not_exposed when the advisory predates the version", async () => {
    const graph = buildGraph({
      advisoryPublishedAtMs: VERSION_PUBLISHED_MS - 7 * 24 * HOUR_MS,
      resolutions: [
        {
          service: CHECKOUT_SERVICE,
          versionNodeId: COMPROMISED_VERSION_NODE_ID,
          resolvedAtMs: VERSION_PUBLISHED_MS + HOUR_MS,
        },
      ],
    });

    const answered = await computeAnswer(graph);
    if (!answered.ok) return expect.unreachable(answered.failure.message);

    expect(answered.value.verdict).toBe("not_exposed");
    expect(answered.value.rationale).toContain("advisory predates the version");
    expect(answered.value.limits).toEqual([]);
    expect(answered.value.evidence.victims).toEqual([]);
    expect(answered.value.evidence.window.durationMs).toBe(0);
  });

  test("abstains when a publish time is the registry's missing-timestamp sentinel", async () => {
    const graph = buildGraph({
      versionPublishedAtMs: -1,
      resolutions: [
        {
          service: CHECKOUT_SERVICE,
          versionNodeId: COMPROMISED_VERSION_NODE_ID,
          resolvedAtMs: VERSION_PUBLISHED_MS + HOUR_MS,
        },
      ],
    });

    const answered = await computeAnswer(graph);
    if (!answered.ok) return expect.unreachable(answered.failure.message);

    expect(answered.value.verdict).toBe("unknown");
    expect(answered.value.rationale).toContain(COMPROMISED_VERSION_KEY);
    expect(answered.value.evidence.victims).toEqual([]);
    expect(answered.value.evidence.window.durationMs).toBe(0);
    // An unreadable clock is left out of the timeline rather than emitted as 1969.
    expect(answered.value.evidence.timeline.map((event) => event.kind)).toEqual(["disclosed"]);
  });

  test("abstains when a truncated edge list could be hiding the victim", async () => {
    const graph = buildGraph({
      resolutions: [
        {
          service: CHECKOUT_SERVICE,
          versionNodeId: CLEAN_VERSION_NODE_ID,
          resolvedAtMs: VERSION_PUBLISHED_MS + HOUR_MS,
        },
        {
          service: CHECKOUT_SERVICE,
          versionNodeId: COMPROMISED_VERSION_NODE_ID,
          resolvedAtMs: VERSION_PUBLISHED_MS + 2 * HOUR_MS,
        },
      ],
    });

    const truncated = await computeAnswer(graph, { options: { resolvedEdgesPerService: 1 } });
    if (!truncated.ok) return expect.unreachable(truncated.failure.message);

    expect(truncated.value.verdict).toBe("unknown");
    expect(truncated.value.evidence.victims).toEqual([]);
    expect(truncated.value.limits).toEqual([{ kind: "scan_capped", examined: 0, total: 1 }]);

    // The same graph read without the cap finds the victim, which is what makes the
    // abstention above a truncation and not a real negative.
    const complete = await computeAnswer(graph);
    if (!complete.ok) return expect.unreachable(complete.failure.message);
    expect(complete.value.verdict).toBe("exposed");
    expect(complete.value.evidence.victims.map((victim) => victim.serviceKey)).toEqual([
      CHECKOUT_SERVICE.key,
    ]);
  });

  test("abstains when the advisory is not in the slice", async () => {
    const graph = buildGraph({
      resolutions: [
        {
          service: CHECKOUT_SERVICE,
          versionNodeId: COMPROMISED_VERSION_NODE_ID,
          resolvedAtMs: VERSION_PUBLISHED_MS + HOUR_MS,
        },
      ],
    });

    const answered = await computeAnswer(graph, { advisoryKey: ABSENT_ADVISORY_KEY });
    if (!answered.ok) return expect.unreachable(answered.failure.message);

    expect(answered.value.verdict).toBe("unknown");
    expect(answered.value.limits).toContainEqual({
      kind: "package_absent",
      subjectKey: ABSENT_ADVISORY_KEY,
    });
    expect(answered.value.evidence.victims).toEqual([]);
  });
});

describe("buildExposureTimeline", () => {
  test("orders the replay chronologically and ends on disclosure", async () => {
    const graph = buildGraph({
      resolutions: [
        {
          service: CHECKOUT_SERVICE,
          versionNodeId: COMPROMISED_VERSION_NODE_ID,
          resolvedAtMs: VERSION_PUBLISHED_MS + 30 * HOUR_MS,
        },
        {
          service: ANALYTICS_SERVICE,
          versionNodeId: COMPROMISED_VERSION_NODE_ID,
          resolvedAtMs: VERSION_PUBLISHED_MS,
        },
      ],
    });

    const answered = await computeAnswer(graph);
    if (!answered.ok) return expect.unreachable(answered.failure.message);

    // Called on the returned evidence, the way the scrubber will call it.
    const timeline = buildExposureTimeline(answered.value.evidence);
    expect(timeline).toEqual(answered.value.evidence.timeline);

    expect(timeline.map((event) => event.kind)).toEqual([
      "published",
      "resolved",
      "resolved",
      "disclosed",
    ]);

    const timestamps = timeline.map((event) => event.atMs);
    expect(timestamps).toEqual([...timestamps].sort((left, right) => left - right));
    expect(timestamps[0]).toBe(VERSION_PUBLISHED_MS);
    expect(timestamps[timestamps.length - 1]).toBe(ADVISORY_PUBLISHED_MS);
    expect(timeline[1]?.label).toBe(`${ANALYTICS_SERVICE.name} resolved chalk@5.3.1`);
  });
});
