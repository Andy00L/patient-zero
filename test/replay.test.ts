import { describe, expect, test } from "bun:test";

import { type ReplayTimeline, buildReplayTimeline, frameAt } from "@/lib/analysis/replay";
import { MemoryGraph } from "@/lib/graph/memory-gateway";
import { packageKey, serviceKey, versionKey } from "@/lib/graph/model";
import type { SliceCoverage } from "@/lib/graph/slice-manifest";
import { type IncidentPack, parseIncidentPack } from "@/lib/incidents/pack";

import {
  buildFixtureGraph,
  buildSliceCoverage,
  dependencyEdge,
  lockfileEdge,
} from "./fixtures/graph";

/**
 * The replay is the demo's front door, so the assertions below are about the two shapes a
 * scrubber makes visible and nothing else: exposure only ever grows as the index rises, and
 * the known-time flag flips exactly once. Everything else under test is the rule that an
 * empty frame is never a safe frame.
 *
 * The graph is built with the shared fixture builder so the property names, the reverse
 * dependency edges and the node ids are the ones the real writer produces. The pack is built
 * through parseIncidentPack rather than as a literal, so a schema change breaks these tests
 * instead of letting them assert against a shape the loader would reject.
 */

const DAY_MS = 24 * 60 * 60 * 1_000;

/** Valid time opens (T1): the payload becomes installable. */
const PAYLOAD_LIVE_MS = Date.UTC(2025, 2, 1);
/** Known time opens (T2): the advisory is published, eight days later. */
const DISCLOSED_MS = PAYLOAD_LIVE_MS + 8 * DAY_MS;

const WINDOW_START_MS = PAYLOAD_LIVE_MS - 2 * DAY_MS;
const WINDOW_END_MS = DISCLOSED_MS + 6 * DAY_MS;

/** Inside the blind spot: exposed, and nothing public said so. */
const BLIND_SPOT_RESOLVED_MS = PAYLOAD_LIVE_MS + 3 * DAY_MS;
/** Also inside the blind spot, but exposed through a dependency rather than directly. */
const TRANSITIVE_RESOLVED_MS = PAYLOAD_LIVE_MS + 5 * DAY_MS;
/** After disclosure: exposed, but the service could have known. */
const LATE_RESOLVED_MS = DISCLOSED_MS + 2 * DAY_MS;
/** A service on a package nothing in the incident reaches. */
const CONTROL_RESOLVED_MS = PAYLOAD_LIVE_MS + DAY_MS;

const ADVISORY_ID = "GHSA-mh6f-8j2x-4483";

const PAYLOAD = { name: "flatmap-stream", version: "0.1.1" } as const;
const CARRIER = { name: "event-stream", version: "3.3.6" } as const;
/** Depends on the carrier, so anything locking it is exposed at one extra hop. */
const RELAY = { name: "ps-tree", version: "1.2.0" } as const;
const CONTROL = { name: "chalk", version: "5.3.1" } as const;

const PAYLOAD_VERSION_KEY = versionKey("npm", PAYLOAD.name, PAYLOAD.version);
const CARRIER_VERSION_KEY = versionKey("npm", CARRIER.name, CARRIER.version);
const RELAY_VERSION_KEY = versionKey("npm", RELAY.name, RELAY.version);
const CONTROL_VERSION_KEY = versionKey("npm", CONTROL.name, CONTROL.version);

const BLIND_SPOT_SERVICE = "jobs-runner";
const TRANSITIVE_SERVICE = "search-indexer";
const LATE_SERVICE = "ledger-api";
const CONTROL_SERVICE = "docs-site";

/** Pack services, which is the denominator every per-frame count is taken over. */
const KNOWN_SERVICE_COUNT = 4;

/**
 * The graph the pack describes.
 *
 * jobs-runner resolved the carrier directly inside the blind spot, search-indexer resolved
 * the relay inside it and so is exposed one hop further out, ledger-api resolved the carrier
 * after disclosure, and docs-site only ever resolved the control package.
 */
function buildIncidentGraph(): MemoryGraph {
  const fixture = buildFixtureGraph({
    packages: [
      { name: PAYLOAD.name },
      { name: CARRIER.name },
      { name: RELAY.name },
      { name: CONTROL.name },
    ],
    versions: [
      { name: PAYLOAD.name, version: PAYLOAD.version, published_at_ms: PAYLOAD_LIVE_MS },
      { name: CARRIER.name, version: CARRIER.version, published_at_ms: PAYLOAD_LIVE_MS },
      { name: RELAY.name, version: RELAY.version, published_at_ms: WINDOW_START_MS },
      { name: CONTROL.name, version: CONTROL.version, published_at_ms: WINDOW_START_MS },
    ],
    services: [
      { name: BLIND_SPOT_SERVICE },
      { name: TRANSITIVE_SERVICE },
      { name: LATE_SERVICE },
      { name: CONTROL_SERVICE },
    ],
    advisories: [
      {
        ghsa_id: ADVISORY_ID,
        published_at_ms: DISCLOSED_MS,
        modified_at_ms: DISCLOSED_MS,
        summary: `${PAYLOAD.name} ${PAYLOAD.version} ships a wallet credential reader`,
      },
    ],
    edges: [
      dependencyEdge(CARRIER_VERSION_KEY, PAYLOAD_VERSION_KEY),
      dependencyEdge(RELAY_VERSION_KEY, CARRIER_VERSION_KEY),
      lockfileEdge(BLIND_SPOT_SERVICE, CARRIER_VERSION_KEY, BLIND_SPOT_RESOLVED_MS),
      lockfileEdge(TRANSITIVE_SERVICE, RELAY_VERSION_KEY, TRANSITIVE_RESOLVED_MS),
      lockfileEdge(LATE_SERVICE, CARRIER_VERSION_KEY, LATE_RESOLVED_MS),
      lockfileEdge(CONTROL_SERVICE, CONTROL_VERSION_KEY, CONTROL_RESOLVED_MS),
    ],
  });
  expect(fixture.danglingEdges).toEqual([]);
  return fixture.graph;
}

/** Coverage claiming the whole incident was ingested closed. */
function buildClosedCoverage(): SliceCoverage {
  return buildSliceCoverage({
    closedPackageKeys: [
      packageKey("npm", PAYLOAD.name),
      packageKey("npm", CARRIER.name),
      packageKey("npm", RELAY.name),
      packageKey("npm", CONTROL.name),
    ],
    closedServiceKeys: [
      serviceKey(BLIND_SPOT_SERVICE),
      serviceKey(TRANSITIVE_SERVICE),
      serviceKey(LATE_SERVICE),
      serviceKey(CONTROL_SERVICE),
    ],
  });
}

/** The same incident as a pack, validated by the real loader schema. */
function buildIncidentPack(): IncidentPack {
  const parsed = parseIncidentPack({
    slug: "replay-fixture",
    title: `${CARRIER.name} ${CARRIER.version} and ${PAYLOAD.name} ${PAYLOAD.version}`,
    ecosystem: "npm",
    dataOrigin: "modeled",
    summary:
      "A constructed pack that mirrors the shape of a maintainer takeover: a carrier release pulls a payload package, and the advisory lands eight days later. Every service and lockfile instant here is invented.",
    windowStartMs: WINDOW_START_MS,
    windowEndMs: WINDOW_END_MS,
    compromisedVersions: [
      {
        ecosystem: "npm",
        name: PAYLOAD.name,
        version: PAYLOAD.version,
        publishedAtMs: PAYLOAD_LIVE_MS,
        hasInstallScript: false,
        note: "The payload itself, published alongside the carrier release that depends on it.",
      },
      {
        ecosystem: "npm",
        name: CARRIER.name,
        version: CARRIER.version,
        publishedAtMs: PAYLOAD_LIVE_MS,
        hasInstallScript: false,
        note: "The carrier release that added the dependency on the payload.",
      },
    ],
    advisories: [
      {
        advisoryId: ADVISORY_ID,
        publishedAtMs: DISCLOSED_MS,
        modifiedAtMs: DISCLOSED_MS,
        summary: `Embedded malicious code in ${CARRIER.name}: ${PAYLOAD.name} carried the payload.`,
        affects: [
          { ecosystem: "npm", name: CARRIER.name, introduced: CARRIER.version, fixed: "4.0.0" },
          { ecosystem: "npm", name: PAYLOAD.name, introduced: "0", fixed: null },
        ],
      },
    ],
    services: [
      {
        key: `svc:${BLIND_SPOT_SERVICE}`,
        name: BLIND_SPOT_SERVICE,
        description: "Background job worker that locked the carrier while the payload was live.",
        resolved: [
          {
            ecosystem: "npm",
            name: CARRIER.name,
            version: CARRIER.version,
            resolvedAtMs: BLIND_SPOT_RESOLVED_MS,
          },
        ],
      },
      {
        key: `svc:${TRANSITIVE_SERVICE}`,
        name: TRANSITIVE_SERVICE,
        description: "Batch indexer that locked the relay package while the payload was live.",
        resolved: [
          {
            ecosystem: "npm",
            name: RELAY.name,
            version: RELAY.version,
            resolvedAtMs: TRANSITIVE_RESOLVED_MS,
          },
        ],
      },
      {
        key: `svc:${LATE_SERVICE}`,
        name: LATE_SERVICE,
        description: "Ledger service that refreshed its lockfile two days after disclosure.",
        resolved: [
          {
            ecosystem: "npm",
            name: CARRIER.name,
            version: CARRIER.version,
            resolvedAtMs: LATE_RESOLVED_MS,
          },
        ],
      },
      {
        key: `svc:${CONTROL_SERVICE}`,
        name: CONTROL_SERVICE,
        description: "Docs site that only ever depended on the control package.",
        resolved: [
          {
            ecosystem: "npm",
            name: CONTROL.name,
            version: CONTROL.version,
            resolvedAtMs: CONTROL_RESOLVED_MS,
          },
        ],
      },
    ],
    timeline: [
      {
        atMs: PAYLOAD_LIVE_MS,
        kind: "published",
        label: "the carrier release adds the payload dependency",
        sourceUrl: null,
      },
      {
        atMs: BLIND_SPOT_RESOLVED_MS,
        kind: "resolved",
        label: `${BLIND_SPOT_SERVICE} locks the carrier, with no advisory in existence`,
        sourceUrl: null,
      },
      {
        atMs: TRANSITIVE_RESOLVED_MS,
        kind: "resolved",
        label: `${TRANSITIVE_SERVICE} locks the relay package and inherits the payload`,
        sourceUrl: null,
      },
      {
        atMs: DISCLOSED_MS,
        kind: "disclosed",
        label: `${ADVISORY_ID} published`,
        sourceUrl: null,
      },
      {
        atMs: LATE_RESOLVED_MS,
        kind: "resolved",
        label: `${LATE_SERVICE} locks the carrier after disclosure`,
        sourceUrl: null,
      },
    ],
    sources: ["https://registry.npmjs.org/event-stream"],
  });

  if (!parsed.ok) return expect.unreachable(`fixture pack is invalid: ${parsed.failure.message}`);
  return parsed.value;
}

/** Builds a replay, failing the test loudly if the build itself failed. */
async function buildTimeline(
  overrides: { graph?: MemoryGraph; coverage?: SliceCoverage; frameCount?: number } = {},
): Promise<ReplayTimeline> {
  const built = await buildReplayTimeline({
    gateway: overrides.graph ?? buildIncidentGraph(),
    coverage: overrides.coverage ?? buildClosedCoverage(),
    pack: buildIncidentPack(),
    options: { frameCount: overrides.frameCount ?? 12 },
  });
  if (!built.ok) return expect.unreachable(`replay build failed: ${built.failure.message}`);
  return built.value;
}

function exposedKeysAt(timeline: ReplayTimeline, index: number): string[] {
  const frame = frameAt(timeline, index);
  if (!frame.ok) return expect.unreachable(frame.failure.message);
  return frame.value.answer.evidence.exposedServices.map((exposure) => exposure.serviceKey);
}

describe("buildReplayTimeline", () => {
  test("places the boundaries and the frames inside the pack window", async () => {
    const timeline = await buildTimeline();

    expect(timeline.packSlug).toBe("replay-fixture");
    expect(timeline.payloadLiveAtMs).toBe(PAYLOAD_LIVE_MS);
    expect(timeline.disclosedAtMs).toBe(DISCLOSED_MS);
    expect(timeline.blindSpot).toEqual({
      startMs: PAYLOAD_LIVE_MS,
      endMs: DISCLOSED_MS,
      durationMs: DISCLOSED_MS - PAYLOAD_LIVE_MS,
    });

    const instants = timeline.frames.map((frame) => frame.atMs);
    expect(instants[0]).toBe(WINDOW_START_MS);
    expect(instants[instants.length - 1]).toBe(WINDOW_END_MS);
    expect([...instants].sort((left, right) => left - right)).toEqual(instants);
    // Every instant the pack narrates gets its own tick, or the scrubber could never stop on it.
    for (const entry of buildIncidentPack().timeline) expect(instants).toContain(entry.atMs);
  });

  test("keeps exposure cumulative: the set only ever grows with the index", async () => {
    const timeline = await buildTimeline();

    let previous: string[] = [];
    for (const frame of timeline.frames) {
      const current = frame.answer.evidence.exposedServices.map((exposure) => exposure.serviceKey);
      for (const key of previous) expect(current).toContain(key);
      expect(current.length).toBeGreaterThanOrEqual(previous.length);
      previous = current;
    }

    const last = timeline.frames[timeline.frames.length - 1];
    expect(last?.answer.evidence.exposedServices.map((exposure) => exposure.serviceKey)).toEqual([
      BLIND_SPOT_SERVICE,
      TRANSITIVE_SERVICE,
      LATE_SERVICE,
    ]);
    // The control service resolved a package nothing in the incident reaches.
    expect(exposedKeysAt(timeline, timeline.frames.length - 1)).not.toContain(CONTROL_SERVICE);
  });

  test("flips the known-time flag exactly once, at the advisory instant", async () => {
    const timeline = await buildTimeline();

    const flips = timeline.frames.filter((frame, index) => {
      const previous = timeline.frames[index - 1];
      return previous !== undefined && previous.answer.evidence.advisoryPublic === false && frame.answer.evidence.advisoryPublic;
    });
    expect(flips).toHaveLength(1);
    expect(flips[0]?.atMs).toBe(DISCLOSED_MS);

    for (const frame of timeline.frames) {
      expect(frame.answer.evidence.advisoryPublic).toBe(frame.atMs >= DISCLOSED_MS);
    }
  });

  test("reports a post-disclosure pin as exposed but outside the unknown window", async () => {
    const timeline = await buildTimeline();

    const blindSpotFrame = timeline.frames.find((frame) => frame.atMs === BLIND_SPOT_RESOLVED_MS);
    expect(blindSpotFrame?.answer.verdict).toBe("exposed");
    expect(blindSpotFrame?.answer.evidence.unknownWindowServiceKeys).toEqual([BLIND_SPOT_SERVICE]);
    expect(blindSpotFrame?.answer.evidence.advisoryPublic).toBe(false);

    const lateFrame = timeline.frames.find((frame) => frame.atMs === LATE_RESOLVED_MS);
    const exposedKeys = lateFrame?.answer.evidence.exposedServices.map(
      (exposure) => exposure.serviceKey,
    );
    expect(exposedKeys).toEqual([BLIND_SPOT_SERVICE, TRANSITIVE_SERVICE, LATE_SERVICE]);
    // Exposed, and knowable: the late pin must not be counted in the blind spot group, while
    // the transitive pin made inside the window must be.
    expect(lateFrame?.answer.evidence.unknownWindowServiceKeys).toEqual([
      BLIND_SPOT_SERVICE,
      TRANSITIVE_SERVICE,
    ]);
  });

  test("carries the hop distance and the route that exposed each service", async () => {
    const timeline = await buildTimeline();

    const exposures = timeline.frames[timeline.frames.length - 1]?.answer.evidence.exposedServices;

    // The direct pin: one hop, and the route is the lockfile edge itself.
    const direct = exposures?.find((exposure) => exposure.serviceKey === BLIND_SPOT_SERVICE);
    expect(direct?.hopCount).toBe(1);
    expect(direct?.isDirectDependency).toBe(true);
    expect(direct?.resolvedAtMs).toBe(BLIND_SPOT_RESOLVED_MS);
    expect(direct?.path.steps.map((step) => step.key)).toEqual([
      serviceKey(BLIND_SPOT_SERVICE),
      CARRIER_VERSION_KEY,
    ]);

    // The transitive pin: the relay package sits between the service and the carrier, so the
    // route has to name it or the UI cannot explain why the service is exposed at all.
    const transitive = exposures?.find((exposure) => exposure.serviceKey === TRANSITIVE_SERVICE);
    expect(transitive?.hopCount).toBe(2);
    expect(transitive?.isDirectDependency).toBe(false);
    expect(transitive?.path.steps.map((step) => step.key)).toEqual([
      serviceKey(TRANSITIVE_SERVICE),
      RELAY_VERSION_KEY,
      CARRIER_VERSION_KEY,
    ]);
  });

  test("counts every known service into exactly one verdict bucket", async () => {
    const timeline = await buildTimeline();

    const firstFrame = timeline.frames[0];
    expect(firstFrame?.answer.verdict).toBe("not_exposed");
    expect(firstFrame?.answer.evidence.counts).toEqual({
      exposed: 0,
      not_exposed: KNOWN_SERVICE_COUNT,
      unknown: 0,
    });

    const lastFrame = timeline.frames[timeline.frames.length - 1];
    expect(lastFrame?.answer.evidence.counts).toEqual({ exposed: 3, not_exposed: 1, unknown: 0 });
  });
});

describe("buildReplayTimeline abstention", () => {
  test("answers unknown on every frame when the graph is empty", async () => {
    const timeline = await buildTimeline({ graph: new MemoryGraph() });

    expect(timeline.frames.length).toBeGreaterThan(0);
    for (const frame of timeline.frames) {
      expect(frame.answer.verdict).toBe("unknown");
      expect(frame.answer.limits.some((limit) => limit.kind === "empty_graph")).toBe(true);
      expect(frame.answer.evidence.exposedServices).toEqual([]);
      // The one rule the whole module exists for: no frame reports the empty graph as safety.
      expect(frame.answer.evidence.counts.not_exposed).toBe(0);
      expect(frame.answer.evidence.counts.unknown).toBe(KNOWN_SERVICE_COUNT);
    }
  });

  test("answers unknown and names the absent package when the pack is outside the slice", async () => {
    const timeline = await buildTimeline({
      coverage: buildSliceCoverage({ closedPackageKeys: [packageKey("npm", CONTROL.name)] }),
    });

    for (const frame of timeline.frames) {
      expect(frame.answer.verdict).toBe("unknown");
      expect(frame.answer.evidence.counts.not_exposed).toBe(0);
    }

    const absences = timeline.frames[0]?.answer.limits.filter(
      (limit) => limit.kind === "package_absent",
    );
    expect(absences?.length).toBeGreaterThan(0);
    const namedKeys = absences?.map((limit) =>
      limit.kind === "package_absent" ? limit.subjectKey : "",
    );
    expect(namedKeys).toContain(packageKey("npm", PAYLOAD.name));
  });
});

describe("frameAt", () => {
  test("returns a failure rather than throwing on an out-of-range index", async () => {
    const timeline = await buildTimeline();

    const first = frameAt(timeline, 0);
    expect(first.ok).toBe(true);

    for (const index of [-1, timeline.frames.length, 1.5]) {
      const looked = frameAt(timeline, index);
      expect(looked.ok).toBe(false);
      if (looked.ok) continue;
      expect(looked.failure.reason).toBe("invalid_input");
    }
  });

  test("hands back the frame at the requested index, with its own index on it", async () => {
    const timeline = await buildTimeline();

    const looked = frameAt(timeline, 3);
    expect(looked.ok).toBe(true);
    if (!looked.ok) return;
    expect(looked.value.index).toBe(3);
    expect(looked.value.atMs).toBe(timeline.frames[3]?.atMs);
    expect(looked.value.label.length).toBeGreaterThan(0);
  });
});

describe("buildReplayTimeline options", () => {
  test("rejects unusable frame counts and intervals as values", async () => {
    const pack = buildIncidentPack();
    const graph = buildIncidentGraph();
    const coverage = buildClosedCoverage();

    for (const options of [{ frameCount: 1 }, { frameCount: 2.5 }, { intervalMs: 0 }, { intervalMs: 1 }]) {
      const built = await buildReplayTimeline({ gateway: graph, coverage, pack, options });
      expect(built.ok).toBe(false);
      if (built.ok) continue;
      expect(built.failure.reason).toBe("invalid_input");
    }
  });

  test("walks the window by the interval when one is given", async () => {
    const built = await buildReplayTimeline({
      gateway: buildIncidentGraph(),
      coverage: buildClosedCoverage(),
      pack: buildIncidentPack(),
      options: { intervalMs: DAY_MS },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const instants = built.value.frames.map((frame) => frame.atMs);
    expect(instants).toContain(WINDOW_START_MS + DAY_MS);
    expect(instants).toContain(DISCLOSED_MS);
    expect(new Set(instants).size).toBe(instants.length);
  });
});
