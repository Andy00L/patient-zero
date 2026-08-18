import {
  type AbstainingAnswer,
  type AnswerLimit,
  type Verdict,
  buildAnswer,
  buildUnknownAnswer,
  budgetLimitFromContext,
  decideVerdict,
  detectHopLimit,
  detectPathLimit,
  weakestCoverage,
} from "@/lib/analysis/abstention";
import {
  type GraphGateway,
  type GraphPath,
  type GraphPathNode,
  type GraphProperties,
  isGraphEmpty,
  readBooleanProperty,
  readNumberProperty,
  readStringProperty,
} from "@/lib/graph/gateway";
import { type Ecosystem, packageKey, parsePackageKey, parseVersionKey } from "@/lib/graph/model";
import type { Coverage, SliceCoverage } from "@/lib/graph/slice-manifest";
import { type Failure, type Result, fail, succeed } from "@/lib/result";

/**
 * Maintainer infection surface: whose account, if compromised tomorrow, does the most
 * damage.
 *
 * This is the predictive half of the product. blast-radius.ts reports on a version that
 * already went bad; this module ranks accounts that have not gone bad yet, so every
 * number it produces has to say whether it was measured or assumed.
 *
 * Hop 1 is measured. A MAINTAINS edge is a publish-rights fact from the registry: a
 * leaked npm token publishes to every package the account can publish to, and from
 * there the dependent walk and the service intersection are the same graph facts
 * blast-radius.ts uses. Nothing in `direct` is a model.
 *
 * Hop 2 is a stated worst case. Everything about it lives behind `isModelled: true` in
 * `modelled`, and it is never summed into a hop-1 total.
 *
 * Four engine facts decide the algorithm:
 *
 *   1. Path procedures take a direction: relDirection accepts "incoming", "outgoing", or
 *      "both", and every request here states it. MAINTAINS is read forwards because that
 *      is the way the edge runs (Maintainer to Package), and DEPENDED_ON_BY is read
 *      forwards because the materialised reverse of RESOLVES_TO is an index-shape choice
 *      settled by scripts/measure-traversal.ts, not a workaround for a missing argument.
 *      sourceRef: docs/HYDRADB.md section 4.
 *
 *   2. VERSION_OF runs Version to Package (REL_ENDPOINTS in src/lib/graph/model.ts), so
 *      "the versions of this package" is an incoming read, which a one-hop pattern
 *      expresses with the arrow. That is why this step is one neighbors call per distinct
 *      package rather than another traversal: a one-hop row query returns the ids without
 *      hydrating a whole path per version, and path bytes are what the engine meters.
 *
 *   3. algo.MSpaths selects its sources by string natural key rather than by integer id,
 *      so one pass can be seeded with every maintainer at once and attribution survives
 *      the batch through path.nodes[0]. This is what keeps the leaderboard a handful of
 *      requests instead of one per maintainer. sourceRef: docs/HYDRADB.md section 4.
 *
 *   4. RESOLVED runs Service to Version and has no materialised reverse type, so the
 *      services that consume a reachable version are found by walking from the small
 *      side: enumerate the Service nodes, expand each one forwards, intersect. Same
 *      reason and same shape as blast-radius.ts.
 *
 * Every answer is an AbstainingAnswer, and every answer is a lower bound on the slice:
 * a maintainer's packages that were never ingested are not counted, which the rationale
 * states and the leaderboard carries as an explicit field.
 */

/** A package an account can publish to. Hop 1, from a MAINTAINS edge. */
export type PublishablePackage = {
  packageKey: string;
  ecosystem: Ecosystem;
  name: string;
  /**
   * Downloads in the last 7 days at ingest time, or null when the registry reported
   * none. The graph stores that case as -1, which is a sentinel and not a count.
   * sourceRef: src/lib/graph/model.ts PackageNode.weekly_downloads.
   */
  weeklyDownloads: number | null;
  /** Versions of this package in the slice: the seeds of the dependent walk. */
  versionCount: number;
};

/** A service that would be running poisoned code if this account fell. */
export type ReachedService = {
  serviceKey: string;
  serviceName: string;
  /** Hops from the service to a version the account controls. 1 is a direct dependency. */
  hopCount: number;
};

/**
 * Hop 1: what a leaked publish token reaches, from data alone.
 *
 * Every field here is a count over graph facts. A reader can act on these numbers
 * without qualifying them, which is exactly what separates them from `modelled`.
 */
export type DirectSurface = {
  /** Ordered by package key, so two runs render identically. */
  packages: PublishablePackage[];
  /** Distinct versions of those packages: the seeds of the dependent walk. */
  versionCount: number;
  /** Distinct versions that transitively depend on a seed version. */
  dependentVersionCount: number;
  /** Distinct packages those dependent versions belong to. */
  dependentPackageCount: number;
  /** Ordered by hop count ascending, then by name. Closest damage first. */
  reachedServices: ReachedService[];
  /**
   * Weekly download volume under this account: the sum of `weekly_downloads` over
   * `packages`, with the -1 sentinel excluded rather than added as a negative number.
   *
   * The sum covers the account's own packages, not the packages downstream of them.
   * `weekly_downloads` lives on Package nodes, and the dependent walk hydrates Version
   * nodes; pulling the downstream Package nodes in would either cost one request per
   * dependent package or spend the shared path budget on package tails, shrinking the
   * dependent set the service intersection is computed from.
   */
  reachableWeeklyDownloads: number;
  /** Packages whose registry reported no download count. Kept out of the sum above. */
  packagesWithoutDownloadCount: number;
};

/**
 * The sentence that has to travel with every hop-2 number.
 *
 * Exported so the UI and the README state the assumption in the same words the
 * evidence carries, instead of paraphrasing it into something weaker.
 */
export const HOP_TWO_ASSUMPTION =
  "Stated worst case: a worm in a poisoned package runs in the environment of every project that depends on it and harvests that project's publish token. The slice holds no data on whose CI runs what.";

/**
 * Hop 2: the accounts a worm could plausibly reach next. Modelled, never observed.
 *
 * The mechanism being assumed is install-time or build-time execution in a downstream
 * project's environment. The project has no data on whose CI runs what, so these counts
 * are a stated worst case and sit behind `isModelled` rather than in `DirectSurface`.
 *
 * A candidate is a dependent version whose package this account does not already
 * control: poisoning a second package of your own is still hop 1, not propagation.
 */
export type ModelledInfectionSurface = {
  /**
   * Always true, and typed as the literal so no code can build a modelled block that
   * claims to be a measurement.
   */
  isModelled: true;
  /** Downstream versions whose build would run the poisoned code. */
  candidateVersionCount: number;
  /** Distinct packages those versions belong to: one publish account each, at least. */
  candidatePackageCount: number;
  /**
   * The higher-confidence subset: candidates whose manifest already declares an install
   * script, which is the mechanism that would actually run.
   * sourceRef: src/lib/graph/model.ts VersionNode.has_install_script.
   */
  candidateVersionsWithInstallScript: number;
  /** Distinct packages of that higher-confidence subset. */
  candidatePackagesWithInstallScript: number;
  /** The assumption, verbatim, so the number cannot be rendered without it. */
  assumption: string;
};

export type MaintainerSubject = {
  /** `ecosystem:username`, as stored in the Maintainer node's `key` property. */
  maintainerKey: string;
  ecosystem: Ecosystem;
  username: string;
  /** null when the account is not a node in the slice. */
  nodeId: number | null;
};

export type MaintainerSurface = {
  subject: MaintainerSubject;
  direct: DirectSurface;
  modelled: ModelledInfectionSurface;
};

export type MaintainerLeaderboard = {
  /** Ranked by reachable services, then by weekly downloads. Most damage first. */
  rows: MaintainerSurface[];
  /** Distinct maintainer keys asked about. */
  maintainersRequested: number;
  /**
   * Keys that hold no rank because they have no MAINTAINS edge in the slice. Telling
   * "not a node" from "node with no ingested packages" would cost one key resolution
   * per maintainer, which is the exact cost the batched pass exists to avoid, so both
   * cases land here.
   */
  unrankedMaintainerKeys: string[];
  /** Service nodes examined for the intersection, for the scan_capped limit. */
  servicesConsidered: number;
  /**
   * Always true. A maintainer's packages outside the ingested slice are not counted, so
   * every rank is a lower bound on the slice and never a global claim.
   */
  isSliceLowerBound: true;
};

export type MaintainerSurfaceOptions = {
  /**
   * Hop ceiling on the dependent walk. Eight matches blast-radius.ts, which measured it
   * against the deepest real resolution chain in this project while leaving headroom
   * under the engine's 16 hop cap.
   */
  maxHops?: number;
  /**
   * Path ceiling per traversal. A popular package produces enormously many distinct
   * routes and the surface only needs each dependent once.
   */
  pathCount?: number;
  /** Ceiling on Service nodes enumerated. Reaching it is a scan_capped limit. */
  maxServices?: number;
  /** Ceiling on RESOLVED edges read per service. A lockfile has a few thousand. */
  resolvedEdgesPerService?: number;
  /** Ceiling on versions read per package over VERSION_OF. */
  versionsPerPackage?: number;
};

/** Hop ceiling on the dependent walk. sourceRef: src/lib/analysis/blast-radius.ts. */
const DEFAULT_MAX_HOPS = 8;
/** Paths per traversal. sourceRef: src/lib/analysis/blast-radius.ts. */
const DEFAULT_PATH_COUNT = 20_000;
/** Service nodes enumerated. sourceRef: src/lib/analysis/blast-radius.ts. */
const DEFAULT_MAX_SERVICES = 5_000;
/** RESOLVED edges per service. sourceRef: src/lib/analysis/blast-radius.ts. */
const DEFAULT_RESOLVED_EDGES_PER_SERVICE = 20_000;
/**
 * Versions read per package. A busy npm package has a few thousand published versions
 * and the slice holds fewer, so this is generous; reaching it is a scan_capped limit.
 */
const DEFAULT_VERSIONS_PER_PACKAGE = 5_000;

/** The caveat every answer from this module carries, in the rationale. */
const SLICE_LOWER_BOUND_CAVEAT =
  "Packages outside the ingested slice are not counted, so this reach is a lower bound on the slice and not a global claim.";

/** Subject label for a multi-maintainer answer, used in the rationale and its limits. */
const LEADERBOARD_SUBJECT = "The requested maintainer set";

export type MaintainerSurfaceRequest = {
  gateway: GraphGateway;
  coverage: SliceCoverage;
  /** The account, as `ecosystem:username`. */
  maintainerKey: string;
  options?: MaintainerSurfaceOptions;
};

export type MaintainerLeaderboardRequest = {
  gateway: GraphGateway;
  coverage: SliceCoverage;
  /** Accounts to rank, as `ecosystem:username`. Duplicates are collapsed. */
  maintainerKeys: readonly string[];
  options?: MaintainerSurfaceOptions;
};

/**
 * Answers "how much damage does this one account do", with the hop-1 facts and the
 * hop-2 model kept apart.
 *
 * Engine requests: 3 + P + ceil(V / 2048) + ceil(V / 256) + S + ceil(S / 2048), where P
 * is the packages the account maintains, V their versions, and S the Service nodes in
 * the slice. The three fixed calls are the key resolution, the Version count and the
 * MAINTAINS pass; the P and S terms are one-hop expansions, and the ceilings are the
 * gateway's own chunking. An account that is not in the slice costs the three fixed
 * calls and nothing else.
 *
 * Returns a Failure only when the graph itself could not be read. A missing account, a
 * slice that cannot decide, and a traversal cut short by a budget are all answers, and
 * come back as an `unknown` verdict carrying the reason.
 */
export async function computeMaintainerSurface(
  request: MaintainerSurfaceRequest,
): Promise<Result<AbstainingAnswer<MaintainerSurface>, Failure>> {
  const parsed = parseMaintainerKey(request.maintainerKey);
  if (parsed === null) {
    return fail(
      "invalid_input",
      `[computeMaintainerSurface] "${request.maintainerKey}" is not an ecosystem:username key`,
    );
  }

  const options = resolveOptions(request.options);

  // The key resolution is the one call that separates "no such account" from "an
  // account whose packages were never ingested". Both produce zero MAINTAINS paths, and
  // they are different answers.
  const resolved = await request.gateway.resolveNodeIds({
    label: "Maintainer",
    keys: [request.maintainerKey],
  });
  if (!resolved.ok) return resolved;

  const nodeId = resolved.value.get(request.maintainerKey) ?? null;
  const subject: MaintainerSubject = {
    maintainerKey: request.maintainerKey,
    ecosystem: parsed.ecosystem,
    username: parsed.username,
    nodeId,
  };

  const collected = await collectMaintainerSurfaces({
    gateway: request.gateway,
    maintainerKeys: [request.maintainerKey],
    options,
  });
  if (!collected.ok) {
    // A budget rejection is a truncated answer, not a broken one: the UI has to say
    // "we could not finish" rather than render a surface of zero.
    if (collected.failure.reason === "query_budget_exceeded") {
      return succeed(
        buildUnknownAnswer(
          `The infection surface of ${request.maintainerKey} exceeded an engine budget, so its reach is incomplete. ${SLICE_LOWER_BOUND_CAVEAT}`,
          buildEmptySurface(subject),
          [budgetLimitFromContext(collected.failure.context)],
        ),
      );
    }
    return collected;
  }

  if (nodeId === null) {
    // Coverage is passed as absent regardless of what the manifest says about any
    // package: the question was asked about this account, and there is no node to walk
    // from.
    return succeed(
      buildAnswer(
        withLowerBoundCaveat(
          decideVerdict({
            foundEvidence: false,
            subjectCoverage: "absent",
            subjectKey: request.maintainerKey,
            limits: collected.value.limits,
            graphIsEmpty: collected.value.graphIsEmpty,
          }),
        ),
        buildEmptySurface(subject),
      ),
    );
  }

  const surface =
    collected.value.surfacesByMaintainerKey.get(request.maintainerKey) ??
    buildEmptySurface(subject);

  // Publish rights to even one package in the slice is a concrete path, which is what
  // the exposed verdict means here. How much damage that path carries is in the
  // evidence, not in the verdict.
  return succeed(
    buildAnswer(
      withLowerBoundCaveat(
        decideVerdict({
          foundEvidence: surface.direct.packages.length > 0,
          subjectCoverage: describeAccountCoverage(request.coverage, surface.direct.packages),
          subjectKey: request.maintainerKey,
          limits: collected.value.limits,
          graphIsEmpty: collected.value.graphIsEmpty,
        }),
      ),
      surface,
    ),
  );
}

/**
 * The single-point-of-failure leaderboard: the same computation over many accounts,
 * batched so the cost does not grow with the number of accounts.
 *
 * Engine requests: 2 + ceil(M / 256) + P + ceil(V / 2048) + ceil(V / 256) + S +
 * ceil(S / 2048), where M is the accounts asked about, P the distinct packages they
 * maintain, V the versions of those packages, and S the Service nodes in the slice. M
 * enters only through the gateway's 256-key selector chunking, so ranking 500 accounts
 * costs two MAINTAINS calls rather than 500, and no account costs a request of its own.
 * sourceRef: src/lib/hydra/hydra-gateway.ts SELECTOR_CHUNK_SIZE.
 *
 * The leaderboard is precomputed by an offline script, so P and S requests are
 * affordable; one request per maintainer would not be.
 *
 * One answer wraps the whole ranked list, because the passes are shared and a
 * truncation in any of them truncates every row.
 */
export async function rankMaintainerSurfaces(
  request: MaintainerLeaderboardRequest,
): Promise<Result<AbstainingAnswer<MaintainerLeaderboard>, Failure>> {
  const requestedKeys = [...new Set(request.maintainerKeys)];
  if (requestedKeys.length === 0) {
    return fail("invalid_input", "[rankMaintainerSurfaces] no maintainer keys were given");
  }

  const options = resolveOptions(request.options);

  const collected = await collectMaintainerSurfaces({
    gateway: request.gateway,
    maintainerKeys: requestedKeys,
    options,
  });
  if (!collected.ok) {
    if (collected.failure.reason === "query_budget_exceeded") {
      return succeed(
        buildUnknownAnswer(
          `Ranking ${requestedKeys.length} accounts exceeded an engine budget, so the leaderboard is incomplete. ${SLICE_LOWER_BOUND_CAVEAT}`,
          buildEmptyLeaderboard(requestedKeys),
          [budgetLimitFromContext(collected.failure.context)],
        ),
      );
    }
    return collected;
  }

  const ranked = [...collected.value.surfacesByMaintainerKey.values()].sort(compareSurfaces);
  const unrankedMaintainerKeys = requestedKeys.filter(
    (maintainerKey) => !collected.value.surfacesByMaintainerKey.has(maintainerKey),
  );

  const leaderboard: MaintainerLeaderboard = {
    rows: ranked,
    maintainersRequested: requestedKeys.length,
    unrankedMaintainerKeys,
    servicesConsidered: collected.value.servicesConsidered,
    isSliceLowerBound: true,
  };

  const firstKey = requestedKeys[0];
  const subjectKey =
    requestedKeys.length === 1 && firstKey !== undefined ? firstKey : LEADERBOARD_SUBJECT;

  return succeed(
    buildAnswer(
      withLowerBoundCaveat(
        decideVerdict({
          foundEvidence: ranked.length > 0,
          subjectCoverage: describeLeaderboardCoverage(
            request.coverage,
            ranked,
            unrankedMaintainerKeys.length,
          ),
          subjectKey,
          limits: collected.value.limits,
          graphIsEmpty: collected.value.graphIsEmpty,
        }),
      ),
      leaderboard,
    ),
  );
}

/** Reachable services first, then download volume, then the key for a stable order. */
function compareSurfaces(left: MaintainerSurface, right: MaintainerSurface): number {
  const serviceDifference =
    right.direct.reachedServices.length - left.direct.reachedServices.length;
  if (serviceDifference !== 0) return serviceDifference;

  const downloadDifference =
    right.direct.reachableWeeklyDownloads - left.direct.reachableWeeklyDownloads;
  if (downloadDifference !== 0) return downloadDifference;

  return left.subject.maintainerKey.localeCompare(right.subject.maintainerKey);
}

// ---------------------------------------------------------------------------
// The shared computation
// ---------------------------------------------------------------------------

type ResolvedOptions = {
  maxHops: number;
  pathCount: number;
  maxServices: number;
  resolvedEdgesPerService: number;
  versionsPerPackage: number;
};

function resolveOptions(options: MaintainerSurfaceOptions | undefined): ResolvedOptions {
  return {
    maxHops: options?.maxHops ?? DEFAULT_MAX_HOPS,
    pathCount: options?.pathCount ?? DEFAULT_PATH_COUNT,
    maxServices: options?.maxServices ?? DEFAULT_MAX_SERVICES,
    resolvedEdgesPerService:
      options?.resolvedEdgesPerService ?? DEFAULT_RESOLVED_EDGES_PER_SERVICE,
    versionsPerPackage: options?.versionsPerPackage ?? DEFAULT_VERSIONS_PER_PACKAGE,
  };
}

type SurfaceCollectionRequest = {
  gateway: GraphGateway;
  maintainerKeys: readonly string[];
  options: ResolvedOptions;
};

type SurfaceCollection = {
  /** One entry per account that holds at least one MAINTAINS edge in the slice. */
  surfacesByMaintainerKey: Map<string, MaintainerSurface>;
  /** Limits from the shared passes, so they apply to every account in the batch. */
  limits: AnswerLimit[];
  graphIsEmpty: boolean;
  servicesConsidered: number;
};

/**
 * The whole computation, for one account or for five hundred.
 *
 * Both entry points share this so the single-account answer and the leaderboard row for
 * the same account cannot drift apart. The batching is what makes that affordable: the
 * MAINTAINS pass, the dependent walk and the service intersection are each one pass over
 * the union of the inputs, and attribution back to individual accounts happens in
 * TypeScript through the maps built on the way.
 */
async function collectMaintainerSurfaces(
  request: SurfaceCollectionRequest,
): Promise<Result<SurfaceCollection, Failure>> {
  const graphIsEmpty = await isGraphEmpty(request.gateway);
  if (!graphIsEmpty.ok) return graphIsEmpty;

  const limits: AnswerLimit[] = [];
  const emptyCollection = (): SurfaceCollection => ({
    surfacesByMaintainerKey: new Map(),
    limits,
    graphIsEmpty: graphIsEmpty.value,
    servicesConsidered: 0,
  });

  // HOP 1, from data: every package these accounts can publish to, in one pass.
  const maintainsPaths = await request.gateway.pathsFromSources({
    sourceLabel: "Maintainer",
    sourceKeys: request.maintainerKeys,
    relTypes: ["MAINTAINS"],
    direction: "outgoing",
    maxLength: 1,
    pathCount: request.options.pathCount,
  });
  if (!maintainsPaths.ok) return maintainsPaths;

  // No hop limit is recorded for this pass. MAINTAINS runs Maintainer to Package and
  // stops there, so a one-hop walk is complete by construction and detectHopLimit would
  // mark every answer truncated. The path ceiling is a real truncation and is recorded.
  const maintainsPathLimit = detectPathLimit(maintainsPaths.value, request.options.pathCount);
  if (maintainsPathLimit !== null) limits.push(maintainsPathLimit);

  const publishRights = indexPublishRights(maintainsPaths.value);
  if (publishRights.packagesByMaintainerKey.size === 0) return succeed(emptyCollection());

  const seeds = await expandSeedVersions(request.gateway, publishRights, request.options);
  if (!seeds.ok) return seeds;

  if (seeds.value.scanWasCapped) {
    // examined equals the ceiling by definition at a cap: reading past it is the only
    // way to learn the real total, and the limit's job is to say the fan-out was cut.
    limits.push({
      kind: "scan_capped",
      examined: request.options.versionsPerPackage,
      total: request.options.versionsPerPackage,
    });
  }

  const seedVersionKeys = [...seeds.value.maintainerKeysByVersionKey.keys()];
  if (seedVersionKeys.length === 0) {
    // Packages with no ingested version: nothing to walk from, and no service pass to
    // pay for. The surfaces are still built so the packages themselves are reported.
    return succeed({
      surfacesByMaintainerKey: assembleSurfaces({
        publishRights,
        seeds: seeds.value,
        reachByMaintainerKey: new Map(),
        dependentNodesById: new Map(),
        servicesByMaintainerKey: new Map(),
      }),
      limits,
      graphIsEmpty: graphIsEmpty.value,
      servicesConsidered: 0,
    });
  }

  // One pass for every transitive dependent of every version these accounts control.
  // The gateway chunks the selector list at 256 keys per engine call, so the whole list
  // goes in one call here. sourceRef: src/lib/hydra/hydra-gateway.ts SELECTOR_CHUNK_SIZE.
  const dependentPaths = await request.gateway.pathsFromSources({
    sourceLabel: "Version",
    sourceKeys: seedVersionKeys,
    relTypes: ["DEPENDED_ON_BY"],
    direction: "outgoing",
    maxLength: request.options.maxHops,
    pathCount: request.options.pathCount,
  });
  if (!dependentPaths.ok) return dependentPaths;

  const hopLimit = detectHopLimit(dependentPaths.value, request.options.maxHops);
  if (hopLimit !== null) limits.push(hopLimit);
  const dependentPathLimit = detectPathLimit(dependentPaths.value, request.options.pathCount);
  if (dependentPathLimit !== null) limits.push(dependentPathLimit);

  const reach = indexReach(dependentPaths.value, seeds.value);

  const services = await collectServiceReach({
    gateway: request.gateway,
    reachByMaintainerKey: reach.reachByMaintainerKey,
    maxServices: request.options.maxServices,
    resolvedEdgesPerService: request.options.resolvedEdgesPerService,
  });
  if (!services.ok) return services;

  if (services.value.serviceScanWasCapped) {
    limits.push({
      kind: "scan_capped",
      examined: services.value.servicesConsidered,
      total: request.options.maxServices,
    });
  }
  if (services.value.resolvedScanWasCapped) {
    limits.push({
      kind: "scan_capped",
      examined: request.options.resolvedEdgesPerService,
      total: request.options.resolvedEdgesPerService,
    });
  }

  return succeed({
    surfacesByMaintainerKey: assembleSurfaces({
      publishRights,
      seeds: seeds.value,
      reachByMaintainerKey: reach.reachByMaintainerKey,
      dependentNodesById: reach.dependentNodesById,
      servicesByMaintainerKey: services.value.servicesByMaintainerKey,
    }),
    limits,
    graphIsEmpty: graphIsEmpty.value,
    servicesConsidered: services.value.servicesConsidered,
  });
}

/** A package one or more of the queried accounts can publish to. */
type PublishableRecord = {
  packageKey: string;
  nodeId: number;
  ecosystem: Ecosystem;
  name: string;
  weeklyDownloads: number | null;
};

type PublishRights = {
  /** Account key to the packages it can publish to, keyed by package key. */
  packagesByMaintainerKey: Map<string, Map<string, PublishableRecord>>;
  /** The inverse, so a package maintained by ten accounts is expanded once. */
  maintainerKeysByPackageKey: Map<string, Set<string>>;
  /** Maintainer node ids, taken from path.nodes[0] rather than a second read. */
  nodeIdByMaintainerKey: Map<string, number>;
};

/**
 * Turns the batched MAINTAINS pass into publish rights per account.
 *
 * Attribution survives the batch because path.nodes[0] is the source the engine started
 * from, so a single pass seeded with every account still says which account each package
 * belongs to. Both directions of the map are built: the forward one answers "what can
 * this account publish to", the inverse one keeps the version expansion at one request
 * per distinct package instead of one per (account, package) pair.
 */
function indexPublishRights(paths: readonly GraphPath[]): PublishRights {
  const packagesByMaintainerKey = new Map<string, Map<string, PublishableRecord>>();
  const maintainerKeysByPackageKey = new Map<string, Set<string>>();
  const nodeIdByMaintainerKey = new Map<string, number>();

  for (const path of paths) {
    const maintainerNode = path.nodes[0];
    const packageNode = path.nodes[1];
    if (maintainerNode === undefined || packageNode === undefined) continue;

    const maintainerKey = readStringProperty(maintainerNode.properties, "key");
    const foundPackageKey = readStringProperty(packageNode.properties, "key");
    if (maintainerKey === null || foundPackageKey === null) continue;

    const parsed = parsePackageKey(foundPackageKey);
    if (parsed === null) continue;

    nodeIdByMaintainerKey.set(maintainerKey, maintainerNode.id);

    const packages = packagesByMaintainerKey.get(maintainerKey) ?? new Map();
    packages.set(foundPackageKey, {
      packageKey: foundPackageKey,
      nodeId: packageNode.id,
      // The ecosystem comes from the key rather than the property, so a node written
      // without a full property set still yields a well-typed ecosystem.
      ecosystem: parsed.ecosystem,
      name: readStringProperty(packageNode.properties, "name") ?? parsed.name,
      weeklyDownloads: readWeeklyDownloads(packageNode.properties),
    });
    packagesByMaintainerKey.set(maintainerKey, packages);

    const maintainers = maintainerKeysByPackageKey.get(foundPackageKey) ?? new Set<string>();
    maintainers.add(maintainerKey);
    maintainerKeysByPackageKey.set(foundPackageKey, maintainers);
  }

  return { packagesByMaintainerKey, maintainerKeysByPackageKey, nodeIdByMaintainerKey };
}

type SeedVersions = {
  /** Version natural key to every queried account that can publish that version. */
  maintainerKeysByVersionKey: Map<string, Set<string>>;
  /** Seed version node ids per account, so the reach map can start them at hop 0. */
  seedNodeIdsByMaintainerKey: Map<string, Set<number>>;
  /** Versions read per package, for the reported version count. */
  versionCountByPackageKey: Map<string, number>;
  scanWasCapped: boolean;
};

/**
 * Reads the versions of every package the accounts can publish to.
 *
 * VERSION_OF runs Version to Package, so this is an incoming one-hop expansion. A MATCH
 * pattern can express incoming ((p:Package {id})<-[:VERSION_OF]-(v)); only the path
 * procedures cannot, which is why this is a neighbors call per package. One call per
 * distinct package, not per (account, package) pair.
 *
 * The node ids come back from the edges, and the natural keys come from one chunked
 * property read: algo.MSpaths selects on the string `key`, not on integer ids, so the
 * dependent walk needs the keys rather than the ids it already has.
 * sourceRef: docs/HYDRADB.md section 4.
 */
async function expandSeedVersions(
  gateway: GraphGateway,
  publishRights: PublishRights,
  options: ResolvedOptions,
): Promise<Result<SeedVersions, Failure>> {
  const versionNodeIdsByPackageKey = new Map<string, number[]>();
  const allVersionNodeIds = new Set<number>();
  let scanWasCapped = false;

  for (const [currentPackageKey, maintainerKeys] of publishRights.maintainerKeysByPackageKey) {
    const record = findPublishableRecord(publishRights, maintainerKeys, currentPackageKey);
    if (record === null) continue;

    const versionEdges = await gateway.neighbors({
      nodeId: record.nodeId,
      nodeLabel: "Package",
      relType: "VERSION_OF",
      direction: "incoming",
      limit: options.versionsPerPackage,
    });
    if (!versionEdges.ok) return versionEdges;

    if (versionEdges.value.length >= options.versionsPerPackage) scanWasCapped = true;

    const nodeIds = versionEdges.value.map((edge) => edge.otherNodeId);
    versionNodeIdsByPackageKey.set(currentPackageKey, nodeIds);
    for (const nodeId of nodeIds) allVersionNodeIds.add(nodeId);
  }

  const versionRecords = await gateway.readNodes({
    label: "Version",
    nodeIds: [...allVersionNodeIds],
  });
  if (!versionRecords.ok) return versionRecords;

  const versionKeyByNodeId = new Map<number, string>();
  for (const record of versionRecords.value) {
    const key = readStringProperty(record.properties, "key");
    // A Version without a `key` cannot be a selector value, so it cannot seed the
    // dependent walk at all and is left out rather than silently walked from.
    if (key !== null) versionKeyByNodeId.set(record.id, key);
  }

  const maintainerKeysByVersionKey = new Map<string, Set<string>>();
  const seedNodeIdsByMaintainerKey = new Map<string, Set<number>>();
  const versionCountByPackageKey = new Map<string, number>();

  for (const [currentPackageKey, nodeIds] of versionNodeIdsByPackageKey) {
    const maintainerKeys = publishRights.maintainerKeysByPackageKey.get(currentPackageKey);
    if (maintainerKeys === undefined) continue;

    let counted = 0;
    for (const nodeId of nodeIds) {
      const versionKey = versionKeyByNodeId.get(nodeId);
      if (versionKey === undefined) continue;
      counted += 1;

      const owners = maintainerKeysByVersionKey.get(versionKey) ?? new Set<string>();
      for (const maintainerKey of maintainerKeys) {
        owners.add(maintainerKey);
        const seeds = seedNodeIdsByMaintainerKey.get(maintainerKey) ?? new Set<number>();
        seeds.add(nodeId);
        seedNodeIdsByMaintainerKey.set(maintainerKey, seeds);
      }
      maintainerKeysByVersionKey.set(versionKey, owners);
    }
    versionCountByPackageKey.set(currentPackageKey, counted);
  }

  return succeed({
    maintainerKeysByVersionKey,
    seedNodeIdsByMaintainerKey,
    versionCountByPackageKey,
    scanWasCapped,
  });
}

/** The stored record for a package, from any account that maintains it. */
function findPublishableRecord(
  publishRights: PublishRights,
  maintainerKeys: ReadonlySet<string>,
  currentPackageKey: string,
): PublishableRecord | null {
  for (const maintainerKey of maintainerKeys) {
    const record = publishRights.packagesByMaintainerKey.get(maintainerKey)?.get(currentPackageKey);
    if (record !== undefined) return record;
  }
  return null;
}

type ReachIndex = {
  /**
   * Account key to (version node id, fewest hops). Seeds sit at hop 0, so a service that
   * resolved a seed is reached at hop 1, the same convention blast-radius.ts uses.
   */
  reachByMaintainerKey: Map<string, Map<number, number>>;
  /** Dependent nodes by id, kept hydrated so hop 2 can read has_install_script. */
  dependentNodesById: Map<number, GraphPathNode>;
};

/**
 * Collapses the batched dependent walk into one reach map per account.
 *
 * The walk returns every simple path from every seed, so a diamond in the dependency
 * graph yields several routes to the same version. A surface counts each reachable thing
 * once, at its shortest distance, so the collapse happens here rather than in the UI.
 *
 * Attribution runs through the versionKey-to-accounts map built by expandSeedVersions:
 * path.nodes[0] is the seed the engine started from, and its `key` property is present by
 * construction because that property is what selected it.
 */
function indexReach(paths: readonly GraphPath[], seeds: SeedVersions): ReachIndex {
  const reachByMaintainerKey = new Map<string, Map<number, number>>();
  const dependentNodesById = new Map<number, GraphPathNode>();

  for (const [maintainerKey, seedNodeIds] of seeds.seedNodeIdsByMaintainerKey) {
    const reach = new Map<number, number>();
    for (const nodeId of seedNodeIds) reach.set(nodeId, 0);
    reachByMaintainerKey.set(maintainerKey, reach);
  }

  for (const path of paths) {
    const seedNode = path.nodes[0];
    const dependentNode = path.nodes[path.nodes.length - 1];
    if (seedNode === undefined || dependentNode === undefined) continue;
    if (dependentNode.id === seedNode.id) continue;

    const seedKey = readStringProperty(seedNode.properties, "key");
    if (seedKey === null) continue;

    const owners = seeds.maintainerKeysByVersionKey.get(seedKey);
    if (owners === undefined) continue;

    dependentNodesById.set(dependentNode.id, dependentNode);

    for (const maintainerKey of owners) {
      const reach = reachByMaintainerKey.get(maintainerKey);
      if (reach === undefined) continue;
      const known = reach.get(dependentNode.id);
      // A version this account already publishes stays at hop 0: reaching your own
      // second package through the dependency graph is still hop 1 damage.
      if (known === undefined || path.hopCount < known) reach.set(dependentNode.id, path.hopCount);
    }
  }

  return { reachByMaintainerKey, dependentNodesById };
}

type ServiceReachRequest = {
  gateway: GraphGateway;
  reachByMaintainerKey: Map<string, Map<number, number>>;
  maxServices: number;
  resolvedEdgesPerService: number;
};

type ServiceReach = {
  servicesByMaintainerKey: Map<string, Map<string, ReachedService>>;
  servicesConsidered: number;
  serviceScanWasCapped: boolean;
  resolvedScanWasCapped: boolean;
};

/**
 * Intersects every account's reachable versions with what the services actually resolved.
 *
 * Walks from the service side because RESOLVED has no materialised reverse type, exactly
 * as blast-radius.ts does: the request count is the number of services, which is in the
 * tens, rather than the number of reachable versions, which is in the tens of thousands.
 *
 * The pass is shared by every account in the batch. One inverted index over the reach
 * maps turns each resolved version into the accounts that reach it, so a leaderboard of
 * five hundred accounts costs the same service requests as one account.
 */
async function collectServiceReach(
  request: ServiceReachRequest,
): Promise<Result<ServiceReach, Failure>> {
  const empty: ServiceReach = {
    servicesByMaintainerKey: new Map(),
    servicesConsidered: 0,
    serviceScanWasCapped: false,
    resolvedScanWasCapped: false,
  };

  const serviceIds = await request.gateway.listNodeIds({
    label: "Service",
    limit: request.maxServices,
  });
  if (!serviceIds.ok) return serviceIds;
  if (serviceIds.value.length === 0) return succeed(empty);

  const serviceRecords = await request.gateway.readNodes({
    label: "Service",
    nodeIds: serviceIds.value,
  });
  if (!serviceRecords.ok) return serviceRecords;

  const identityByNodeId = new Map<number, { key: string; name: string }>();
  for (const record of serviceRecords.value) {
    const key = readStringProperty(record.properties, "key") ?? `service:${record.id}`;
    const name = readStringProperty(record.properties, "name") ?? key;
    identityByNodeId.set(record.id, { key, name });
  }

  const ownersByVersionNodeId = invertReach(request.reachByMaintainerKey);
  const servicesByMaintainerKey = new Map<string, Map<string, ReachedService>>();
  let resolvedScanWasCapped = false;

  for (const serviceId of serviceIds.value) {
    const edges = await request.gateway.neighbors({
      nodeId: serviceId,
      nodeLabel: "Service",
      relType: "RESOLVED",
      direction: "outgoing",
      limit: request.resolvedEdgesPerService,
    });
    if (!edges.ok) return edges;

    if (edges.value.length >= request.resolvedEdgesPerService) resolvedScanWasCapped = true;

    const identity =
      identityByNodeId.get(serviceId) ?? { key: `service:${serviceId}`, name: `service:${serviceId}` };

    for (const edge of edges.value) {
      const owners = ownersByVersionNodeId.get(edge.otherNodeId);
      if (owners === undefined) continue;

      for (const [maintainerKey, versionHopCount] of owners) {
        const reached = servicesByMaintainerKey.get(maintainerKey) ?? new Map<string, ReachedService>();
        const hopCount = versionHopCount + 1;
        const known = reached.get(identity.key);
        if (known === undefined || hopCount < known.hopCount) {
          reached.set(identity.key, {
            serviceKey: identity.key,
            serviceName: identity.name,
            hopCount,
          });
        }
        servicesByMaintainerKey.set(maintainerKey, reached);
      }
    }
  }

  return succeed({
    servicesByMaintainerKey,
    servicesConsidered: serviceIds.value.length,
    serviceScanWasCapped: serviceIds.value.length >= request.maxServices,
    resolvedScanWasCapped,
  });
}

/** Version node id to the accounts that reach it, with the fewest hops each. */
function invertReach(
  reachByMaintainerKey: Map<string, Map<number, number>>,
): Map<number, Map<string, number>> {
  const inverted = new Map<number, Map<string, number>>();

  for (const [maintainerKey, reach] of reachByMaintainerKey) {
    for (const [versionNodeId, hopCount] of reach) {
      const owners = inverted.get(versionNodeId) ?? new Map<string, number>();
      const known = owners.get(maintainerKey);
      if (known === undefined || hopCount < known) owners.set(maintainerKey, hopCount);
      inverted.set(versionNodeId, owners);
    }
  }

  return inverted;
}

type AssembleRequest = {
  publishRights: PublishRights;
  seeds: SeedVersions;
  reachByMaintainerKey: Map<string, Map<number, number>>;
  dependentNodesById: Map<number, GraphPathNode>;
  servicesByMaintainerKey: Map<string, Map<string, ReachedService>>;
};

/** Builds one surface per account from the shared indexes. */
function assembleSurfaces(request: AssembleRequest): Map<string, MaintainerSurface> {
  const surfaces = new Map<string, MaintainerSurface>();

  for (const [maintainerKey, packages] of request.publishRights.packagesByMaintainerKey) {
    const parsed = parseMaintainerKey(maintainerKey);
    // A Maintainer node whose key is not ecosystem:username cannot be attributed to an
    // ecosystem, and a surface without one cannot be rendered or ranked honestly.
    if (parsed === null) continue;

    const subject: MaintainerSubject = {
      maintainerKey,
      ecosystem: parsed.ecosystem,
      username: parsed.username,
      nodeId: request.publishRights.nodeIdByMaintainerKey.get(maintainerKey) ?? null,
    };

    const publishable: PublishablePackage[] = [...packages.values()]
      .map((record) => ({
        packageKey: record.packageKey,
        ecosystem: record.ecosystem,
        name: record.name,
        weeklyDownloads: record.weeklyDownloads,
        versionCount: request.seeds.versionCountByPackageKey.get(record.packageKey) ?? 0,
      }))
      .sort((left, right) => left.packageKey.localeCompare(right.packageKey));

    const ownPackageKeys = new Set(packages.keys());
    const dependents = collectDependents({
      reach: request.reachByMaintainerKey.get(maintainerKey),
      dependentNodesById: request.dependentNodesById,
      ownPackageKeys,
    });

    const reachedServices = [...(request.servicesByMaintainerKey.get(maintainerKey)?.values() ?? [])].sort(
      compareReachedServices,
    );

    let reachableWeeklyDownloads = 0;
    let packagesWithoutDownloadCount = 0;
    for (const entry of publishable) {
      if (entry.weeklyDownloads === null) packagesWithoutDownloadCount += 1;
      else reachableWeeklyDownloads += entry.weeklyDownloads;
    }

    surfaces.set(maintainerKey, {
      subject,
      direct: {
        packages: publishable,
        versionCount: request.seeds.seedNodeIdsByMaintainerKey.get(maintainerKey)?.size ?? 0,
        dependentVersionCount: dependents.versionCount,
        dependentPackageCount: dependents.packageKeys.size,
        reachedServices,
        reachableWeeklyDownloads,
        packagesWithoutDownloadCount,
      },
      modelled: {
        isModelled: true,
        candidateVersionCount: dependents.candidateVersionCount,
        candidatePackageCount: dependents.candidatePackageKeys.size,
        candidateVersionsWithInstallScript: dependents.candidateVersionsWithInstallScript,
        candidatePackagesWithInstallScript: dependents.candidatePackageKeysWithInstallScript.size,
        assumption: HOP_TWO_ASSUMPTION,
      },
    });
  }

  return surfaces;
}

type DependentTotals = {
  /** Dependent versions, at hop 1 or deeper. Hop-1 fact. */
  versionCount: number;
  /** Packages those dependents belong to. Hop-1 fact. */
  packageKeys: Set<string>;
  /** Dependents outside the account's own packages: the hop-2 candidates. */
  candidateVersionCount: number;
  candidatePackageKeys: Set<string>;
  candidateVersionsWithInstallScript: number;
  candidatePackageKeysWithInstallScript: Set<string>;
};

type DependentRequest = {
  reach: Map<number, number> | undefined;
  dependentNodesById: Map<number, GraphPathNode>;
  ownPackageKeys: ReadonlySet<string>;
};

/**
 * Splits one account's reach into the hop-1 dependents and the hop-2 candidates.
 *
 * Entries at hop 0 are the account's own versions, so they are neither. A dependent that
 * belongs to a package the account already controls is counted as a dependent but never
 * as a hop-2 candidate: harvesting a token you already hold is not propagation.
 */
function collectDependents(request: DependentRequest): DependentTotals {
  const totals: DependentTotals = {
    versionCount: 0,
    packageKeys: new Set<string>(),
    candidateVersionCount: 0,
    candidatePackageKeys: new Set<string>(),
    candidateVersionsWithInstallScript: 0,
    candidatePackageKeysWithInstallScript: new Set<string>(),
  };
  if (request.reach === undefined) return totals;

  for (const [versionNodeId, hopCount] of request.reach) {
    if (hopCount === 0) continue;

    const node = request.dependentNodesById.get(versionNodeId);
    if (node === undefined) continue;

    const versionKey = readStringProperty(node.properties, "key");
    if (versionKey === null) continue;

    const parsed = parseVersionKey(versionKey);
    if (parsed === null) continue;

    const dependentPackageKey = packageKey(parsed.ecosystem, parsed.name);
    totals.versionCount += 1;
    totals.packageKeys.add(dependentPackageKey);

    if (request.ownPackageKeys.has(dependentPackageKey)) continue;

    totals.candidateVersionCount += 1;
    totals.candidatePackageKeys.add(dependentPackageKey);

    if (readBooleanProperty(node.properties, "has_install_script") === true) {
      totals.candidateVersionsWithInstallScript += 1;
      totals.candidatePackageKeysWithInstallScript.add(dependentPackageKey);
    }
  }

  return totals;
}

function compareReachedServices(left: ReachedService, right: ReachedService): number {
  if (left.hopCount !== right.hopCount) return left.hopCount - right.hopCount;
  return left.serviceName.localeCompare(right.serviceName);
}

// ---------------------------------------------------------------------------
// Coverage, verdicts and empty answers
// ---------------------------------------------------------------------------

/**
 * Coverage of one account, folded so a present account never reads as absent.
 *
 * The Maintainer node's presence proves the account is in the slice, so a package of
 * theirs that the manifest does not list means the account's package list is incomplete,
 * which is what partial means. Passing absent would make the rationale claim the account
 * was never ingested, and a false rationale is worse than a vague one.
 *
 * An account with no MAINTAINS edge is partial for the same reason: their packages were
 * not ingested, which is not the same as having none. That keeps a silent zero from ever
 * reaching a not_exposed verdict.
 */
function describeAccountCoverage(
  coverage: SliceCoverage,
  packages: readonly PublishablePackage[],
): Coverage {
  if (packages.length === 0) return "partial";
  const packageKeys = packages.map((entry) => entry.packageKey);
  return weakestCoverage(coverage, packageKeys) === "closed" ? "closed" : "partial";
}

/** The weakest coverage across every ranked account, with an unranked key as partial. */
function describeLeaderboardCoverage(
  coverage: SliceCoverage,
  rows: readonly MaintainerSurface[],
  unrankedCount: number,
): Coverage {
  if (rows.length === 0) return "absent";
  if (unrankedCount > 0) return "partial";

  const packageKeys = rows.flatMap((row) => row.direct.packages.map((entry) => entry.packageKey));
  return weakestCoverage(coverage, packageKeys) === "closed" ? "closed" : "partial";
}

/** What decideVerdict returns, named so the caveat helper can take and return it. */
type DecidedVerdict = { verdict: Verdict; rationale: string; limits: AnswerLimit[] };

/** Appends the slice caveat to a decided verdict, for every answer this module returns. */
function withLowerBoundCaveat(decided: DecidedVerdict): DecidedVerdict {
  return {
    verdict: decided.verdict,
    rationale: `${decided.rationale} ${SLICE_LOWER_BOUND_CAVEAT}`,
    limits: decided.limits,
  };
}

function buildEmptySurface(subject: MaintainerSubject): MaintainerSurface {
  return {
    subject,
    direct: {
      packages: [],
      versionCount: 0,
      dependentVersionCount: 0,
      dependentPackageCount: 0,
      reachedServices: [],
      reachableWeeklyDownloads: 0,
      packagesWithoutDownloadCount: 0,
    },
    modelled: {
      isModelled: true,
      candidateVersionCount: 0,
      candidatePackageCount: 0,
      candidateVersionsWithInstallScript: 0,
      candidatePackagesWithInstallScript: 0,
      assumption: HOP_TWO_ASSUMPTION,
    },
  };
}

function buildEmptyLeaderboard(requestedKeys: readonly string[]): MaintainerLeaderboard {
  return {
    rows: [],
    maintainersRequested: requestedKeys.length,
    unrankedMaintainerKeys: [...requestedKeys],
    servicesConsidered: 0,
    isSliceLowerBound: true,
  };
}

// ---------------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------------

/**
 * Parses `ecosystem:username`.
 *
 * A maintainer key has the same ecosystem-then-rest shape as a package key
 * (maintainerKey and packageKey in src/lib/graph/model.ts), so that parser is reused
 * rather than duplicated with a different name; `name` there is the username here.
 */
function parseMaintainerKey(key: string): { ecosystem: Ecosystem; username: string } | null {
  const parsed = parsePackageKey(key);
  if (parsed === null) return null;
  return { ecosystem: parsed.ecosystem, username: parsed.name };
}

/**
 * Weekly downloads, with the registry's "no data" case kept out of arithmetic.
 *
 * The graph stores a missing count as -1, so summing the raw property would quietly
 * subtract from a leaderboard total.
 * sourceRef: src/lib/graph/model.ts PackageNode.weekly_downloads.
 */
function readWeeklyDownloads(properties: GraphProperties): number | null {
  const value = readNumberProperty(properties, "weekly_downloads");
  if (value === null || value < 0) return null;
  return value;
}
