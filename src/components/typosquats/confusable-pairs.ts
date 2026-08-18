import {
  describeTyposquatSignal,
  type TyposquatConfidence,
  type TyposquatFinding,
  type TyposquatSignal,
  toEcosystemIdentity,
  UNKNOWN_WEEKLY_DOWNLOADS,
} from "@/lib/analysis/typosquat";
import { formatCount } from "@/lib/format";
import type { Ecosystem } from "@/lib/graph/model";

import { CONFIDENCE_FLOORS, type ConfidenceCounts } from "./typosquat-query";

/**
 * The view model for /typosquats: confusable name pairs, with what the slice installs.
 *
 * Pure. Everything here is a rearrangement of what the detector reported plus what two traversals
 * measured, and nothing is scored, weighted or re-ranked. Three decisions live in this file, and
 * all three exist to keep the surface from saying more than the evidence supports.
 *
 * Folding. The detector scores every name against every other name, so a confusable pair is
 * reported twice: "@voiceflow/pino imitates pino" and "pino imitates @voiceflow/pino" are one
 * collision seen from both ends. Rendering both is how a list of 68 real pairs becomes a wall of
 * 101 rows where a third of them are duplicates.
 *
 * Direction. Which of the two names is the imitation is settled by the popularity gap, and only
 * by that: a spelling collision is symmetric by nature. This slice knows a weekly download figure
 * for well under half of its packages, so most pairs have no gap to measure and the detector
 * reports both directions. `isMirrored` records exactly that, and the surface presents a mirrored
 * pair as two confusable names rather than as an accusation with a subject.
 *
 * Attribution. A pair's reach is measured per name, never per pair, because "something here
 * installs one of these two names" is worthless without knowing which one. Every reading carries
 * the name it belongs to.
 */

/** What the slice knows about one name of a pair. */
export type SideFacts = {
  /** UNKNOWN_WEEKLY_DOWNLOADS when the registry published no figure for it. */
  weeklyDownloads: number;
  /**
   * The Package node's own key, or null when the node carries no readable one. Null means the
   * reach probes could not select this name, which is why `isProbed` exists.
   */
  nodeKey: string | null;
  /** Versions in the slice whose manifest declares a dependency on this name. */
  dependentVersionCount: number;
  /** Services whose lockfile pinned a version of this name, by service name. */
  serviceNames: readonly string[];
  /**
   * False when the name could not be probed at all. A row then reads unknown rather than zero:
   * a name nobody could ask about is not a name nothing depends on.
   */
  isProbed: boolean;
};

export type PairSide = SideFacts & {
  /** The identity form, which is what the graph keys on and what the detector compared. */
  name: string;
};

export type ConfusablePair = {
  /** Stable across renders: the ecosystem and the two identity forms in sorted order. */
  pairId: string;
  ecosystem: Ecosystem;
  /**
   * The two names, in the order the detector reported the finding this pair was folded onto.
   * Named after the detector's own fields so the mapping stays checkable, but the surface does
   * not present them as an ordered claim unless the detector settled the direction.
   */
  suspect: PairSide;
  target: PairSide;
  confidence: TyposquatConfidence;
  /** One sentence per signal that fired, in the detector's own ranking. Never empty. */
  reasons: readonly string[];
  /**
   * True when the detector reported this pair from both ends, which means it found no evidence
   * that settles which name imitates which.
   */
  isMirrored: boolean;
  /** True when a service lockfile in the slice pinned a version of either name. */
  isPinnedHere: boolean;
};

/** The key both the fold and the reach probes address a name by. */
export function sideId(ecosystem: Ecosystem, name: string): string {
  return `${ecosystem}|${toEcosystemIdentity(ecosystem, name)}`;
}

/**
 * One sentence per signal, with the numbers put through the shared formatter.
 *
 * Every sentence comes from `describeTyposquatSignal`, with one exception. The popularity gap
 * sentence interpolates two raw download counts, and a six figure integer printed without
 * separators is unreadable next to every other number on the surface, so that one signal is
 * rendered here from the same fields through `formatCount`. The wording follows the library's.
 * sourceRef: describeTyposquatSignal in src/lib/analysis/typosquat.ts.
 */
export function describeReasons(signals: readonly TyposquatSignal[]): string[] {
  return signals.map((signal) => {
    if (signal.kind !== "popularity_gap") return describeTyposquatSignal(signal);
    return `the imitated package has ${formatCount(Math.round(signal.ratio))} times the weekly downloads (${formatCount(signal.targetWeeklyDownloads)} against ${formatCount(signal.suspectWeeklyDownloads)})`;
  });
}

export type FoldRequest = {
  /**
   * The detector's findings, already ranked. The ranking is preserved: the first finding folded
   * onto a pair decides the pair's place in the list, so the surface never re-orders the
   * detector's judgement.
   */
  findings: readonly TyposquatFinding[];
  /** What the slice knows about each name, addressed by `sideId`. */
  facts: ReadonlyMap<string, SideFacts>;
};

/**
 * Folds mirrored findings into one pair per collision.
 *
 * The first finding of a pair is the one kept, which is the stronger of the two by the incoming
 * ranking. The second is not discarded silently: it sets `isMirrored`, which is the surface's only
 * evidence that the detector could not tell the two names apart.
 */
export function foldConfusablePairs({ findings, facts }: FoldRequest): ConfusablePair[] {
  const pairs: ConfusablePair[] = [];
  const seen = new Map<string, number>();

  for (const finding of findings) {
    const suspectId = sideId(finding.suspect.ecosystem, finding.suspect.name);
    const targetId = sideId(finding.target.ecosystem, finding.target.name);
    const pairId = [suspectId, targetId].sort().join("::");

    const alreadyAt = seen.get(pairId);
    if (alreadyAt !== undefined) {
      const kept = pairs[alreadyAt];
      if (kept !== undefined) pairs[alreadyAt] = { ...kept, isMirrored: true };
      continue;
    }

    const suspect = buildSide(finding.suspect.name, facts.get(suspectId));
    const target = buildSide(finding.target.name, facts.get(targetId));

    seen.set(pairId, pairs.length);
    pairs.push({
      pairId,
      ecosystem: finding.suspect.ecosystem,
      suspect,
      target,
      confidence: finding.confidence,
      reasons: describeReasons(finding.signals),
      isMirrored: false,
      isPinnedHere: suspect.serviceNames.length > 0 || target.serviceNames.length > 0,
    });
  }

  return pairs;
}

/**
 * A name the facts map does not hold reads as unprobed rather than as untouched.
 *
 * Every name in a finding came out of the same corpus the facts were built from, so a miss here
 * would be a defect rather than a slice with a gap. It is still rendered as unknown, because a
 * zero printed in place of a missing measurement is the one mistake this surface cannot make.
 */
function buildSide(name: string, facts: SideFacts | undefined): PairSide {
  if (facts === undefined) {
    return {
      name,
      weeklyDownloads: UNKNOWN_WEEKLY_DOWNLOADS,
      nodeKey: null,
      dependentVersionCount: 0,
      serviceNames: [],
      isProbed: false,
    };
  }
  return { name, ...facts };
}

/** How many pairs carry each tier. Every tier is present, so a zero is a measured zero. */
export function countPairsByConfidence(pairs: readonly ConfusablePair[]): ConfidenceCounts {
  const counts: ConfidenceCounts = { high: 0, medium: 0, low: 0 };
  for (const pair of pairs) counts[pair.confidence] += 1;
  return counts;
}

/** The pairs at or above a floor, in the order they arrived. */
export function keepAtFloor(
  pairs: readonly ConfusablePair[],
  floor: TyposquatConfidence,
): ConfusablePair[] {
  // The tier order is the one the URL contract publishes, which is the detector's own ranking.
  // Deriving the depth from it rather than restating it keeps the two from drifting apart.
  const ceiling = CONFIDENCE_FLOORS.indexOf(floor);
  return pairs.filter((pair) => CONFIDENCE_FLOORS.indexOf(pair.confidence) <= ceiling);
}

export type PairSplit = {
  /** Pairs a service lockfile in the slice pinned. These are findings, not candidates. */
  pinned: ConfusablePair[];
  /** Pairs nothing in the slice has pinned. A collision, whatever else it may be. */
  unpinned: ConfusablePair[];
};

/**
 * Splits the pairs on the one fact that separates a finding from a candidate: did a lockfile in
 * this slice actually resolve one of these two names.
 *
 * A declared dependency range is not the same fact and does not promote a pair. A manifest can
 * name a package that no lockfile ever pinned, and a name that reached a lockfile is a name that
 * reached a disk. Both readings are printed on every row either way; this decides which list the
 * row is in, which is the surface's whole structure.
 *
 * The order inside each list is the order it arrived, which is the detector's ranking.
 */
export function splitByLockfilePin(pairs: readonly ConfusablePair[]): PairSplit {
  const pinned: ConfusablePair[] = [];
  const unpinned: ConfusablePair[] = [];
  for (const pair of pairs) (pair.isPinnedHere ? pinned : unpinned).push(pair);
  return { pinned, unpinned };
}

/**
 * How many of the pairs at a floor the detector could not give a direction to.
 *
 * Stated on the surface rather than per row when it is all of them, which is what a slice with
 * few download figures produces.
 */
export function countMirroredPairs(pairs: readonly ConfusablePair[]): number {
  return pairs.filter((pair) => pair.isMirrored).length;
}
