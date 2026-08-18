import type { AnswerLimit } from "@/lib/analysis/abstention";
import type { Ecosystem } from "@/lib/graph/model";
import { normalizePypiName } from "@/lib/ingest/pypi";
import { type Failure, type Result, fail, succeed } from "@/lib/result";

/**
 * Typosquat detection: is this package name imitating a popular one, and on what evidence.
 *
 * Pure and I/O free by construction. The input is a candidate name plus the popular names
 * of the same registry with their weekly download figures; the output is labelled
 * evidence. Both callers already hold that data: the ingest path scores names while it
 * builds a slice and turns findings into TYPOSQUAT_OF edges, and the API layer scores a
 * name the user typed. Neither wants this module to own a network client or a graph
 * handle, so it owns neither.
 *
 * Why signals instead of one number: "0.87 suspicious" is unreadable and unarguable.
 * Every detector contributes a named signal carrying what it actually found (the
 * distance, the two canonical forms, the padding token), and the confidence is derived
 * from which signals fired, never from arithmetic on a float. A reader can check it.
 *
 * Registry identity is the detail that decides correctness:
 *
 *   PyPI  normalises names per PEP 503, so "Foo.Bar", "foo-bar" and "foo_bar" are the
 *         SAME project. Reporting one as a squat of another would be a false positive
 *         against the specification itself.
 *   npm   names are case and separator sensitive, so "node-fetch", "node_fetch" and
 *         "NodeFetch" are three different packages, and a name that collapses onto a
 *         popular one there is the strongest spelling signal in this file.
 *
 * Untrusted input: a candidate name can arrive from a pasted lockfile. Nothing here
 * executes, fetches or reads a path; every intermediate lands in a Map or a Set rather
 * than an object literal keyed by an untrusted string; and the work per popular name is
 * bounded by a length gate and precomputed lookups, so a crafted name cannot make a
 * 10,000 name scan expensive.
 */

// ---------------------------------------------------------------------------
// Limits, defaults and the vocabularies the detectors use
// ---------------------------------------------------------------------------

/**
 * Weekly downloads are not known. Same convention, and same value, as the graph property
 * that stores them, so a figure read from the graph can be passed straight through.
 * sourceRef: PackageNode.weekly_downloads in src/lib/graph/model.ts ("-1 when the
 * registry had none").
 */
export const UNKNOWN_WEEKLY_DOWNLOADS = -1;

/**
 * The pair matched on a signal other than distance and sits farther apart than the
 * configured ceiling, so no distance was measured. Written to the TYPOSQUAT_OF edge as
 * is, following the same "-1 means not known" convention as the node properties.
 */
export const UNMEASURED_EDIT_DISTANCE = -1;

/**
 * Longest name this module scores, in characters. npm rejects a name over 214 and PEP 508
 * states no maximum, so the npm number is applied to both registries.
 * sourceRef: https://github.com/npm/validate-npm-package-name ("cannot exceed 214"), and
 * the sibling constant MAX_PACKAGE_NAME_LENGTH in src/lib/scanner/lockfile.ts.
 *
 * Note this module deliberately does not reuse validatePackageName from that file: it
 * enforces each registry's published grammar, which would reject the exact malformed
 * spellings a squat detector has to be able to score ("@types-foo" is not a legal npm
 * name, and is precisely the kind of name that gets published to fool a reader).
 */
export const MAX_SCORED_NAME_LENGTH = 214;

/**
 * Default edit distance ceiling, in single character edits or transpositions.
 *
 * Two covers every documented campaign this project replays: one deletion for "crossenv"
 * against "cross-env" (npm, 2017), one insertion for "colourama" against "colorama"
 * (PyPI, 2018), one transposition for "axois" against "axios". Three starts pairing
 * unrelated short names, where two edits already reach across ("chalk" and "check" are
 * two apart), so the extra reach buys noise rather than recall.
 */
export const DEFAULT_MAX_EDIT_DISTANCE = 2;

/** Ceiling on the configurable distance. Past four edits a name is a different word. */
export const MAX_ALLOWED_EDIT_DISTANCE = 4;

/**
 * Default popularity ratio: the target must have at least 50 times the candidate's weekly
 * downloads to count as the thing being imitated.
 *
 * A squat lives off the target's traffic, so the gap is the point. Legitimate siblings sit
 * within an order of magnitude of each other ("react-router-dom" against "react-dom",
 * "cross-fetch" against "node-fetch") and are rejected by this ratio, while a freshly
 * published squat with a few hundred installs clears it against any real target.
 */
export const DEFAULT_MIN_POPULARITY_RATIO = 50;

/** Default findings returned. The panel shows the strongest few; matchedCount reports the rest. */
export const DEFAULT_MAX_FINDINGS = 10;

/**
 * Default ceiling on popular names compared in one scan. 10,000 is the size of the npm
 * download leaderboard this project ingests, and each comparison is a handful of passes
 * over a name of at most 214 characters, so a full scan stays well inside a millisecond
 * budget. Reaching the ceiling is reported as a scan_capped limit, never dropped in silence.
 */
export const DEFAULT_MAX_COMPARED_NAMES = 10_000;

/** Shortest form a padding variant may collapse to. Below this, everything looks alike. */
const MIN_VARIANT_LENGTH = 2;

/**
 * Segment tokens that carry no meaning of their own in a package name, which is what
 * makes "lodash-js" a copy of "lodash" rather than a different library. Drawn from the
 * names npm removed in the August 2017 hacktask campaign ("d3.js", "mssql-node",
 * "jquery.js") and from the PyPI removals of December 2019 ("python3-dateutil").
 */
const PADDING_SEGMENT_TOKENS: readonly string[] = [
  "js",
  "cjs",
  "esm",
  "es",
  "ts",
  "node",
  "nodejs",
  "npm",
  "py",
  "python",
  "python2",
  "python3",
  "lib",
  "libs",
  "core",
  "cli",
  "io",
  "dev",
  "git",
  "pkg",
  "package",
  "sdk",
  "api",
  "2",
  "3",
  "4",
  "x",
];

/**
 * Tokens a squat glues on with no separator at all: "react-doms", "nodefetch2",
 * "lodashjs", "python3-dateutil". Kept short on purpose, because stripping a long glued
 * token from a name invents a second name rather than recovering the imitated one.
 */
const GLUED_PADDING_TOKENS: readonly string[] = ["s", "2", "3", "js", "ts", "io", "lib", "cli", "node", "py"];

/**
 * Scopes whose presence is a convention rather than an imitation. "@types/express" is the
 * DefinitelyTyped package for "express", published by that project, and reporting it as a
 * squat of "express" would be the loudest false positive this module could produce. The
 * reverse direction stays detected: an unscoped name that folds a scope into itself
 * ("types-express") is still scored.
 * sourceRef: https://github.com/DefinitelyTyped/DefinitelyTyped ("@types" scope).
 */
const CONVENTIONAL_SCOPES: readonly string[] = ["types"];

/**
 * Multi-character confusables, applied before the single character map because they are
 * what the eye actually loses: "rn" reads as "m" and "vv" reads as "w" in a proportional
 * font, which is how "rnoment" passes for "moment" in a diff.
 */
const CONFUSABLE_SEQUENCES: readonly { written: string; canonical: string }[] = [
  { written: "rn", canonical: "m" },
  { written: "vv", canonical: "w" },
];

/**
 * Single character confusables, ASCII only on purpose. npm requires a URL safe name and
 * PEP 508 restricts a project name to ASCII letters, digits, ".", "-" and "_", so a
 * Unicode homoglyph cannot be published to either registry and a Unicode confusable table
 * would be dead weight here.
 *
 * The classes are the ones real campaigns used: PyPI removed "jeIlyfish" in December 2019,
 * which is "jellyfish" with a capital I in place of a lowercase l.
 * sourceRef: https://pypi.org/security/advisories/ and the PyPI removal notice for
 * jeIlyfish and python3-dateutil.
 */
const CONFUSABLE_CHARACTERS: ReadonlyMap<string, string> = new Map([
  ["1", "l"],
  ["i", "l"],
  ["0", "o"],
  ["5", "s"],
]);

/** Characters that separate segments of a package name in both registries. */
const SEGMENT_SEPARATORS: readonly string[] = ["-", "_", "."];

/** Everything that is not a lowercase letter or a digit, for the flattened comparison form. */
const NON_ALPHANUMERIC = /[^a-z0-9]/g;

/** The same, case preserving, so a comparison can isolate a case difference. */
const NON_ALPHANUMERIC_ANY_CASE = /[^A-Za-z0-9]/g;

/**
 * Signal order in a finding: how hard the signal is to explain away, hardest first. The
 * UI reads the first entry aloud, so this order decides what a judge sees.
 */
const SIGNAL_RANK: ReadonlyMap<TyposquatSignal["kind"], number> = new Map([
  ["homoglyph", 0],
  ["separator_or_case", 1],
  ["scope_confusion", 2],
  ["edit_distance", 3],
  ["padding", 4],
  ["popularity_gap", 5],
]);

const CONFIDENCE_RANK: ReadonlyMap<TyposquatConfidence, number> = new Map([
  ["high", 0],
  ["medium", 1],
  ["low", 2],
]);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** How much of the evidence is hard to explain away. See deriveConfidence for the rule. */
export type TyposquatConfidence = "high" | "medium" | "low";

/** A package name with the popularity figure the graph stores for it. */
export type ComparablePackage = {
  ecosystem: Ecosystem;
  name: string;
  /**
   * Downloads in the last 7 days. Omit it, or pass UNKNOWN_WEEKLY_DOWNLOADS, when the
   * registry publishes none: the PyPI JSON API does not carry download counts.
   */
  weeklyDownloads?: number;
};

/** One confusable rule that fired, and how often, in one name. */
export type ConfusableSubstitution = {
  /** The character or pair as written in the name, such as "rn" or "1". */
  written: string;
  /** What it collapses to in the canonical form, such as "m" or "l". */
  canonical: string;
  occurrences: number;
};

/** Where the extra token sits relative to the imitated name. */
export type PaddingPosition = "prefix" | "infix" | "suffix";

/**
 * How the two names disagree about scoping. All four are npm only: PyPI has no scopes,
 * and a PEP 508 project name cannot contain "@" or "/".
 */
export type ScopeConfusionVariety =
  /** The suspect is scoped, the target is not, and the unscoped halves match: "@evil/lodash" against "lodash". */
  | "scope_added"
  /** The suspect is unscoped and equals the target's unscoped half: "core" against "@babel/core". */
  | "scope_dropped"
  /** Both are scoped with the same unscoped half: "@evil/core" against "@babel/core". */
  | "scope_swapped"
  /** One side folded the scope into the name: "types-node" or "@types-node" against "@types/node". */
  | "scope_flattened";

/** One detector's finding, carrying the evidence it actually saw. */
export type TyposquatSignal =
  | {
      kind: "edit_distance";
      /** Damerau-Levenshtein distance, transposition aware, measured on the identity forms. */
      distance: number;
      /** Plain Levenshtein over the same pair, which scores a transposition as two edits. */
      plainDistance: number;
      /** True when a transposition is what makes the pair one edit apart. */
      includesTransposition: boolean;
      suspectForm: string;
      targetForm: string;
    }
  | {
      kind: "scope_confusion";
      variety: ScopeConfusionVariety;
      /** Scope without the "@", or null when that side is unscoped. */
      suspectScope: string | null;
      targetScope: string | null;
      /** The part both names share once the scoping disagreement is removed. */
      sharedName: string;
    }
  | {
      kind: "separator_or_case";
      /** Both names with case and every separator removed. Equal, which is why this fired. */
      flattenedForm: string;
      /** True when the two names disagree about letter case somewhere. */
      caseDiffers: boolean;
      /** True when they disagree about separators. Both can be true at once. */
      separatorsDiffer: boolean;
    }
  | {
      kind: "homoglyph";
      /** The form both names collapse to once confusables are canonicalised. */
      canonicalForm: string;
      suspectSubstitutions: ConfusableSubstitution[];
      targetSubstitutions: ConfusableSubstitution[];
    }
  | {
      kind: "padding";
      position: PaddingPosition;
      /** The token the suspect carries and the target does not, such as "js" or "native". */
      token: string;
      /** True when the token is a known meaningless filler rather than an unknown word. */
      isKnownPaddingToken: boolean;
      /** The suspect with the token removed. Equal to the target's identity form. */
      strippedForm: string;
    }
  | {
      kind: "popularity_gap";
      suspectWeeklyDownloads: number;
      targetWeeklyDownloads: number;
      /** Target downloads divided by the suspect's, floored at one to avoid dividing by zero. */
      ratio: number;
    };

/** One popular package a candidate name appears to imitate, and why. */
export type TyposquatFinding = {
  suspect: {
    ecosystem: Ecosystem;
    /** Identity form: the name as published on npm, PEP 503 normalised on PyPI. What the graph keys on. */
    name: string;
    /** The name exactly as it was handed in, for the UI to echo back. */
    providedName: string;
  };
  target: {
    ecosystem: Ecosystem;
    name: string;
    providedName: string;
    weeklyDownloads: number;
  };
  /** Ordered hardest to explain away first. Never empty. */
  signals: TyposquatSignal[];
  confidence: TyposquatConfidence;
  /** Damerau-Levenshtein distance, or UNMEASURED_EDIT_DISTANCE when beyond the ceiling. */
  editDistance: number;
};

export type TyposquatOptions = {
  /** Edit distance ceiling, 0 to MAX_ALLOWED_EDIT_DISTANCE. Defaults to DEFAULT_MAX_EDIT_DISTANCE. */
  maxEditDistance?: number;
  /** How many times more popular the target must be. At least 1. Defaults to DEFAULT_MIN_POPULARITY_RATIO. */
  minPopularityRatio?: number;
  /** Findings returned after ranking. At least 1. Defaults to DEFAULT_MAX_FINDINGS. */
  maxFindings?: number;
  /** Popular names compared before the scan stops. At least 1. Defaults to DEFAULT_MAX_COMPARED_NAMES. */
  maxComparedNames?: number;
};

/** A whole scan, with the counts that make an empty finding list readable. */
export type TyposquatScan = {
  suspect: { ecosystem: Ecosystem; name: string };
  /** Ranked, then capped at maxFindings. */
  findings: TyposquatFinding[];
  /** Popular names actually compared, after the ecosystem filter and the compare cap. */
  comparedCount: number;
  /** Pairs that produced at least one signal, before the findings cap. */
  matchedCount: number;
  /** Entries skipped because they belong to the other registry. A port is not a squat. */
  otherEcosystemCount: number;
  /** Entries skipped because their name was empty or longer than MAX_SCORED_NAME_LENGTH. */
  unusableTargetCount: number;
  /**
   * Truncation, in the shared abstention vocabulary so the caller can hand it straight to
   * decideVerdict. Empty means the scan compared every name it was given, which still does
   * not mean the name is clean: it means nothing in the supplied list matched.
   */
  limits: AnswerLimit[];
};

/**
 * Structurally identical to TyposquatFacts in src/lib/ingest/graph-builder.ts, so a
 * finding assigns to an ingest slice with no adapter. Declared here rather than imported
 * to keep this module clear of the ingest and writer layers.
 */
export type TyposquatEdgeFacts = {
  suspect: { ecosystem: Ecosystem; name: string; version: string };
  target: { ecosystem: Ecosystem; name: string };
  editDistance: number;
};

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Scores one candidate name against a list of popular names and returns the findings.
 *
 * A Failure means the request itself was unusable (an empty name, a name past the 214
 * character cap, an option outside its range). Finding nothing is a success carrying an
 * empty array: absence of a match is a result, not an error.
 */
export function findTyposquats(
  candidate: ComparablePackage,
  popular: readonly ComparablePackage[],
  options?: TyposquatOptions,
): Result<TyposquatFinding[], Failure> {
  const scan = scanForTyposquats(candidate, popular, options);
  return scan.ok ? succeed(scan.value.findings) : scan;
}

/**
 * The same scan with its bookkeeping: how many names were compared, how many matched
 * before the findings cap, and what was truncated.
 *
 * The counts exist because an empty finding list is ambiguous on its own. "We compared
 * 10,000 names and none matched" and "we compared the 3 names you gave us" are different
 * claims, and the typosquat panel has to make the honest one.
 */
export function scanForTyposquats(
  candidate: ComparablePackage,
  popular: readonly ComparablePackage[],
  options?: TyposquatOptions,
): Result<TyposquatScan, Failure> {
  const settings = resolveOptions(options);
  if (!settings.ok) return settings;

  const profile = buildCandidateProfile(candidate);
  if (!profile.ok) return profile;

  const { maxEditDistance, minPopularityRatio, maxFindings, maxComparedNames } = settings.value;
  const matches: TyposquatFinding[] = [];
  let comparedCount = 0;
  let otherEcosystemCount = 0;
  let unusableTargetCount = 0;
  let compareCapReached = false;

  for (const target of popular) {
    if (target.ecosystem !== candidate.ecosystem) {
      otherEcosystemCount += 1;
      continue;
    }

    const targetName = target.name.trim();
    if (targetName.length === 0 || targetName.length > MAX_SCORED_NAME_LENGTH) {
      unusableTargetCount += 1;
      continue;
    }

    if (comparedCount >= maxComparedNames) {
      compareCapReached = true;
      break;
    }
    comparedCount += 1;

    const finding = compareWithTarget(profile.value, {
      ecosystem: target.ecosystem,
      name: targetName,
      weeklyDownloads: target.weeklyDownloads ?? UNKNOWN_WEEKLY_DOWNLOADS,
      maxEditDistance,
      minPopularityRatio,
    });
    if (finding !== null) matches.push(finding);
  }

  matches.sort(compareFindings);

  const limits: AnswerLimit[] = [];
  if (compareCapReached) {
    limits.push({ kind: "scan_capped", examined: comparedCount, total: popular.length });
  }

  return succeed({
    suspect: { ecosystem: profile.value.ecosystem, name: profile.value.identity },
    findings: matches.slice(0, maxFindings),
    comparedCount,
    matchedCount: matches.length,
    otherEcosystemCount,
    unusableTargetCount,
    limits,
  });
}

/**
 * Turns a finding into the shape the graph writer stages. The version comes from the
 * caller because a name has many versions and this module scores names, not releases.
 */
export function toTyposquatEdgeFacts(
  finding: TyposquatFinding,
  suspectVersion: string,
): TyposquatEdgeFacts {
  return {
    suspect: {
      ecosystem: finding.suspect.ecosystem,
      name: finding.suspect.name,
      version: suspectVersion,
    },
    target: { ecosystem: finding.target.ecosystem, name: finding.target.name },
    editDistance: finding.editDistance,
  };
}

// ---------------------------------------------------------------------------
// Identity: the rule that decides whether two names can be squats at all
// ---------------------------------------------------------------------------

/**
 * The form a registry treats as the package's identity, and the form the graph keys on.
 *
 * PyPI names go through PEP 503 normalisation, reusing the ingest layer's single
 * implementation of it. npm names are used as published, because npm treats case and
 * separators as part of the name.
 */
export function toEcosystemIdentity(ecosystem: Ecosystem, name: string): string {
  const trimmed = name.trim();
  return ecosystem === "pypi" ? normalizePypiName(trimmed) : trimmed;
}

/**
 * Whether two names are the same package rather than two packages.
 *
 * This is the guard behind the zero false positive rule: a package is never reported as a
 * squat of itself, and on PyPI two spellings that normalise alike are one project, so
 * "Zope.Interface" and "zope-interface" cannot squat each other. On npm the same pair is
 * two different packages and is scored.
 */
export function areSamePackage(ecosystem: Ecosystem, leftName: string, rightName: string): boolean {
  return toEcosystemIdentity(ecosystem, leftName) === toEcosystemIdentity(ecosystem, rightName);
}

/** Case and every separator removed, so "node-fetch", "node_fetch" and "NodeFetch" agree. */
export function flattenPackageName(name: string): string {
  return name.toLowerCase().replace(NON_ALPHANUMERIC, "");
}

/** The scope and the rest, for an npm name. PyPI has no scopes, so the scope is null there. */
export function readPackageScope(
  ecosystem: Ecosystem,
  identity: string,
): { scope: string | null; unscopedName: string } {
  if (ecosystem !== "npm" || !identity.startsWith("@")) {
    return { scope: null, unscopedName: identity };
  }
  const slashIndex = identity.indexOf("/");
  // A leading "@" with no slash is not a scope, it is a name npm would refuse. Score it as
  // an unscoped name so the scope-flattening detector can still see it.
  if (slashIndex <= 1 || slashIndex === identity.length - 1) {
    return { scope: null, unscopedName: identity };
  }
  return { scope: identity.slice(1, slashIndex), unscopedName: identity.slice(slashIndex + 1) };
}

// ---------------------------------------------------------------------------
// Confusables
// ---------------------------------------------------------------------------

export type ConfusableForm = {
  /** The name with every confusable collapsed onto one representative character. */
  canonical: string;
  /** Which rules fired, and how often. Empty means the name carries no confusable. */
  substitutions: ConfusableSubstitution[];
};

/**
 * Collapses a name onto its confusable canonical form in one left to right pass.
 *
 * Sequences are tried before single characters so "rn" becomes "m" instead of "rl". Case
 * is folded first, which is what makes a capital I and a lowercase l land on the same
 * character, the substitution PyPI removed "jeIlyfish" for.
 */
export function readConfusableForm(name: string): ConfusableForm {
  const lowered = name.toLowerCase();
  const canonicalCharacters: string[] = [];
  const counts = new Map<string, ConfusableSubstitution>();

  let position = 0;
  while (position < lowered.length) {
    const sequence = CONFUSABLE_SEQUENCES.find((rule) => lowered.startsWith(rule.written, position));
    if (sequence !== undefined) {
      canonicalCharacters.push(sequence.canonical);
      countSubstitution(counts, sequence.written, sequence.canonical);
      position += sequence.written.length;
      continue;
    }

    const character = lowered[position];
    const replacement = CONFUSABLE_CHARACTERS.get(character);
    if (replacement !== undefined) {
      canonicalCharacters.push(replacement);
      countSubstitution(counts, character, replacement);
    } else {
      canonicalCharacters.push(character);
    }
    position += 1;
  }

  return { canonical: canonicalCharacters.join(""), substitutions: [...counts.values()] };
}

function countSubstitution(
  counts: Map<string, ConfusableSubstitution>,
  written: string,
  canonical: string,
): void {
  const existing = counts.get(written);
  if (existing === undefined) {
    counts.set(written, { written, canonical, occurrences: 1 });
    return;
  }
  existing.occurrences += 1;
}

// ---------------------------------------------------------------------------
// Bounded Damerau-Levenshtein
// ---------------------------------------------------------------------------

/**
 * Damerau-Levenshtein distance, returned only when it is within maxDistance, null when it
 * is farther. Callers use the null to skip a pair for the price of a length check.
 *
 * Transposition awareness is the reason this is not plain Levenshtein: "axois" is one
 * transposition from "axios", which plain Levenshtein scores as 2, and 2 is the threshold
 * where unrelated names start pairing. Losing the transposition means losing the single
 * strongest real world signal.
 *
 * This is the restricted variant, also called optimal string alignment: no substring is
 * edited more than once. The unrestricted variant differs only on inputs needing three or
 * more edits with overlapping transpositions ("ca" to "abc"), which sit outside the
 * ceiling this module allows anyway.
 */
export function measureEditDistanceWithin(
  left: string,
  right: string,
  maxDistance: number,
): number | null {
  return runBoundedEditDistance(left, right, maxDistance, true);
}

/**
 * Plain Levenshtein over the same bound, used to state in the evidence what a
 * transposition-blind matcher would have scored.
 */
export function measureLevenshteinWithin(
  left: string,
  right: string,
  maxDistance: number,
): number | null {
  return runBoundedEditDistance(left, right, maxDistance, false);
}

/**
 * One banded dynamic program serving both distances.
 *
 * Two bounds keep a 10,000 name scan cheap. The length difference alone is a lower bound
 * on the distance, so a pair that differs by more than maxDistance characters is rejected
 * before any allocation. Inside the loop only the diagonal band of width 2 * maxDistance
 * plus 1 can hold a value within the bound, and a row whose whole band already exceeds the
 * bound can never recover, so the walk stops there.
 */
function runBoundedEditDistance(
  left: string,
  right: string,
  maxDistance: number,
  allowTransposition: boolean,
): number | null {
  if (maxDistance < 0) return null;
  if (left === right) return 0;

  const leftLength = left.length;
  const rightLength = right.length;
  if (Math.abs(leftLength - rightLength) > maxDistance) return null;
  if (leftLength === 0) return rightLength <= maxDistance ? rightLength : null;
  if (rightLength === 0) return leftLength <= maxDistance ? leftLength : null;

  // Any value above the bound is equivalent for the decision, so one sentinel stands in
  // for "unreachable within the bound" and keeps every cell a plain number.
  const beyondBound = maxDistance + 1;
  let twoRowsAbove: number[] = new Array<number>(rightLength + 1).fill(beyondBound);
  let oneRowAbove: number[] = new Array<number>(rightLength + 1).fill(beyondBound);
  let currentRow: number[] = new Array<number>(rightLength + 1).fill(beyondBound);

  for (let column = 0; column <= rightLength; column += 1) oneRowAbove[column] = column;

  for (let row = 1; row <= leftLength; row += 1) {
    const firstColumn = Math.max(1, row - maxDistance);
    const lastColumn = Math.min(rightLength, row + maxDistance);

    currentRow[0] = row;
    if (firstColumn > 1) currentRow[firstColumn - 1] = beyondBound;

    let bestInRow = beyondBound;
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      const substitutionCost = left[row - 1] === right[column - 1] ? 0 : 1;
      let best = Math.min(
        oneRowAbove[column] + 1, // deletion from left
        currentRow[column - 1] + 1, // insertion into left
        oneRowAbove[column - 1] + substitutionCost,
      );

      if (
        allowTransposition &&
        row > 1 &&
        column > 1 &&
        left[row - 1] === right[column - 2] &&
        left[row - 2] === right[column - 1]
      ) {
        best = Math.min(best, twoRowsAbove[column - 2] + 1);
      }

      currentRow[column] = best;
      if (best < bestInRow) bestInRow = best;
    }

    if (lastColumn < rightLength) currentRow[lastColumn + 1] = beyondBound;
    if (bestInRow > maxDistance) return null;

    const recycled = twoRowsAbove;
    twoRowsAbove = oneRowAbove;
    oneRowAbove = currentRow;
    currentRow = recycled;
  }

  const distance = oneRowAbove[rightLength];
  return distance <= maxDistance ? distance : null;
}

// ---------------------------------------------------------------------------
// The candidate profile: every form precomputed once, so a target costs O(name length)
// ---------------------------------------------------------------------------

type PaddingVariant = {
  position: PaddingPosition;
  token: string;
  isKnownPaddingToken: boolean;
  /** The suspect with the token removed, in its original case. */
  strippedForm: string;
};

type CandidateProfile = {
  ecosystem: Ecosystem;
  providedName: string;
  identity: string;
  loweredIdentity: string;
  flattened: string;
  confusable: ConfusableForm;
  scope: string | null;
  unscopedName: string;
  weeklyDownloads: number;
  /** Keyed by the lowercased variant, because npm case differences are reported separately. */
  paddingVariants: ReadonlyMap<string, PaddingVariant>;
};

function buildCandidateProfile(candidate: ComparablePackage): Result<CandidateProfile, Failure> {
  const providedName = candidate.name.trim();
  if (providedName.length === 0) {
    return fail("invalid_input", "[buildCandidateProfile] empty package name");
  }
  if (providedName.length > MAX_SCORED_NAME_LENGTH) {
    return fail(
      "invalid_input",
      `[buildCandidateProfile] name of ${providedName.length} characters exceeds ${MAX_SCORED_NAME_LENGTH}`,
    );
  }

  const identity = toEcosystemIdentity(candidate.ecosystem, providedName);
  const { scope, unscopedName } = readPackageScope(candidate.ecosystem, identity);

  return succeed({
    ecosystem: candidate.ecosystem,
    providedName,
    identity,
    loweredIdentity: identity.toLowerCase(),
    flattened: flattenPackageName(identity),
    confusable: readConfusableForm(identity),
    scope,
    unscopedName,
    weeklyDownloads: candidate.weeklyDownloads ?? UNKNOWN_WEEKLY_DOWNLOADS,
    paddingVariants: buildPaddingVariants(identity, scope, unscopedName),
  });
}

type ResolvedOptions = {
  maxEditDistance: number;
  minPopularityRatio: number;
  maxFindings: number;
  maxComparedNames: number;
};

function resolveOptions(options: TyposquatOptions | undefined): Result<ResolvedOptions, Failure> {
  const maxEditDistance = options?.maxEditDistance ?? DEFAULT_MAX_EDIT_DISTANCE;
  const minPopularityRatio = options?.minPopularityRatio ?? DEFAULT_MIN_POPULARITY_RATIO;
  const maxFindings = options?.maxFindings ?? DEFAULT_MAX_FINDINGS;
  const maxComparedNames = options?.maxComparedNames ?? DEFAULT_MAX_COMPARED_NAMES;

  if (!Number.isInteger(maxEditDistance) || maxEditDistance < 0 || maxEditDistance > MAX_ALLOWED_EDIT_DISTANCE) {
    return fail(
      "invalid_input",
      `[resolveOptions] maxEditDistance must be an integer from 0 to ${MAX_ALLOWED_EDIT_DISTANCE}, received ${maxEditDistance}`,
    );
  }
  // A ratio below 1 would ask for a target less popular than the suspect, which inverts
  // the model: the thing being imitated is the popular one.
  if (!Number.isFinite(minPopularityRatio) || minPopularityRatio < 1) {
    return fail(
      "invalid_input",
      `[resolveOptions] minPopularityRatio must be at least 1, received ${minPopularityRatio}`,
    );
  }
  if (!Number.isInteger(maxFindings) || maxFindings < 1) {
    return fail("invalid_input", `[resolveOptions] maxFindings must be at least 1, received ${maxFindings}`);
  }
  if (!Number.isInteger(maxComparedNames) || maxComparedNames < 1) {
    return fail(
      "invalid_input",
      `[resolveOptions] maxComparedNames must be at least 1, received ${maxComparedNames}`,
    );
  }

  return succeed({ maxEditDistance, minPopularityRatio, maxFindings, maxComparedNames });
}

type NameSegment = { text: string; start: number; end: number };

/** Segments of a name with their positions, so a variant can be cut from the original string. */
function splitNameSegments(name: string): NameSegment[] {
  const segments: NameSegment[] = [];
  let start = 0;
  for (let index = 0; index <= name.length; index += 1) {
    const atEnd = index === name.length;
    if (!atEnd && !SEGMENT_SEPARATORS.includes(name[index])) continue;
    if (index > start) segments.push({ text: name.slice(start, index), start, end: index });
    start = index + 1;
  }
  return segments;
}

/**
 * Every name the candidate becomes once one padding token is removed, keyed by the
 * lowercased result.
 *
 * Precomputing the variants is what keeps the scan linear: the padding check against a
 * popular name is one Map lookup instead of a token loop per pair. Three removals are
 * generated, and they cover prefix, infix and suffix in one mechanism:
 *
 *   a whole segment with its separator   "electron-native-notify" to "electron-notify"
 *   a token glued to a segment's end     "react-doms" to "react-dom", "python3-" to "python-"
 *   a token glued to the first segment    "nodefetch" to "fetch"
 *
 * The removed segment may be a word this module does not know ("native"), which is why the
 * signal carries isKnownPaddingToken: an unknown token is weaker evidence than "-js".
 */
function buildPaddingVariants(
  identity: string,
  scope: string | null,
  unscopedName: string,
): ReadonlyMap<string, PaddingVariant> {
  const variants = new Map<string, PaddingVariant>();
  const scopePrefix = scope === null ? "" : `@${scope}/`;
  const segments = splitNameSegments(unscopedName);

  const register = (strippedUnscoped: string, variant: Omit<PaddingVariant, "strippedForm">): void => {
    if (strippedUnscoped.length < MIN_VARIANT_LENGTH) return;
    const strippedForm = `${scopePrefix}${strippedUnscoped}`;
    if (strippedForm === identity) return;
    const key = strippedForm.toLowerCase();
    if (variants.has(key)) return;
    variants.set(key, { ...variant, strippedForm });
  };

  // Whole segment removal first: it is the more specific explanation, and first
  // registration wins for a variant two removals could produce.
  if (segments.length > 1) {
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const removalStart = index > 0 ? segment.start - 1 : segment.start;
      const removalEnd = index > 0 ? segment.end : segment.end + 1;
      register(unscopedName.slice(0, removalStart) + unscopedName.slice(removalEnd), {
        position: positionOf(index, segments.length),
        token: segment.text,
        isKnownPaddingToken: PADDING_SEGMENT_TOKENS.includes(segment.text.toLowerCase()),
      });
    }
  }

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const lowered = segment.text.toLowerCase();

    for (const token of GLUED_PADDING_TOKENS) {
      if (lowered.length <= token.length) continue;

      if (lowered.endsWith(token)) {
        const trimmed = segment.text.slice(0, segment.text.length - token.length);
        register(unscopedName.slice(0, segment.start) + trimmed + unscopedName.slice(segment.end), {
          position: index === segments.length - 1 ? "suffix" : "infix",
          token,
          isKnownPaddingToken: true,
        });
      }

      if (index === 0 && lowered.startsWith(token)) {
        const trimmed = segment.text.slice(token.length);
        register(unscopedName.slice(0, segment.start) + trimmed + unscopedName.slice(segment.end), {
          position: "prefix",
          token,
          isKnownPaddingToken: true,
        });
      }
    }
  }

  return variants;
}

function positionOf(index: number, segmentCount: number): PaddingPosition {
  if (index === 0) return "prefix";
  if (index === segmentCount - 1) return "suffix";
  return "infix";
}

// ---------------------------------------------------------------------------
// One pair: run every detector, then the popularity gate
// ---------------------------------------------------------------------------

type TargetComparison = {
  ecosystem: Ecosystem;
  name: string;
  weeklyDownloads: number;
  maxEditDistance: number;
  minPopularityRatio: number;
};

function compareWithTarget(
  profile: CandidateProfile,
  target: TargetComparison,
): TyposquatFinding | null {
  const targetIdentity = toEcosystemIdentity(target.ecosystem, target.name);

  // The one hard rule: a package is never a squat of itself. On PyPI this also covers two
  // spellings of one project, because the identity form is PEP 503 normalised.
  if (targetIdentity === profile.identity) return null;

  const signals: TyposquatSignal[] = [];
  const targetScope = readPackageScope(target.ecosystem, targetIdentity);
  const targetFlattened = flattenPackageName(targetIdentity);
  const targetConfusable = readConfusableForm(targetIdentity);
  const loweredTargetIdentity = targetIdentity.toLowerCase();

  const homoglyph = detectHomoglyph(profile, {
    identity: targetIdentity,
    loweredIdentity: loweredTargetIdentity,
    confusable: targetConfusable,
  });
  if (homoglyph !== null) signals.push(homoglyph);

  const separator = detectSeparatorOrCase(profile, {
    identity: targetIdentity,
    loweredIdentity: loweredTargetIdentity,
    flattened: targetFlattened,
    scope: targetScope.scope,
  });
  if (separator !== null) signals.push(separator);

  const scopeConfusion = detectScopeConfusion(profile, {
    identity: targetIdentity,
    flattened: targetFlattened,
    scope: targetScope.scope,
    unscopedName: targetScope.unscopedName,
  });
  if (scopeConfusion !== null) signals.push(scopeConfusion);

  const padding = profile.paddingVariants.get(loweredTargetIdentity);
  if (padding !== undefined) {
    signals.push({
      kind: "padding",
      position: padding.position,
      token: padding.token,
      isKnownPaddingToken: padding.isKnownPaddingToken,
      strippedForm: padding.strippedForm,
    });
  }

  const distance = measureEditDistanceWithin(profile.identity, targetIdentity, target.maxEditDistance);
  if (distance !== null && distance > 0) {
    // A transposition costs 1 here and 2 in plain Levenshtein, so twice the distance is
    // always a sufficient bound for the plain measurement.
    const plainDistance = measureLevenshteinWithin(profile.identity, targetIdentity, distance * 2);
    const plain = plainDistance ?? distance;
    signals.push({
      kind: "edit_distance",
      distance,
      plainDistance: plain,
      includesTransposition: plain > distance,
      suspectForm: profile.identity,
      targetForm: targetIdentity,
    });
  }

  if (signals.length === 0) return null;

  const popularity = evaluatePopularityGap(
    profile.weeklyDownloads,
    target.weeklyDownloads,
    target.minPopularityRatio,
  );
  if (popularity.isSibling) return null;
  if (popularity.signal !== null) signals.push(popularity.signal);

  signals.sort(compareSignals);

  return {
    suspect: {
      ecosystem: profile.ecosystem,
      name: profile.identity,
      providedName: profile.providedName,
    },
    target: {
      ecosystem: target.ecosystem,
      name: targetIdentity,
      providedName: target.name,
      weeklyDownloads: target.weeklyDownloads,
    },
    signals,
    confidence: deriveConfidence(signals),
    editDistance: distance ?? UNMEASURED_EDIT_DISTANCE,
  };
}

type TargetForms = {
  identity: string;
  loweredIdentity: string;
  confusable: ConfusableForm;
};

/**
 * Fires when the two names collapse onto the same string once confusables are
 * canonicalised, and at least one side actually used a confusable.
 *
 * The substitution requirement matters: without it, two names differing only in case
 * would land here, and a case difference is a separate claim with a separate signal.
 */
function detectHomoglyph(profile: CandidateProfile, target: TargetForms): TyposquatSignal | null {
  if (target.confusable.canonical !== profile.confusable.canonical) return null;
  if (profile.loweredIdentity === target.loweredIdentity) return null;
  if (profile.confusable.substitutions.length === 0 && target.confusable.substitutions.length === 0) {
    return null;
  }
  return {
    kind: "homoglyph",
    canonicalForm: profile.confusable.canonical,
    suspectSubstitutions: profile.confusable.substitutions,
    targetSubstitutions: target.confusable.substitutions,
  };
}

type TargetSeparatorForms = {
  identity: string;
  loweredIdentity: string;
  flattened: string;
  scope: string | null;
};

/**
 * Fires when the two names are the same letters and digits in the same order, differing
 * only in case, in separators, or in both: "crossenv" against "cross-env", "node_fetch"
 * against "node-fetch", "NodeFetch" against "node-fetch".
 *
 * npm lowercases every new name, so a case-only difference can only exist against a name
 * registered before that rule. That makes it a stronger signal there, not a weaker one.
 *
 * A pair that disagrees about scoping is left to the scope detector, which describes the
 * same evidence more precisely.
 */
function detectSeparatorOrCase(
  profile: CandidateProfile,
  target: TargetSeparatorForms,
): TyposquatSignal | null {
  if (profile.flattened !== target.flattened) return null;
  if (profile.flattened.length === 0) return null;
  if (profile.scope !== target.scope) return null;

  // Both names carry the same letters and digits in the same order, so anything left is a
  // case difference, a separator difference, or both. Each is reported on its own.
  return {
    kind: "separator_or_case",
    flattenedForm: profile.flattened,
    caseDiffers: stripSeparators(profile.identity) !== stripSeparators(target.identity),
    separatorsDiffer: profile.loweredIdentity !== target.loweredIdentity,
  };
}

/** Separators removed, case preserved, so a leftover difference can only be case. */
function stripSeparators(name: string): string {
  return name.replace(NON_ALPHANUMERIC_ANY_CASE, "");
}

type TargetScopeForms = {
  identity: string;
  flattened: string;
  scope: string | null;
  unscopedName: string;
};

/** The four scoping disagreements, npm only. See ScopeConfusionVariety for each one. */
function detectScopeConfusion(
  profile: CandidateProfile,
  target: TargetScopeForms,
): TyposquatSignal | null {
  if (profile.ecosystem !== "npm") return null;

  const build = (variety: ScopeConfusionVariety, sharedName: string): TyposquatSignal => ({
    kind: "scope_confusion",
    variety,
    suspectScope: profile.scope,
    targetScope: target.scope,
    sharedName,
  });

  if (profile.scope !== null && target.scope !== null) {
    if (profile.scope === target.scope) return null;
    return profile.unscopedName === target.unscopedName
      ? build("scope_swapped", target.unscopedName)
      : null;
  }

  if (profile.scope !== null && target.scope === null) {
    // "@types/express" is the DefinitelyTyped package for "express", not an imitation of it.
    if (CONVENTIONAL_SCOPES.includes(profile.scope.toLowerCase())) return null;
    return profile.unscopedName === target.identity ? build("scope_added", target.identity) : null;
  }

  if (profile.scope === null && target.scope !== null) {
    if (profile.identity === target.unscopedName) return build("scope_dropped", target.unscopedName);
    // The scope was folded into the name: "types-node" or "@types-node" for "@types/node".
    return profile.flattened === target.flattened ? build("scope_flattened", target.flattened) : null;
  }

  return null;
}

type PopularityDecision = {
  /** True when both figures are known and the target is not far enough ahead. */
  isSibling: boolean;
  signal: TyposquatSignal | null;
};

/**
 * The gate that separates a squat from a sibling.
 *
 * A squat exists to catch traffic meant for something much bigger, so a neighbour with
 * comparable popularity is a different library with a similar name, not an imitation.
 * When either figure is unknown the gate abstains rather than rejecting: PyPI publishes no
 * download counts, and treating unknown as "not a squat" would hide every PyPI finding.
 * An unconfirmed gap costs the finding one confidence level instead.
 */
function evaluatePopularityGap(
  suspectWeeklyDownloads: number,
  targetWeeklyDownloads: number,
  minRatio: number,
): PopularityDecision {
  if (suspectWeeklyDownloads < 0 || targetWeeklyDownloads < 0) {
    return { isSibling: false, signal: null };
  }

  // Flooring the divisor at 1 keeps a brand new package with zero downloads scoring the
  // full target count as its ratio instead of dividing by zero.
  const ratio = targetWeeklyDownloads / Math.max(suspectWeeklyDownloads, 1);
  if (ratio < minRatio) return { isSibling: true, signal: null };

  return {
    isSibling: false,
    signal: {
      kind: "popularity_gap",
      suspectWeeklyDownloads,
      targetWeeklyDownloads,
      ratio,
    },
  };
}

// ---------------------------------------------------------------------------
// Confidence, ranking and rendering
// ---------------------------------------------------------------------------

/**
 * True when a signal cannot plausibly be a coincidence between two independently chosen
 * names: the two names collapse onto one string under a rule the eye does not catch (a
 * confusable, a separator, a case change, a scope fold), or they sit a single edit apart.
 *
 * Padding and two-edit distance are weak on purpose. Legitimate ecosystems are full of
 * both: "lodash-es", "vue2", "react-cli" are all real packages, and two edits separates
 * plenty of unrelated short names.
 */
function isStrongSignal(signal: TyposquatSignal): boolean {
  switch (signal.kind) {
    case "homoglyph":
    case "separator_or_case":
    case "scope_confusion":
      return true;
    case "edit_distance":
      return signal.distance <= 1;
    case "padding":
    case "popularity_gap":
      return false;
  }
}

/**
 * Confidence from which signals fired, never from arithmetic on a float.
 *
 * Two axes decide it. The spelling axis is strong or weak, per isStrongSignal above. The
 * popularity axis is confirmed when both download figures were known and the target
 * cleared the ratio, and unknown when either figure was missing, which is every PyPI
 * finding because the PyPI JSON API publishes no download counts.
 *
 *   strong spelling + confirmed gap  -> high
 *   strong spelling + unknown gap    -> medium
 *   weak spelling   + confirmed gap  -> medium
 *   weak spelling   + unknown gap    -> low
 *
 * A pair whose figures are known and whose gap is below the ratio never reaches here: it
 * was rejected as a sibling before the finding was built.
 */
function deriveConfidence(signals: readonly TyposquatSignal[]): TyposquatConfidence {
  const hasStrongSpelling = signals.some(isStrongSignal);
  const hasConfirmedGap = signals.some((signal) => signal.kind === "popularity_gap");

  if (hasStrongSpelling) return hasConfirmedGap ? "high" : "medium";
  return hasConfirmedGap ? "medium" : "low";
}

function compareSignals(left: TyposquatSignal, right: TyposquatSignal): number {
  return (SIGNAL_RANK.get(left.kind) ?? 9) - (SIGNAL_RANK.get(right.kind) ?? 9);
}

/**
 * Ranks findings for a panel with limited room: confidence first, then the closest
 * spelling, then the biggest target. An unmeasured distance sorts last among equals rather
 * than first, because it means the names are far apart in spelling.
 */
function compareFindings(left: TyposquatFinding, right: TyposquatFinding): number {
  const byConfidence =
    (CONFIDENCE_RANK.get(left.confidence) ?? 9) - (CONFIDENCE_RANK.get(right.confidence) ?? 9);
  if (byConfidence !== 0) return byConfidence;

  const byDistance = sortableDistance(left.editDistance) - sortableDistance(right.editDistance);
  if (byDistance !== 0) return byDistance;

  const byDownloads = right.target.weeklyDownloads - left.target.weeklyDownloads;
  if (byDownloads !== 0) return byDownloads;

  return left.target.name.localeCompare(right.target.name);
}

function sortableDistance(distance: number): number {
  return distance < 0 ? MAX_ALLOWED_EDIT_DISTANCE + 1 : distance;
}

/**
 * One sentence per signal, written for the person reading the panel. The UI shows the
 * first signal of a finding, so this is the sentence that has to make the case.
 */
export function describeTyposquatSignal(signal: TyposquatSignal): string {
  switch (signal.kind) {
    case "edit_distance":
      return signal.includesTransposition
        ? `"${signal.suspectForm}" is ${signal.distance} edit away from "${signal.targetForm}" through a transposition, which a plain Levenshtein matcher scores as ${signal.plainDistance}`
        : `"${signal.suspectForm}" is ${signal.distance} character edit${signal.distance === 1 ? "" : "s"} away from "${signal.targetForm}"`;
    case "scope_confusion":
      return describeScopeConfusion(signal.variety, signal.sharedName, signal.suspectScope, signal.targetScope);
    case "separator_or_case":
      if (signal.caseDiffers && signal.separatorsDiffer) {
        return `the two names differ only in separators and letter case, and both read as "${signal.flattenedForm}"`;
      }
      return signal.separatorsDiffer
        ? `the two names carry the same letters in the same order and differ only in separators, both reading as "${signal.flattenedForm}"`
        : `the two names differ only in letter case, and both read as "${signal.flattenedForm}"`;
    case "homoglyph":
      return `the names are identical once look-alike characters are folded (${describeSubstitutions(signal.suspectSubstitutions, signal.targetSubstitutions)}), both reading as "${signal.canonicalForm}"`;
    case "padding":
      return signal.isKnownPaddingToken
        ? `the name is "${signal.strippedForm}" with the filler token "${signal.token}" added as a ${signal.position}`
        : `the name is "${signal.strippedForm}" with "${signal.token}" inserted as a ${signal.position}`;
    case "popularity_gap":
      return `the imitated package has ${Math.round(signal.ratio)} times the weekly downloads (${signal.targetWeeklyDownloads} against ${signal.suspectWeeklyDownloads})`;
  }
}

function describeScopeConfusion(
  variety: ScopeConfusionVariety,
  sharedName: string,
  suspectScope: string | null,
  targetScope: string | null,
): string {
  switch (variety) {
    case "scope_added":
      return `the name publishes "${sharedName}" under the scope "@${suspectScope ?? ""}", which the real package does not use`;
    case "scope_dropped":
      return `the name publishes "${sharedName}" with no scope, while the real package lives under "@${targetScope ?? ""}"`;
    case "scope_swapped":
      return `the name keeps "${sharedName}" and swaps the scope "@${targetScope ?? ""}" for "@${suspectScope ?? ""}"`;
    case "scope_flattened":
      return `the name folds the scope into itself, reading as "${sharedName}" without the slash the real package uses`;
  }
}

function describeSubstitutions(
  suspectSubstitutions: readonly ConfusableSubstitution[],
  targetSubstitutions: readonly ConfusableSubstitution[],
): string {
  const rendered = [...suspectSubstitutions, ...targetSubstitutions].map(
    (substitution) => `"${substitution.written}" for "${substitution.canonical}"`,
  );
  return rendered.length === 0 ? "no substitution" : rendered.join(", ");
}
