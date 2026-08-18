import {
  type AbstainingAnswer,
  type AnswerLimit,
  type Verdict,
  buildAnswer,
  decideVerdict,
  describeLimit,
  weakestCoverage,
} from "@/lib/analysis/abstention";
import { type ExposurePath, computeBlastRadius } from "@/lib/analysis/blast-radius";
import { type ExposureWindow, computeResolvedWhileLive } from "@/lib/analysis/bitemporal";
import { type GraphGateway, isGraphEmpty } from "@/lib/graph/gateway";
import { packageKey, serviceKey, versionKey } from "@/lib/graph/model";
import type { Coverage, SliceCoverage } from "@/lib/graph/slice-manifest";
import {
  type Ecosystem,
  type IncidentAdvisory,
  type IncidentCompromisedVersion,
  type IncidentPack,
  computeExposureWindow,
} from "@/lib/incidents/pack";
import { type Failure, type Result, fail, succeed } from "@/lib/result";

/**
 * The replay engine behind the demo's time scrubber.
 *
 * Given one incident pack and one graph, this produces an ordered series of frames, one per
 * timeline instant, each stating what was true at that instant. The UI renders frame N when
 * the scrubber sits at position N and does no reasoning of its own: every verdict, count,
 * label and path in a frame is decided here.
 *
 * The point of the replay is the bitemporal gap, so a frame keeps the two clocks apart:
 *
 *   VALID TIME  when a service actually resolved a compromised version, read from
 *               (Service)-[:RESOLVED {resolved_at_ms}]->(Version).
 *   KNOWN TIME  when the advisory became public, read from the pack's advisories.
 *
 * Between the first payload publish (T1) and the first advisory (T2) every service that
 * resolved the bad version was exposed and nobody could know it. That interval is the
 * product, so exposure is cumulative across frames while `advisoryPublic` flips exactly
 * once, at T2, and the services pinned inside the interval stay grouped as the blind spot.
 *
 * Two reuse rules hold here and are worth stating, because breaking either one silently
 * changes the answer:
 *
 *   1. Which services are exposed, over how many hops, along which path, comes from
 *      blast-radius.ts. Which of them pinned the version while the compromise was still
 *      unknown comes from bitemporal.ts. Neither decision is re-derived from timestamps in
 *      this file.
 *   2. Every frame carries its own AbstainingAnswer, decided through decideVerdict. A frame
 *      with an empty exposure set is not a safe frame: an empty graph, a pack package
 *      outside the ingested slice, or a clock that could not be read all make the frame
 *      `unknown`. An empty result is never rendered as safety.
 *
 * Deterministic by construction. Every instant comes from the pack or the graph, so the
 * same pack and the same slice replay identically on every run.
 */

/** Ticks a caller gets when it states neither a frame count nor an interval. */
const DEFAULT_FRAME_COUNT = 60;

/** Two frames is the smallest replay that can show a change. */
const MIN_FRAME_COUNT = 2;

/**
 * Ceiling on frames. A scrubber is dragged by a person, so tens of thousands of frames
 * only buys memory pressure, and an interval of one millisecond over a 78 day window would
 * ask for billions.
 */
const MAX_FRAME_COUNT = 2_000;

/**
 * One exposed service as a frame reports it.
 *
 * `resolvedAtMs` is the valid-time clock the frame is filtered on, and
 * `withinUnknownWindow` is the known-time verdict for the same service: true only when
 * bitemporal.ts placed this pin inside the exposure window, which is what makes it a
 * blind-spot victim rather than a service that patched late.
 */
export type ReplayExposure = {
  /** Natural key of the Service node, which is its bare name. */
  serviceKey: string;
  serviceName: string;
  /** The compromised version that first exposed this service, as `ecosystem:name:version`. */
  versionKey: string;
  /** Valid time: when the lockfile pinned the route to the compromised version. */
  resolvedAtMs: number;
  /** Hops from the service down to the compromised version. 1 means a direct dependency. */
  hopCount: number;
  isDirectDependency: boolean;
  /** The route, service first and compromised version last, for the UI to draw. */
  path: ExposurePath;
  /** True when the pin happened before the advisory existed: exposed and unknowable. */
  withinUnknownWindow: boolean;
};

/**
 * Service tally for one frame.
 *
 * `exposed` counts what was observed at or before the instant. The remaining known services
 * land in `not_exposed` only when the frame carries no limit at all, and in `unknown`
 * otherwise, because a service can only be called clean by a frame that could reach a
 * negative verdict in the first place.
 */
export type ReplayVerdictCounts = Record<Verdict, number>;

/** What was true at one instant. The payload the scrubber renders. */
export type ReplayFrameEvidence = {
  /** Epoch milliseconds. */
  atMs: number;
  /** Cumulative and ordered by resolution time: patient zero first, one row per service. */
  exposedServices: ReplayExposure[];
  counts: ReplayVerdictCounts;
  /** Known time: whether the earliest advisory in the pack was public at this instant. */
  advisoryPublic: boolean;
  /** Keys of the exposed services pinned inside the exposure window. The blind spot. */
  unknownWindowServiceKeys: string[];
};

/** One scrubber position. */
export type ReplayFrame = {
  /** Position in `ReplayTimeline.frames`, so a frame handed to a component knows its index. */
  index: number;
  atMs: number;
  /** One line for the tick, taken from the pack's timeline when an entry lands on it. */
  label: string;
  /** Decided per frame through the abstention model, never inferred by the UI. */
  answer: AbstainingAnswer<ReplayFrameEvidence>;
};

/** The whole replay: what the scrubber is bound to. */
export type ReplayTimeline = {
  /** Pack identity, so a rendered replay can always name what it is replaying. */
  packSlug: string;
  packTitle: string;
  ecosystem: Ecosystem;
  /** T1, valid time opens: the earliest instant a compromised version was installable. */
  payloadLiveAtMs: number;
  /** T2, known time opens: the earliest advisory publication in the pack. */
  disclosedAtMs: number;
  /**
   * The gap between T1 and T2, or null when the advisory did not follow the payload. Null is
   * "no blind spot", not a zero-length window, and the UI says so.
   */
  blindSpot: { startMs: number; endMs: number; durationMs: number } | null;
  /** Scrubber bounds, from the pack. */
  windowStartMs: number;
  windowEndMs: number;
  /** Ordered by instant ascending. Never empty. */
  frames: ReplayFrame[];
};

/**
 * How finely to slice the pack window.
 *
 * `intervalMs` takes precedence over `frameCount` when both are given. Either way the pack's
 * own timeline instants, T1 and T2 each get a frame of their own, so `frames.length` can
 * exceed `frameCount`: a scrubber that cannot land exactly on the disclosure instant cannot
 * show the flip that the replay exists to show.
 */
export type ReplayOptions = {
  /** Evenly spaced ticks across the pack window, both ends included. */
  frameCount?: number;
  /** Spacing in milliseconds, walked from the window start. */
  intervalMs?: number;
};

export type ReplayTimelineRequest = {
  gateway: GraphGateway;
  /** What the slice manifest claims was ingested. Drives every frame's verdict. */
  coverage: SliceCoverage;
  pack: IncidentPack;
  options?: ReplayOptions;
};

/**
 * Builds the replay for one incident pack.
 *
 * Returns a Failure only when the graph itself could not be read or the options are not
 * usable. An empty graph, a pack package outside the slice, a clock that could not be read
 * and a truncated traversal are all answers, and they come back as frames carrying an
 * `unknown` verdict and the reason.
 */
export async function buildReplayTimeline(
  request: ReplayTimelineRequest,
): Promise<Result<ReplayTimeline, Failure>> {
  const pack = request.pack;
  const payloadLiveAtMs = earliestPayloadInstantMs(pack);
  const disclosedAtMs = earliestAdvisoryInstantMs(pack);

  const instants = buildFrameInstants(pack, payloadLiveAtMs, disclosedAtMs, request.options);
  if (!instants.ok) return instants;

  const graphIsEmpty = await isGraphEmpty(request.gateway);
  if (!graphIsEmpty.ok) return graphIsEmpty;

  // Emptiness short-circuits the traversals rather than running them for a known answer:
  // nothing can be exposed in a graph with no versions, and every frame is unknown anyway.
  const collected = graphIsEmpty.value
    ? succeed<ExposureCollection>({ exposures: [], limits: [] })
    : await collectExposures(request);
  if (!collected.ok) return collected;

  const compromisedPackageKeys = uniqueStrings(
    pack.compromisedVersions.map((compromised) =>
      packageKey(compromised.ecosystem, compromised.name),
    ),
  );
  const subjectCoverage = weakestCoverage(request.coverage, compromisedPackageKeys);

  const frames = buildFrames({
    instants: instants.value,
    exposures: collected.value.exposures,
    limits: dedupeLimits(collected.value.limits),
    subjectCoverage,
    subjectKey: pickSubjectKey(request.coverage, compromisedPackageKeys, subjectCoverage, pack.slug),
    graphIsEmpty: graphIsEmpty.value,
    knownServiceCount: countKnownServices(pack, collected.value.exposures),
    disclosedAtMs,
  });

  return succeed({
    packSlug: pack.slug,
    packTitle: pack.title,
    ecosystem: pack.ecosystem,
    payloadLiveAtMs,
    disclosedAtMs,
    blindSpot: computeExposureWindow(pack),
    windowStartMs: pack.windowStartMs,
    windowEndMs: pack.windowEndMs,
    frames,
  });
}

/**
 * Bounds-checked frame lookup for the UI.
 *
 * A scrubber is driven by a pointer, a keyboard and a URL parameter, so an out-of-range
 * index is an ordinary input rather than a bug. It comes back as a Failure the caller can
 * render, never as an exception and never as `undefined` pretending to be a frame.
 */
export function frameAt(timeline: ReplayTimeline, index: number): Result<ReplayFrame, Failure> {
  if (!Number.isInteger(index)) {
    return fail("invalid_input", `[frameAt] frame index ${index} is not an integer`);
  }
  const frame = timeline.frames[index];
  if (frame === undefined) {
    return fail(
      "invalid_input",
      `[frameAt] frame ${index} is outside 0 to ${timeline.frames.length - 1}`,
      { context: { packSlug: timeline.packSlug, frameCount: timeline.frames.length } },
    );
  }
  return succeed(frame);
}

// ---------------------------------------------------------------------------
// Frame instants
// ---------------------------------------------------------------------------

type ReplayInstant = { atMs: number; label: string };

/**
 * Derives the scrubber ticks from the pack's own window, never from a hardcoded date.
 *
 * The evenly spaced ticks give the scrubber a smooth axis, and the pack's timeline instants
 * plus T1 and T2 are unioned in so the two moments the story turns on are reachable exactly.
 * Instants are integers: a fractional epoch would never compare equal to a pack timestamp,
 * so no tick would ever pick up its label.
 */
function buildFrameInstants(
  pack: IncidentPack,
  payloadLiveAtMs: number,
  disclosedAtMs: number,
  options: ReplayOptions | undefined,
): Result<ReplayInstant[], Failure> {
  const startMs = pack.windowStartMs;
  const endMs = pack.windowEndMs;
  const spanMs = endMs - startMs;
  const ticks = new Set<number>([startMs, endMs]);

  if (options?.intervalMs !== undefined) {
    const intervalMs = options.intervalMs;
    if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
      return fail(
        "invalid_input",
        `[buildReplayTimeline] intervalMs must be a positive integer, got ${intervalMs}`,
      );
    }
    if (spanMs / intervalMs > MAX_FRAME_COUNT) {
      return fail(
        "invalid_input",
        `[buildReplayTimeline] intervalMs ${intervalMs} would produce more than ${MAX_FRAME_COUNT} frames over the ${spanMs} ms pack window`,
      );
    }
    for (let atMs = startMs; atMs < endMs; atMs += intervalMs) ticks.add(atMs);
  } else {
    const frameCount = options?.frameCount ?? DEFAULT_FRAME_COUNT;
    if (
      !Number.isInteger(frameCount) ||
      frameCount < MIN_FRAME_COUNT ||
      frameCount > MAX_FRAME_COUNT
    ) {
      return fail(
        "invalid_input",
        `[buildReplayTimeline] frameCount must be an integer between ${MIN_FRAME_COUNT} and ${MAX_FRAME_COUNT}, got ${frameCount}`,
      );
    }
    const stepMs = spanMs / (frameCount - 1);
    for (let tick = 0; tick < frameCount; tick += 1) {
      ticks.add(Math.round(startMs + stepMs * tick));
    }
  }

  // Pack timeline entries are inside the window by schema. T1 and T2 are not, so they are
  // clamped out rather than dragging the scrubber past its own bounds.
  for (const entry of pack.timeline) ticks.add(entry.atMs);
  for (const boundary of [payloadLiveAtMs, disclosedAtMs]) {
    if (boundary >= startMs && boundary <= endMs) ticks.add(boundary);
  }

  const ordered = [...ticks].sort((left, right) => left - right);
  return succeed(
    ordered.map((atMs) => ({
      atMs,
      label: labelInstant(pack, atMs, payloadLiveAtMs, disclosedAtMs),
    })),
  );
}

/**
 * The tick label, preferring what the curator wrote.
 *
 * A pack entry sitting on the instant wins, because it is sourced prose. The two boundaries
 * get a written fallback so the disclosure tick never reads as a bare timestamp, and every
 * other tick reads as its ISO instant, which is deterministic and sorts the way it displays.
 */
function labelInstant(
  pack: IncidentPack,
  atMs: number,
  payloadLiveAtMs: number,
  disclosedAtMs: number,
): string {
  const entry = pack.timeline.find((candidate) => candidate.atMs === atMs);
  if (entry !== undefined) return entry.label;

  if (atMs === disclosedAtMs) {
    const advisory = earliestAdvisory(pack.advisories);
    if (advisory !== null) {
      return `${advisory.advisoryId} published, the compromise becomes public knowledge`;
    }
  }
  if (atMs === payloadLiveAtMs) {
    const compromised = earliestCompromisedVersion(pack.compromisedVersions);
    if (compromised !== null) {
      return `${compromised.name}@${compromised.version} becomes installable`;
    }
  }
  return new Date(atMs).toISOString();
}

// ---------------------------------------------------------------------------
// Exposure collection
// ---------------------------------------------------------------------------

/**
 * Everything the frames filter, read once for the whole replay: the exposures with their
 * clocks, and every limit the two traversals hit on the way.
 */
type ExposureCollection = { exposures: ReplayExposure[]; limits: AnswerLimit[] };

/**
 * Reads exposure once, for the whole replay, and lets the frames filter it by instant.
 *
 * Two questions per compromised version: blast radius says who is reachable and along which
 * path, and resolved-while-live says which of those pins happened before the advisory
 * existed. Both answers carry limits, and every limit travels into every frame, because a
 * traversal that was cut short at build time is cut short at every scrubber position.
 */
async function collectExposures(
  request: ReplayTimelineRequest,
): Promise<Result<ExposureCollection, Failure>> {
  const limits: AnswerLimit[] = [];
  /** Earliest exposure per service, so a frame renders one row per service. */
  const bestByServiceKey = new Map<string, ReplayExposure>();

  for (const compromised of request.pack.compromisedVersions) {
    const compromisedVersionKey = versionKey(
      compromised.ecosystem,
      compromised.name,
      compromised.version,
    );

    const radius = await computeBlastRadius({
      gateway: request.gateway,
      coverage: request.coverage,
      versionKey: compromisedVersionKey,
    });
    if (!radius.ok) return radius;
    limits.push(...radius.value.limits);

    const advisory = earliestAdvisoryAffecting(request.pack, compromised);
    let unknownWindowServiceKeys = new Set<string>();
    let exposureWindow: ExposureWindow | null = null;

    if (advisory === null) {
      // No advisory in the pack condemns this artifact, so its known-time clock cannot be
      // placed and the blind-spot grouping for it is undecidable rather than empty.
      limits.push({
        kind: "timestamp_missing",
        field: `advisory publish time for ${packageKey(compromised.ecosystem, compromised.name)}`,
      });
    } else {
      const whileLive = await computeResolvedWhileLive({
        gateway: request.gateway,
        coverage: request.coverage,
        advisoryKey: advisory.advisoryId,
        versionKey: compromisedVersionKey,
      });
      if (!whileLive.ok) return whileLive;
      limits.push(...whileLive.value.limits);
      unknownWindowServiceKeys = new Set(
        whileLive.value.evidence.victims.map((victim) => victim.serviceKey),
      );
      // A zero duration means bitemporal could not place the window, or the advisory
      // preceded the artifact. Either way there is no interval to test a pin against.
      exposureWindow =
        whileLive.value.evidence.window.durationMs > 0 ? whileLive.value.evidence.window : null;
    }

    for (const exposed of radius.value.evidence.exposedServices) {
      const resolvedAtMs = readResolutionInstantMs(exposed.shortestPath);
      if (resolvedAtMs === null) {
        // Exposed, but with no valid-time clock there is no frame it belongs to. Dropping it
        // silently would let a later frame read as safety, so the limit says it is missing.
        limits.push({
          kind: "timestamp_missing",
          field: `resolved_at_ms for ${exposed.serviceKey} on ${compromisedVersionKey}`,
        });
        continue;
      }

      const candidate: ReplayExposure = {
        serviceKey: exposed.serviceKey,
        serviceName: exposed.serviceName,
        versionKey: compromisedVersionKey,
        resolvedAtMs,
        hopCount: exposed.hopCount,
        isDirectDependency: exposed.isDirectDependency,
        path: exposed.shortestPath,
        withinUnknownWindow: isBlindSpotPin(
          exposed.serviceKey,
          resolvedAtMs,
          unknownWindowServiceKeys,
          exposureWindow,
        ),
      };

      const held = bestByServiceKey.get(candidate.serviceKey);
      if (held === undefined || comparePreferredExposure(candidate, held) < 0) {
        bestByServiceKey.set(candidate.serviceKey, candidate);
      }
    }
  }

  const exposures = [...bestByServiceKey.values()].sort(compareExposuresChronologically);
  return succeed({ exposures, limits });
}

/**
 * Whether one pin belongs in the blind spot.
 *
 * bitemporal.ts decides this outright for a service that resolved the compromised version
 * itself, and its victim list is taken as authoritative. A service exposed through a
 * dependency never appears in that list, because RESOLVED runs from the service to the
 * version it pinned and a transitive victim pinned something else, so its pin is placed
 * against the window bitemporal computed and returned rather than against a boundary
 * re-derived here. Excluding those services would understate the blind spot, which is the
 * one number the whole replay exists to show.
 */
function isBlindSpotPin(
  serviceKey: string,
  resolvedAtMs: number,
  directVictimKeys: ReadonlySet<string>,
  window: ExposureWindow | null,
): boolean {
  if (directVictimKeys.has(serviceKey)) return true;
  if (window === null) return false;
  return resolvedAtMs >= window.fromMs && resolvedAtMs < window.toExclusiveMs;
}

/**
 * Which of two exposures of one service the replay shows: the earliest pin, because that is
 * when the service became exposed. Hops then key break ties so the choice is stable.
 */
function comparePreferredExposure(left: ReplayExposure, right: ReplayExposure): number {
  if (left.resolvedAtMs !== right.resolvedAtMs) return left.resolvedAtMs - right.resolvedAtMs;
  if (left.hopCount !== right.hopCount) return left.hopCount - right.hopCount;
  return left.versionKey.localeCompare(right.versionKey);
}

/** Patient zero first, then by service key so a shared instant orders the same every run. */
function compareExposuresChronologically(left: ReplayExposure, right: ReplayExposure): number {
  if (left.resolvedAtMs !== right.resolvedAtMs) return left.resolvedAtMs - right.resolvedAtMs;
  return left.serviceKey.localeCompare(right.serviceKey);
}

/**
 * The lockfile instant on an exposure path.
 *
 * blast-radius.ts hangs `resolvedAtMs` on the step reached over RESOLVED, which is the first
 * hop out of the service, so the first readable value is the pin that opened this route.
 */
function readResolutionInstantMs(path: ExposurePath): number | null {
  for (const step of path.steps) {
    if (step.resolvedAtMs !== null && step.resolvedAtMs > 0) return step.resolvedAtMs;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

type FrameBuildInput = {
  instants: readonly ReplayInstant[];
  /** Ordered by resolution instant ascending, one entry per service. */
  exposures: readonly ReplayExposure[];
  limits: readonly AnswerLimit[];
  subjectCoverage: Coverage;
  subjectKey: string;
  graphIsEmpty: boolean;
  knownServiceCount: number;
  disclosedAtMs: number;
};

/**
 * Folds the exposures into one cumulative snapshot per instant.
 *
 * Cumulative is the whole visual payoff: a service that pinned the bad version at frame 3 is
 * still in the set at frame 40, because the pin happened and no later instant undoes it. The
 * known-time flag is the opposite shape, a single flip at T2, and the two together are what
 * makes the blind spot visible on screen.
 */
function buildFrames(input: FrameBuildInput): ReplayFrame[] {
  const frames: ReplayFrame[] = [];
  const cumulative: ReplayExposure[] = [];
  let cursor = 0;

  input.instants.forEach((instant, index) => {
    while (cursor < input.exposures.length) {
      const next = input.exposures[cursor];
      if (next === undefined || next.resolvedAtMs > instant.atMs) break;
      cumulative.push(next);
      cursor += 1;
    }

    // Copied per frame: a frame is a snapshot, and handing the UI the live array would make
    // every rendered frame show the final state.
    const exposedServices = [...cumulative];
    const decided = decideVerdict({
      foundEvidence: exposedServices.length > 0,
      subjectCoverage: input.subjectCoverage,
      subjectKey: input.subjectKey,
      limits: input.limits,
      graphIsEmpty: input.graphIsEmpty,
    });

    const evidence: ReplayFrameEvidence = {
      atMs: instant.atMs,
      exposedServices,
      counts: countVerdicts(exposedServices.length, input.knownServiceCount, decided.limits),
      // Half-open at the start of the blind spot and closed at its end: the instant the
      // advisory published, the world knew, so the flag is true at T2 and not only after it.
      advisoryPublic: input.disclosedAtMs > 0 && instant.atMs >= input.disclosedAtMs,
      unknownWindowServiceKeys: exposedServices
        .filter((exposure) => exposure.withinUnknownWindow)
        .map((exposure) => exposure.serviceKey),
    };

    frames.push({
      index,
      atMs: instant.atMs,
      label: instant.label,
      answer: buildAnswer(decided, evidence),
    });
  });

  return frames;
}

/**
 * Splits the known services across the three verdicts.
 *
 * The residual services are only called clean when the frame carries no limit whatsoever.
 * Any limit means the slice could not finish looking, and a service the tool did not finish
 * looking at is unknown, not safe.
 */
function countVerdicts(
  exposedCount: number,
  knownServiceCount: number,
  limits: readonly AnswerLimit[],
): ReplayVerdictCounts {
  const residual = Math.max(knownServiceCount - exposedCount, 0);
  const canDecideNegative = limits.length === 0;
  return {
    exposed: exposedCount,
    not_exposed: canDecideNegative ? residual : 0,
    unknown: canDecideNegative ? 0 : residual,
  };
}

/**
 * The denominator for the per-frame counts: the services the pack names plus any exposed
 * service the graph knew about and the pack did not, so the three counts always sum to the
 * number of services the replay can say anything about.
 */
function countKnownServices(pack: IncidentPack, exposures: readonly ReplayExposure[]): number {
  const keys = new Set(exposures.map((exposure) => exposure.serviceKey));
  // The pack states a prefixed key and a name, while the graph stores the bare name as the
  // Service key, so the join runs through the model's own key function rather than through a
  // string edit here. sourceRef: src/lib/graph/model.ts (serviceKey).
  for (const service of pack.services) keys.add(serviceKey(service.name));
  return keys.size;
}

// ---------------------------------------------------------------------------
// Pack reading
// ---------------------------------------------------------------------------

/** T1: the earliest instant any compromised artifact in the pack was installable. */
function earliestPayloadInstantMs(pack: IncidentPack): number {
  return Math.min(...pack.compromisedVersions.map((compromised) => compromised.publishedAtMs));
}

/** T2: the earliest instant any advisory in the pack was public. */
function earliestAdvisoryInstantMs(pack: IncidentPack): number {
  return Math.min(...pack.advisories.map((advisory) => advisory.publishedAtMs));
}

function earliestCompromisedVersion(
  compromisedVersions: readonly IncidentCompromisedVersion[],
): IncidentCompromisedVersion | null {
  const ordered = [...compromisedVersions].sort(
    (left, right) => left.publishedAtMs - right.publishedAtMs || left.name.localeCompare(right.name),
  );
  return ordered[0] ?? null;
}

/** Earliest publication first, then by id, so the choice never depends on file order. */
function earliestAdvisory(advisories: readonly IncidentAdvisory[]): IncidentAdvisory | null {
  const ordered = [...advisories].sort(
    (left, right) =>
      left.publishedAtMs - right.publishedAtMs ||
      left.advisoryId.localeCompare(right.advisoryId),
  );
  return ordered[0] ?? null;
}

/**
 * The advisory that closes the window for one artifact.
 *
 * Earliest wins: known time opens at the first public record, and a later advisory naming
 * the same package (event-stream got a second one two years on) does not reopen the gap.
 */
function earliestAdvisoryAffecting(
  pack: IncidentPack,
  compromised: IncidentCompromisedVersion,
): IncidentAdvisory | null {
  const affectedKey = packageKey(compromised.ecosystem, compromised.name);
  const candidates = pack.advisories.filter((advisory) =>
    advisory.affects.some(
      (affected) => packageKey(affected.ecosystem, affected.name) === affectedKey,
    ),
  );
  return earliestAdvisory(candidates);
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/**
 * Names the weakest-covered compromised package, so an absence limit says which package the
 * slice is missing instead of naming the pack as a whole.
 */
function pickSubjectKey(
  coverage: SliceCoverage,
  compromisedPackageKeys: readonly string[],
  weakest: Coverage,
  fallback: string,
): string {
  const named = compromisedPackageKeys.find(
    (candidate) => coverage.describePackageCoverage(candidate) === weakest,
  );
  return named ?? fallback;
}

/**
 * Collapses limits repeated across compromised versions. Two versions of one package produce
 * the same partial-coverage limit twice, and a frame that lists it twice reads as two
 * separate problems.
 */
function dedupeLimits(limits: readonly AnswerLimit[]): AnswerLimit[] {
  const seen = new Set<string>();
  const unique: AnswerLimit[] = [];
  for (const limit of limits) {
    const signature = `${limit.kind}|${describeLimit(limit)}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    unique.push(limit);
  }
  return unique;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}
