import {
  type AbstainingAnswer,
  type AnswerLimit,
  buildAnswer,
  buildUnknownAnswer,
  budgetLimitFromContext,
  decideVerdict,
} from "@/lib/analysis/abstention";
import type { CompromisedSubject } from "@/lib/analysis/blast-radius";
import {
  type GraphGateway,
  type GraphProperties,
  isGraphEmpty,
  readNumberProperty,
  readStringProperty,
} from "@/lib/graph/gateway";
import { packageKey, parseVersionKey } from "@/lib/graph/model";
import type { SliceCoverage } from "@/lib/graph/slice-manifest";
import { type Failure, type Result, fail, succeed } from "@/lib/result";

/**
 * The bitemporal answer: which services resolved a compromised version while it was live
 * and published, but before the advisory that condemned it existed.
 *
 * Two clocks, kept apart on purpose:
 *
 *   VALID TIME  when a lockfile actually pinned a version. Stored on
 *               (Service)-[:RESOLVED {resolved_at_ms}]->(Version), harvested from real
 *               lockfile git history.
 *   KNOWN TIME  when the world learned the version was bad. Stored as
 *               Advisory.published_at_ms.
 *
 * The interval between the two is the blind spot. Inside it a build could pull the
 * payload while every scanner on earth reported the lockfile clean, because there was
 * nothing yet to match against. A service that resolved the version inside that interval
 * is a real victim, and a tool that reads only the present state of a lockfile cannot see
 * it: the pin has almost always been bumped since, which erases the evidence from the
 * current file while leaving it in the history.
 *
 * Three engine facts decide the implementation:
 *
 *   1. The Cypher subset compares a property against a literal or a parameter, never
 *      against another property, and it has no min or max to fold two of them together.
 *      So the two clocks are resolved into TypeScript scalars first and only then handed
 *      back to the engine as a numeric window.
 *      sourceRef: docs/HYDRADB.md section 2 ("min, max: absent. All version and time
 *      arithmetic is precomputed in TypeScript").
 *
 *   2. That window is pushed down into the one-hop expansion as a half-open
 *      [fromInclusive, toExclusive) filter on resolved_at_ms rather than being applied
 *      client side. A service with years of harvested lockfile history has far more
 *      RESOLVED edges outside the window than inside it, and pulling them all over the
 *      wire to discard them is the cost this filter exists to avoid.
 *
 *   3. RESOLVED runs Service to Version and has no materialised reverse type, so "which
 *      services resolved this version" is not answered by asking for one. This module
 *      enumerates the Service nodes, which number in the tens, and expands each one
 *      forward. That is the same approach, and the same reason, as blast-radius.ts.
 *
 * Property spellings used below (published_at_ms, resolved_at_ms, key, name, ghsa_id,
 * summary) are the ones the writers and readers share.
 * sourceRef: src/lib/graph/model.ts (NODE_PROPERTY_NAMES, REL_PROPERTY_NAMES).
 *
 * Every answer is an AbstainingAnswer. An empty victim list is not the same claim as
 * "nobody was exposed", and this module never conflates them.
 */

/**
 * Placeholder for a clock this module could not read. The graph model writes -1 when a
 * registry had no timestamp, so the same value stands in here rather than inventing a
 * second encoding of "unknown". Unit: epoch milliseconds.
 * sourceRef: src/lib/graph/model.ts (VersionNode.published_at_ms, AdvisoryNode.published_at_ms).
 */
const UNKNOWN_TIMESTAMP_MS = -1;

/**
 * Ceiling on Service nodes enumerated, and on RESOLVED edges read per service. Both
 * numbers are the ones blast-radius.ts uses, because this is the same fan-out over the
 * same nodes; the window only narrows what each expansion returns.
 * sourceRef: src/lib/analysis/blast-radius.ts (DEFAULT_MAX_SERVICES, DEFAULT_RESOLVED_EDGES_PER_SERVICE).
 */
const DEFAULT_MAX_SERVICES = 5_000;
const DEFAULT_RESOLVED_EDGES_PER_SERVICE = 20_000;

/** The advisory that closes the window. This is the known-time clock. */
export type DisclosureSubject = {
  /** Natural key of the Advisory node, which is the advisory id itself. */
  advisoryKey: string;
  ghsaId: string;
  summary: string;
  /** When the advisory became public, epoch milliseconds. UNKNOWN_TIMESTAMP_MS if unread. */
  publishedAtMs: number;
  nodeId: number | null;
};

/**
 * The compromised version that opens the window. This is the valid-time clock.
 *
 * It is the blast radius subject plus its publish time, reused rather than redeclared so
 * the two answers describe the same thing with the same fields.
 */
export type CompromisedVersionSubject = CompromisedSubject & {
  /** When the version became installable, epoch milliseconds. */
  publishedAtMs: number;
};

/**
 * The exposure window, half-open at the end.
 *
 * Named after the gateway's propertyWindow rather than after a start/end pair, because
 * the exclusive end is load-bearing: a resolution at the instant the advisory published
 * was not made in ignorance, and counting it would overstate the victim list.
 */
export type ExposureWindow = {
  /** Inclusive start: when the compromised version became installable. */
  fromMs: number;
  /** Exclusive end: when the advisory was published. */
  toExclusiveMs: number;
  /** toExclusiveMs minus fromMs, clamped at 0 so an empty window reports no duration. */
  durationMs: number;
};

/** A service that pinned the compromised version while the compromise was still unknown. */
export type ResolvedWhileLiveVictim = {
  serviceKey: string;
  serviceName: string;
  /**
   * When the lockfile pinned it, epoch milliseconds. The earliest in-window resolution
   * when the harvested history holds more than one, because that is when exposure began.
   */
  resolvedAtMs: number;
  /** How long the pin preceded disclosure. Always positive inside the window. */
  msBeforeDisclosure: number;
};

/**
 * Timeline event kinds.
 *
 * The three literals are the ones a curated incident pack already uses for the same three
 * moments, so a scrubber can render a graph-derived timeline and a pack-authored one
 * through one switch instead of two vocabularies for one concept.
 * sourceRef: src/lib/incidents/pack.ts (INCIDENT_TIMELINE_KIND_SCHEMA).
 */
export type ExposureEventKind = "published" | "resolved" | "disclosed";

/** One tick of the demo's time scrubber. */
export type ExposureEvent = {
  /** Epoch milliseconds. */
  atMs: number;
  kind: ExposureEventKind;
  /** One line, written for a person reading the scrubber, not for a log. */
  label: string;
};

export type ResolvedWhileLiveEvidence = {
  advisory: DisclosureSubject;
  compromised: CompromisedVersionSubject;
  window: ExposureWindow;
  /** Ordered by resolvedAtMs ascending: patient zero first. */
  victims: ResolvedWhileLiveVictim[];
  /** How many Service nodes were examined, for the scan_capped limit. */
  servicesConsidered: number;
  timeline: ExposureEvent[];
};

/** The evidence minus the timeline derived from it: what buildExposureTimeline reads. */
export type ExposureTimelineSource = Omit<ResolvedWhileLiveEvidence, "timeline">;

export type ResolvedWhileLiveOptions = {
  /** Ceiling on Service nodes enumerated. Reaching it is recorded as a scan_capped limit. */
  maxServices?: number;
  /** Ceiling on in-window RESOLVED edges read per service. */
  resolvedEdgesPerService?: number;
};

export type ResolvedWhileLiveRequest = {
  gateway: GraphGateway;
  coverage: SliceCoverage;
  /** The advisory, as its GHSA or OSV id, which is the Advisory node's key. */
  advisoryKey: string;
  /** The compromised version, as `ecosystem:name:version`. */
  versionKey: string;
  options?: ResolvedWhileLiveOptions;
};

/**
 * Answers "who resolved this version while it was live and still unknown".
 *
 * Returns a Failure only when the graph itself could not be read. A missing node, a
 * window that cannot be placed, a window that does not exist, and a truncated scan are
 * all answers, and they come back as a verdict carrying the reason.
 */
export async function computeResolvedWhileLive(
  request: ResolvedWhileLiveRequest,
): Promise<Result<AbstainingAnswer<ResolvedWhileLiveEvidence>, Failure>> {
  const parsed = parseVersionKey(request.versionKey);
  if (parsed === null) {
    return fail(
      "invalid_input",
      `[computeResolvedWhileLive] "${request.versionKey}" is not an ecosystem:name:version key`,
    );
  }
  if (request.advisoryKey.length === 0) {
    return fail("invalid_input", "[computeResolvedWhileLive] the advisory key is empty");
  }

  const maxServices = request.options?.maxServices ?? DEFAULT_MAX_SERVICES;
  const resolvedEdgesPerService =
    request.options?.resolvedEdgesPerService ?? DEFAULT_RESOLVED_EDGES_PER_SERVICE;

  const advisory: DisclosureSubject = {
    advisoryKey: request.advisoryKey,
    ghsaId: request.advisoryKey,
    summary: "",
    publishedAtMs: UNKNOWN_TIMESTAMP_MS,
    nodeId: null,
  };
  const compromised: CompromisedVersionSubject = {
    versionKey: request.versionKey,
    packageKey: packageKey(parsed.ecosystem, parsed.name),
    ecosystem: parsed.ecosystem,
    name: parsed.name,
    version: parsed.version,
    publishedAtMs: UNKNOWN_TIMESTAMP_MS,
    nodeId: null,
  };

  /** Evidence for every path that never reaches the service scan. */
  const evidenceWithoutVictims = (
    exposureWindow: ExposureWindow,
  ): ResolvedWhileLiveEvidence =>
    buildEvidence({
      advisory,
      compromised,
      window: exposureWindow,
      victims: [],
      servicesConsidered: 0,
    });

  const advisoryIds = await request.gateway.resolveNodeIds({
    label: "Advisory",
    keys: [request.advisoryKey],
  });
  if (!advisoryIds.ok) return advisoryIds;

  const versionIds = await request.gateway.resolveNodeIds({
    label: "Version",
    keys: [request.versionKey],
  });
  if (!versionIds.ok) return versionIds;

  const graphIsEmpty = await isGraphEmpty(request.gateway);
  if (!graphIsEmpty.ok) return graphIsEmpty;

  // Emptiness is decided before the clocks are read, because an unread timestamp in an
  // unpopulated graph is a missing ingest, not a data quality problem worth reporting.
  if (graphIsEmpty.value) {
    return succeed(
      buildAnswer(
        decideVerdict({
          foundEvidence: false,
          subjectCoverage: request.coverage.describePackageCoverage(compromised.packageKey),
          subjectKey: request.versionKey,
          limits: [],
          graphIsEmpty: true,
        }),
        evidenceWithoutVictims(buildWindow(UNKNOWN_TIMESTAMP_MS, UNKNOWN_TIMESTAMP_MS)),
      ),
    );
  }

  const advisoryNodeId = advisoryIds.value.get(request.advisoryKey);
  const versionNodeId = versionIds.value.get(request.versionKey);

  if (advisoryNodeId === undefined || versionNodeId === undefined) {
    // Coverage is passed as absent regardless of what the manifest claims: the question
    // was asked about this advisory and this exact version, and one of them is provably
    // not a node, so there is no window to place and nothing to walk.
    const missingKey =
      versionNodeId === undefined ? request.versionKey : request.advisoryKey;
    return succeed(
      buildAnswer(
        decideVerdict({
          foundEvidence: false,
          subjectCoverage: "absent",
          subjectKey: missingKey,
          limits: [],
          graphIsEmpty: false,
        }),
        evidenceWithoutVictims(buildWindow(UNKNOWN_TIMESTAMP_MS, UNKNOWN_TIMESTAMP_MS)),
      ),
    );
  }

  advisory.nodeId = advisoryNodeId;
  compromised.nodeId = versionNodeId;

  const advisoryRead = await request.gateway.readNodes({
    label: "Advisory",
    nodeIds: [advisoryNodeId],
  });
  if (!advisoryRead.ok) return advisoryRead;

  const advisoryRecord = advisoryRead.value[0];
  if (advisoryRecord !== undefined) {
    advisory.ghsaId =
      readStringProperty(advisoryRecord.properties, "ghsa_id") ?? request.advisoryKey;
    advisory.summary = readStringProperty(advisoryRecord.properties, "summary") ?? "";
  }
  advisory.publishedAtMs = readPublishTime(advisoryRecord?.properties);

  const versionRead = await request.gateway.readNodes({
    label: "Version",
    nodeIds: [versionNodeId],
  });
  if (!versionRead.ok) return versionRead;
  compromised.publishedAtMs = readPublishTime(versionRead.value[0]?.properties);

  const exposureWindow = buildWindow(compromised.publishedAtMs, advisory.publishedAtMs);

  // A clock that reads as the -1 sentinel, or a node that vanished between the resolve
  // and the read, leaves the window unplaceable. That is unknown, never a negative: the
  // resolutions may well be there, and nothing here can test them.
  if (
    !isReadableTimestamp(compromised.publishedAtMs) ||
    !isReadableTimestamp(advisory.publishedAtMs)
  ) {
    const unreadable = describeUnreadableClocks(advisory, compromised);
    return succeed(
      buildUnknownAnswer(
        `The exposure window cannot be placed because ${unreadable}, so "resolved while live" has no bounds to test a lockfile against.`,
        evidenceWithoutVictims(exposureWindow),
      ),
    );
  }

  if (exposureWindow.toExclusiveMs <= exposureWindow.fromMs) {
    // A decided negative, and sound even under partial coverage, because it follows from
    // the two clocks rather than from an empty traversal: no resolution can fall inside a
    // window that does not exist, so no amount of further ingest could produce a victim.
    return succeed(
      buildAnswer(
        {
          verdict: "not_exposed",
          rationale:
            `${advisory.ghsaId} was published at or before the moment ${request.versionKey} became installable, ` +
            `so there is no window in which a lockfile could have pinned it unknowingly. The advisory predates the version.`,
          limits: [],
        },
        evidenceWithoutVictims(exposureWindow),
      ),
    );
  }

  const collected = await collectResolvedWhileLiveVictims({
    gateway: request.gateway,
    compromisedNodeId: versionNodeId,
    window: exposureWindow,
    maxServices,
    resolvedEdgesPerService,
  });
  if (!collected.ok) {
    // A budget rejection is a truncated answer, not a broken one: the UI has to say "we
    // could not finish" rather than render an empty victim list.
    if (collected.failure.reason === "query_budget_exceeded") {
      return succeed(
        buildUnknownAnswer(
          `The lockfile scan for ${request.versionKey} exceeded an engine budget, so the victim list is incomplete.`,
          evidenceWithoutVictims(exposureWindow),
          [budgetLimitFromContext(collected.failure.context)],
        ),
      );
    }
    return collected;
  }

  const limits: AnswerLimit[] = [];
  if (collected.value.serviceScanWasCapped) {
    limits.push({
      kind: "scan_capped",
      examined: collected.value.servicesConsidered,
      total: maxServices,
    });
  }
  if (collected.value.servicesWithTruncatedEdges > 0) {
    // Counted in services rather than in edges: "examined of total" only reads honestly
    // when both sides count the same thing, and the number of RESOLVED edges a service
    // really has is precisely what a truncated read does not reveal.
    limits.push({
      kind: "scan_capped",
      examined:
        collected.value.servicesConsidered - collected.value.servicesWithTruncatedEdges,
      total: collected.value.servicesConsidered,
    });
  }

  const evidence = buildEvidence({
    advisory,
    compromised,
    window: exposureWindow,
    victims: collected.value.victims,
    servicesConsidered: collected.value.servicesConsidered,
  });

  return succeed(
    buildAnswer(
      decideVerdict({
        foundEvidence: evidence.victims.length > 0,
        subjectCoverage: request.coverage.describePackageCoverage(compromised.packageKey),
        subjectKey: request.versionKey,
        limits,
        graphIsEmpty: false,
      }),
      evidence,
    ),
  );
}

/**
 * Turns the evidence into the event list the demo's time scrubber replays: the version
 * appearing, every victim pinning it, and the advisory landing.
 *
 * Pure by design. The scrubber re-renders on every tick, and the answer it renders was
 * computed once, so this must never reach for the graph.
 *
 * A clock that reads as the unknown placeholder is skipped rather than emitted, so a
 * partially ingested incident cannot send the scrubber to 1969.
 */
export function buildExposureTimeline(source: ExposureTimelineSource): ExposureEvent[] {
  const versionLabel = `${source.compromised.name}@${source.compromised.version}`;
  const events: ExposureEvent[] = [];

  if (isReadableTimestamp(source.compromised.publishedAtMs)) {
    events.push({
      atMs: source.compromised.publishedAtMs,
      kind: "published",
      label: `${versionLabel} published on ${source.compromised.ecosystem}`,
    });
  }

  for (const victim of source.victims) {
    events.push({
      atMs: victim.resolvedAtMs,
      kind: "resolved",
      label: `${victim.serviceName} resolved ${versionLabel}`,
    });
  }

  if (isReadableTimestamp(source.advisory.publishedAtMs)) {
    events.push({
      atMs: source.advisory.publishedAtMs,
      kind: "disclosed",
      label: `${source.advisory.ghsaId} published, ${versionLabel} is public knowledge`,
    });
  }

  return events.sort(compareEventsChronologically);
}

/**
 * Rank for events sharing an instant.
 *
 * The window is half-open at the start, so a resolution at the exact publish instant is
 * legitimate and the scrubber has to show the publish before the pin that followed it.
 * Disclosure ranks last so it closes the replay even when a harvested clock collides
 * with it.
 */
const EVENT_RANK_BY_KIND: Record<ExposureEventKind, number> = {
  published: 0,
  resolved: 1,
  disclosed: 2,
};

function compareEventsChronologically(left: ExposureEvent, right: ExposureEvent): number {
  if (left.atMs !== right.atMs) return left.atMs - right.atMs;
  return EVENT_RANK_BY_KIND[left.kind] - EVENT_RANK_BY_KIND[right.kind];
}

type VictimCollectionRequest = {
  gateway: GraphGateway;
  compromisedNodeId: number;
  window: ExposureWindow;
  maxServices: number;
  resolvedEdgesPerService: number;
};

type VictimCollection = {
  victims: ResolvedWhileLiveVictim[];
  servicesConsidered: number;
  serviceScanWasCapped: boolean;
  /** Services whose in-window RESOLVED edge list came back at the cap. */
  servicesWithTruncatedEdges: number;
};

/**
 * Finds the services that pinned the compromised version inside the window.
 *
 * Walks from the service side because RESOLVED has no materialised reverse type: see the
 * module comment. The window travels with each expansion, so a service with a decade of
 * lockfile history returns only the handful of resolutions that could possibly matter.
 */
async function collectResolvedWhileLiveVictims(
  request: VictimCollectionRequest,
): Promise<Result<VictimCollection, Failure>> {
  const serviceIds = await request.gateway.listNodeIds({
    label: "Service",
    limit: request.maxServices,
  });
  if (!serviceIds.ok) return serviceIds;

  const servicesConsidered = serviceIds.value.length;
  const serviceScanWasCapped = servicesConsidered >= request.maxServices;

  if (servicesConsidered === 0) {
    return succeed({
      victims: [],
      servicesConsidered: 0,
      serviceScanWasCapped: false,
      servicesWithTruncatedEdges: 0,
    });
  }

  /** Earliest in-window resolution per service, keyed by service node id. */
  const earliestResolutionByServiceId = new Map<number, number>();
  let servicesWithTruncatedEdges = 0;

  for (const serviceId of serviceIds.value) {
    const edges = await request.gateway.neighbors({
      nodeId: serviceId,
      nodeLabel: "Service",
      relType: "RESOLVED",
      direction: "outgoing",
      // Both bounds are scalars the caller already resolved and guarded, so the engine
      // can compare each edge against them without a property-to-property comparison.
      propertyWindow: {
        property: "resolved_at_ms",
        fromInclusive: request.window.fromMs,
        toExclusive: request.window.toExclusiveMs,
      },
      limit: request.resolvedEdgesPerService,
    });
    if (!edges.ok) return edges;

    // Recorded even when this service produced no hit: a truncated edge list is exactly
    // where a resolution of the compromised version would hide.
    if (edges.value.length >= request.resolvedEdgesPerService) servicesWithTruncatedEdges += 1;

    for (const edge of edges.value) {
      if (edge.otherNodeId !== request.compromisedNodeId) continue;

      // The edge matched the pushed-down window, so the resolution provably happened
      // inside it even if the returned property is unreadable. Dropping the service
      // would be a false negative, so the window's inclusive start stands in and the
      // victim sorts first, where a person will look at it.
      const resolvedAtMs =
        readNumberProperty(edge.properties, "resolved_at_ms") ?? request.window.fromMs;

      const earliest = earliestResolutionByServiceId.get(serviceId);
      if (earliest === undefined || resolvedAtMs < earliest) {
        earliestResolutionByServiceId.set(serviceId, resolvedAtMs);
      }
    }
  }

  const hitServiceIds = [...earliestResolutionByServiceId.keys()];
  if (hitServiceIds.length === 0) {
    return succeed({
      victims: [],
      servicesConsidered,
      serviceScanWasCapped,
      servicesWithTruncatedEdges,
    });
  }

  // Read after the scan, not before it: one request either way, but the payload is the
  // victims rather than every Service row in the slice.
  const serviceRecords = await request.gateway.readNodes({
    label: "Service",
    nodeIds: hitServiceIds,
  });
  if (!serviceRecords.ok) return serviceRecords;

  const identityByServiceId = new Map<number, { key: string; name: string }>();
  for (const record of serviceRecords.value) {
    const key = readStringProperty(record.properties, "key") ?? `service:${record.id}`;
    const name = readStringProperty(record.properties, "name") ?? key;
    identityByServiceId.set(record.id, { key, name });
  }

  const victims: ResolvedWhileLiveVictim[] = [];
  for (const [serviceId, resolvedAtMs] of earliestResolutionByServiceId) {
    const identity = identityByServiceId.get(serviceId) ?? {
      key: `service:${serviceId}`,
      name: `service:${serviceId}`,
    };
    victims.push({
      serviceKey: identity.key,
      serviceName: identity.name,
      resolvedAtMs,
      msBeforeDisclosure: request.window.toExclusiveMs - resolvedAtMs,
    });
  }

  victims.sort(compareVictimsByResolution);

  return succeed({ victims, servicesConsidered, serviceScanWasCapped, servicesWithTruncatedEdges });
}

/**
 * Earliest pin first, then by service key so two resolutions sharing an instant order the
 * same way on every run. The key rather than the name, because two services can carry the
 * same display name and only the key is unique.
 */
function compareVictimsByResolution(
  left: ResolvedWhileLiveVictim,
  right: ResolvedWhileLiveVictim,
): number {
  if (left.resolvedAtMs !== right.resolvedAtMs) return left.resolvedAtMs - right.resolvedAtMs;
  return left.serviceKey.localeCompare(right.serviceKey);
}

/** Keeps the timeline in step with the facts it is derived from. */
function buildEvidence(source: ExposureTimelineSource): ResolvedWhileLiveEvidence {
  return { ...source, timeline: buildExposureTimeline(source) };
}

function buildWindow(fromMs: number, toExclusiveMs: number): ExposureWindow {
  const isPlaceable = isReadableTimestamp(fromMs) && isReadableTimestamp(toExclusiveMs);
  return {
    fromMs,
    toExclusiveMs,
    // 0 whenever the window is empty or unplaceable. A subtraction would report an
    // inverted pair of clocks as a window running backwards, and an unread clock sitting
    // at the -1 placeholder as five decades of exposure.
    durationMs: isPlaceable ? Math.max(toExclusiveMs - fromMs, 0) : 0,
  };
}

/**
 * True when a timestamp carries a real clock reading.
 *
 * The ingest writes -1 when the registry had no publish time, and every real publish time
 * in this project is a positive epoch-millisecond integer, so anything at or below zero
 * is treated as absent rather than as a date in 1970.
 * sourceRef: src/lib/graph/model.ts (VersionNode.published_at_ms),
 * src/lib/incidents/pack.ts (EPOCH_MS_SCHEMA).
 */
function isReadableTimestamp(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

/** Reads a published_at_ms clock, collapsing every unreadable case onto the placeholder. */
function readPublishTime(properties: GraphProperties | undefined): number {
  if (properties === undefined) return UNKNOWN_TIMESTAMP_MS;
  const published = readNumberProperty(properties, "published_at_ms");
  return isReadableTimestamp(published) ? published : UNKNOWN_TIMESTAMP_MS;
}

/** Names the clocks that could not be read, for the unknown rationale. */
function describeUnreadableClocks(
  advisory: DisclosureSubject,
  compromised: CompromisedVersionSubject,
): string {
  const unreadable: string[] = [];
  if (!isReadableTimestamp(compromised.publishedAtMs)) {
    unreadable.push(`${compromised.versionKey} carries no publish time`);
  }
  if (!isReadableTimestamp(advisory.publishedAtMs)) {
    unreadable.push(`${advisory.advisoryKey} carries no publish time`);
  }
  return unreadable.join(" and ");
}
