import semver from "semver";

import {
  type AbstainingAnswer,
  type AnswerLimit,
  type Verdict,
  buildAnswer,
  buildUnknownAnswer,
  budgetLimitFromContext,
  decideVerdict,
  describeLimits,
  isTruncatingLimit,
} from "@/lib/analysis/abstention";
import { sortVersionsAscending } from "@/lib/analysis/semver-facts";
import {
  type GraphGateway,
  type GraphNodeRecord,
  type GraphProperties,
  isGraphEmpty,
  readBooleanProperty,
  readNumberProperty,
  readStringProperty,
} from "@/lib/graph/gateway";
import { type Ecosystem, parsePackageKey, parseVersionKey } from "@/lib/graph/model";
import type { SliceCoverage } from "@/lib/graph/slice-manifest";
import { type Failure, type Result, fail, succeed } from "@/lib/result";

/**
 * Introduced version: which published version of a package first carried the defect an
 * advisory describes, with the evidence for that claim.
 *
 * The range arithmetic is already done by the time this module runs. HydraDB's Cypher
 * subset has no `min` and cannot parse a version range, and string comparison is not
 * version comparison, so the ingest resolves every advisory range in TypeScript and
 * writes the outcome as explicit AFFECTS_VERSION edges (sourceRef: docs/HYDRADB.md
 * section 2). This module therefore never parses a range. It reads the precomputed
 * edges and decides the order.
 *
 * Ordering is the whole question, and two facts shape it:
 *
 *   1. Publish time is the primary key, because the question a responder asks is which
 *      version a consumer could first have installed. A registry timestamp is a fact,
 *      not an inference.
 *
 *   2. The registry does not always have one. The model writes published_at_ms as -1
 *      when it is missing (sourceRef: src/lib/graph/model.ts VersionNode), and semver
 *      precedence is then the only remaining signal. A version with neither signal is
 *      reported as undecidable rather than quietly placed first, because "1.0.0
 *      introduced it" is read as an instruction to roll back to 0.9.x.
 *
 * The fixed version is never derived. It is reported only when the advisory states one
 * on its AFFECTS edge, because an invented fix sends someone to a release that fixes
 * nothing.
 *
 * Every answer is an AbstainingAnswer. An empty affected list over a package whose
 * closure was never ingested is not the same claim as "no version was ever affected",
 * and this module never conflates them.
 */

/** The advisory the question is about, as the slice holds it. */
export type AdvisorySubject = {
  /** Natural key. sourceRef: src/lib/graph/model.ts advisoryKey */
  key: string;
  ghsaId: string;
  /** One-line advisory text. Empty when the node carries none. */
  summary: string;
  /** Disclosure time as epoch milliseconds, null when the node carries none. */
  publishedAtMs: number | null;
  /** null when the advisory is not a node in the slice. */
  nodeId: number | null;
};

/** The package the question is about. */
export type PackageSubject = {
  packageKey: string;
  ecosystem: Ecosystem;
  name: string;
  /** null when the package is not a node in the slice. */
  nodeId: number | null;
};

/** One published version the advisory affects, as read from the graph. */
export type AffectedVersionFact = {
  versionKey: string;
  version: string;
  /** Publish time as epoch milliseconds, null when the registry never gave one. */
  publishedAtMs: number | null;
  /** True when the manifest declares an install, preinstall or postinstall script. */
  hasInstallScript: boolean;
  /**
   * False when the version has neither a publish time nor a parseable semver string,
   * so it has no defensible position in the order and is listed rather than ranked.
   */
  isOrdered: boolean;
};

/**
 * What the advisory itself states about the package, verbatim from the AFFECTS edge.
 * sourceRef: src/lib/graph/model.ts AffectsProps
 */
export type StatedAdvisoryRange = {
  /** First affected version, or "" when the advisory is open ended at the bottom. */
  introduced: string;
  /** First fixed version, or "" when the advisory names no fix. */
  fixed: string;
  /** True when `fixed` names a release, so a fix is stated rather than guessed. */
  hasStatedFix: boolean;
};

export type IntroducedVersionEvidence = {
  advisory: AdvisorySubject;
  affectedPackage: PackageSubject;
  /** null when no affected version of this package could be placed in the order. */
  introducingVersion: AffectedVersionFact | null;
  /** Oldest first. The versions that could not be placed sort last. */
  affectedVersions: AffectedVersionFact[];
  /** null when the advisory has no AFFECTS edge to this package in the slice. */
  statedRange: StatedAdvisoryRange | null;
  /** How many affected versions could not be placed in the order. */
  undecidableVersionCount: number;
};

export type IntroducedVersionOptions = {
  /**
   * Ceiling on AFFECTS_VERSION edges read in the single expansion. A real advisory
   * names tens of versions; 20,000 covers one that condemns a whole major line while
   * staying inside the engine's 100,000 result vertex budget.
   * sourceRef: docs/HYDRADB.md section 6
   */
  maxAffectedVersions?: number;
  /**
   * Ceiling on AFFECTS edges read to find the stated range. One edge per package the
   * advisory names, which is generous for a monorepo advisory that condemns every
   * package published from one release. Reaching it is recorded, not ignored.
   */
  maxAffectedPackages?: number;
};

const DEFAULT_MAX_AFFECTED_VERSIONS = 20_000;
const DEFAULT_MAX_AFFECTED_PACKAGES = 1_000;

export type IntroducedVersionRequest = {
  gateway: GraphGateway;
  coverage: SliceCoverage;
  /** The advisory's natural key, which is its GHSA id. */
  advisoryKey: string;
  /** The package the question is about, as `ecosystem:name`. */
  packageKey: string;
  options?: IntroducedVersionOptions;
};

/**
 * Answers the introduced version question.
 *
 * Returns a Failure only when the graph itself could not be read. A missing advisory, a
 * package outside the slice, a truncated expansion and a version that cannot be ordered
 * are all answers, and they come back as a verdict carrying the reason.
 */
export async function computeIntroducedVersion(
  request: IntroducedVersionRequest,
): Promise<Result<AbstainingAnswer<IntroducedVersionEvidence>, Failure>> {
  const parsedPackage = parsePackageKey(request.packageKey);
  if (parsedPackage === null) {
    return fail(
      "invalid_input",
      `[computeIntroducedVersion] "${request.packageKey}" is not an ecosystem:name key`,
    );
  }
  if (request.advisoryKey.trim().length === 0) {
    return fail("invalid_input", "[computeIntroducedVersion] the advisory key is empty");
  }

  const maxAffectedVersions =
    request.options?.maxAffectedVersions ?? DEFAULT_MAX_AFFECTED_VERSIONS;
  const maxAffectedPackages =
    request.options?.maxAffectedPackages ?? DEFAULT_MAX_AFFECTED_PACKAGES;

  const advisory: AdvisorySubject = {
    key: request.advisoryKey,
    // Until the node is read, the key is all that is known, and the key of an Advisory
    // is its GHSA id (sourceRef: src/lib/graph/model.ts advisoryKey).
    ghsaId: request.advisoryKey,
    summary: "",
    publishedAtMs: null,
    nodeId: null,
  };

  const affectedPackage: PackageSubject = {
    packageKey: request.packageKey,
    ecosystem: parsedPackage.ecosystem,
    name: parsedPackage.name,
    nodeId: null,
  };

  const emptyEvidence = (): IntroducedVersionEvidence => ({
    advisory,
    affectedPackage,
    introducingVersion: null,
    affectedVersions: [],
    statedRange: null,
    undecidableVersionCount: 0,
  });

  const resolvedAdvisory = await request.gateway.resolveNodeIds({
    label: "Advisory",
    keys: [request.advisoryKey],
  });
  if (!resolvedAdvisory.ok) return resolvedAdvisory;

  const advisoryNodeId = resolvedAdvisory.value.get(request.advisoryKey);
  const graphIsEmpty = await isGraphEmpty(request.gateway);
  if (!graphIsEmpty.ok) return graphIsEmpty;

  if (advisoryNodeId === undefined) {
    // The advisory is provably not a node, so there is no range to read and nothing to
    // order. Coverage is passed as absent regardless of what the manifest says about
    // the package: the question was asked about this advisory, and a package with a
    // fully ingested closure says nothing about an advisory that was never loaded.
    return succeed(
      buildAnswer(
        decideVerdict({
          foundEvidence: false,
          subjectCoverage: "absent",
          subjectKey: request.advisoryKey,
          limits: [],
          graphIsEmpty: graphIsEmpty.value,
        }),
        emptyEvidence(),
      ),
    );
  }
  advisory.nodeId = advisoryNodeId;

  const advisoryRead = await request.gateway.readNodes({
    label: "Advisory",
    nodeIds: [advisoryNodeId],
  });
  if (!advisoryRead.ok) return advisoryRead;

  const advisoryNode = advisoryRead.value[0];
  if (advisoryNode !== undefined) {
    // A node resolved by key but unreadable is a torn read, and the version evidence
    // does not depend on these three properties, so the answer keeps the key-derived
    // defaults rather than failing the whole question.
    advisory.ghsaId = readStringProperty(advisoryNode.properties, "ghsa_id") ?? advisory.ghsaId;
    advisory.summary = readStringProperty(advisoryNode.properties, "summary") ?? "";
    advisory.publishedAtMs = readNumberProperty(advisoryNode.properties, "published_at_ms");
  }

  const resolvedPackage = await request.gateway.resolveNodeIds({
    label: "Package",
    keys: [request.packageKey],
  });
  if (!resolvedPackage.ok) return resolvedPackage;
  affectedPackage.nodeId = resolvedPackage.value.get(request.packageKey) ?? null;

  const affectedVersionEdges = await request.gateway.neighbors({
    nodeId: advisoryNodeId,
    nodeLabel: "Advisory",
    relType: "AFFECTS_VERSION",
    direction: "outgoing",
    limit: maxAffectedVersions,
  });
  if (!affectedVersionEdges.ok) {
    const abstained = abstainOnBudget(
      affectedVersionEdges.failure,
      `Reading the versions ${advisory.ghsaId} affects exceeded an engine budget, so the introducing version is not decided.`,
      emptyEvidence(),
    );
    return abstained === null ? affectedVersionEdges : succeed(abstained);
  }

  const limits: AnswerLimit[] = [];
  if (affectedVersionEdges.value.length >= maxAffectedVersions) {
    limits.push({
      kind: "scan_capped",
      examined: affectedVersionEdges.value.length,
      total: maxAffectedVersions,
    });
  }

  const versionRead = await request.gateway.readNodes({
    label: "Version",
    nodeIds: affectedVersionEdges.value.map((edge) => edge.otherNodeId),
  });
  if (!versionRead.ok) {
    const abstained = abstainOnBudget(
      versionRead.failure,
      `Reading the ${affectedVersionEdges.value.length} versions ${advisory.ghsaId} affects exceeded an engine budget, so the introducing version is not decided.`,
      emptyEvidence(),
    );
    return abstained === null ? versionRead : succeed(abstained);
  }

  const ordered = orderAffectedVersions(
    collectPackageVersions(versionRead.value, parsedPackage.ecosystem, parsedPackage.name),
  );
  if (ordered.undecidableCount > 0) {
    limits.push({ kind: "undecidable_versions", count: ordered.undecidableCount });
  }

  const stated = await readStatedRange({
    gateway: request.gateway,
    advisoryNodeId,
    packageNodeId: affectedPackage.nodeId,
    limit: maxAffectedPackages,
  });
  if (!stated.ok) {
    const abstained = abstainOnBudget(
      stated.failure,
      `Reading the range ${advisory.ghsaId} states for ${request.packageKey} exceeded an engine budget, so the stated bounds are unknown.`,
      emptyEvidence(),
    );
    return abstained === null ? stated : succeed(abstained);
  }
  if (stated.value.scanWasCapped) {
    limits.push({
      kind: "scan_capped",
      examined: stated.value.examined,
      total: maxAffectedPackages,
    });
  }

  const evidence: IntroducedVersionEvidence = {
    advisory,
    affectedPackage,
    introducingVersion: ordered.introducing,
    affectedVersions: ordered.versions,
    statedRange: stated.value.range,
    undecidableVersionCount: ordered.undecidableCount,
  };

  const decided = decideVerdict({
    // One AFFECTS_VERSION edge to this package is the concrete finding here: it is a
    // fact the ingest computed, and more data cannot unfind it.
    foundEvidence: evidence.affectedVersions.length > 0,
    subjectCoverage: request.coverage.describePackageCoverage(request.packageKey),
    subjectKey: request.packageKey,
    limits,
    graphIsEmpty: graphIsEmpty.value,
  });

  const answer = buildAnswer(decided, evidence);
  // The verdict and the limits stand as decided; only the sentence is rewritten, since
  // decideVerdict writes its rationale in the vocabulary of a path traversal.
  return succeed({ ...answer, rationale: describeIntroducedVersion(decided, evidence) });
}

/**
 * Keeps the affected versions that belong to the requested package.
 *
 * One advisory routinely affects several packages, and AFFECTS_VERSION does not
 * separate them: every edge hangs off the same Advisory node. The ecosystem and the
 * name come from the version key rather than from the properties, so a node written
 * without a full property set still filters correctly instead of falling back to a
 * guessed default (same reason as buildVersionExposures in blast-radius.ts).
 */
function collectPackageVersions(
  records: readonly GraphNodeRecord[],
  ecosystem: Ecosystem,
  name: string,
): AffectedVersionFact[] {
  const facts: AffectedVersionFact[] = [];

  for (const record of records) {
    const key = readStringProperty(record.properties, "key");
    if (key === null) continue;

    const parsed = parseVersionKey(key);
    if (parsed === null) continue;
    if (parsed.ecosystem !== ecosystem || parsed.name !== name) continue;

    const version = readStringProperty(record.properties, "version") ?? parsed.version;
    const publishedAtMs = readPublishTime(record.properties);

    facts.push({
      versionKey: key,
      version,
      // The current ingest writes has_install_script for every Version (sourceRef:
      // src/lib/graph/model.ts NODE_PROPERTY_NAMES), so a node missing it came from an
      // older writer. False here means "not flagged", never "proven to have no script".
      hasInstallScript: readBooleanProperty(record.properties, "has_install_script") ?? false,
      publishedAtMs,
      isOrdered: publishedAtMs !== null || semver.valid(version, { loose: true }) !== null,
    });
  }

  return facts;
}

type OrderedAffectedVersions = {
  /** Oldest first, with the versions that could not be placed appended last. */
  versions: AffectedVersionFact[];
  /** The earliest version that could be placed, or null when none could. */
  introducing: AffectedVersionFact | null;
  undecidableCount: number;
};

/**
 * Orders the affected versions oldest first and names the one that introduced the
 * vulnerability.
 *
 * Versions with no publish time and no parseable semver string are separated out rather
 * than ranked: the caller turns that count into an undecidable_versions limit, which is
 * the difference between "5.0.0 introduced it" and "we could not tell".
 */
function orderAffectedVersions(
  facts: readonly AffectedVersionFact[],
): OrderedAffectedVersions {
  // sortVersionsAscending already defines this project's semver precedence order,
  // including its rule that an unparseable version sorts last. Ranking against its
  // output keeps one definition of that order instead of a second comparator here.
  const semverRankByVersion = new Map<string, number>();
  const bySemver = sortVersionsAscending(facts.map((fact) => fact.version));
  for (let rank = 0; rank < bySemver.length; rank += 1) {
    const version = bySemver[rank];
    if (version !== undefined && !semverRankByVersion.has(version)) {
      semverRankByVersion.set(version, rank);
    }
  }

  const orderable = facts.filter((fact) => fact.isOrdered);
  const undecidable = facts.filter((fact) => !fact.isOrdered);

  orderable.sort((left, right) => comparePublishThenSemver(left, right, semverRankByVersion));
  undecidable.sort((left, right) => left.versionKey.localeCompare(right.versionKey));

  return {
    versions: [...orderable, ...undecidable],
    introducing: orderable[0] ?? null,
    undecidableCount: undecidable.length,
  };
}

/**
 * Publish time first, semver precedence second.
 *
 * The fallback fires in two cases: a missing timestamp, where precedence is the only
 * signal left, and two versions published in the same millisecond, where precedence is
 * the only signal that distinguishes them. Mixing the two keys cannot produce a strict
 * total order, so the tail of the comparison is deliberately deterministic rather than
 * exact: an equal semver rank falls back to the version key, and the same slice
 * therefore always yields the same list.
 */
function comparePublishThenSemver(
  left: AffectedVersionFact,
  right: AffectedVersionFact,
  semverRankByVersion: Map<string, number>,
): number {
  if (
    left.publishedAtMs !== null &&
    right.publishedAtMs !== null &&
    left.publishedAtMs !== right.publishedAtMs
  ) {
    return left.publishedAtMs - right.publishedAtMs;
  }

  const leftRank = semverRankByVersion.get(left.version) ?? Number.MAX_SAFE_INTEGER;
  const rightRank = semverRankByVersion.get(right.version) ?? Number.MAX_SAFE_INTEGER;
  if (leftRank !== rightRank) return leftRank - rightRank;
  return left.versionKey.localeCompare(right.versionKey);
}

type StatedRangeRead = {
  /** null when the advisory has no AFFECTS edge to this package in the slice. */
  range: StatedAdvisoryRange | null;
  /** How many AFFECTS edges were examined, for the scan_capped limit. */
  examined: number;
  scanWasCapped: boolean;
};

type StatedRangeRequest = {
  gateway: GraphGateway;
  advisoryNodeId: number;
  /** null when the package is not a node, in which case no AFFECTS edge can exist. */
  packageNodeId: number | null;
  limit: number;
};

/**
 * Reads what the advisory states about this package: the raw `introduced` and `fixed`
 * bounds on the AFFECTS edge.
 *
 * These are stated facts, not derived ones, so they are surfaced verbatim. An empty
 * `fixed` stays empty rather than being filled in from the version list, because
 * naming an upgrade target the advisory never claimed is worse than naming none.
 *
 * A cap reached after the package's own edge was found truncated nothing this answer
 * depends on, so it is not reported: a truncating limit blocks a not_exposed verdict,
 * and blocking one for an edge that was already read would abstain for no reason.
 */
async function readStatedRange(
  request: StatedRangeRequest,
): Promise<Result<StatedRangeRead, Failure>> {
  if (request.packageNodeId === null) {
    return succeed({ range: null, examined: 0, scanWasCapped: false });
  }

  const edges = await request.gateway.neighbors({
    nodeId: request.advisoryNodeId,
    nodeLabel: "Advisory",
    relType: "AFFECTS",
    direction: "outgoing",
    limit: request.limit,
  });
  if (!edges.ok) return edges;

  for (const edge of edges.value) {
    if (edge.otherNodeId !== request.packageNodeId) continue;

    const introduced = readStringProperty(edge.properties, "introduced") ?? "";
    const fixed = readStringProperty(edge.properties, "fixed") ?? "";
    return succeed({
      range: { introduced, fixed, hasStatedFix: fixed.length > 0 },
      examined: edges.value.length,
      scanWasCapped: false,
    });
  }

  return succeed({
    range: null,
    examined: edges.value.length,
    scanWasCapped: edges.value.length >= request.limit,
  });
}

/**
 * The publish time, or null when the registry never gave one.
 *
 * The model stores -1 for a missing timestamp (sourceRef: src/lib/graph/model.ts
 * VersionNode.published_at_ms). Any negative value is treated the same way: no npm or
 * PyPI release predates 1970, so a negative value is the sentinel or corruption, and
 * neither can order anything.
 */
function readPublishTime(properties: GraphProperties): number | null {
  const publishedAtMs = readNumberProperty(properties, "published_at_ms");
  if (publishedAtMs === null || publishedAtMs < 0) return null;
  return publishedAtMs;
}

/**
 * Rewrites the decided sentence in the vocabulary of this question.
 *
 * decideVerdict stays the authority on the verdict and the limits. Its wording talks
 * about paths, and this answer is about versions: a not_exposed here means specifically
 * that no version of the package in the slice falls in the advisory's range, and that is
 * the sentence someone reads before deciding not to roll back.
 */
function describeIntroducedVersion(
  decided: { verdict: Verdict; rationale: string; limits: AnswerLimit[] },
  evidence: IntroducedVersionEvidence,
): string {
  // An unknown verdict already names its own reason: the empty graph, the absent
  // subject, or the limit that cut the search short.
  if (decided.verdict === "unknown") return decided.rationale;

  if (decided.verdict === "not_exposed") {
    return `No published version of ${evidence.affectedPackage.packageKey} in the slice falls in the range stated by ${evidence.advisory.ghsaId}, and the slice holds that package's full closure, so this is a real negative.`;
  }

  const introducing = evidence.introducingVersion;
  if (introducing === null) {
    return `${evidence.advisory.ghsaId} affects ${evidence.affectedVersions.length} published versions of ${evidence.affectedPackage.packageKey}, but none of them carries a publish time or a parseable version, so which one introduced it is undecided.`;
  }

  const opening = `${evidence.affectedPackage.name}@${introducing.version} is the earliest version of ${evidence.affectedPackage.packageKey} that ${evidence.advisory.ghsaId} affects in the slice`;
  const truncating = decided.limits.filter(isTruncatingLimit);
  return truncating.length > 0
    ? `${opening}, but the search stopped early (${describeLimits(truncating)}), so an earlier affected version may exist.`
    : `${opening}, out of ${evidence.affectedVersions.length} affected versions.`;
}

/**
 * Turns a budget rejection into an abstaining answer, or null when the failure is
 * something else and the caller must propagate it.
 *
 * A budget rejection is a truncated answer, not a broken one: the UI has to say "we
 * could not finish" rather than render an empty version list, which reads as "nothing
 * was affected".
 */
function abstainOnBudget<TEvidence>(
  failure: Failure,
  rationale: string,
  evidence: TEvidence,
): AbstainingAnswer<TEvidence> | null {
  if (failure.reason !== "query_budget_exceeded") return null;
  return buildUnknownAnswer(rationale, evidence, [budgetLimitFromContext(failure.context)]);
}
