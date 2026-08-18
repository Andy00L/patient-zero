/**
 * GET /api/typosquats
 *
 * Names in the ingested slice that imitate a more popular name in the same registry.
 *
 * Query contract:
 *   ecosystem  optional  npm or pypi. Omitted scans every ecosystem in the slice.
 *   limit      optional  1 to 100 findings, default 20.
 *
 * The findings are computed here rather than read back as TYPOSQUAT_OF edges. The ingest can
 * stage those edges, but neither committed snapshot carries one, and a route that read them
 * would answer "no typosquats" on data where the detector has simply never been run. Scoring
 * the Package names in the slice against each other answers from what is actually there.
 *
 * Two costs shape the caps below. The scan is quadratic in the number of names, so the
 * enumeration is bounded and a shortfall is reported as a `scan_capped` limit. And the corpus is
 * a curated slice, never the registry, so `not_exposed` is unreachable on this route by
 * construction: finding nothing here means nothing in the slice imitates anything else in the
 * slice, which is not a statement about npm or PyPI. That is why an empty result is `unknown`.
 */

import { z } from "zod";

import { digitsInRange, jsonFailure, jsonOk, parseQuery, runRoute } from "@/lib/api/http";
import {
  type AnswerLimit,
  buildAnswer,
  buildUnknownAnswer,
} from "@/lib/analysis/abstention";
import {
  type ComparablePackage,
  type TyposquatFinding,
  UNKNOWN_WEEKLY_DOWNLOADS,
  UNMEASURED_EDIT_DISTANCE,
  scanForTyposquats,
} from "@/lib/analysis/typosquat";
import {
  type GraphGateway,
  isGraphEmpty,
  readNumberProperty,
  readStringProperty,
} from "@/lib/graph/gateway";
import { loadGraph } from "@/lib/graph/load-graph";
import { ECOSYSTEMS, type Ecosystem, isEcosystem } from "@/lib/graph/model";
import { type Failure, type Result, succeed } from "@/lib/result";

const ROUTE_NAME = "GET /api/typosquats";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Ceiling on Package names enumerated in one request.
 *
 * Every candidate is scored against every other name, so the work grows with the square of
 * this number. A thousand names is under a second of scoring and comfortably above the
 * committed slice; beyond it the answer carries a `scan_capped` limit rather than pretending it
 * looked at everything.
 */
const MAX_PACKAGES_SCANNED = 1_000;

/** Findings kept per candidate before the route ranks them together. */
const FINDINGS_PER_CANDIDATE = 5;

const CONFIDENCE_ORDER: Record<TyposquatFinding["confidence"], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

const QUERY_SCHEMA = z.object({
  ecosystem: z.enum(ECOSYSTEMS).optional(),
  limit: digitsInRange(1, MAX_LIMIT).optional(),
});

type TyposquatEvidence = {
  findings: TyposquatFinding[];
  /** Names scored as candidates, after the ecosystem filter. */
  candidatesScanned: number;
  /** Names each candidate was compared against, which is the corpus size. */
  comparisonCorpusSize: number;
  /** Pairs that produced at least one signal, before the findings cap. */
  matchedCount: number;
  /** Names that could not be scored at all: empty, or past the registry length cap. */
  unusableCandidateCount: number;
  /** Package nodes in the graph, before the ecosystem filter and the enumeration cap. */
  packagesInGraph: number;
};

export async function GET(request: Request): Promise<Response> {
  return runRoute(ROUTE_NAME, async () => {
    const query = parseQuery(request, QUERY_SCHEMA, ROUTE_NAME);
    if (!query.ok) return jsonFailure(query.failure);

    const limit = query.value.limit ?? DEFAULT_LIMIT;
    const ecosystem: Ecosystem | null = query.value.ecosystem ?? null;

    const loaded = await loadGraph();
    if (!loaded.ok) return jsonFailure(loaded.failure);

    const { gateway, source } = loaded.value;

    const total = await gateway.countNodes("Package");
    if (!total.ok) return jsonFailure(total.failure);

    const packages = await readComparablePackages(
      gateway,
      Math.min(total.value, MAX_PACKAGES_SCANNED),
    );
    if (!packages.ok) return jsonFailure(packages.failure);

    const corpus =
      ecosystem === null
        ? packages.value
        : packages.value.filter((entry) => entry.ecosystem === ecosystem);

    const limits: AnswerLimit[] = [];
    if (packages.value.length < total.value) {
      limits.push({ kind: "scan_capped", examined: packages.value.length, total: total.value });
    }

    const scanned = scanCorpus(corpus, limits);

    const evidence: TyposquatEvidence = {
      findings: scanned.findings.slice(0, limit),
      candidatesScanned: corpus.length - scanned.unusableCandidateCount,
      comparisonCorpusSize: corpus.length,
      matchedCount: scanned.findings.length,
      unusableCandidateCount: scanned.unusableCandidateCount,
      packagesInGraph: total.value,
    };

    const payload = {
      query: { ecosystem, limit },
      source,
      pagination: {
        limit,
        returnedFindings: evidence.findings.length,
        matchedFindings: scanned.findings.length,
      },
    };

    if (evidence.findings.length > 0) {
      // Found evidence is sound under partial coverage: a name that imitates another one does so
      // whether or not the rest of the registry was ingested.
      return jsonOk({
        ...payload,
        answer: buildAnswer(
          {
            verdict: "exposed",
            rationale: `${scanned.findings.length} name${scanned.findings.length === 1 ? "" : "s"} in the slice imitate a more popular name in the same registry. Each finding carries the signals that fired.`,
            limits,
          },
          evidence,
        ),
      });
    }

    const empty = await isGraphEmpty(gateway);
    if (!empty.ok) return jsonFailure(empty.failure);
    if (empty.value) {
      return jsonOk({
        ...payload,
        answer: buildUnknownAnswer(
          "The graph is empty, so no name can be compared to another yet. Run an ingest first.",
          evidence,
          [{ kind: "empty_graph" }, ...limits],
        ),
      });
    }

    return jsonOk({
      ...payload,
      answer: buildUnknownAnswer(
        `No name among the ${corpus.length} compared imitates another one in the slice. The slice is a curated subset of the registry, so this is not a statement about ${ecosystem ?? "either registry"} as a whole.`,
        evidence,
        limits,
      ),
    });
  });
}

/**
 * Reads Package nodes into the shape the detector compares.
 *
 * `weekly_downloads` carries -1 when the registry published no count, and the detector treats
 * that as unknown rather than as zero: it neither rejects a pair for a missing popularity gap
 * nor claims one. Passing the sentinel straight through is what keeps that behaviour.
 */
async function readComparablePackages(
  gateway: GraphGateway,
  scanLimit: number,
): Promise<Result<ComparablePackage[], Failure>> {
  const nodeIds = await gateway.listNodeIds({ label: "Package", limit: Math.max(scanLimit, 1) });
  if (!nodeIds.ok) return nodeIds;

  const nodes = await gateway.readNodes({ nodeIds: nodeIds.value, label: "Package" });
  if (!nodes.ok) return nodes;

  const packages: ComparablePackage[] = [];
  for (const node of nodes.value) {
    const ecosystem = readStringProperty(node.properties, "ecosystem");
    const name = readStringProperty(node.properties, "name");
    if (ecosystem === null || name === null || !isEcosystem(ecosystem)) continue;

    const weeklyDownloads = readNumberProperty(node.properties, "weekly_downloads");
    packages.push({
      ecosystem,
      name,
      weeklyDownloads: weeklyDownloads ?? UNKNOWN_WEEKLY_DOWNLOADS,
    });
  }

  return succeed(packages);
}

/**
 * Scores every name against every other one, ranked hardest to explain away first.
 *
 * A candidate the detector refuses (an empty name, a name past the registry cap) is counted and
 * skipped: one unusable row must not fail a scan over a thousand.
 */
function scanCorpus(
  corpus: readonly ComparablePackage[],
  limits: AnswerLimit[],
): { findings: TyposquatFinding[]; unusableCandidateCount: number } {
  const findings: TyposquatFinding[] = [];
  const seenLimits = new Set(limits.map((limit) => JSON.stringify(limit)));
  let unusableCandidateCount = 0;

  for (const candidate of corpus) {
    const scan = scanForTyposquats(candidate, corpus, {
      maxFindings: FINDINGS_PER_CANDIDATE,
      maxComparedNames: corpus.length,
    });
    if (!scan.ok) {
      unusableCandidateCount += 1;
      continue;
    }

    findings.push(...scan.value.findings);
    for (const limit of scan.value.limits) {
      const fingerprint = JSON.stringify(limit);
      if (seenLimits.has(fingerprint)) continue;
      seenLimits.add(fingerprint);
      limits.push(limit);
    }
  }

  findings.sort(compareFindings);
  return { findings, unusableCandidateCount };
}

/** Confidence first, then the closest name, then alphabetical so two runs render alike. */
function compareFindings(left: TyposquatFinding, right: TyposquatFinding): number {
  const byConfidence = CONFIDENCE_ORDER[left.confidence] - CONFIDENCE_ORDER[right.confidence];
  if (byConfidence !== 0) return byConfidence;

  const byDistance = sortableDistance(left) - sortableDistance(right);
  if (byDistance !== 0) return byDistance;

  const bySuspect = left.suspect.name.localeCompare(right.suspect.name);
  return bySuspect !== 0 ? bySuspect : left.target.name.localeCompare(right.target.name);
}

/** An unmeasured distance sorts last rather than first, where its -1 would put it. */
function sortableDistance(finding: TyposquatFinding): number {
  return finding.editDistance === UNMEASURED_EDIT_DISTANCE
    ? Number.MAX_SAFE_INTEGER
    : finding.editDistance;
}
