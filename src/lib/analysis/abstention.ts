import type { Coverage, SliceCoverage } from "@/lib/graph/slice-manifest";
import type { GraphPath } from "@/lib/graph/gateway";

/**
 * The abstention model.
 *
 * This project answers questions over a curated slice of npm and PyPI, never over the
 * whole registry. That makes an empty traversal result ambiguous: it can mean "nothing
 * depends on this" or it can mean "the dependents were never ingested". Presenting the
 * second as the first would tell someone their service is clean when the tool simply
 * never looked, which is the one failure mode a security tool must not have.
 *
 * So every answer carries one of three verdicts, and the reason for it:
 *
 *   exposed      a concrete path was found. Sound under partial coverage too, because
 *                finding a path is monotone: more data cannot unfind it.
 *   not_exposed  no path was found, the subject's closure was fully ingested, and
 *                nothing truncated the traversal. Only then is absence evidence.
 *   unknown      everything else. The honest answer when the slice cannot decide.
 *
 * Nothing in this file talks to the graph. It takes what a traversal found, what the
 * slice manifest says was ingested, and what limits the traversal hit, and decides.
 */

export type Verdict = "exposed" | "not_exposed" | "unknown";

/**
 * Something that stopped the answer from being complete.
 *
 * Every kind here is either an absence (the data was never loaded) or a truncation
 * (the traversal was cut short). Both block a not_exposed verdict, and both are
 * rendered to the user rather than hidden, because a limit is the difference between
 * "clean" and "we stopped looking".
 *
 * Absence is normally decided from the subject's coverage rather than from this list,
 * so `decideVerdict` checks both: a caller that already knows the subject is missing
 * can say so here and still be prevented from reaching not_exposed.
 */
export type AnswerLimit =
  /** The graph holds nothing at all: no ingest has run. */
  | { kind: "empty_graph" }
  /**
   * The subject is not in the slice, so nothing about it can be decided.
   *
   * `subjectKey` holds whatever the question was about, which is not always a package: the
   * callers of `decideVerdict` pass version keys, package keys, advisory ids, maintainer
   * keys, and one phrase naming a requested set. The `package_` prefix on this kind and the
   * next one is the wire vocabulary clients already branch on, so it stays.
   */
  | { kind: "package_absent"; subjectKey: string }
  /** The subject is present but only partly covered: its closure was cut short at ingest. */
  | { kind: "package_partial"; subjectKey: string }
  /** A path reached the requested hop maximum, so deeper dependents were not visited. */
  | { kind: "hop_limit"; maxHops: number }
  /** As many paths came back as were asked for, so more may exist. */
  | { kind: "path_limit"; pathCount: number }
  /** The engine refused on a budget. `operation` is its stable identifier. */
  | { kind: "budget_rejected"; operation: string }
  /** A bounded fan-out was capped before every candidate was examined. */
  | { kind: "scan_capped"; examined: number; total: number }
  /** A version string could not be placed in an advisory range. */
  | { kind: "undecidable_versions"; count: number }
  /**
   * A service's lockfile history was only partly harvested, so the valid-time axis has
   * gaps. A gap is not an absence of exposure: the service may well have resolved the
   * bad version in a revision nobody read.
   */
  | { kind: "service_history_partial"; serviceKey: string; harvestedRevisions: number }
  /**
   * A timestamp the answer needs is the unknown sentinel, so an interval could not be
   * placed on the timeline. `field` names which one, so the UI can say what is missing
   * instead of showing a zero-length window as if it were a measured fact.
   */
  | { kind: "timestamp_missing"; field: string };

/**
 * An answer that knows what it does not know.
 *
 * `evidence` holds the domain payload. `limits` is always populated honestly, even on
 * an exposed verdict, because "exposed, and there may be more" is a different message
 * from "exposed, and this is all of it".
 */
export type AbstainingAnswer<TEvidence> = {
  verdict: Verdict;
  /** One sentence, written for a person reading the result, not for a log. */
  rationale: string;
  limits: AnswerLimit[];
  evidence: TEvidence;
};

/** True when a limit means the traversal stopped early rather than finished. */
export function isTruncatingLimit(limit: AnswerLimit): boolean {
  switch (limit.kind) {
    case "hop_limit":
    case "path_limit":
    case "budget_rejected":
    case "scan_capped":
    case "undecidable_versions":
    case "package_partial":
    case "service_history_partial":
    case "timestamp_missing":
      return true;
    case "empty_graph":
    case "package_absent":
      return false;
  }
}

/** True when a limit means the subject was never in the slice to begin with. */
export function isAbsenceLimit(limit: AnswerLimit): boolean {
  return limit.kind === "empty_graph" || limit.kind === "package_absent";
}

export type VerdictInput = {
  /** True when the traversal found at least one concrete path or match. */
  foundEvidence: boolean;
  /** How completely the subject of the question was ingested. */
  subjectCoverage: Coverage;
  /** Natural key of the subject, for the limit and the rationale. */
  subjectKey: string;
  limits: readonly AnswerLimit[];
  /** True when the graph is empty, which overrides everything else. */
  graphIsEmpty: boolean;
};

/**
 * Decides the verdict and writes its own rationale.
 *
 * The order of the branches is the whole point, so it is spelled out rather than
 * compressed: emptiness first, then absence, then found evidence, then truncation, and
 * only a subject with closed coverage and an untruncated empty traversal reaches
 * not_exposed.
 *
 * Absence outranks found evidence deliberately. A path through a subject the slice never
 * ingested is a path through data of unknown provenance, so the honest answer is unknown
 * rather than a confident "exposed" built on a partially loaded neighbourhood.
 */
export function decideVerdict(input: VerdictInput): { verdict: Verdict; rationale: string; limits: AnswerLimit[] } {
  const limits: AnswerLimit[] = [...input.limits];

  if (input.graphIsEmpty) {
    limits.unshift({ kind: "empty_graph" });
    return {
      verdict: "unknown",
      rationale: "The graph is empty, so no question about it can be answered yet. Run an ingest first.",
      limits,
    };
  }

  if (input.subjectCoverage === "absent") {
    limits.unshift({ kind: "package_absent", subjectKey: input.subjectKey });
    return {
      verdict: "unknown",
      rationale: `${input.subjectKey} is outside the ingested slice, so this answer would be about data that was never loaded.`,
      limits,
    };
  }

  if (input.subjectCoverage === "partial" && !hasLimitKind(limits, "package_partial")) {
    limits.push({ kind: "package_partial", subjectKey: input.subjectKey });
  }

  if (input.foundEvidence) {
    const truncated = limits.some(isTruncatingLimit);
    return {
      verdict: "exposed",
      rationale: truncated
        ? "A concrete path was found. The traversal was cut short, so the real reach is at least this large."
        : "A concrete path was found, and the traversal ran to completion.",
      limits,
    };
  }

  const truncating = limits.filter(isTruncatingLimit);
  if (truncating.length > 0) {
    return {
      verdict: "unknown",
      rationale: `No path was found, but the search stopped early (${describeLimits(truncating)}), so absence here is not evidence of safety.`,
      limits,
    };
  }

  // A caller that already knows something was missing can say so through limits without
  // also setting coverage. Checking here means not_exposed cannot be reached by that
  // route either, so the invariant holds however the caller assembled its input.
  const absences = limits.filter(isAbsenceLimit);
  if (absences.length > 0) {
    return {
      verdict: "unknown",
      rationale: `No path was found, but part of the data was never loaded (${describeLimits(absences)}), so this is not a negative result.`,
      limits,
    };
  }

  return {
    verdict: "not_exposed",
    rationale: `No path exists. ${input.subjectKey} has its full closure in the slice and the traversal ran to completion, so this is a real negative.`,
    limits,
  };
}

/** Wraps a decided verdict around its evidence. */
export function buildAnswer<TEvidence>(
  decided: { verdict: Verdict; rationale: string; limits: AnswerLimit[] },
  evidence: TEvidence,
): AbstainingAnswer<TEvidence> {
  return {
    verdict: decided.verdict,
    rationale: decided.rationale,
    limits: decided.limits,
    evidence,
  };
}

/**
 * An answer that could not run at all, for a caller that has to return something.
 *
 * Used when a prerequisite read fails: a failed read is not a negative result, and the
 * UI has to say so rather than render an empty list.
 */
export function buildUnknownAnswer<TEvidence>(
  rationale: string,
  evidence: TEvidence,
  limits: readonly AnswerLimit[] = [],
): AbstainingAnswer<TEvidence> {
  return { verdict: "unknown", rationale, limits: [...limits], evidence };
}

/**
 * Records the hop ceiling as a limit only when a path actually reached it.
 *
 * Every traversal carries a maximum, so recording it unconditionally would make
 * not_exposed unreachable and the whole model useless. The ceiling only truncated the
 * answer if something was sitting at it when the walk stopped.
 */
export function detectHopLimit(paths: readonly GraphPath[], maxHops: number): AnswerLimit | null {
  return paths.some((path) => path.hopCount >= maxHops) ? { kind: "hop_limit", maxHops } : null;
}

/**
 * Records the path ceiling as a limit only when the traversal returned exactly as many
 * paths as were asked for, which is the only observable sign that it may have been cut.
 */
export function detectPathLimit(paths: readonly GraphPath[], pathCount: number): AnswerLimit | null {
  return paths.length >= pathCount ? { kind: "path_limit", pathCount } : null;
}

/**
 * Turns an engine budget rejection into a limit.
 *
 * HydraDB reports every budget as a 429 carrying a stable operation identifier, which
 * http-transport.ts lifts into `context.budget`. Keeping the identifier means the UI
 * can say which limit was hit instead of "the query failed".
 *
 * Returns the narrow variant, not the whole union, so a caller can read `.operation`
 * without a cast. Type suppression is banned here, so a widened return type would force
 * every caller into an awkward narrowing dance for no benefit.
 */
export function budgetLimitFromContext(
  context: Record<string, string | number | boolean> | undefined,
): Extract<AnswerLimit, { kind: "budget_rejected" }> {
  const operation = context?.budget;
  return {
    kind: "budget_rejected",
    operation: typeof operation === "string" ? operation : "unnamed_budget",
  };
}

/** Collects the coverage of several packages, returning the weakest one found. */
export function weakestCoverage(
  coverage: SliceCoverage,
  packageKeys: readonly string[],
): Coverage {
  let weakest: Coverage = "closed";
  for (const packageKey of packageKeys) {
    const found = coverage.describePackageCoverage(packageKey);
    if (found === "absent") return "absent";
    if (found === "partial") weakest = "partial";
  }
  return weakest;
}

/** Human-readable one-liner per verdict, for the UI and the README. */
export function describeVerdict(verdict: Verdict): string {
  switch (verdict) {
    case "exposed":
      return "Exposed";
    case "not_exposed":
      return "Not exposed";
    case "unknown":
      return "Unknown";
  }
}

/** Renders limits as a short phrase for a rationale sentence. */
export function describeLimits(limits: readonly AnswerLimit[]): string {
  return limits.map(describeLimit).join(", ");
}

export function describeLimit(limit: AnswerLimit): string {
  switch (limit.kind) {
    case "empty_graph":
      return "the graph is empty";
    case "package_absent":
      return `${limit.subjectKey} is not in the ingested slice`;
    case "package_partial":
      return `${limit.subjectKey} is only partly covered by the slice`;
    case "hop_limit":
      return `the walk stopped at ${limit.maxHops} hops`;
    case "path_limit":
      return `the path cap of ${limit.pathCount} was reached`;
    case "budget_rejected":
      return `the engine refused on ${limit.operation}`;
    case "scan_capped":
      return `only ${limit.examined} of ${limit.total} candidates were examined`;
    case "undecidable_versions":
      return `${limit.count} version strings could not be placed in the advisory range`;
    case "service_history_partial":
      return `${limit.serviceKey} has only ${limit.harvestedRevisions} harvested lockfile revisions`;
    case "timestamp_missing":
      return `${limit.field} is unknown, so the window could not be placed on the timeline`;
  }
}

/**
 * A limit's identity, for folding many answers into one list of reasons.
 *
 * The kind alone is too coarse: three hundred dependencies outside the slice produce three
 * hundred `package_absent` limits naming three hundred different subjects, and collapsing
 * them on the kind would report one absence and hide the rest. So the identity is the kind
 * plus the field that says what the limit is about.
 *
 * `undecidable_versions` is the one kind whose payload is a magnitude rather than a subject,
 * so its identity is the bare kind and a caller that folds two of them adds the counts
 * instead of dropping one. Every variant is spelled out, so a new kind cannot be folded on
 * its kind alone by accident.
 */
export function describeLimitIdentity(limit: AnswerLimit): string {
  switch (limit.kind) {
    case "empty_graph":
      return limit.kind;
    case "package_absent":
    case "package_partial":
      return `${limit.kind}:${limit.subjectKey}`;
    case "hop_limit":
      return `${limit.kind}:${limit.maxHops}`;
    case "path_limit":
      return `${limit.kind}:${limit.pathCount}`;
    case "budget_rejected":
      return `${limit.kind}:${limit.operation}`;
    case "scan_capped":
      return `${limit.kind}:${limit.examined}/${limit.total}`;
    case "undecidable_versions":
      return limit.kind;
    case "service_history_partial":
      return `${limit.kind}:${limit.serviceKey}`;
    case "timestamp_missing":
      return `${limit.kind}:${limit.field}`;
  }
}

function hasLimitKind(limits: readonly AnswerLimit[], kind: AnswerLimit["kind"]): boolean {
  return limits.some((limit) => limit.kind === kind);
}
