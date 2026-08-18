import {
  type AbstainingAnswer,
  type AnswerLimit,
  buildAnswer,
  buildUnknownAnswer,
  detectPathLimit,
} from "@/lib/analysis/abstention";
import {
  type ComparablePackage,
  scanForTyposquats,
  type TyposquatFinding,
  UNKNOWN_WEEKLY_DOWNLOADS,
} from "@/lib/analysis/typosquat";
import {
  type GraphGateway,
  type GraphPath,
  isGraphEmpty,
  nodeHasLabel,
  pathSourceNode,
  pathTargetNode,
  readNumberProperty,
  readStringProperty,
} from "@/lib/graph/gateway";
import { isEcosystem, SELECTOR_PROPERTY } from "@/lib/graph/model";
import { type Failure, type Result, succeed } from "@/lib/result";

import {
  type ConfusablePair,
  foldConfusablePairs,
  type SideFacts,
  sideId,
} from "./confusable-pairs";

/**
 * Scanning the slice for confusable names, and measuring what it installs.
 *
 * This module reads the graph. It exists beside the view rather than in `src/lib/analysis/`
 * because no shared function scans a whole slice for typosquats: the JSON route at
 * src/app/api/typosquats/route.ts does the same enumeration and the same corpus scan inline, and
 * this is the second caller. The two are kept deliberately identical, constant for constant, so
 * the surface and the route cannot answer the same question differently. Extracting one function
 * both of them call is the right fix and belongs to whoever owns that route.
 * sourceRef: src/app/api/typosquats/route.ts.
 *
 * Findings are computed here rather than read back as TYPOSQUAT_OF edges, for the reason the route
 * gives: the ingest can stage those edges, no committed snapshot carries one, and a surface that
 * read them would answer "nothing imitates anything" on a slice where the detector has simply
 * never run.
 *
 * The reach measurement is two traversals for the whole board, not two per name. Both are
 * multi-source walks from every name that appears in a pair, which is what makes an answer about
 * ninety names cost a handful of operations instead of a hundred round trips.
 */

/**
 * Ceiling on Package names enumerated in one render. The scan is quadratic in this number.
 * sourceRef: MAX_PACKAGES_SCANNED in src/app/api/typosquats/route.ts.
 */
const MAX_PACKAGES_SCANNED = 1_000;

/** Findings kept per candidate before the pairs are folded. Matches the route. */
const FINDINGS_PER_CANDIDATE = 5;

/**
 * Upper bound on paths returned by one reach probe.
 *
 * A probe walks one hop from every name in the board, or two for the lockfile question, so the
 * result is bounded by the slice's edge count rather than by its node count. The cap is recorded
 * as a limit when a walk actually reaches it, so a truncated reach reads as truncated.
 */
const PROBE_PATH_COUNT = 5_000;

export type SliceScan = {
  /** Every folded pair, ranked by the detector, before any confidence floor is applied. */
  pairs: readonly ConfusablePair[];
  /** Names the detector could score at all. */
  candidatesScanned: number;
  /** Names it refused: empty, or past the registry's length cap. */
  unusableCandidateCount: number;
  /**
   * Names carrying no weekly download figure. This is the number that explains the confidence
   * column: without both figures the detector cannot confirm a popularity gap, and without a
   * confirmed gap no pair reaches high confidence and no pair gets a direction.
   */
  namesWithoutDownloadCount: number;
  /** Package nodes in the graph, before the enumeration cap. */
  packagesInGraph: number;
  /** Findings before folding, so the surface can say how many were duplicates of each other. */
  findingCount: number;
};

/**
 * Scans the slice and measures reach, or fails.
 *
 * A Failure means the graph could not be read. Finding nothing is a success with no pairs, and the
 * verdict says which of the two happened.
 */
export async function scanSliceForConfusables(
  gateway: GraphGateway,
): Promise<Result<AbstainingAnswer<SliceScan>, Failure>> {
  const total = await gateway.countNodes("Package");
  if (!total.ok) return total;

  const corpus = await readComparablePackages(gateway, Math.min(total.value, MAX_PACKAGES_SCANNED));
  if (!corpus.ok) return corpus;

  const limits: AnswerLimit[] = [];
  if (corpus.value.packages.length < total.value) {
    limits.push({
      kind: "scan_capped",
      examined: corpus.value.packages.length,
      total: total.value,
    });
  }

  const scanned = scanCorpus(corpus.value.packages, limits);

  const reach = await probeReach(gateway, scanned.findings, corpus.value.byName, limits);
  if (!reach.ok) return reach;

  const pairs = foldConfusablePairs({ findings: scanned.findings, facts: reach.value });

  const evidence: SliceScan = {
    pairs,
    candidatesScanned: corpus.value.packages.length - scanned.unusableCandidateCount,
    unusableCandidateCount: scanned.unusableCandidateCount,
    namesWithoutDownloadCount: corpus.value.namesWithoutDownloadCount,
    packagesInGraph: total.value,
    findingCount: scanned.findings.length,
  };

  if (pairs.length > 0) {
    // A name that imitates another one does so whether or not the rest of the registry was
    // ingested, so found evidence is sound under partial coverage. sourceRef: the same
    // reasoning in src/app/api/typosquats/route.ts.
    return succeed(
      buildAnswer(
        {
          verdict: "exposed",
          rationale: `${pairs.length} pair${pairs.length === 1 ? "" : "s"} of names in this slice are close enough that an install typo would reach the wrong one. Each pair carries the signals that fired and what the slice installs.`,
          limits,
        },
        evidence,
      ),
    );
  }

  const empty = await isGraphEmpty(gateway);
  if (!empty.ok) return empty;
  if (empty.value) {
    return succeed(
      buildUnknownAnswer(
        "The graph is empty, so no name can be compared to another yet. Run an ingest first.",
        evidence,
        [{ kind: "empty_graph" }, ...limits],
      ),
    );
  }

  // Never not_exposed: the corpus is a curated slice, so finding nothing means nothing in the
  // slice imitates anything else in the slice, which is not a statement about either registry.
  return succeed(
    buildUnknownAnswer(
      `No name among the ${corpus.value.packages.length} compared imitates another one in this slice. The slice is a curated subset of the registry, so this is not a statement about npm or PyPI as a whole.`,
      evidence,
      limits,
    ),
  );
}

/** What the corpus read knows about one name, before any traversal. */
type CorpusEntry = {
  /** The Package node's own key, or null when the node carries no readable one. */
  nodeKey: string | null;
  /** UNKNOWN_WEEKLY_DOWNLOADS when the registry published no figure. */
  weeklyDownloads: number;
};

type Corpus = {
  packages: ComparablePackage[];
  /**
   * One entry per name, addressed by `sideId`. This is the only place holding a download figure
   * for every name in the slice: a finding carries one for its target and none for its suspect,
   * so reading the figure off a finding would print unknown for half the board.
   */
  byName: Map<string, CorpusEntry>;
  namesWithoutDownloadCount: number;
};

/**
 * Reads Package nodes into the shape the detector compares, keeping each node's own key.
 *
 * `weekly_downloads` carries the unknown sentinel when the registry published no count, and it is
 * passed straight through: the detector treats it as unknown rather than as zero, so it neither
 * rejects a pair for a missing popularity gap nor claims one.
 *
 * The key is read from the node rather than rebuilt from the ecosystem and the name. The reach
 * probes select their sources by that key, and a key this code composed itself would silently
 * select nothing if the ingest ever wrote a different form.
 */
async function readComparablePackages(
  gateway: GraphGateway,
  scanLimit: number,
): Promise<Result<Corpus, Failure>> {
  const nodeIds = await gateway.listNodeIds({ label: "Package", limit: Math.max(scanLimit, 1) });
  if (!nodeIds.ok) return nodeIds;

  const nodes = await gateway.readNodes({ nodeIds: nodeIds.value, label: "Package" });
  if (!nodes.ok) return nodes;

  const packages: ComparablePackage[] = [];
  const byName = new Map<string, CorpusEntry>();
  let namesWithoutDownloadCount = 0;

  for (const node of nodes.value) {
    const ecosystem = readStringProperty(node.properties, "ecosystem");
    const name = readStringProperty(node.properties, "name");
    if (ecosystem === null || name === null || !isEcosystem(ecosystem)) continue;

    const weeklyDownloads =
      readNumberProperty(node.properties, "weekly_downloads") ?? UNKNOWN_WEEKLY_DOWNLOADS;
    if (weeklyDownloads === UNKNOWN_WEEKLY_DOWNLOADS) namesWithoutDownloadCount += 1;

    packages.push({ ecosystem, name, weeklyDownloads });
    byName.set(sideId(ecosystem, name), {
      nodeKey: readStringProperty(node.properties, SELECTOR_PROPERTY),
      weeklyDownloads,
    });
  }

  return succeed({ packages, byName, namesWithoutDownloadCount });
}

/**
 * Scores every name against every other one, ranked hardest to explain away first.
 *
 * A candidate the detector refuses is counted and skipped: one unusable name must not fail a scan
 * over a thousand. sourceRef: scanCorpus in src/app/api/typosquats/route.ts, which this mirrors,
 * including its ranking.
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

const CONFIDENCE_ORDER: Record<TyposquatFinding["confidence"], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/**
 * Confidence first, then the closest name, then alphabetical so two renders agree.
 * sourceRef: compareFindings in src/app/api/typosquats/route.ts, which this mirrors exactly.
 */
function compareFindings(left: TyposquatFinding, right: TyposquatFinding): number {
  const byConfidence = CONFIDENCE_ORDER[left.confidence] - CONFIDENCE_ORDER[right.confidence];
  if (byConfidence !== 0) return byConfidence;

  const byDistance = sortableDistance(left) - sortableDistance(right);
  if (byDistance !== 0) return byDistance;

  const bySuspect = left.suspect.name.localeCompare(right.suspect.name);
  return bySuspect !== 0 ? bySuspect : left.target.name.localeCompare(right.target.name);
}

/** An unmeasured distance sorts last rather than first, where its sentinel would put it. */
function sortableDistance(finding: TyposquatFinding): number {
  return finding.editDistance < 0 ? Number.MAX_SAFE_INTEGER : finding.editDistance;
}

/**
 * Measures what the slice installs, for every name that appears in any finding.
 *
 * Two multi-source walks answer two different questions, and the difference between them is the
 * whole structure of the surface:
 *
 *   declared  Versions whose manifest names this package. One hop backwards over DEPENDS_ON.
 *             A range in a manifest, which may never have resolved to anything.
 *   pinned    Services whose lockfile pinned a version of this package. Two hops backwards,
 *             VERSION_OF then RESOLVED. A pin is a name that reached a disk.
 *
 * Both walks start from the small side, which is the set of names under suspicion, rather than
 * enumerating services or versions and filtering. The direction is incoming because the stored
 * edges run the other way: a Version declares a dependency on a Package, and a Service resolved
 * a Version. sourceRef: RELATIONSHIP_ENDPOINTS in src/lib/graph/model.ts.
 */
async function probeReach(
  gateway: GraphGateway,
  findings: readonly TyposquatFinding[],
  corpus: ReadonlyMap<string, CorpusEntry>,
  limits: AnswerLimit[],
): Promise<Result<Map<string, SideFacts>, Failure>> {
  const unprobed = new Map<string, SideFacts>();
  const sourceKeys: string[] = [];

  for (const finding of findings) {
    for (const side of [finding.suspect, finding.target]) {
      const id = sideId(side.ecosystem, side.name);
      if (unprobed.has(id)) continue;

      // Both readings come from the corpus, never from the finding: a finding carries a download
      // figure for its target only, and this map holds one for every name that was compared.
      const entry = corpus.get(id);
      const nodeKey = entry?.nodeKey ?? null;
      unprobed.set(id, {
        weeklyDownloads: entry?.weeklyDownloads ?? UNKNOWN_WEEKLY_DOWNLOADS,
        nodeKey,
        dependentVersionCount: 0,
        serviceNames: [],
        // A name with no readable node key cannot be selected by a traversal, so its reach stays
        // unknown instead of being reported as nothing.
        isProbed: nodeKey !== null,
      });
      if (nodeKey !== null) sourceKeys.push(nodeKey);
    }
  }

  if (sourceKeys.length === 0) return succeed(unprobed);

  const declared = await gateway.pathsFromSources({
    sourceLabel: "Package",
    sourceKeys,
    relTypes: ["DEPENDS_ON"],
    direction: "incoming",
    maxLength: 1,
    pathCount: PROBE_PATH_COUNT,
    targetLabel: "Version",
  });
  if (!declared.ok) return declared;

  const pinned = await gateway.pathsFromSources({
    sourceLabel: "Package",
    sourceKeys,
    relTypes: ["VERSION_OF", "RESOLVED"],
    direction: "incoming",
    maxLength: 2,
    pathCount: PROBE_PATH_COUNT,
    targetLabel: "Service",
  });
  if (!pinned.ok) return pinned;

  for (const paths of [declared.value, pinned.value]) {
    const limit = detectPathLimit(paths, PROBE_PATH_COUNT);
    if (limit !== null && !limits.some((existing) => existing.kind === limit.kind)) {
      limits.push(limit);
    }
  }

  const declaredByKey = groupTargets(declared.value, "Version", SELECTOR_PROPERTY);
  const pinnedByKey = groupTargets(pinned.value, "Service", "name");

  const facts = new Map<string, SideFacts>();
  for (const [id, side] of unprobed) {
    const nodeKey = side.nodeKey;
    facts.set(id, {
      ...side,
      dependentVersionCount: nodeKey === null ? 0 : (declaredByKey.get(nodeKey)?.size ?? 0),
      serviceNames: nodeKey === null ? [] : [...(pinnedByKey.get(nodeKey) ?? [])].sort(),
    });
  }

  return succeed(facts);
}

/**
 * Groups path endpoints by the source they were reached from.
 *
 * A set per source, not a count: the same service can be reached over more than one path when it
 * pinned several versions of one package, and counting paths would report it twice.
 */
function groupTargets(
  paths: readonly GraphPath[],
  targetLabel: "Version" | "Service",
  targetProperty: string,
): Map<string, Set<string>> {
  const grouped = new Map<string, Set<string>>();

  for (const path of paths) {
    const source = pathSourceNode(path);
    const target = pathTargetNode(path);
    if (source === null || target === null || !nodeHasLabel(target, targetLabel)) continue;

    const sourceKey = readStringProperty(source.properties, SELECTOR_PROPERTY);
    const targetName = readStringProperty(target.properties, targetProperty);
    if (sourceKey === null || targetName === null) continue;

    const reached = grouped.get(sourceKey) ?? new Set<string>();
    reached.add(targetName);
    grouped.set(sourceKey, reached);
  }

  return grouped;
}
