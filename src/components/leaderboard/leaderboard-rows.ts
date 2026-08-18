import { weakestCoverage } from "@/lib/analysis/abstention";
import type { MaintainerSurface } from "@/lib/analysis/maintainer-surface";
import { formatCount, UNKNOWN_READING } from "@/lib/format";
import type { Coverage, SliceCoverage } from "@/lib/graph/slice-manifest";

/**
 * What a leaderboard row says, decided once for the table and the panel below it.
 *
 * The ranking arrives already ordered from `rankMaintainerSurfaces`, so nothing here sorts,
 * scores, or combines. What it does decide is which of a row's numbers may be printed as a
 * number at all, and that decision is the whole difference between a leaderboard and a claim.
 *
 * Two rules, both of them about a zero:
 *
 *   - No service found under partial coverage is not "this account reaches nothing". It is
 *     "nothing was found in the part of the registry this slice holds". A row in that state
 *     reads unknown, because a printed 0 in a reach column is the exact false negative this
 *     product exists to avoid.
 *   - A download sum over packages that all reported nothing is not 0 downloads. The graph
 *     stores an unreported count as a sentinel and the ranking excludes it from the sum, so a
 *     row whose every package is unreported has no sum to print.
 *
 * The row's own coverage follows the rule the ranking module already applies to the same fact,
 * so a row cannot claim to be better covered than the verdict computed from it.
 * sourceRef: describeAccountCoverage in src/lib/analysis/maintainer-surface.ts.
 */

export type LeaderboardRow = {
  /** Position in the ranking the library returned, 1 based. Never recomputed here. */
  rank: number;
  /** The ranked account, verbatim, so the panel can read the parts the table has no room for. */
  surface: MaintainerSurface;
  /** How completely this account's packages are represented in the slice. */
  coverage: Coverage;
  /** That coverage as the words the row prints: what its numbers are worth. */
  basisReading: string;
  /** Services reached, or the absent reading when a zero here would not be a finding. */
  serviceReading: string;
  /** False when `serviceReading` is the absent reading, so a caller can dim the cell. */
  isServiceReachKnown: boolean;
  /** Weekly downloads across the account's own packages, or the absent reading. */
  downloadReading: string;
  /** False when `downloadReading` is the absent reading, so a caller can dim the cell. */
  isDownloadSumKnown: boolean;
  /** True when the sum covers only some of the account's packages, which the panel states. */
  isDownloadSumPartial: boolean;
};

export type LeaderboardRowsRequest = {
  /** The ranked rows, in the library's order. */
  rows: readonly MaintainerSurface[];
  coverage: SliceCoverage;
};

/**
 * How completely one account's publish rights are covered by the slice.
 *
 * An account with no ingested package is partial rather than absent: their packages were not
 * ingested, which is not the same as having none. Collapsing absent into partial is the
 * ranking module's own rule, repeated rather than reinvented so the row and the verdict agree.
 */
export function describeRowCoverage(
  coverage: SliceCoverage,
  surface: MaintainerSurface,
): Coverage {
  const packages = surface.direct.packages;
  if (packages.length === 0) return "partial";

  const packageKeys = packages.map((entry) => entry.packageKey);
  return weakestCoverage(coverage, packageKeys) === "closed" ? "closed" : "partial";
}

/** What this row's numbers are worth, in the two or three words a column has room for. */
export function describeBasis(coverage: Coverage): string {
  switch (coverage) {
    case "closed":
      return "measured";
    case "partial":
      return "lower bound";
    case "absent":
      return "no claim";
  }
}

export function describeLeaderboardRows(request: LeaderboardRowsRequest): LeaderboardRow[] {
  return request.rows.map((surface, index) => {
    const coverage = describeRowCoverage(request.coverage, surface);
    const direct = surface.direct;

    const serviceCount = direct.reachedServices.length;
    const isServiceReachKnown = serviceCount > 0 || coverage === "closed";

    // At least one package has to have reported for the sum to mean anything. Zero packages
    // lands here too, which is correct: an account with no ingested package has no sum.
    const isDownloadSumKnown = direct.packages.length > direct.packagesWithoutDownloadCount;

    return {
      rank: index + 1,
      surface,
      coverage,
      basisReading: describeBasis(coverage),
      serviceReading: isServiceReachKnown ? formatCount(serviceCount) : UNKNOWN_READING,
      isServiceReachKnown,
      downloadReading: isDownloadSumKnown
        ? formatCount(direct.reachableWeeklyDownloads)
        : UNKNOWN_READING,
      isDownloadSumKnown,
      isDownloadSumPartial: isDownloadSumKnown && direct.packagesWithoutDownloadCount > 0,
    };
  });
}

/**
 * The row a reader is looking at.
 *
 * A key that names no ranked row falls back to the worst-ranked account rather than to an
 * error: a mistyped or stale link still shows the finding the surface is about, and the table
 * marks the row it opened so the surface stays self-consistent.
 * sourceRef: the same fallback for an unrecognised incident slug in src/app/page.tsx.
 */
export function selectRow(
  rows: readonly LeaderboardRow[],
  requestedKey: string | null,
): LeaderboardRow | null {
  if (rows.length === 0) return null;
  if (requestedKey === null) return rows[0] ?? null;
  return rows.find((row) => row.surface.subject.maintainerKey === requestedKey) ?? rows[0] ?? null;
}
