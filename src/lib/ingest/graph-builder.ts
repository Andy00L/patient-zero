import {
  type Ecosystem,
  type RelType,
  type ServiceSource,
  REL_TYPES,
  UNKNOWN_NUMERIC_VALUE,
  packageKey,
  versionKey,
} from "@/lib/graph/model";
import {
  type SliceCounts,
  type SliceManifest,
  SLICE_MANIFEST_VERSION,
} from "@/lib/graph/slice-manifest";
import { encodeStringLiteral } from "@/lib/hydra/cypher";
import {
  type GraphWriter,
  type NodeRef,
  type RelPropertiesByType,
  advisoryRef,
  maintainerRef,
  packageRef,
  serviceRef,
  versionRef,
} from "@/lib/ingest/writer";
import { type Failure, type Result, succeed } from "@/lib/result";

/**
 * The graph builder: turns fetched registry facts into a written graph.
 *
 * It sits between the API clients and the batch writer and owns three things none of
 * them can own alone.
 *
 *   1. DERIVED EDGES. Every RESOLVES_TO written here gets a DEPENDED_ON_BY written beside
 *      it. That reverse type is an index-shape choice, not a workaround for a missing
 *      argument: relDirection is a procedure argument that accepts "incoming", "outgoing"
 *      or "both" on all three path procedures, so "who depends on me" is equally
 *      expressible as an incoming walk over RESOLVES_TO. An outgoing walk over the stored
 *      reverse type reads the forward adjacency and an incoming walk drives the reverse
 *      index, which are different code paths with different costs, and
 *      scripts/measure-traversal.ts is what settles which one a given slice should use.
 *      Forgetting the reverse edge would not fail a single test against the writer; it
 *      would make every blast radius that reads the materialised shape come back empty,
 *      which reads as "nothing is exposed". sourceRef: docs/HYDRADB.md section 4.
 *
 *   2. STUBS AND HONESTY. A resolution can point at a version the fetch never reached.
 *      Dropping that edge would silently shrink the answer, so a stub Version is written
 *      instead and every package that can reach a stub is marked `partial` in the slice
 *      manifest. That marking is what turns an empty traversal into `unknown` rather
 *      than a false `not_exposed`, so it is a correctness output, not bookkeeping.
 *
 *   3. SELECTOR SAFETY. algo.MSpaths inlines its selector values as string literals in
 *      query text, and the `key` property is the selector. A key outside the engine's
 *      literal character set can be written and then never selected again, so keys are
 *      validated here, before anything reaches the graph. Validation reuses
 *      encodeStringLiteral rather than restating the pattern, so the two cannot drift.
 *
 * The input contract below is deliberately its own small domain type set rather than the
 * API clients' response types. The clients evolve with the registries; the graph does
 * not, and a builder coupled to a packument shape would have to change every time npm
 * adds a field.
 */

/** A package as the registry described it. */
export type PackageFacts = {
  ecosystem: Ecosystem;
  name: string;
  /**
   * Downloads in the last 7 days. Use UNKNOWN_NUMERIC_VALUE when the registry reported
   * none, never 0: 0 is a real download count and would read as an unused package.
   * sourceRef: src/lib/graph/model.ts UNKNOWN_NUMERIC_VALUE.
   */
  weeklyDownloads: number;
  /** Accounts with publish rights, the proxy for who can poison this package. */
  maintainerUsernames: readonly string[];
};

export type DeclaredDependency = {
  ecosystem: Ecosystem;
  name: string;
  /** The semver range verbatim from the manifest. */
  versionRange: string;
};

/** A concrete resolution, as deps.dev resolved it. */
export type ResolvedDependency = {
  ecosystem: Ecosystem;
  name: string;
  version: string;
};

export type VersionFacts = {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  /**
   * Publish time in epoch milliseconds, or UNKNOWN_NUMERIC_VALUE when the registry
   * reported none. sourceRef: src/lib/graph/model.ts UNKNOWN_NUMERIC_VALUE.
   */
  publishedAtMs: number;
  hasInstallScript: boolean;
  declaredDependencies: readonly DeclaredDependency[];
  resolvedDependencies: readonly ResolvedDependency[];
  /**
   * True when the fetch stopped short of this version's full resolution list, for
   * example at a depth limit. Propagates to the manifest as `partial`, because a
   * truncated closure cannot support a negative answer.
   */
  closureTruncated?: boolean;
};

export type ServiceResolution = {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  /** When the lockfile pinned it, epoch milliseconds. The valid-time clock. */
  resolvedAtMs: number;
};

export type ServiceFacts = {
  /**
   * The natural key, exactly as its source states it. Example: "svc:ledger-api".
   *
   * Stated rather than composed, which is the one way Service differs from the other
   * labels: a Package key is built from its ecosystem and name, while a service's key is
   * assigned by whatever inventory describes it, and every query, manifest entry and
   * fixture addresses the service by that assigned string.
   * sourceRef: src/lib/incidents/pack.ts INCIDENT_SERVICE_SCHEMA.key.
   */
  key: string;
  /**
   * Readable name, for display beside the key. Example: "ledger-api".
   *
   * Separate from the key for the same reason a Package node carries "chalk" next to the
   * key "npm:chalk": the key is the selector and the name is what a human reads. Writing
   * the key into both is what made the UI show "svc:ledger-api" as a service's name.
   * sourceRef: src/lib/graph/model.ts ServiceNode.
   */
  name: string;
  source: ServiceSource;
  resolutions: readonly ServiceResolution[];
};

/** One package an advisory affects, with the range facts the advisory stated. */
export type AdvisoryAffected = {
  ecosystem: Ecosystem;
  name: string;
  /** First affected version, or "" when the range is open ended. */
  introduced: string;
  /** First fixed version, or "" when unfixed. */
  fixed: string;
  /**
   * The versions inside the range, computed by the semver layer at ingest. HydraDB
   * cannot parse a range and has no `min`, so membership is precomputed and written as
   * AFFECTS_VERSION edges.
   */
  affectedVersions: readonly string[];
};

export type AdvisoryFacts = {
  ghsaId: string;
  /** Disclosure time in epoch milliseconds. The known-time clock. */
  publishedAtMs: number;
  modifiedAtMs: number;
  summary: string;
  affected: readonly AdvisoryAffected[];
};

export type TyposquatFacts = {
  suspect: { ecosystem: Ecosystem; name: string; version: string };
  target: { ecosystem: Ecosystem; name: string };
  editDistance: number;
};

/** Everything one ingest run gathered. */
export type IngestSlice = {
  packages: readonly PackageFacts[];
  versions: readonly VersionFacts[];
  services: readonly ServiceFacts[];
  advisories: readonly AdvisoryFacts[];
  typosquats: readonly TyposquatFacts[];
};

export function emptyIngestSlice(): IngestSlice {
  return { packages: [], versions: [], services: [], advisories: [], typosquats: [] };
}

export type BuildSkipCounts = {
  /** Names or versions rejected because they cannot be an MSpaths selector value. */
  unselectableKeys: number;
  /** Advisory entries naming a version that has no node, even as a stub. */
  advisoryVersionsWithoutNode: number;
  /** Typosquat edges dropped because an endpoint was unselectable. */
  typosquatEdgesDropped: number;
};

export type BuildReport = {
  /** The manifest the analysis layer reads to decide what an empty answer means. */
  manifest: SliceManifest;
  /** Natural keys of Version nodes written as stubs rather than fetched. */
  stubVersionKeys: string[];
  /** Natural keys of Package nodes written as stubs rather than fetched. */
  stubPackageKeys: string[];
  skipped: BuildSkipCounts;
  /** Human-readable degradations, copied into the manifest notes. */
  notes: string[];
};

export type BuildOptions = {
  /**
   * Manifest timestamp, passed in rather than read from the clock so an ingest is
   * reproducible and a test can assert on the manifest it produced.
   */
  generatedAtMs: number;
};

/**
 * Stages an entire slice into the writer and returns the manifest describing it.
 *
 * Two passes, deliberately. Every node is staged before any edge, because the writer
 * resolves an edge's endpoints through the id map and fails locally when one was never
 * staged. Interleaving would work for edges whose endpoints happen to come first and
 * fail for the rest, which is the kind of order dependence that shows up only on real
 * data.
 *
 * The caller flushes. This function stages, so a caller can build several slices into
 * one graph and flush once.
 */
export async function buildGraph(
  writer: GraphWriter,
  slice: IngestSlice,
  options: BuildOptions,
): Promise<Result<BuildReport, Failure>> {
  const plan = planSlice(slice);

  const nodesStaged = await stageNodes(writer, slice, plan);
  if (!nodesStaged.ok) return nodesStaged;

  const edgesStaged = await stageEdges(writer, slice, plan);
  if (!edgesStaged.ok) return edgesStaged;

  return succeed(buildReport(slice, plan, edgesStaged.value, options));
}

// ---------------------------------------------------------------------------
// Planning: decide what exists, what is a stub, and what cannot be written
// ---------------------------------------------------------------------------

/**
 * Everything the two staging passes need to agree on, computed once.
 *
 * Both passes have to make the same decision about every key: a node staged in pass one
 * and an edge endpoint rejected in pass two would leave an orphan, and the reverse would
 * fail the whole batch. Deciding up front removes the possibility of disagreement.
 */
type SlicePlan = {
  /** Version keys that came from a fetch, with their facts. */
  fetchedVersions: Map<string, VersionFacts>;
  /** Package keys that came from a fetch, with their facts. */
  fetchedPackages: Map<string, PackageFacts>;
  /** Version keys referenced by an edge but never fetched. */
  stubVersions: Map<string, ResolvedDependency>;
  /** Package keys referenced by an edge but never fetched. */
  stubPackages: Map<string, { ecosystem: Ecosystem; name: string }>;
  /** Maintainer keys, deduplicated across packages, that survived key validation. */
  maintainers: Map<string, { ecosystem: Ecosystem; username: string }>;
  /** Service keys that survived key validation, in input order. */
  serviceKeys: Set<string>;
  /** Advisory ids that survived key validation, in input order. */
  advisoryIds: Set<string>;
  /** Keys the engine could never use as a selector value, so nothing about them is written. */
  unselectableKeys: Set<string>;
  /**
   * Version to version resolution pairs, the RESOLVES_TO adjacency, used by
   * markPartialClosures to walk backward from every incomplete version.
   *
   * Closure specific on purpose. A service's RESOLVED pin is also a resolution, but its
   * source is a Service key rather than a Version key, so folding the two into one list
   * would feed markPartialClosures endpoints it cannot resolve. Reporting how many
   * resolution edges the graph holds is a separate job, done from the staged edge counts
   * rather than from this list.
   */
  closureEdges: Array<{ fromKey: string; toKey: string }>;
  /** Package keys whose closure is known to be incomplete. */
  partialPackageKeys: Set<string>;
  skipped: BuildSkipCounts;
  notes: string[];
};

function planSlice(slice: IngestSlice): SlicePlan {
  const plan: SlicePlan = {
    fetchedVersions: new Map(),
    fetchedPackages: new Map(),
    stubVersions: new Map(),
    stubPackages: new Map(),
    maintainers: new Map(),
    serviceKeys: new Set(),
    advisoryIds: new Set(),
    unselectableKeys: new Set(),
    closureEdges: [],
    partialPackageKeys: new Set(),
    skipped: { unselectableKeys: 0, advisoryVersionsWithoutNode: 0, typosquatEdgesDropped: 0 },
    notes: [],
  };

  for (const facts of slice.packages) {
    const key = packageKey(facts.ecosystem, facts.name);
    if (!recordSelectable(plan, key)) continue;
    plan.fetchedPackages.set(key, facts);

    for (const username of facts.maintainerUsernames) {
      const maintainerKey = maintainerKeyOf(facts.ecosystem, username);
      if (!recordSelectable(plan, maintainerKey)) continue;
      plan.maintainers.set(maintainerKey, { ecosystem: facts.ecosystem, username });
    }
  }

  for (const facts of slice.versions) {
    const key = versionKey(facts.ecosystem, facts.name, facts.version);
    if (!recordSelectable(plan, key)) continue;
    plan.fetchedVersions.set(key, facts);

    // Every version needs its package, whether or not the package was fetched: without
    // VERSION_OF there is no way to get from a package to its versions.
    requirePackage(plan, facts.ecosystem, facts.name);

    if (facts.closureTruncated === true) {
      plan.partialPackageKeys.add(packageKey(facts.ecosystem, facts.name));
    }
  }

  // Second sweep over versions, now that every fetched key is known, so a resolution
  // pointing at a fetched version is not mistaken for a stub because of input order.
  for (const facts of slice.versions) {
    const fromKey = versionKey(facts.ecosystem, facts.name, facts.version);
    if (!plan.fetchedVersions.has(fromKey)) continue;

    for (const declared of facts.declaredDependencies) {
      requirePackage(plan, declared.ecosystem, declared.name);
    }

    for (const resolved of facts.resolvedDependencies) {
      const toKey = versionKey(resolved.ecosystem, resolved.name, resolved.version);
      if (!recordSelectable(plan, toKey)) continue;

      if (!plan.fetchedVersions.has(toKey) && !plan.stubVersions.has(toKey)) {
        plan.stubVersions.set(toKey, resolved);
        requirePackage(plan, resolved.ecosystem, resolved.name);
      }
      plan.closureEdges.push({ fromKey, toKey });
    }
  }

  for (const facts of slice.services) {
    // The key is what gets validated, because the key is the selector value. A display
    // name never reaches a selector, so its character set is the writer's concern.
    if (!recordSelectable(plan, facts.key)) continue;
    plan.serviceKeys.add(facts.key);

    for (const resolution of facts.resolutions) {
      const key = versionKey(resolution.ecosystem, resolution.name, resolution.version);
      if (!recordSelectable(plan, key)) continue;
      if (!plan.fetchedVersions.has(key) && !plan.stubVersions.has(key)) {
        plan.stubVersions.set(key, resolution);
        requirePackage(plan, resolution.ecosystem, resolution.name);
      }
    }
  }

  for (const advisory of slice.advisories) {
    if (!recordSelectable(plan, advisory.ghsaId)) continue;
    plan.advisoryIds.add(advisory.ghsaId);

    for (const affected of advisory.affected) {
      requirePackage(plan, affected.ecosystem, affected.name);
    }
  }

  for (const typosquat of slice.typosquats) {
    requirePackage(plan, typosquat.target.ecosystem, typosquat.target.name);
  }

  // A package can be required as an edge endpoint before its own facts are read, so
  // anything that turned out to be fetched is dropped from the stub set here. Keeping the
  // two sets disjoint is what lets pass one stage each node exactly once.
  for (const key of plan.fetchedPackages.keys()) plan.stubPackages.delete(key);

  markPartialClosures(plan);

  if (plan.stubVersions.size > 0) {
    plan.notes.push(
      `${plan.stubVersions.size} versions were referenced but never fetched, so they are stubs and every package that reaches one is marked partial`,
    );
  }
  if (plan.skipped.unselectableKeys > 0) {
    plan.notes.push(
      `${plan.skipped.unselectableKeys} keys were skipped because they contain characters HydraDB cannot use as a selector literal`,
    );
  }

  return plan;
}

/** The Maintainer natural key. Kept in one place so the node and its edges agree. */
function maintainerKeyOf(ecosystem: Ecosystem, username: string): string {
  return `${ecosystem}:${username}`;
}


/**
 * Records a package as needing a node, as a stub when it was not fetched.
 *
 * Called from many places on purpose: any edge endpoint, any advisory target, any
 * typosquat target. The alternative, requiring the caller to have fetched every package
 * it mentions, would make a partial fetch unrepresentable.
 */
function requirePackage(plan: SlicePlan, ecosystem: Ecosystem, name: string): void {
  const key = packageKey(ecosystem, name);
  if (!recordSelectable(plan, key)) return;
  if (plan.fetchedPackages.has(key) || plan.stubPackages.has(key)) return;
  plan.stubPackages.set(key, { ecosystem, name });
}

/**
 * Checks a key against the engine's literal rules and remembers the verdict.
 *
 * Reuses encodeStringLiteral so the character set and length ceiling live in exactly one
 * place. The encoded value is discarded: only whether the engine would accept it matters
 * here.
 */
function recordSelectable(plan: SlicePlan, key: string): boolean {
  if (plan.unselectableKeys.has(key)) return false;
  if (encodeStringLiteral(key).ok) return true;

  plan.unselectableKeys.add(key);
  plan.skipped.unselectableKeys += 1;
  return false;
}

/**
 * Marks every package that can reach a stub or a truncated version as partial.
 *
 * This is the whole point of tracking stubs. A package whose closure ends in a stub has
 * an unknown remainder, so a traversal finding nothing proves nothing about it, and the
 * abstention model has to return `unknown` rather than `not_exposed`. The walk runs
 * backward over the resolution edges from the incomplete set, because "who can reach an
 * incomplete thing" is the question, not "what does this package reach".
 */
function markPartialClosures(plan: SlicePlan): void {
  const dependentsByKey = new Map<string, string[]>();
  for (const edge of plan.closureEdges) {
    const dependents = dependentsByKey.get(edge.toKey);
    if (dependents === undefined) dependentsByKey.set(edge.toKey, [edge.fromKey]);
    else dependents.push(edge.fromKey);
  }

  const incomplete: string[] = [...plan.stubVersions.keys()];
  for (const [key, facts] of plan.fetchedVersions) {
    if (facts.closureTruncated === true) incomplete.push(key);
  }

  const seen = new Set<string>(incomplete);
  const queue = [...incomplete];

  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) continue;

    const facts = plan.fetchedVersions.get(current) ?? plan.stubVersions.get(current);
    if (facts !== undefined) {
      plan.partialPackageKeys.add(packageKey(facts.ecosystem, facts.name));
    }

    for (const dependent of dependentsByKey.get(current) ?? []) {
      if (seen.has(dependent)) continue;
      seen.add(dependent);
      queue.push(dependent);
    }
  }
}

// ---------------------------------------------------------------------------
// Pass one: nodes
// ---------------------------------------------------------------------------

async function stageNodes(
  writer: GraphWriter,
  slice: IngestSlice,
  plan: SlicePlan,
): Promise<Result<void, Failure>> {
  for (const facts of plan.fetchedPackages.values()) {
    const staged = await writer.stagePackage({
      ecosystem: facts.ecosystem,
      name: facts.name,
      weekly_downloads: facts.weeklyDownloads,
    });
    if (!staged.ok) return staged;
  }

  for (const facts of plan.stubPackages.values()) {
    // UNKNOWN_NUMERIC_VALUE rather than 0: a package whose download count was never
    // fetched is not a package with no downloads, and the leaderboard must not add it
    // into a total. sourceRef: src/lib/graph/model.ts UNKNOWN_NUMERIC_VALUE.
    const staged = await writer.stagePackage({
      ecosystem: facts.ecosystem,
      name: facts.name,
      weekly_downloads: UNKNOWN_NUMERIC_VALUE,
    });
    if (!staged.ok) return staged;
  }

  for (const facts of plan.fetchedVersions.values()) {
    const staged = await writer.stageVersion({
      ecosystem: facts.ecosystem,
      name: facts.name,
      version: facts.version,
      published_at_ms: facts.publishedAtMs,
      has_install_script: facts.hasInstallScript,
    });
    if (!staged.ok) return staged;
  }

  for (const facts of plan.stubVersions.values()) {
    // A stub carries no publish clock, so it gets UNKNOWN_NUMERIC_VALUE rather than an
    // invented instant, and the analysis layer refuses to place a window on it.
    // has_install_script false on a stub is a claim the fetch cannot support, so the
    // manifest marks the package partial and the UI never reports "no install script"
    // for a version that was never inspected.
    // sourceRef: src/lib/graph/model.ts UNKNOWN_NUMERIC_VALUE.
    const staged = await writer.stageVersion({
      ecosystem: facts.ecosystem,
      name: facts.name,
      version: facts.version,
      published_at_ms: UNKNOWN_NUMERIC_VALUE,
      has_install_script: false,
    });
    if (!staged.ok) return staged;
  }

  for (const maintainer of plan.maintainers.values()) {
    const staged = await writer.stageMaintainer(maintainer);
    if (!staged.ok) return staged;
  }

  for (const facts of slice.services) {
    if (!plan.serviceKeys.has(facts.key)) continue;
    // The key and the readable name are written as two properties, the way a Package
    // writes "chalk" beside the key "npm:chalk". sourceRef: src/lib/graph/model.ts
    // NODE_PROPERTY_NAMES.Service.
    const staged = await writer.stageService({
      key: facts.key,
      name: facts.name,
      source: facts.source,
    });
    if (!staged.ok) return staged;
  }

  for (const advisory of slice.advisories) {
    if (!plan.advisoryIds.has(advisory.ghsaId)) continue;
    const staged = await writer.stageAdvisory({
      ghsa_id: advisory.ghsaId,
      published_at_ms: advisory.publishedAtMs,
      modified_at_ms: advisory.modifiedAtMs,
      // The summary is free advisory text, so it is truncated to stay inside the
      // engine's literal ceiling rather than failing an otherwise good ingest.
      summary: truncateSummary(advisory.summary),
    });
    if (!staged.ok) return staged;
  }

  return succeed(undefined);
}

// ---------------------------------------------------------------------------
// Pass two: edges
// ---------------------------------------------------------------------------

/**
 * How many edges of each relationship type actually reached the writer.
 *
 * The manifest reports a resolution edge count, and that number has to be a fact about
 * the graph rather than about the plan. It used to be `plan.closureEdges.length`, which
 * covers only the version to version RESOLVES_TO pairs, so a slice whose resolutions are
 * all lockfile pins reported zero over a graph holding every one of them. Counting here,
 * at the single point every edge passes through, is what keeps the number and the graph
 * from disagreeing again: a new edge type cannot be added without passing this tally, and
 * no call site has a counter of its own to forget.
 *
 * One caveat worth stating: the writer suppresses an exact duplicate edge and still
 * reports success, so a slice that states the same edge twice is counted twice here and
 * written once. The count is therefore an upper bound, exact for any input that does not
 * repeat itself, and the writer's own duplicateEdgesSkipped reports the difference.
 * sourceRef: src/lib/ingest/writer.ts GraphWriter.stageEdge.
 */
type StagedEdgeCounts = Map<RelType, number>;

/** Stages one edge and tallies it. Every edge in this file goes through here. */
async function stageCountedEdge<TRelType extends RelType>(
  writer: GraphWriter,
  staged: StagedEdgeCounts,
  relType: TRelType,
  from: NodeRef,
  to: NodeRef,
  properties: RelPropertiesByType[TRelType],
): Promise<Result<void, Failure>> {
  const written = await writer.stageEdge(relType, from, to, properties);
  if (!written.ok) return written;

  staged.set(relType, (staged.get(relType) ?? 0) + 1);
  return written;
}

/**
 * Every resolution edge in the graph, of both kinds.
 *
 * RESOLVES_TO is a dependency resolution and RESOLVED is a lockfile pin. Both answer
 * "this artifact resolved to that exact version", and the manifest's single count covers
 * both, so a graph built from lockfiles alone does not report itself as holding no
 * resolutions at all. sourceRef: src/lib/graph/model.ts REL_TYPES.
 */
function countResolutionEdges(staged: StagedEdgeCounts): number {
  return (staged.get(REL_TYPES.resolvesTo) ?? 0) + (staged.get(REL_TYPES.resolved) ?? 0);
}

async function stageEdges(
  writer: GraphWriter,
  slice: IngestSlice,
  plan: SlicePlan,
): Promise<Result<StagedEdgeCounts, Failure>> {
  const staged: StagedEdgeCounts = new Map();

  const versionOf = await stageVersionOfEdges(writer, staged, plan);
  if (!versionOf.ok) return versionOf;

  const dependencies = await stageDependencyEdges(writer, staged, slice, plan);
  if (!dependencies.ok) return dependencies;

  const maintains = await stageMaintainsEdges(writer, staged, plan);
  if (!maintains.ok) return maintains;

  const resolved = await stageResolvedEdges(writer, staged, slice, plan);
  if (!resolved.ok) return resolved;

  const advisories = await stageAdvisoryEdges(writer, staged, slice, plan);
  if (!advisories.ok) return advisories;

  const typosquats = await stageTyposquatEdges(writer, staged, slice, plan);
  if (!typosquats.ok) return typosquats;

  return succeed(staged);
}

async function stageVersionOfEdges(
  writer: GraphWriter,
  staged: StagedEdgeCounts,
  plan: SlicePlan,
): Promise<Result<void, Failure>> {
  for (const facts of allVersions(plan)) {
    const written = await stageCountedEdge(
      writer,
      staged,
      "VERSION_OF",
      versionRef(facts.ecosystem, facts.name, facts.version),
      packageRef(facts.ecosystem, facts.name),
      {},
    );
    if (!written.ok) return written;
  }
  return succeed(undefined);
}

/**
 * Writes the declared ranges, the concrete resolutions, and the reverse of every
 * resolution.
 *
 * DEPENDED_ON_BY is written here, next to its forward edge, so the two cannot get out of
 * step. It is an index-shape choice rather than a workaround: direction is a procedure
 * argument, relDirection accepts "incoming", "outgoing" or "both", so "who depends on this
 * compromised version" is equally expressible as an incoming walk over RESOLVES_TO. An
 * outgoing walk over the stored reverse type reads the forward adjacency while an incoming
 * walk drives the reverse index, two code paths with different costs that are not
 * interchangeable on performance grounds, and scripts/measure-traversal.ts is what settles
 * which one a given slice should use. sourceRef: docs/HYDRADB.md section 4.
 */
async function stageDependencyEdges(
  writer: GraphWriter,
  staged: StagedEdgeCounts,
  slice: IngestSlice,
  plan: SlicePlan,
): Promise<Result<void, Failure>> {
  for (const facts of slice.versions) {
    const fromKey = versionKey(facts.ecosystem, facts.name, facts.version);
    if (!plan.fetchedVersions.has(fromKey)) continue;

    const from = versionRef(facts.ecosystem, facts.name, facts.version);

    for (const declared of facts.declaredDependencies) {
      if (plan.unselectableKeys.has(packageKey(declared.ecosystem, declared.name))) continue;
      const written = await stageCountedEdge(
        writer,
        staged,
        "DEPENDS_ON",
        from,
        packageRef(declared.ecosystem, declared.name),
        { version_range: truncateRange(declared.versionRange) },
      );
      if (!written.ok) return written;
    }

    for (const resolved of facts.resolvedDependencies) {
      const toKey = versionKey(resolved.ecosystem, resolved.name, resolved.version);
      if (plan.unselectableKeys.has(toKey)) continue;

      const to = versionRef(resolved.ecosystem, resolved.name, resolved.version);

      const forward = await stageCountedEdge(writer, staged, "RESOLVES_TO", from, to, {});
      if (!forward.ok) return forward;

      const reverse = await stageCountedEdge(writer, staged, "DEPENDED_ON_BY", to, from, {});
      if (!reverse.ok) return reverse;
    }
  }
  return succeed(undefined);
}

async function stageMaintainsEdges(
  writer: GraphWriter,
  staged: StagedEdgeCounts,
  plan: SlicePlan,
): Promise<Result<void, Failure>> {
  for (const facts of plan.fetchedPackages.values()) {
    const to = packageRef(facts.ecosystem, facts.name);
    for (const username of facts.maintainerUsernames) {
      if (!plan.maintainers.has(maintainerKeyOf(facts.ecosystem, username))) continue;
      const written = await stageCountedEdge(
        writer,
        staged,
        "MAINTAINS",
        maintainerRef(facts.ecosystem, username),
        to,
        {},
      );
      if (!written.ok) return written;
    }
  }
  return succeed(undefined);
}

async function stageResolvedEdges(
  writer: GraphWriter,
  staged: StagedEdgeCounts,
  slice: IngestSlice,
  plan: SlicePlan,
): Promise<Result<void, Failure>> {
  for (const facts of slice.services) {
    if (!plan.serviceKeys.has(facts.key)) continue;
    const from = serviceRef(facts.key);

    for (const resolution of facts.resolutions) {
      const key = versionKey(resolution.ecosystem, resolution.name, resolution.version);
      if (plan.unselectableKeys.has(key)) continue;

      const written = await stageCountedEdge(
        writer,
        staged,
        "RESOLVED",
        from,
        versionRef(resolution.ecosystem, resolution.name, resolution.version),
        { resolved_at_ms: resolution.resolvedAtMs },
      );
      if (!written.ok) return written;
    }
  }
  return succeed(undefined);
}

async function stageAdvisoryEdges(
  writer: GraphWriter,
  staged: StagedEdgeCounts,
  slice: IngestSlice,
  plan: SlicePlan,
): Promise<Result<void, Failure>> {
  for (const advisory of slice.advisories) {
    if (!plan.advisoryIds.has(advisory.ghsaId)) continue;
    const from = advisoryRef(advisory.ghsaId);

    for (const affected of advisory.affected) {
      if (plan.unselectableKeys.has(packageKey(affected.ecosystem, affected.name))) continue;

      const stagedAffects = await stageCountedEdge(
        writer,
        staged,
        "AFFECTS",
        from,
        packageRef(affected.ecosystem, affected.name),
        { introduced: affected.introduced, fixed: affected.fixed },
      );
      if (!stagedAffects.ok) return stagedAffects;

      for (const version of affected.affectedVersions) {
        const key = versionKey(affected.ecosystem, affected.name, version);
        // An advisory can name a version the fetch never saw. Writing the edge would
        // fail on a missing endpoint, so it is counted and disclosed instead: the
        // introduced-version answer then reports a truncation rather than a wrong first
        // affected version.
        if (!plan.fetchedVersions.has(key) && !plan.stubVersions.has(key)) {
          plan.skipped.advisoryVersionsWithoutNode += 1;
          continue;
        }

        const stagedVersion = await stageCountedEdge(
          writer,
          staged,
          "AFFECTS_VERSION",
          from,
          versionRef(affected.ecosystem, affected.name, version),
          {},
        );
        if (!stagedVersion.ok) return stagedVersion;
      }
    }
  }

  if (plan.skipped.advisoryVersionsWithoutNode > 0) {
    plan.notes.push(
      `${plan.skipped.advisoryVersionsWithoutNode} advisory version references had no node in the slice, so those AFFECTS_VERSION edges are missing`,
    );
  }

  return succeed(undefined);
}

async function stageTyposquatEdges(
  writer: GraphWriter,
  staged: StagedEdgeCounts,
  slice: IngestSlice,
  plan: SlicePlan,
): Promise<Result<void, Failure>> {
  for (const typosquat of slice.typosquats) {
    const suspectKey = versionKey(
      typosquat.suspect.ecosystem,
      typosquat.suspect.name,
      typosquat.suspect.version,
    );
    const targetKey = packageKey(typosquat.target.ecosystem, typosquat.target.name);

    const suspectExists =
      plan.fetchedVersions.has(suspectKey) || plan.stubVersions.has(suspectKey);
    if (!suspectExists || plan.unselectableKeys.has(targetKey)) {
      plan.skipped.typosquatEdgesDropped += 1;
      continue;
    }

    const written = await stageCountedEdge(
      writer,
      staged,
      "TYPOSQUAT_OF",
      versionRef(typosquat.suspect.ecosystem, typosquat.suspect.name, typosquat.suspect.version),
      packageRef(typosquat.target.ecosystem, typosquat.target.name),
      { edit_distance: typosquat.editDistance },
    );
    if (!written.ok) return written;
  }

  if (plan.skipped.typosquatEdgesDropped > 0) {
    plan.notes.push(
      `${plan.skipped.typosquatEdgesDropped} typosquat edges were dropped because an endpoint is not in the slice`,
    );
  }

  return succeed(undefined);
}

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

/**
 * Builds the slice manifest.
 *
 * A package is `closed` only when nothing in its closure is a stub and no version of it
 * reported a truncated fetch. Everything else is `partial`. A package absent from both
 * lists reads as `absent`, which is the correct answer for a stub-only package: it has a
 * node so a traversal can cross it, but nothing about its own dependents was ever
 * fetched, so no negative answer about it is supportable.
 *
 * The resolution count comes from `stagedEdges`, the tally of what pass two actually
 * wrote, rather than from anything the plan holds. A manifest that describes the graph has
 * to be counted off the graph.
 */
function buildReport(
  slice: IngestSlice,
  plan: SlicePlan,
  stagedEdges: StagedEdgeCounts,
  options: BuildOptions,
): BuildReport {
  const closedPackageKeys: string[] = [];
  for (const key of plan.fetchedPackages.keys()) {
    if (!plan.partialPackageKeys.has(key)) closedPackageKeys.push(key);
  }

  const partialPackageKeys = [...plan.partialPackageKeys].filter((key) =>
    plan.fetchedPackages.has(key),
  );

  const closedServiceKeys: string[] = [];
  for (const facts of slice.services) {
    if (!plan.serviceKeys.has(facts.key)) continue;
    // A service is closed when every version it resolved is a fetched version, not a
    // stub: its lockfile is only fully represented if the whole closure was reached.
    const allFetched = facts.resolutions.every((resolution) =>
      plan.fetchedVersions.has(
        versionKey(resolution.ecosystem, resolution.name, resolution.version),
      ),
    );
    if (allFetched) closedServiceKeys.push(facts.key);
  }

  const ecosystems = new Set<Ecosystem>();
  for (const facts of plan.fetchedPackages.values()) ecosystems.add(facts.ecosystem);
  for (const facts of plan.fetchedVersions.values()) ecosystems.add(facts.ecosystem);

  const counts: SliceCounts = {
    packages: plan.fetchedPackages.size + plan.stubPackages.size,
    versions: plan.fetchedVersions.size + plan.stubVersions.size,
    maintainers: plan.maintainers.size,
    services: plan.serviceKeys.size,
    advisories: plan.advisoryIds.size,
    resolutionEdges: countResolutionEdges(stagedEdges),
  };

  const manifest: SliceManifest = {
    version: SLICE_MANIFEST_VERSION,
    generatedAtMs: options.generatedAtMs,
    ecosystems: [...ecosystems],
    closedPackageKeys: closedPackageKeys.sort(),
    partialPackageKeys: partialPackageKeys.sort(),
    closedServiceKeys: closedServiceKeys.sort(),
    counts,
    notes: [...plan.notes],
  };

  return {
    manifest,
    stubVersionKeys: [...plan.stubVersions.keys()].sort(),
    stubPackageKeys: [...plan.stubPackages.keys()].sort(),
    skipped: { ...plan.skipped },
    notes: [...plan.notes],
  };
}

function* allVersions(plan: SlicePlan): Generator<{
  ecosystem: Ecosystem;
  name: string;
  version: string;
}> {
  for (const facts of plan.fetchedVersions.values()) yield facts;
  for (const facts of plan.stubVersions.values()) yield facts;
}

/**
 * Advisory summaries are free text and can be long. The engine's literal ceiling is 512
 * characters, so the summary is cut to fit with room for the marker, because losing the
 * tail of a sentence is better than losing the advisory.
 */
const MAX_SUMMARY_CHARACTERS = 480;

function truncateSummary(summary: string): string {
  const collapsed = summary.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MAX_SUMMARY_CHARACTERS) return collapsed;
  return `${collapsed.slice(0, MAX_SUMMARY_CHARACTERS)} ...`;
}

/** Semver ranges are short in practice, but a malformed manifest can hold anything. */
const MAX_RANGE_CHARACTERS = 200;

function truncateRange(range: string): string {
  const collapsed = range.replace(/\s+/g, " ").trim();
  return collapsed.length <= MAX_RANGE_CHARACTERS
    ? collapsed
    : collapsed.slice(0, MAX_RANGE_CHARACTERS);
}
