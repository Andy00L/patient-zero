/**
 * GET /api/blast-radius
 *
 * Who is exposed to a compromised package version, through which path, and how far away.
 *
 * Query contract:
 *   package   required  natural package key, "ecosystem:name" (npm:event-stream)
 *   version   required  the exact version string (3.3.6)
 *   maxHops   optional  1 to 16, the engine's own ceiling. Default is the analysis default.
 *   at        optional  epoch milliseconds. Answers "who had this resolved at that instant"
 *                       instead of "who has it resolved at all".
 *
 * A question the slice cannot decide answers 200 with `verdict: "unknown"` and the limits that
 * made it undecidable. Only a failed read is an error status.
 *
 * The `at` filter is applied here rather than in the analysis module because there is no
 * as-of-instant traversal: RESOLVED carries `resolved_at_ms` on the edge, and the path each
 * exposure already carries names that instant, so the filter is a pass over an answer that has
 * already been computed. Exposure is cumulative on purpose: a lockfile pin has a start instant
 * and no end instant in this graph, so "resolved at or before `at`" is the whole rule, and a
 * service that later moved off the bad version cannot be detected as having done so.
 */

import { z } from "zod";

import { digitsInRange, epochMs, jsonFailure, jsonOk, parseQuery, runRoute } from "@/lib/api/http";
import {
  type AnswerLimit,
  buildAnswer,
  decideVerdict,
} from "@/lib/analysis/abstention";
import {
  type ServiceExposure,
  computeBlastRadius,
} from "@/lib/analysis/blast-radius";
import { loadGraph } from "@/lib/graph/load-graph";
import { parsePackageKey, versionKey } from "@/lib/graph/model";
import { MAX_TRAVERSAL_HOPS } from "@/lib/hydra/config";

const ROUTE_NAME = "GET /api/blast-radius";

/** npm caps a package name at 214 characters; the key adds an ecosystem prefix. */
const MAX_PACKAGE_KEY_LENGTH = 240;

/** No registry accepts a version string near this length. */
const MAX_VERSION_LENGTH = 128;

const QUERY_SCHEMA = z.object({
  package: z.string().min(1).max(MAX_PACKAGE_KEY_LENGTH),
  version: z.string().min(1).max(MAX_VERSION_LENGTH),
  maxHops: digitsInRange(1, MAX_TRAVERSAL_HOPS).optional(),
  at: epochMs().optional(),
});

export async function GET(request: Request): Promise<Response> {
  return runRoute(ROUTE_NAME, async () => {
    const query = parseQuery(request, QUERY_SCHEMA, ROUTE_NAME);
    if (!query.ok) return jsonFailure(query.failure);

    const parsedKey = parsePackageKey(query.value.package);
    if (parsedKey === null || parsedKey.name.includes(":")) {
      return jsonFailure({
        reason: "invalid_input",
        message: `[${ROUTE_NAME}] package must be a natural key of the form ecosystem:name, for example npm:event-stream. Pass the version separately.`,
      });
    }

    const loaded = await loadGraph();
    if (!loaded.ok) return jsonFailure(loaded.failure);

    const subjectVersionKey = versionKey(parsedKey.ecosystem, parsedKey.name, query.value.version);
    const options = query.value.maxHops === undefined ? undefined : { maxHops: query.value.maxHops };

    const computed = await computeBlastRadius({
      gateway: loaded.value.gateway,
      coverage: loaded.value.coverage,
      versionKey: subjectVersionKey,
      options,
    });
    if (!computed.ok) return jsonFailure(computed.failure);

    const answer = computed.value;
    const askedInstant = query.value.at;

    const payload = {
      query: {
        packageKey: query.value.package,
        version: query.value.version,
        versionKey: subjectVersionKey,
        maxHops: query.value.maxHops ?? null,
        atMs: askedInstant ?? null,
      },
      source: loaded.value.source,
    };

    if (askedInstant === undefined) {
      return jsonOk({ ...payload, answer, asOf: null });
    }

    const asOf = restrictToInstant(answer.evidence.exposedServices, askedInstant);
    const decided = decideVerdict({
      foundEvidence: asOf.exposed.length > 0,
      subjectCoverage: loaded.value.coverage.describePackageCoverage(
        answer.evidence.compromised.packageKey,
      ),
      subjectKey: subjectVersionKey,
      // The analysis limits travel verbatim; the route only ever appends.
      limits: [...answer.limits, ...asOf.addedLimits],
      graphIsEmpty: answer.limits.some((limit) => limit.kind === "empty_graph"),
    });

    return jsonOk({
      ...payload,
      answer: buildAnswer(decided, {
        ...answer.evidence,
        exposedServices: asOf.exposed,
      }),
      asOf: {
        atMs: askedInstant,
        exposedServiceCount: asOf.exposed.length,
        notYetExposedServiceKeys: asOf.notYet,
        undatedServiceKeys: asOf.undated,
        addedLimits: asOf.addedLimits,
        // exposedVersions is not filtered: DEPENDED_ON_BY records that one version depends on
        // another, with no instant attached, so the package-level half of this answer has no
        // valid-time axis to cut. maxHopReached likewise describes the whole walk.
        versionExposureFiltered: false,
      },
    });
  });
}

type InstantRestriction = {
  exposed: ServiceExposure[];
  /** Services whose pin came later than the instant asked about. */
  notYet: string[];
  /** Services whose pin instant could not be read, so they cannot be placed in time. */
  undated: string[];
  addedLimits: AnswerLimit[];
};

/**
 * Keeps the services that had already resolved the compromised version at `atMs`.
 *
 * A service whose pin instant is unreadable is dropped from the exposed list and recorded as a
 * `timestamp_missing` limit, which is a truncating limit: it makes `not_exposed` unreachable.
 * That is the point. Treating an undated pin as "not yet exposed" would let a missing edge
 * property produce a clean bill of health.
 */
function restrictToInstant(
  exposures: readonly ServiceExposure[],
  atMs: number,
): InstantRestriction {
  const exposed: ServiceExposure[] = [];
  const notYet: string[] = [];
  const undated: string[] = [];

  for (const exposure of exposures) {
    const resolvedAtMs = readResolutionInstantMs(exposure);
    if (resolvedAtMs === null) {
      undated.push(exposure.serviceKey);
      continue;
    }
    if (resolvedAtMs <= atMs) exposed.push(exposure);
    else notYet.push(exposure.serviceKey);
  }

  const addedLimits: AnswerLimit[] = undated.map((serviceKey) => ({
    kind: "timestamp_missing",
    field: `resolved_at_ms on ${serviceKey}`,
  }));

  return { exposed, notYet, undated, addedLimits };
}

/**
 * The instant a service pinned its way into this exposure.
 *
 * The lockfile edge is the first hop of every service path, so the first step carrying a usable
 * `resolvedAtMs` is the pin. The same rule is applied frame by frame inside
 * src/lib/analysis/replay.ts, where it is private; the two must stay in agreement, because a
 * scrubber and an as-of query that disagree about one service look like a data bug.
 */
function readResolutionInstantMs(exposure: ServiceExposure): number | null {
  for (const step of exposure.shortestPath.steps) {
    if (step.resolvedAtMs !== null && step.resolvedAtMs > 0) return step.resolvedAtMs;
  }
  return null;
}
