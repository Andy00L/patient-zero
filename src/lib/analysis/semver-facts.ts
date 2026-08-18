import semver from "semver";

import { type Failure, type Result, fail, succeed } from "@/lib/result";

/**
 * Version arithmetic, kept entirely on the TypeScript side.
 *
 * HydraDB's Cypher subset has no min, no max, and compares a property against a
 * literal or a parameter. String comparison is also not version comparison
 * ("1.10.0" sorts before "1.9.0" as text). So every fact that needs version
 * ordering or range membership is computed here at ingest time and written into
 * the graph as explicit edges and integer properties. The query layer then only
 * ever compares integers.
 *
 * The range shape below is the domain form. The OSV wire shape is mapped onto it
 * in src/lib/ingest/osv.ts, so a change in that API cannot reach this file.
 */

/** How versions inside a range are ordered. */
export type RangeKind = "semver" | "ecosystem" | "git";

/**
 * An ordered advisory range event. Semantics, per the OSV schema: events are read
 * in order, `introduced` opens an affected interval, `fixed` closes it exclusive
 * of that version, and `last_affected` closes it inclusive of that version.
 * `introduced: "0"` means "from the first version".
 * sourceRef: https://ossf.github.io/osv-schema/#affectedranges-field
 */
export type RangeEvent =
  | { type: "introduced"; version: string }
  | { type: "fixed"; version: string }
  | { type: "last_affected"; version: string };

export type AffectedRange = {
  kind: RangeKind;
  events: RangeEvent[];
};

/** What an advisory says about one package. */
export type AffectedPackage = {
  ecosystemName: string;
  packageName: string;
  ranges: AffectedRange[];
  /** Explicit affected versions, which some advisories give instead of a range. */
  explicitVersions: string[];
};

/** A half-open affected interval, resolved from the event list. */
export type AffectedInterval = {
  /** Inclusive lower bound. null means "from the beginning". */
  introduced: string | null;
  /** Exclusive upper bound. null means "still affected". */
  fixedExclusive: string | null;
  /** Inclusive upper bound, used when the advisory states last_affected. */
  lastAffectedInclusive: string | null;
};

/**
 * Turns an ordered event list into explicit intervals. Advisories in the wild
 * carry unpaired events (an `introduced` with no `fixed`, or two `introduced` in a
 * row), so this closes the open interval rather than dropping it: an unfixed
 * advisory that reported nothing would understate exposure, which is the one
 * error direction this project must not make.
 */
export function resolveAffectedIntervals(range: AffectedRange): AffectedInterval[] {
  const intervals: AffectedInterval[] = [];
  let open: AffectedInterval | null = null;

  for (const event of range.events) {
    if (event.type === "introduced") {
      if (open !== null) intervals.push(open);
      open = {
        introduced: event.version === "0" ? null : event.version,
        fixedExclusive: null,
        lastAffectedInclusive: null,
      };
      continue;
    }

    // A close event with no open interval means the advisory omitted the
    // `introduced: "0"` event. Treat it as affected from the beginning.
    if (open === null) {
      open = { introduced: null, fixedExclusive: null, lastAffectedInclusive: null };
    }

    if (event.type === "fixed") open.fixedExclusive = event.version;
    else open.lastAffectedInclusive = event.version;

    intervals.push(open);
    open = null;
  }

  if (open !== null) intervals.push(open);
  return intervals;
}

/**
 * Whether a concrete version falls inside an advisory's affected set.
 *
 * Returns a Result rather than a boolean because an unparseable version is not
 * "not affected": it is unknown, and reporting unknown as safe is exactly the
 * false negative the abstention model exists to prevent.
 */
export function isVersionAffected(
  version: string,
  affected: AffectedPackage,
): Result<boolean, Failure> {
  if (affected.explicitVersions.includes(version)) return succeed(true);

  const parsedVersion = semver.parse(version, { loose: true });
  if (parsedVersion === null) {
    // Git ranges are commit based, so a non-semver version cannot be placed in
    // them either. The caller must treat this as unknown, not as safe.
    return fail("unsupported", `[isVersionAffected] cannot parse version "${version}" as semver`);
  }

  for (const range of affected.ranges) {
    if (range.kind === "git") continue; // Commit ranges cannot be answered from a version string.

    for (const interval of resolveAffectedIntervals(range)) {
      const membership = isVersionInInterval(parsedVersion, interval);
      if (!membership.ok) return membership;
      if (membership.value) return succeed(true);
    }
  }

  return succeed(false);
}

function isVersionInInterval(
  parsedVersion: semver.SemVer,
  interval: AffectedInterval,
): Result<boolean, Failure> {
  if (interval.introduced !== null) {
    const introduced = semver.parse(interval.introduced, { loose: true });
    if (introduced === null) {
      return fail(
        "unsupported",
        `[isVersionInInterval] advisory bound "${interval.introduced}" is not semver`,
      );
    }
    if (semver.lt(parsedVersion, introduced)) return succeed(false);
  }

  if (interval.fixedExclusive !== null) {
    const fixed = semver.parse(interval.fixedExclusive, { loose: true });
    if (fixed === null) {
      return fail(
        "unsupported",
        `[isVersionInInterval] advisory bound "${interval.fixedExclusive}" is not semver`,
      );
    }
    if (semver.gte(parsedVersion, fixed)) return succeed(false);
  }

  if (interval.lastAffectedInclusive !== null) {
    const lastAffected = semver.parse(interval.lastAffectedInclusive, { loose: true });
    if (lastAffected === null) {
      return fail(
        "unsupported",
        `[isVersionInInterval] advisory bound "${interval.lastAffectedInclusive}" is not semver`,
      );
    }
    if (semver.gt(parsedVersion, lastAffected)) return succeed(false);
  }

  return succeed(true);
}

/**
 * Partitions a package's known versions into affected and unaffected, keeping the
 * versions that could not be decided in a third bucket. The undecided bucket is
 * what the UI reports as "unknown" rather than folding into "safe".
 */
export function partitionVersionsByAffected(
  versions: readonly string[],
  affected: AffectedPackage,
): { affected: string[]; unaffected: string[]; undecided: string[] } {
  const affectedVersions: string[] = [];
  const unaffectedVersions: string[] = [];
  const undecidedVersions: string[] = [];

  for (const version of versions) {
    const membership = isVersionAffected(version, affected);
    if (!membership.ok) undecidedVersions.push(version);
    else if (membership.value) affectedVersions.push(version);
    else unaffectedVersions.push(version);
  }

  return {
    affected: affectedVersions,
    unaffected: unaffectedVersions,
    undecided: undecidedVersions,
  };
}

/**
 * Orders versions oldest first by semver precedence, not by publish time.
 * Unparseable versions sort last so they never masquerade as the earliest.
 */
export function sortVersionsAscending(versions: readonly string[]): string[] {
  return [...versions].sort((leftVersion, rightVersion) => {
    const left = semver.parse(leftVersion, { loose: true });
    const right = semver.parse(rightVersion, { loose: true });
    if (left === null && right === null) return leftVersion.localeCompare(rightVersion);
    if (left === null) return 1;
    if (right === null) return -1;
    return semver.compare(left, right);
  });
}

/**
 * The "which version introduced the vulnerability" answer: the earliest version by
 * semver precedence inside the advisory's affected set.
 *
 * Precedence, not publish order, is the right choice here: a maintainer can
 * backport and publish 1.2.9 after 1.3.0, and the question the track asks is
 * which version first carried the defect in the version line.
 */
export function findEarliestAffectedVersion(
  versions: readonly string[],
  affected: AffectedPackage,
): Result<string, Failure> {
  const partitioned = partitionVersionsByAffected(versions, affected);
  const earliest = sortVersionsAscending(partitioned.affected)[0];

  if (earliest === undefined) {
    if (partitioned.undecided.length > 0) {
      return fail(
        "unsupported",
        `[findEarliestAffectedVersion] no affected version could be decided from ${partitioned.undecided.length} unparseable versions`,
      );
    }
    return fail(
      "not_found",
      `[findEarliestAffectedVersion] none of the ${versions.length} known versions fall in the advisory range`,
    );
  }

  return succeed(earliest);
}

/**
 * Whether a declared range could resolve to a given version. Used only to explain
 * a dependency edge in the UI; the resolution edges themselves come from deps.dev,
 * so this never decides what is in the graph.
 *
 * `includePrerelease` is on because a lockfile can legitimately pin a prerelease,
 * and the default semver behaviour would report that pin as not satisfying its own
 * declared range.
 */
export function couldRangeResolveToVersion(range: string, version: string): boolean {
  return semver.satisfies(version, range, { loose: true, includePrerelease: true });
}
