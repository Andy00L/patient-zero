/**
 * Ingests a real slice of the npm registry into the graph.
 *
 * Usage:
 *   bun run ingest                                    every package the incident packs name
 *   bun run ingest -- --seed event-stream             one seed (repeatable)
 *   bun run ingest -- --max-packages 20 --max-depth 1 smaller slice
 *   bun run ingest -- --refresh                       ignore the cached responses
 *   bun run ingest -- --sink hydra                    into a running HydraDB
 *
 * WHAT THIS SCRIPT TALKS TO. Three public APIs, through the clients in src/lib/ingest:
 * registry.npmjs.org for packuments, maintainers and weekly downloads, api.deps.dev for
 * resolved dependency graphs (the only source of RESOLVES_TO edges, because a semver range
 * is not a resolution), and api.osv.dev for advisories. Nothing here invents a fact.
 *
 * EXPANSION RULE. Breadth first over packages, one level per depth.
 *   depth 0  the seed set: every package named by data/incidents (compromised artifacts,
 *            advisory targets and service lockfile lines), or the --seed values instead
 *   depth d  for each package admitted at depth d - 1, the packages its selected versions
 *            resolve to directly, as deps.dev resolved them
 * Expansion is dependency directed only. Neither the npm registry nor the deps.dev v3alpha
 * API returns the list of a package's dependents (deps.dev returns dependent counts, not
 * names), so no request can walk that edge backwards. Dependent coverage is therefore
 * exactly the seed set, which is why the packs seed the known victims (nodemon, karma,
 * @vue/cli-service) and not only the compromised packages. That limit is written into the
 * manifest notes, so a blast-radius answer over this slice abstains rather than reporting
 * a clean "nothing depends on this".
 *
 * BUDGETS ARE COVERAGE, NOT BOOKKEEPING. Every budget below can cut the slice short. A cut
 * slice must not answer "not exposed", so each hit budget is recorded, printed, and written
 * into the slice manifest notes, and every version whose resolution list was not fetched
 * carries closureTruncated, which the builder propagates to partialPackageKeys.
 * sourceRef: src/lib/ingest/graph-builder.ts markPartialClosures,
 * src/lib/analysis/abstention.ts decideVerdict.
 *
 * GOOD CITIZEN. Concurrency is bounded, every real request pays a courtesy delay, every
 * response is cached on disk under data/harvest keyed by method, URL and body, and a 4xx is
 * never retried (src/lib/ingest/fetch-json.ts treats it as terminal). A rerun over a warm
 * harvest directory issues no network request at all, which is what makes iterating on the
 * slice free instead of rude.
 *
 * Errors are values everywhere below. Only `runIngest` decides an exit code, and only the
 * last two lines of this file exit the process.
 */

import {
  type AffectedPackage,
  partitionVersionsByAffected,
  resolveAffectedIntervals,
  sortVersionsAscending,
} from "@/lib/analysis/semver-facts";
import { type CoverageRecord, recordLiveGraphCoverage } from "@/lib/graph/coverage-record";
import { MemoryGraph } from "@/lib/graph/memory-gateway";
import { type Ecosystem, isEcosystem, packageKey, versionKey } from "@/lib/graph/model";
import { buildGraphSnapshot, writeGraphSnapshot } from "@/lib/graph/snapshot";
import {
  DEFAULT_SLICE_MANIFEST_PATH,
  type SliceManifest,
  saveSliceManifest,
} from "@/lib/graph/slice-manifest";
import { BoltTransport } from "@/lib/hydra/bolt-transport";
import { type HydraConfig, describeTokenForLog, readHydraConfigFromEnv } from "@/lib/hydra/config";
import { HttpTransport } from "@/lib/hydra/http-transport";
import { HydraGateway } from "@/lib/hydra/hydra-gateway";
import { DEFAULT_ID_MAP_PATHS, IdMap } from "@/lib/hydra/id-map";
import type { GraphTransport } from "@/lib/hydra/transport";
import { loadAllIncidentPacks } from "@/lib/incidents/pack";
import { fetchDepsDevDependencyGraph } from "@/lib/ingest/deps-dev";
import {
  type FetchLike,
  type HttpClientOptions,
  createConcurrencyLimiter,
} from "@/lib/ingest/fetch-json";
import {
  type AdvisoryAffected,
  type AdvisoryFacts,
  type DeclaredDependency,
  type IngestSlice,
  type PackageFacts,
  type ResolvedDependency,
  type VersionFacts,
  buildGraph,
} from "@/lib/ingest/graph-builder";
import {
  type NpmPackageFacts,
  fetchNpmPackageFacts,
  fetchNpmWeeklyDownloadsBatch,
} from "@/lib/ingest/npm-registry";
import {
  type OsvPackageQuery,
  type OsvVulnerability,
  fetchOsvVulnerability,
  fromOsvEcosystem,
  queryOsvBatch,
} from "@/lib/ingest/osv";
import { GraphWriter, MemorySink, TransportSink } from "@/lib/ingest/writer";
import { type Failure, type Result, fail, fromThrowing, succeed } from "@/lib/result";

/** The slice was ingested and persisted. */
const EXIT_INGESTED = 0;

/** Nothing usable was ingested, or the graph write failed. */
const EXIT_NOT_INGESTED = 1;

/**
 * The graph was built and the manifest was written, but the snapshot could not be
 * persisted. Non-zero so a run that leaves nothing on disk for the app to read is visible.
 */
const EXIT_INGESTED_NOT_PERSISTED = 2;

/** The only ecosystem this script can fetch. src/lib/ingest/pypi.ts covers the other one. */
const SUPPORTED_ECOSYSTEM: Ecosystem = "npm";

/**
 * Packages admitted to the slice, seeds included. Default sized to fit the 56 packages the
 * four incident packs name plus a first level of their resolutions.
 */
const DEFAULT_MAX_PACKAGES = 120;

/** Versions kept per package. Newest first, unpublished versions preferred (see selectVersions). */
const DEFAULT_MAX_VERSIONS_PER_PACKAGE = 3;

/** Expansion levels past the seeds. 1 means seeds plus their direct resolutions. */
const DEFAULT_MAX_DEPTH = 1;

/**
 * Network requests one run may issue. Cache hits are free and do not count, so this is the
 * number of times the run touches a public API. A default run of the full pack seed set
 * costs about 160 requests: one packument and one resolved graph per package, one bulk
 * download query per 128 unscoped names plus one per scoped name, one OSV batch, and one
 * OSV record per advisory.
 */
const DEFAULT_MAX_NETWORK_REQUESTS = 400;

/**
 * Versions per package whose resolved dependency graph is fetched. Each one costs a
 * deps.dev request, so the default resolves the newest selected version only and marks the
 * rest closureTruncated rather than pretending their closure is known.
 */
const DEFAULT_CLOSURES_PER_PACKAGE = 1;

/** Full OSV records fetched per run. The batch endpoint returns ids only. */
const DEFAULT_MAX_ADVISORIES = 80;

/** Upstream calls in flight. Small on purpose: three public APIs, no API key, no quota. */
const DEFAULT_CONCURRENCY = 4;

/** Courtesy delay before each real network request, in milliseconds. Cache hits pay nothing. */
const DEFAULT_REQUEST_DELAY_MS = 120;

/**
 * Names per weekly-download query. Well under the endpoint's 128 bulk cap, because a scoped
 * name costs its own request and one rate limit discards the whole group. See
 * collectWeeklyDownloads for why the group is small.
 */
const DOWNLOAD_GROUP_SIZE = 24;

/** Cached responses older than this are refetched. Unit: milliseconds (7 days). */
const DEFAULT_CACHE_MAX_AGE_MS = 604_800_000;

/** Where raw responses are cached, one JSON envelope per request. */
const DEFAULT_HARVEST_DIRECTORY = "data/harvest";

/**
 * Snapshot written by this script. Deliberately not DEFAULT_GRAPH_SNAPSHOT_PATH: that path
 * belongs to the curated incident seed, and an ingest that silently replaced it would
 * delete the demo's ground truth. Pass --snapshot to aim somewhere else.
 * sourceRef: scripts/seed-incidents.ts DEFAULT_SNAPSHOT_PATH.
 */
const DEFAULT_SLICE_SNAPSHOT_PATH = "data/graph/slice-snapshot.json";

/** Value of `source` in the snapshot. Log safe, never a path or a secret. */
const SNAPSHOT_SOURCE = "ingest-slice";

/**
 * Value written for a fact the source did not state. The graph model reserves -1 for
 * "the source had none", and the analysis layer refuses to place a window on it.
 * sourceRef: src/lib/graph/model.ts VersionNode.published_at_ms, PackageNode.weekly_downloads.
 */
const UNKNOWN_NUMERIC_FACT = -1;

/** Longest note list printed before the tail is summarized, to keep the run readable. */
const MAX_PRINTED_NOTES = 25;

const USAGE_LINE =
  "usage: bun run ingest [-- --seed <name>] [-- --max-packages <n>] [-- --max-versions <n>] " +
  "[-- --max-depth <n>] [-- --max-requests <n>] [-- --closures-per-package <n>] " +
  "[-- --max-advisories <n>] [-- --concurrency <n>] [-- --delay-ms <n>] [-- --harvest <path>] " +
  "[-- --snapshot <path>] [-- --manifest <path>] [-- --sink memory|hydra] [-- --refresh]";

/** memory builds the graph in process and writes a snapshot, hydra writes to a live node. */
type IngestSink = "memory" | "hydra";

type PackageIdentity = { ecosystem: Ecosystem; name: string };

/** Which budget cut the slice short. Every one of these reaches the manifest. */
type BudgetName = "packages" | "versionsPerPackage" | "depth" | "requests" | "advisories";

type IngestArguments = {
  /** null means "derive the seed set from the incident packs". */
  seedNames: readonly string[] | null;
  maxPackages: number;
  maxVersionsPerPackage: number;
  maxDepth: number;
  maxNetworkRequests: number;
  closuresPerPackage: number;
  maxAdvisories: number;
  concurrency: number;
  requestDelayMs: number;
  cacheMaxAgeMs: number;
  harvestDirectory: string;
  snapshotPath: string;
  manifestPath: string;
  sink: IngestSink;
  isRefresh: boolean;
};

async function runIngest(argumentValues: readonly string[]): Promise<number> {
  const startedAtMs = performance.now();

  const parsed = parseArguments(argumentValues);
  if (!parsed.ok) {
    reportFailure("arguments", parsed.failure);
    return EXIT_NOT_INGESTED;
  }
  printBudgets(parsed.value);

  const seeds = await resolveSeedPackages(parsed.value);
  if (!seeds.ok) {
    reportFailure("seed selection", seeds.failure);
    return EXIT_NOT_INGESTED;
  }
  console.log(`[runIngest] ${seeds.value.length} seed package(s) selected`);

  const meter = createHttpMeter(parsed.value);

  const expanded = await expandSlice(parsed.value, seeds.value, meter);
  if (expanded.packagesByKey.size === 0) {
    console.error(
      "[runIngest] no package could be fetched, so nothing was written. Check the network and " +
        "the seed spelling, then rerun.",
    );
    for (const note of expanded.notes) console.error(`[runIngest]   ${note}`);
    return EXIT_NOT_INGESTED;
  }

  const versionsByPackageKey = groupVersionsByPackageKey(expanded.versionsByKey.values());

  const advisories = await collectAdvisories(
    parsed.value,
    [...expanded.packagesByKey.values()],
    versionsByPackageKey,
    meter,
  );
  const downloads = await collectWeeklyDownloads(
    parsed.value,
    [...expanded.packagesByKey.values()],
    meter,
  );

  const slice: IngestSlice = {
    packages: [...expanded.packagesByKey.values()].map((facts) => ({
      ...facts,
      weeklyDownloads: downloads.downloadsByName.get(facts.name) ?? UNKNOWN_NUMERIC_FACT,
    })),
    versions: [...expanded.versionsByKey.values()],
    // Lockfile ground truth comes from the incident packs (bun run seed) and from
    // scripts/harvest-lockfile-history.ts. A registry ingest observes no service.
    services: [],
    advisories: advisories.advisories,
    // Name similarity is the detector's job over this slice, never a fetch.
    typosquats: [],
  };

  const budgetsHit = new Set<BudgetName>([...expanded.budgetsHit, ...advisories.budgetsHit]);
  const runNotes = [
    ...expanded.notes,
    ...advisories.notes,
    ...downloads.notes,
    ...describeBudgetNotes(parsed.value, budgetsHit),
  ];

  const written =
    parsed.value.sink === "hydra"
      ? await writeSliceToHydra(slice, runNotes, parsed.value.manifestPath)
      : await writeSliceToMemory(slice);
  if (!written.ok) {
    reportFailure(`${parsed.value.sink} write`, written.failure);
    return EXIT_NOT_INGESTED;
  }

  const manifest: SliceManifest = {
    ...written.value.manifest,
    notes: [...written.value.manifest.notes, ...runNotes],
  };

  // The hydra sink already wrote the record, beside the graph it describes and while it could
  // still be counted. The memory sink writes it here, where the same manifest is also about to
  // be embedded in the snapshot.
  const coverage =
    written.value.coverage ?? (await writeMemoryCoverage(manifest, parsed.value.manifestPath));
  if (coverage.failure !== null) {
    reportFailure("manifest write", coverage.failure);
    return EXIT_NOT_INGESTED;
  }

  // The snapshot carries the manifest, so it is written after the coverage notes are in.
  const persisted =
    written.value.graph === null
      ? null
      : await persistSnapshot(written.value.graph, manifest, parsed.value.snapshotPath);

  printIngestReport({
    argumentValues: parsed.value,
    manifest,
    destination:
      persisted !== null && persisted.ok
        ? `${written.value.destination}, exported to ${persisted.value}`
        : written.value.destination,
    nodesWritten: written.value.nodesWritten,
    edgesWritten: written.value.edgesWritten,
    declaredEdgeCount: countDeclaredEdges(slice),
    meterCounts: meter.readCounts(),
    budgetsHit,
    elapsedMs: elapsedMsSince(startedAtMs),
    notes: [...runNotes, ...written.value.notes],
    coverage,
  });

  if (persisted !== null && !persisted.ok) {
    reportFailure("snapshot export", persisted.failure);
    return EXIT_INGESTED_NOT_PERSISTED;
  }

  return EXIT_INGESTED;
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArguments(argumentValues: readonly string[]): Result<IngestArguments, Failure> {
  const seedNames: string[] = [];
  let maxPackages = DEFAULT_MAX_PACKAGES;
  let maxVersionsPerPackage = DEFAULT_MAX_VERSIONS_PER_PACKAGE;
  let maxDepth = DEFAULT_MAX_DEPTH;
  let maxNetworkRequests = DEFAULT_MAX_NETWORK_REQUESTS;
  let closuresPerPackage = DEFAULT_CLOSURES_PER_PACKAGE;
  let maxAdvisories = DEFAULT_MAX_ADVISORIES;
  let concurrency = DEFAULT_CONCURRENCY;
  let requestDelayMs = DEFAULT_REQUEST_DELAY_MS;
  let harvestDirectory = DEFAULT_HARVEST_DIRECTORY;
  let snapshotPath = DEFAULT_SLICE_SNAPSHOT_PATH;
  let manifestPath = DEFAULT_SLICE_MANIFEST_PATH;
  let sink: IngestSink = "memory";
  let isRefresh = false;

  const numericFlags = new Map<string, (value: number) => void>([
    ["--max-packages", (value) => (maxPackages = value)],
    ["--max-versions", (value) => (maxVersionsPerPackage = value)],
    ["--max-depth", (value) => (maxDepth = value)],
    ["--max-requests", (value) => (maxNetworkRequests = value)],
    ["--closures-per-package", (value) => (closuresPerPackage = value)],
    ["--max-advisories", (value) => (maxAdvisories = value)],
    ["--concurrency", (value) => (concurrency = value)],
    ["--delay-ms", (value) => (requestDelayMs = value)],
  ]);

  const textFlags = new Map<string, (value: string) => void>([
    ["--seed", (value) => seedNames.push(value)],
    ["--harvest", (value) => (harvestDirectory = value)],
    ["--snapshot", (value) => (snapshotPath = value)],
    ["--manifest", (value) => (manifestPath = value)],
  ]);

  for (let index = 0; index < argumentValues.length; index += 1) {
    const argument = argumentValues[index];

    if (argument === "--refresh") {
      isRefresh = true;
      continue;
    }

    if (argument === "--sink") {
      const value = argumentValues[index + 1];
      if (value !== "memory" && value !== "hydra") {
        return fail(
          "invalid_input",
          `[parseArguments] --sink needs "memory" or "hydra". ${USAGE_LINE}`,
        );
      }
      sink = value;
      index += 1;
      continue;
    }

    const numericApply = numericFlags.get(argument);
    const textApply = textFlags.get(argument);
    if (numericApply === undefined && textApply === undefined) {
      return fail("invalid_input", `[parseArguments] unknown argument "${argument}". ${USAGE_LINE}`);
    }

    const value = argumentValues[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return fail("invalid_input", `[parseArguments] ${argument} needs a value. ${USAGE_LINE}`);
    }
    index += 1;

    if (numericApply !== undefined) {
      const parsedNumber = Number.parseInt(value, 10);
      if (!Number.isInteger(parsedNumber) || parsedNumber < 1) {
        return fail(
          "invalid_input",
          `[parseArguments] ${argument} needs a positive integer, got "${value}"`,
        );
      }
      // A delay of zero is legitimate (a fully cached rerun), so it is allowed only there.
      numericApply(parsedNumber);
      continue;
    }
    if (textApply !== undefined) textApply(value);
  }

  return succeed({
    seedNames: seedNames.length > 0 ? seedNames : null,
    maxPackages,
    maxVersionsPerPackage,
    maxDepth,
    maxNetworkRequests,
    closuresPerPackage,
    maxAdvisories,
    concurrency,
    requestDelayMs,
    cacheMaxAgeMs: DEFAULT_CACHE_MAX_AGE_MS,
    harvestDirectory,
    snapshotPath,
    manifestPath,
    sink,
    isRefresh,
  });
}

/**
 * The seed set.
 *
 * With no --seed flag it is every package the incident packs name, in every role:
 * compromised artifacts, advisory targets, and the packages the pack services pinned. The
 * packs are the demo's ground truth, so a slice that missed one of their packages would
 * make the replay abstain on the very question the demo exists to answer.
 */
async function resolveSeedPackages(
  argumentValues: IngestArguments,
): Promise<Result<PackageIdentity[], Failure>> {
  if (argumentValues.seedNames !== null) {
    const identities: PackageIdentity[] = [];
    for (const seedName of argumentValues.seedNames) {
      const parsed = parseSeedName(seedName);
      if (!parsed.ok) return parsed;
      identities.push(parsed.value);
    }
    return succeed(dedupeIdentities(identities));
  }

  const packs = await loadAllIncidentPacks();
  if (!packs.ok) return packs;

  const identities: PackageIdentity[] = [];
  for (const pack of packs.value) {
    for (const compromised of pack.compromisedVersions) {
      identities.push({ ecosystem: compromised.ecosystem, name: compromised.name });
    }
    for (const advisory of pack.advisories) {
      for (const affected of advisory.affects) {
        identities.push({ ecosystem: affected.ecosystem, name: affected.name });
      }
    }
    for (const service of pack.services) {
      for (const resolution of service.resolved) {
        identities.push({ ecosystem: resolution.ecosystem, name: resolution.name });
      }
    }
  }

  const supported = dedupeIdentities(identities).filter(
    (identity) => identity.ecosystem === SUPPORTED_ECOSYSTEM,
  );
  if (supported.length === 0) {
    return fail(
      "not_found",
      `[resolveSeedPackages] the incident packs name no ${SUPPORTED_ECOSYSTEM} package`,
    );
  }
  return succeed(supported);
}

/** Accepts "chalk" and "npm:chalk". A scoped name keeps its slash and its leading "@". */
function parseSeedName(seedName: string): Result<PackageIdentity, Failure> {
  const trimmed = seedName.trim();
  if (trimmed.length === 0) {
    return fail("invalid_input", "[parseSeedName] a --seed value is empty");
  }

  // A scoped name starts with "@" and carries no ecosystem prefix, so only a prefix that
  // names a known ecosystem is treated as one.
  const separator = trimmed.indexOf(":");
  if (separator > 0) {
    const prefix = trimmed.slice(0, separator);
    const name = trimmed.slice(separator + 1);
    if (isEcosystem(prefix)) {
      if (prefix !== SUPPORTED_ECOSYSTEM) {
        return fail(
          "unsupported",
          `[parseSeedName] this script fetches ${SUPPORTED_ECOSYSTEM} only, got "${prefix}". ` +
            "PyPI ingest belongs to src/lib/ingest/pypi.ts and has no seed path yet.",
        );
      }
      if (name.length === 0) {
        return fail("invalid_input", `[parseSeedName] "${seedName}" names no package`);
      }
      return succeed({ ecosystem: prefix, name });
    }
  }

  return succeed({ ecosystem: SUPPORTED_ECOSYSTEM, name: trimmed });
}

function dedupeIdentities(identities: readonly PackageIdentity[]): PackageIdentity[] {
  const byKey = new Map<string, PackageIdentity>();
  for (const identity of identities) {
    const key = packageKey(identity.ecosystem, identity.name);
    if (!byKey.has(key)) byKey.set(key, identity);
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// HTTP metering
// ---------------------------------------------------------------------------

type MeterCounts = {
  /** Calls this script made to a client function, cached or not. */
  upstreamCalls: number;
  /** Requests that actually left the machine, retries included. */
  networkRequests: number;
  /** Calls answered entirely from data/harvest. */
  cacheHits: number;
};

/**
 * One place that owns every upstream call: the shared response cache, the concurrency
 * bound, the courtesy delay, and the request budget.
 *
 * The counters come from wrapping `fetchImpl` rather than from counting intentions, so
 * "requests made" is the number of times this run touched a public API, retries included.
 * A call whose counter did not move was answered from disk, which is what makes the cache
 * hit number real instead of inferred.
 */
type HttpMeter = {
  clientOptions: HttpClientOptions;
  /** Runs one upstream call inside the concurrency bound and counts what it cost. */
  measure: <TValue>(call: () => Promise<Result<TValue, Failure>>) => Promise<Result<TValue, Failure>>;
  /** False once the run has spent its network request budget. */
  hasRequestBudgetLeft: () => boolean;
  readCounts: () => MeterCounts;
};

function createHttpMeter(argumentValues: IngestArguments): HttpMeter {
  const limiter = createConcurrencyLimiter(argumentValues.concurrency);
  const counts: MeterCounts = { upstreamCalls: 0, networkRequests: 0, cacheHits: 0 };

  const countingFetch: FetchLike = async (input, init) => {
    counts.networkRequests += 1;
    if (argumentValues.requestDelayMs > 0) await sleepMs(argumentValues.requestDelayMs);
    return await fetch(input, init);
  };

  const clientOptions: HttpClientOptions = {
    fetchImpl: countingFetch,
    cache: {
      directory: argumentValues.harvestDirectory,
      // --refresh keeps writing the cache and stops reading it, so one refreshed run
      // reprimes the harvest directory for the next one.
      maxAgeMs: argumentValues.isRefresh ? 0 : argumentValues.cacheMaxAgeMs,
    },
  };

  return {
    clientOptions,
    measure: async <TValue>(call: () => Promise<Result<TValue, Failure>>) =>
      await limiter.run(async () => {
        const networkBefore = counts.networkRequests;
        counts.upstreamCalls += 1;
        const outcome = await call();
        if (counts.networkRequests === networkBefore) counts.cacheHits += 1;
        return outcome;
      }),
    hasRequestBudgetLeft: () => counts.networkRequests < argumentValues.maxNetworkRequests,
    readCounts: () => ({ ...counts }),
  };
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

type ExpansionOutcome = {
  packagesByKey: Map<string, PackageFacts>;
  versionsByKey: Map<string, VersionFacts>;
  budgetsHit: Set<BudgetName>;
  notes: string[];
};

/** What one package fetch produced, plus the packages it points at for the next level. */
type PackageOutcome = {
  identity: PackageIdentity;
  packageFacts: PackageFacts | null;
  versions: VersionFacts[];
  /** Direct resolutions, the candidates for the next depth level. */
  discovered: PackageIdentity[];
  notes: string[];
  budgetsHit: BudgetName[];
};

/**
 * Breadth first expansion, one depth level per iteration.
 *
 * Levels rather than a single queue on purpose: depth is a budget the report has to be able
 * to state, and a queue that mixes levels cannot say which level was cut.
 */
async function expandSlice(
  argumentValues: IngestArguments,
  seeds: readonly PackageIdentity[],
  meter: HttpMeter,
): Promise<ExpansionOutcome> {
  const outcome: ExpansionOutcome = {
    packagesByKey: new Map(),
    versionsByKey: new Map(),
    budgetsHit: new Set(),
    notes: [],
  };

  const admittedKeys = new Set<string>();
  const admit = (identity: PackageIdentity): boolean => {
    const key = packageKey(identity.ecosystem, identity.name);
    if (admittedKeys.has(key)) return false;
    if (admittedKeys.size >= argumentValues.maxPackages) {
      outcome.budgetsHit.add("packages");
      return false;
    }
    admittedKeys.add(key);
    return true;
  };

  let frontier: PackageIdentity[] = seeds.filter((identity) => admit(identity));

  for (let depth = 0; frontier.length > 0; depth += 1) {
    console.log(
      `[expandSlice] depth ${depth}: fetching ${frontier.length} package(s), ` +
        `${admittedKeys.size} admitted so far`,
    );

    const fetched = await Promise.all(
      frontier.map((identity) => fetchOnePackage(identity, argumentValues, meter)),
    );

    const discovered: PackageIdentity[] = [];
    for (const packageOutcome of fetched) {
      if (packageOutcome.packageFacts !== null) {
        outcome.packagesByKey.set(
          packageKey(packageOutcome.identity.ecosystem, packageOutcome.identity.name),
          packageOutcome.packageFacts,
        );
      }
      for (const facts of packageOutcome.versions) {
        outcome.versionsByKey.set(versionKey(facts.ecosystem, facts.name, facts.version), facts);
      }
      for (const note of packageOutcome.notes) outcome.notes.push(note);
      for (const budget of packageOutcome.budgetsHit) outcome.budgetsHit.add(budget);
      for (const identity of packageOutcome.discovered) discovered.push(identity);
    }

    if (depth >= argumentValues.maxDepth) {
      const unvisited = discovered.filter(
        (identity) => !admittedKeys.has(packageKey(identity.ecosystem, identity.name)),
      );
      if (unvisited.length > 0) {
        outcome.budgetsHit.add("depth");
        outcome.notes.push(
          `the depth budget of ${argumentValues.maxDepth} stopped the expansion with ` +
            `${dedupeIdentities(unvisited).length} package(s) reachable but never fetched`,
        );
      }
      break;
    }

    frontier = dedupeIdentities(discovered).filter((identity) => admit(identity));
  }

  return outcome;
}

/**
 * One package: its packument, the versions selected from it, and the resolved closure of
 * the newest few.
 *
 * A package that cannot be fetched is a note and an absent node, never a failure that ends
 * the run: one unreachable name out of a hundred must not throw away the other ninety nine.
 */
async function fetchOnePackage(
  identity: PackageIdentity,
  argumentValues: IngestArguments,
  meter: HttpMeter,
): Promise<PackageOutcome> {
  const outcome: PackageOutcome = {
    identity,
    packageFacts: null,
    versions: [],
    discovered: [],
    notes: [],
    budgetsHit: [],
  };

  if (!meter.hasRequestBudgetLeft()) {
    outcome.budgetsHit.push("requests");
    outcome.notes.push(
      `${packageKey(identity.ecosystem, identity.name)} was never fetched: the request budget ran out`,
    );
    return outcome;
  }

  const fetched = await meter.measure(() =>
    fetchNpmPackageFacts(identity.name, meter.clientOptions),
  );
  if (!fetched.ok) {
    outcome.notes.push(
      `${packageKey(identity.ecosystem, identity.name)} could not be fetched ` +
        `(${fetched.failure.reason}), so it is absent from the slice`,
    );
    return outcome;
  }

  const registryFacts = fetched.value;
  const selected = selectVersions(registryFacts, argumentValues.maxVersionsPerPackage);
  if (selected.isTruncated) outcome.budgetsHit.push("versionsPerPackage");

  outcome.packageFacts = {
    ecosystem: identity.ecosystem,
    name: identity.name,
    // Filled from the bulk download query once the package set is final.
    weeklyDownloads: UNKNOWN_NUMERIC_FACT,
    // Only the account name. The registry also publishes maintainer emails, which are
    // personal data with no query value here, so they are never read or logged.
    maintainerUsernames: registryFacts.maintainers.map((maintainer) => maintainer.name),
  };

  if (registryFacts.isFullyUnpublished) {
    outcome.notes.push(
      `${packageKey(identity.ecosystem, identity.name)} is fully unpublished, so its versions ` +
        "are known from the registry time map only",
    );
  }

  let closuresFetched = 0;
  for (const candidate of selected.versions) {
    const canFetchClosure =
      !candidate.isUnpublished &&
      closuresFetched < argumentValues.closuresPerPackage &&
      meter.hasRequestBudgetLeft();

    if (!canFetchClosure) {
      if (!candidate.isUnpublished && closuresFetched >= argumentValues.closuresPerPackage) {
        // Not a budget hit worth naming per version: the closure budget is a stated
        // default, and closureTruncated already makes the package partial.
      } else if (!candidate.isUnpublished) {
        outcome.budgetsHit.push("requests");
      }

      outcome.versions.push(
        buildVersionFacts(identity, candidate, {
          declared: readDeclaredDependencies(candidate),
          resolved: [],
          isClosureTruncated: true,
        }),
      );
      continue;
    }

    closuresFetched += 1;
    const resolved = await meter.measure(() =>
      fetchDepsDevDependencyGraph(
        identity.ecosystem,
        identity.name,
        candidate.version,
        meter.clientOptions,
      ),
    );

    if (!resolved.ok) {
      outcome.notes.push(
        `${versionKey(identity.ecosystem, identity.name, candidate.version)} has no resolved ` +
          `closure (${resolved.failure.reason}), so it is marked partial`,
      );
      outcome.versions.push(
        buildVersionFacts(identity, candidate, {
          declared: readDeclaredDependencies(candidate),
          resolved: [],
          isClosureTruncated: true,
        }),
      );
      continue;
    }

    const direct = readDirectResolutions(resolved.value);
    if (direct.graphError !== null) {
      outcome.notes.push(
        `${versionKey(identity.ecosystem, identity.name, candidate.version)} resolved with an ` +
          `error from deps.dev, so its closure is partial: ${direct.graphError}`,
      );
    }
    for (const note of direct.notes) outcome.notes.push(note);
    for (const dependency of direct.resolutions) {
      outcome.discovered.push({ ecosystem: dependency.ecosystem, name: dependency.name });
    }

    outcome.versions.push(
      buildVersionFacts(identity, candidate, {
        declared: readDeclaredDependencies(candidate),
        resolved: direct.resolutions,
        // Only the direct hop was written here. Every version this one resolves to arrives
        // as a stub unless it is fetched at the next depth level, and the builder marks
        // every package that reaches a stub partial, so nothing here claims a full closure.
        isClosureTruncated: direct.graphError !== null,
      }),
    );
  }

  return outcome;
}

/** A version selected from the packument, with the two facts the graph needs about it. */
type SelectedVersion = {
  version: string;
  publishedAtMs: number;
  hasInstallScript: boolean;
  dependencies: readonly { name: string; versionRange: string }[];
  /** True for a version present in the registry time map but absent from `versions`. */
  isUnpublished: boolean;
};

/**
 * Which versions of a package enter the slice.
 *
 * Order of preference, and the reason for it: `dist-tags.latest` first because every
 * dependent range resolves there today; then the unpublished versions, because a version
 * that was published, timestamped and then pulled is exactly what this project studies
 * (flatmap-stream 11.1.1 exists only in the time map); then the newest published versions.
 */
function selectVersions(
  registryFacts: NpmPackageFacts,
  maxVersions: number,
): { versions: SelectedVersion[]; isTruncated: boolean } {
  const publishedByVersion = new Map(
    registryFacts.versions.map((facts) => [facts.version, facts] as const),
  );

  const candidates: SelectedVersion[] = [];
  const seen = new Set<string>();

  const pushPublished = (version: string): void => {
    const facts = publishedByVersion.get(version);
    if (facts === undefined || seen.has(version)) return;
    seen.add(version);
    candidates.push({
      version: facts.version,
      publishedAtMs: facts.publishedAtMs ?? UNKNOWN_NUMERIC_FACT,
      hasInstallScript: facts.hasInstallScript,
      dependencies: facts.dependencies,
      isUnpublished: false,
    });
  };

  if (registryFacts.latestVersion !== null) pushPublished(registryFacts.latestVersion);

  for (const unpublished of [...registryFacts.unpublishedVersions].sort(
    (left, right) => (right.publishedAtMs ?? 0) - (left.publishedAtMs ?? 0),
  )) {
    if (seen.has(unpublished.version)) continue;
    seen.add(unpublished.version);
    candidates.push({
      version: unpublished.version,
      publishedAtMs: unpublished.publishedAtMs ?? UNKNOWN_NUMERIC_FACT,
      // The registry keeps no manifest for a version it removed, so nothing is known about
      // its install scripts. false here means "unstated", and the note in the manifest says
      // so rather than letting the graph imply a clean artifact.
      hasInstallScript: false,
      dependencies: [],
      isUnpublished: true,
    });
  }

  const newestFirst = [...registryFacts.versions].sort(comparePublishTimeDescending);
  for (const facts of newestFirst) pushPublished(facts.version);

  return {
    versions: candidates.slice(0, maxVersions),
    isTruncated: candidates.length > maxVersions,
  };
}

/** Newest first by publish time, falling back to semver precedence when a time is missing. */
function comparePublishTimeDescending(
  left: { version: string; publishedAtMs: number | null },
  right: { version: string; publishedAtMs: number | null },
): number {
  if (left.publishedAtMs !== null && right.publishedAtMs !== null) {
    return right.publishedAtMs - left.publishedAtMs;
  }
  const ascending = sortVersionsAscending([left.version, right.version]);
  return ascending[0] === left.version ? 1 : -1;
}

function buildVersionFacts(
  identity: PackageIdentity,
  candidate: SelectedVersion,
  edges: {
    declared: DeclaredDependency[];
    resolved: ResolvedDependency[];
    isClosureTruncated: boolean;
  },
): VersionFacts {
  return {
    ecosystem: identity.ecosystem,
    name: identity.name,
    version: candidate.version,
    publishedAtMs: candidate.publishedAtMs,
    hasInstallScript: candidate.hasInstallScript,
    declaredDependencies: edges.declared,
    resolvedDependencies: edges.resolved,
    closureTruncated: edges.isClosureTruncated,
  };
}

/**
 * Production dependencies only. A library's devDependencies are not installed by its
 * dependents, so writing them as DEPENDS_ON would overstate every downstream blast radius.
 */
function readDeclaredDependencies(candidate: SelectedVersion): DeclaredDependency[] {
  return candidate.dependencies.map((dependency) => ({
    ecosystem: SUPPORTED_ECOSYSTEM,
    name: dependency.name,
    versionRange: dependency.versionRange,
  }));
}

/**
 * The direct hop of a deps.dev resolved graph.
 *
 * deps.dev returns the whole closure of one version, but only the root's own edges are
 * written from this response: RESOLVES_TO is a per-hop edge, and attributing an indirect
 * node to the root would turn a three hop path into a one hop path and report a blast
 * radius that is both wrong and too small. The indirect nodes become the next depth level
 * instead, and the ones never reached stay stubs.
 */
function readDirectResolutions(graph: {
  rootNodeIndex: number;
  nodes: readonly { ecosystem: Ecosystem | null; name: string; version: string }[];
  edges: readonly { fromNodeIndex: number; toNodeIndex: number }[];
  graphError: string | null;
}): { resolutions: ResolvedDependency[]; notes: string[]; graphError: string | null } {
  const resolutions: ResolvedDependency[] = [];
  const notes: string[] = [];
  let unknownSystemCount = 0;

  for (const edge of graph.edges) {
    if (edge.fromNodeIndex !== graph.rootNodeIndex) continue;

    const node = graph.nodes[edge.toNodeIndex];
    if (node === undefined) continue;
    if (node.ecosystem === null) {
      unknownSystemCount += 1;
      continue;
    }
    resolutions.push({ ecosystem: node.ecosystem, name: node.name, version: node.version });
  }

  if (unknownSystemCount > 0) {
    notes.push(
      `${unknownSystemCount} resolved dependency(ies) name a packaging system this project ` +
        "does not model, so those edges are absent",
    );
  }

  return { resolutions, notes, graphError: graph.graphError };
}

function groupVersionsByPackageKey(
  versions: Iterable<VersionFacts>,
): Map<string, string[]> {
  const versionsByPackageKey = new Map<string, string[]>();
  for (const facts of versions) {
    const key = packageKey(facts.ecosystem, facts.name);
    const existing = versionsByPackageKey.get(key);
    if (existing === undefined) versionsByPackageKey.set(key, [facts.version]);
    else existing.push(facts.version);
  }
  return versionsByPackageKey;
}

// ---------------------------------------------------------------------------
// Advisories
// ---------------------------------------------------------------------------

type AdvisoryOutcome = {
  advisories: AdvisoryFacts[];
  notes: string[];
  budgetsHit: Set<BudgetName>;
};

/**
 * Advisories for the slice, from OSV.
 *
 * Two clocks, kept apart on purpose. `publishedAtMs` is known time: when the world could
 * first have learned of the vulnerability. Nothing here derives a valid time from an
 * advisory, because an advisory does not say when the artifact became dangerous; the
 * version publish times already in the slice say that. The affected range bounds written on
 * AFFECTS are version-space facts, not timestamps.
 * sourceRef: src/lib/analysis/bitemporal.ts, plan.md section 4.
 */
async function collectAdvisories(
  argumentValues: IngestArguments,
  packages: readonly PackageFacts[],
  versionsByPackageKey: Map<string, string[]>,
  meter: HttpMeter,
): Promise<AdvisoryOutcome> {
  const outcome: AdvisoryOutcome = { advisories: [], notes: [], budgetsHit: new Set() };
  if (packages.length === 0) return outcome;

  if (!meter.hasRequestBudgetLeft()) {
    outcome.budgetsHit.add("requests");
    outcome.notes.push(
      "no advisory was queried: the request budget ran out before the OSV batch, so every " +
        "vulnerability answer over this slice is unknown",
    );
    return outcome;
  }

  const queries: OsvPackageQuery[] = packages.map((facts) => ({
    ecosystem: facts.ecosystem,
    packageName: facts.name,
  }));

  const batched = await meter.measure(() => queryOsvBatch(queries, meter.clientOptions));
  if (!batched.ok) {
    outcome.notes.push(
      `the OSV batch query failed (${batched.failure.reason}), so this slice carries no ` +
        "advisory and every vulnerability answer over it is unknown",
    );
    return outcome;
  }

  const vulnerabilityIds: string[] = [];
  const seenIds = new Set<string>();
  for (const result of batched.value) {
    for (const identifier of result.vulnerabilityIds) {
      if (seenIds.has(identifier)) continue;
      seenIds.add(identifier);
      vulnerabilityIds.push(identifier);
    }
  }
  console.log(
    `[collectAdvisories] OSV named ${vulnerabilityIds.length} advisory(ies) for ` +
      `${packages.length} package(s)`,
  );

  const selectedIds = vulnerabilityIds.slice(0, argumentValues.maxAdvisories);
  if (selectedIds.length < vulnerabilityIds.length) {
    outcome.budgetsHit.add("advisories");
    outcome.notes.push(
      `${vulnerabilityIds.length - selectedIds.length} advisory(ies) were named by OSV and not ` +
        `fetched, because the advisory budget is ${argumentValues.maxAdvisories}`,
    );
  }

  const fetched = await Promise.all(
    selectedIds.map(async (identifier) => {
      if (!meter.hasRequestBudgetLeft()) return null;
      const record = await meter.measure(() =>
        fetchOsvVulnerability(identifier, meter.clientOptions),
      );
      if (!record.ok) {
        outcome.notes.push(
          `advisory ${identifier} could not be fetched (${record.failure.reason}), so it is ` +
            "absent from the slice",
        );
        return null;
      }
      return record.value;
    }),
  );

  const missedByBudget = fetched.filter((record) => record === null).length;
  if (missedByBudget > 0 && !meter.hasRequestBudgetLeft()) {
    outcome.budgetsHit.add("requests");
  }

  for (const record of fetched) {
    if (record === null) continue;
    const mapped = mapVulnerability(record, versionsByPackageKey, outcome.notes);
    if (mapped !== null) outcome.advisories.push(mapped);
  }

  return outcome;
}

/**
 * One OSV record as advisory facts, restricted to the packages this slice holds.
 *
 * Range membership is decided here, by the semver layer, because HydraDB cannot parse a
 * range. A version the range logic cannot place is left out of the edges and disclosed:
 * folding it into "unaffected" would be a false clean answer.
 */
function mapVulnerability(
  vulnerability: OsvVulnerability,
  versionsByPackageKey: Map<string, string[]>,
  notes: string[],
): AdvisoryFacts | null {
  const identifier = vulnerability.ghsaId ?? vulnerability.id;
  const affected: AdvisoryAffected[] = [];

  for (const facts of vulnerability.affected) {
    const ecosystem = fromOsvEcosystem(facts.affected.ecosystemName);
    if (!ecosystem.ok) continue;

    const key = packageKey(ecosystem.value, facts.affected.packageName);
    const knownVersions = versionsByPackageKey.get(key);
    // An advisory naming a package outside the slice is normal: OSV answers about the whole
    // ecosystem. The edge is skipped rather than pulling an unfetched package into the graph.
    if (knownVersions === undefined) continue;

    const partitioned = partitionVersionsByAffected(knownVersions, facts.affected);
    for (const undecided of partitioned.undecided) {
      notes.push(
        `${identifier}: cannot place ${key}@${undecided} in the advisory range, so it carries ` +
          "no AFFECTS_VERSION edge and stays unknown",
      );
    }
    for (const unusable of facts.unusableRanges) {
      notes.push(
        `${identifier}: a ${unusable.kind} range on ${key} is unusable (${unusable.reason}), so ` +
          "its membership is unknown",
      );
    }

    const bounds = readRangeBounds(facts.affected);
    if (bounds.hasMultipleIntervals) {
      notes.push(
        `${identifier}: ${key} is affected in more than one interval, so the AFFECTS edge ` +
          "carries the first one and AFFECTS_VERSION carries the exact membership",
      );
    }

    affected.push({
      ecosystem: ecosystem.value,
      name: facts.affected.packageName,
      introduced: bounds.introduced,
      fixed: bounds.fixed,
      affectedVersions: partitioned.affected,
    });
  }

  if (affected.length === 0) return null;

  return {
    ghsaId: identifier,
    // Known time. OSV omits `published` on a small number of records, and -1 keeps that
    // unstated rather than inventing a disclosure date the scrubber would then trust.
    publishedAtMs: vulnerability.publishedAtMs ?? UNKNOWN_NUMERIC_FACT,
    modifiedAtMs: vulnerability.modifiedAtMs ?? UNKNOWN_NUMERIC_FACT,
    summary: vulnerability.summary ?? `${identifier} has no summary in OSV`,
    affected,
  };
}

/** The first affected interval as the graph spells it: "" for an open bound. */
function readRangeBounds(affected: AffectedPackage): {
  introduced: string;
  fixed: string;
  hasMultipleIntervals: boolean;
} {
  const intervals = affected.ranges.flatMap((range) => resolveAffectedIntervals(range));
  const first = intervals[0];
  if (first === undefined) return { introduced: "", fixed: "", hasMultipleIntervals: false };

  return {
    introduced: first.introduced ?? "",
    fixed: first.fixedExclusive ?? "",
    hasMultipleIntervals: intervals.length > 1,
  };
}

// ---------------------------------------------------------------------------
// Weekly downloads
// ---------------------------------------------------------------------------

/**
 * Weekly downloads for the whole slice, in groups.
 *
 * Grouped rather than one call for every name, because api.npmjs.org rate limits the
 * downloads endpoint and fetchNpmWeeklyDownloadsBatch discards the figures it already
 * collected when any name fails with something other than not_found
 * (src/lib/ingest/npm-registry.ts lines 437, 443 and 454). Observed live on 2026-08-17: one
 * 429 partway through the 42 scoped @voiceflow names cost all 120 packages their figure.
 * Grouping bounds that loss to one group, and a 429 stops the remaining groups instead of
 * hammering an endpoint that just asked for less.
 *
 * A name with no download data is simply absent from the map, and the package then carries
 * -1 rather than 0: a popularity of zero and an unknown popularity rank differently, and
 * the UI must not present the second as the first.
 */
async function collectWeeklyDownloads(
  argumentValues: IngestArguments,
  packages: readonly PackageFacts[],
  meter: HttpMeter,
): Promise<{ downloadsByName: Map<string, number>; notes: string[] }> {
  const downloadsByName = new Map<string, number>();
  const notes: string[] = [];
  if (packages.length === 0) return { downloadsByName, notes };

  const names = packages.map((facts) => facts.name);
  let unqueriedCount = 0;
  let wasRateLimited = false;

  for (let start = 0; start < names.length; start += DOWNLOAD_GROUP_SIZE) {
    const group = names.slice(start, start + DOWNLOAD_GROUP_SIZE);

    if (wasRateLimited || !meter.hasRequestBudgetLeft()) {
      unqueriedCount += group.length;
      continue;
    }

    const fetched = await meter.measure(() =>
      fetchNpmWeeklyDownloadsBatch(group, meter.clientOptions),
    );
    if (!fetched.ok) {
      unqueriedCount += group.length;
      if (fetched.failure.reason === "rate_limited") wasRateLimited = true;
      notes.push(
        `weekly downloads for ${group.length} package(s) were not read ` +
          `(${fetched.failure.reason}), so they carry ${UNKNOWN_NUMERIC_FACT}`,
      );
      continue;
    }

    for (const [name, downloads] of fetched.value) downloadsByName.set(name, downloads);
  }

  if (wasRateLimited) {
    notes.push(
      "the registry rate limited the downloads endpoint, so the remaining groups were not " +
        `queried. Rerun with a higher --delay-ms than ${argumentValues.requestDelayMs} to fill ` +
        "them in over the warm cache",
    );
  }

  const missing = names.filter((name) => !downloadsByName.has(name)).length - unqueriedCount;
  if (missing > 0) {
    notes.push(
      `${missing} package(s) have no weekly download figure from the registry, so they carry ` +
        `${UNKNOWN_NUMERIC_FACT}`,
    );
  }

  return { downloadsByName, notes };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

type WriteOutcome = {
  destination: string;
  manifest: SliceManifest;
  nodesWritten: number;
  edgesWritten: number;
  notes: string[];
  /**
   * The in-process graph, for the snapshot export. null on the hydra sink, where the data
   * lives in the server and a second copy on disk would be a stale duplicate.
   */
  graph: MemoryGraph | null;
  /**
   * What became of the coverage record, on a sink that had to write it itself. null on the
   * memory sink, where the caller writes it: an in-process build is the whole graph, so its
   * own counts are exact and there is nothing to read back or merge with.
   */
  coverage: CoverageRecord | null;
};

/**
 * Builds the graph in process.
 *
 * Reproducible by construction: the id map starts empty, so the same slice produces the
 * same ids in the same order. The snapshot is written afterwards by persistSnapshot,
 * because a snapshot carries the manifest and the manifest is not final until the run's
 * coverage notes are folded into it.
 */
async function writeSliceToMemory(slice: IngestSlice): Promise<Result<WriteOutcome, Failure>> {
  const graph = new MemoryGraph();
  const writer = new GraphWriter(new MemorySink(graph), new IdMap());

  const staged = await stageAndFlush(writer, slice);
  if (!staged.ok) return staged;

  return succeed({
    destination: graph.describe(),
    manifest: staged.value.manifest,
    nodesWritten: staged.value.nodesWritten,
    edgesWritten: staged.value.edgesWritten,
    notes: staged.value.notes,
    graph,
    // The caller writes the record for this sink: the snapshot it is about to export carries
    // the same manifest, so the two cannot describe different graphs.
    coverage: null,
  });
}

/**
 * Builds the graph in a running HydraDB.
 *
 * The id map is loaded from disk first and persisted on flush, because reassigning ids for
 * keys the graph already holds would write a second node for the same package instead of
 * updating the first one.
 */
async function writeSliceToHydra(
  slice: IngestSlice,
  runNotes: readonly string[],
  manifestPath: string,
): Promise<Result<WriteOutcome, Failure>> {
  const config = readHydraConfigFromEnv();
  if (!config.ok) return config;

  console.log(
    `[writeSliceToHydra] config read, transport=${config.value.transport} ` +
      `graph=${config.value.graphId} namespace=${config.value.namespace} ` +
      `cell=${config.value.cellId} token=${describeTokenForLog(config.value.authToken)}`,
  );

  const idMap = await IdMap.load(DEFAULT_ID_MAP_PATHS);
  if (!idMap.ok) return idMap;

  const transport = createTransport(config.value);
  const writer = new GraphWriter(new TransportSink(transport), idMap.value, {
    idMapPaths: DEFAULT_ID_MAP_PATHS,
  });

  const staged = await stageAndFlush(writer, slice);
  const destination = transport.describe();

  // The record is written here rather than by the caller, because the counts in it are read back
  // out of the engine and the transport is about to close. The run's own notes are folded in
  // first, so the file states what this ingest had to assume as well as what it covered.
  const coverage: CoverageRecord = staged.ok
    ? await recordLiveGraphCoverage(
        new HydraGateway(transport),
        { ...staged.value.manifest, notes: [...staged.value.manifest.notes, ...runNotes] },
        manifestPath,
      )
    : { location: "not written, the graph write failed", failure: null };

  const closed = await closeTransport(transport);
  if (!closed.ok) console.warn(`[writeSliceToHydra] ${closed.failure.message}`);

  if (!staged.ok) return staged;

  return succeed({
    destination,
    manifest: staged.value.manifest,
    nodesWritten: staged.value.nodesWritten,
    edgesWritten: staged.value.edgesWritten,
    notes: staged.value.notes,
    graph: null,
    coverage,
  });
}

function createTransport(config: HydraConfig): GraphTransport {
  return config.transport === "bolt" ? new BoltTransport(config) : new HttpTransport(config);
}

type StagedOutcome = {
  manifest: SliceManifest;
  nodesWritten: number;
  edgesWritten: number;
  notes: string[];
};

/** Stages the slice through the shared builder, flushes once, and gathers the disclosures. */
async function stageAndFlush(
  writer: GraphWriter,
  slice: IngestSlice,
): Promise<Result<StagedOutcome, Failure>> {
  const built = await buildGraph(writer, slice, { generatedAtMs: Date.now() });
  if (!built.ok) return built;

  const flushed = await writer.flush();
  if (!flushed.ok) return flushed;

  const notes = [...built.value.notes, ...flushed.value.notes];

  if (built.value.stubVersionKeys.length > 0) {
    notes.push(
      `${built.value.stubVersionKeys.length} version(s) were written as stubs, for example ` +
        built.value.stubVersionKeys.slice(0, 5).join(", "),
    );
  }
  if (built.value.skipped.unselectableKeys > 0) {
    notes.push(
      `${built.value.skipped.unselectableKeys} key(s) were refused as selector values and are ` +
        "absent from the graph",
    );
  }
  if (built.value.skipped.advisoryVersionsWithoutNode > 0) {
    notes.push(
      `${built.value.skipped.advisoryVersionsWithoutNode} advisory version edge(s) had no node ` +
        "to attach to",
    );
  }

  return succeed({
    manifest: built.value.manifest,
    nodesWritten: flushed.value.nodesWritten,
    edgesWritten: flushed.value.edgesWritten,
    notes,
  });
}

/**
 * Persists the graph and its coverage as one snapshot file.
 *
 * The serialisation, the integrity rules and the format version all live in
 * src/lib/graph/snapshot.ts, so this script and the incident seed write the one format the
 * app reads. The manifest passed here is the final one, run notes included: a snapshot that
 * carried a manifest without its budget disclosures would answer "not exposed" on a slice
 * that was merely cut short.
 */
async function persistSnapshot(
  graph: MemoryGraph,
  manifest: SliceManifest,
  snapshotPath: string,
): Promise<Result<string, Failure>> {
  const snapshot = buildGraphSnapshot({
    graph,
    manifest,
    generatedAtMs: manifest.generatedAtMs,
    source: SNAPSHOT_SOURCE,
  });

  const written = await writeGraphSnapshot(snapshot, snapshotPath);
  if (!written.ok) return written;

  return succeed(
    `${written.value.path}, ${written.value.nodeCount} nodes ${written.value.edgeCount} edges ` +
      `${written.value.byteSize} bytes`,
  );
}

async function closeTransport(transport: GraphTransport): Promise<Result<void, Failure>> {
  return await fromThrowing(
    "internal",
    "[closeTransport] transport did not close cleanly",
    async () => {
      await transport.close();
    },
  );
}

function countDeclaredEdges(slice: IngestSlice): number {
  let total = 0;
  for (const facts of slice.versions) total += facts.declaredDependencies.length;
  return total;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printBudgets(argumentValues: IngestArguments): void {
  const rows: readonly [string, string][] = [
    ["seeds", argumentValues.seedNames?.join(", ") ?? "every package the incident packs name"],
    ["max packages", String(argumentValues.maxPackages)],
    ["max versions per package", String(argumentValues.maxVersionsPerPackage)],
    ["max expansion depth", String(argumentValues.maxDepth)],
    ["max network requests", String(argumentValues.maxNetworkRequests)],
    ["closures per package", String(argumentValues.closuresPerPackage)],
    ["max advisories", String(argumentValues.maxAdvisories)],
    ["concurrency", String(argumentValues.concurrency)],
    ["delay per request", `${argumentValues.requestDelayMs} ms`],
    [
      "response cache",
      argumentValues.isRefresh
        ? `${argumentValues.harvestDirectory} (refreshing, reads bypassed)`
        : `${argumentValues.harvestDirectory} (max age ${argumentValues.cacheMaxAgeMs} ms)`,
    ],
    ["sink", argumentValues.sink],
    ["snapshot", argumentValues.sink === "hydra" ? "not written, HydraDB holds the data" : argumentValues.snapshotPath],
    ["manifest", argumentValues.manifestPath],
  ];

  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  console.log("[printBudgets] budgets and destinations for this run");
  for (const [label, value] of rows) {
    console.log(`[printBudgets]   ${label.padEnd(labelWidth)}  ${value}`);
  }
}

/** Turns the budgets that were hit into manifest notes, in the abstention model's language. */
function describeBudgetNotes(
  argumentValues: IngestArguments,
  budgetsHit: ReadonlySet<BudgetName>,
): string[] {
  const notes: string[] = [
    "expansion follows dependency edges only: no public API lists a package's dependents by " +
      "name, so dependent coverage is exactly the seed set and a dependents answer over any " +
      "other package is unknown",
  ];

  if (budgetsHit.has("packages")) {
    notes.push(
      `the package budget of ${argumentValues.maxPackages} was reached, so reachable packages ` +
        "are missing from this slice",
    );
  }
  if (budgetsHit.has("versionsPerPackage")) {
    notes.push(
      `at least one package has more versions than the per-package budget of ` +
        `${argumentValues.maxVersionsPerPackage}, so its version history is incomplete`,
    );
  }
  if (budgetsHit.has("depth")) {
    notes.push(
      `the expansion depth budget of ${argumentValues.maxDepth} was reached, so the deepest ` +
        "level of this slice resolves into stubs",
    );
  }
  if (budgetsHit.has("requests")) {
    notes.push(
      `the network request budget of ${argumentValues.maxNetworkRequests} was spent before the ` +
        "slice was complete, so parts of it were never fetched",
    );
  }
  if (budgetsHit.has("advisories")) {
    notes.push(
      `the advisory budget of ${argumentValues.maxAdvisories} was reached, so OSV named ` +
        "advisories this slice does not carry",
    );
  }

  return notes;
}

type IngestReport = {
  argumentValues: IngestArguments;
  manifest: SliceManifest;
  destination: string;
  nodesWritten: number;
  edgesWritten: number;
  declaredEdgeCount: number;
  meterCounts: MeterCounts;
  budgetsHit: ReadonlySet<BudgetName>;
  elapsedMs: number;
  notes: readonly string[];
  /** Where the record went, so the summary states the file that was actually written. */
  coverage: CoverageRecord;
};

function printIngestReport(report: IngestReport): void {
  const counts = report.manifest.counts;
  const rows: readonly [string, string][] = [
    ["sink", report.argumentValues.sink === "hydra" ? "live HydraDB" : "in-process MemoryGraph"],
    ["destination", report.destination],
    ["packages", String(counts.packages)],
    ["versions", String(counts.versions)],
    ["maintainers", String(counts.maintainers)],
    ["advisories", String(counts.advisories)],
    ["resolution edges", String(counts.resolutionEdges)],
    ["declared edges", String(report.declaredEdgeCount)],
    ["nodes written", String(report.nodesWritten)],
    ["edges written", String(report.edgesWritten)],
    ["closed packages", String(report.manifest.closedPackageKeys.length)],
    ["partial packages", String(report.manifest.partialPackageKeys.length)],
    ["upstream calls", String(report.meterCounts.upstreamCalls)],
    ["requests made", String(report.meterCounts.networkRequests)],
    ["cache hits", String(report.meterCounts.cacheHits)],
    [
      "budgets hit",
      report.budgetsHit.size === 0 ? "none" : [...report.budgetsHit].join(", "),
    ],
    ["wall clock", `${report.elapsedMs} ms`],
    ["manifest", report.coverage.location],
  ];

  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  console.log("[printIngestReport] ingest summary");
  for (const [label, value] of rows) {
    console.log(`[printIngestReport]   ${label.padEnd(labelWidth)}  ${value}`);
  }

  if (report.notes.length === 0) return;

  console.log(`[printIngestReport] ${report.notes.length} disclosure(s) about this slice`);
  for (const note of report.notes.slice(0, MAX_PRINTED_NOTES)) {
    console.log(`[printIngestReport]   ${note}`);
  }
  if (report.notes.length > MAX_PRINTED_NOTES) {
    console.log(
      `[printIngestReport]   ... ${report.notes.length - MAX_PRINTED_NOTES} more, all of them in ` +
        report.argumentValues.manifestPath,
    );
  }
}

/**
 * Writes the record for an in-process build.
 *
 * No read-back and no merge, unlike the live path: this run built the whole graph, so its own
 * counts are exact, and the snapshot it exports carries the same manifest. A merge here would
 * fold claims about a live engine into a record of a file.
 * sourceRef: src/lib/graph/coverage-record.ts.
 */
async function writeMemoryCoverage(
  manifest: SliceManifest,
  manifestPath: string,
): Promise<CoverageRecord> {
  const saved = await saveSliceManifest(manifest, manifestPath);
  if (!saved.ok) return { location: `not written, ${saved.failure.message}`, failure: saved.failure };
  return { location: `written to ${manifestPath}`, failure: null };
}

/** Prints a Failure in full, then the next thing to try. Same shape as hydra-health. */
function reportFailure(stage: string, failure: Failure): void {
  console.error(`[reportFailure] FAILED at ${stage}, reason=${failure.reason}`);
  console.error(`[reportFailure] ${failure.message}`);
  if (failure.status !== undefined) {
    console.error(`[reportFailure] http status ${failure.status}`);
  }
  if (failure.context !== undefined) {
    const pairs = Object.entries(failure.context).map(([name, value]) => `${name}=${String(value)}`);
    if (pairs.length > 0) console.error(`[reportFailure] context ${pairs.join(" ")}`);
  }
  const remedy = describeRemedy(failure);
  if (remedy !== null) console.error(`[reportFailure] next step: ${remedy}`);
}

function describeRemedy(failure: Failure): string | null {
  switch (failure.reason) {
    case "invalid_input":
      return `fix the argument named above. ${USAGE_LINE}`;
    case "not_found":
      return "check the seed spelling, an unpublished package answers 404 on the registry";
    case "rate_limited":
      return "raise --delay-ms and lower --concurrency, then rerun over the warm cache";
    case "upstream_unavailable":
      return "the registry, deps.dev or OSV did not answer, rerun when it does";
    case "timeout":
      return "lower --concurrency, or rerun to pick up the cached responses";
    case "graph_unavailable":
      return "start HydraDB with `docker compose up -d graph-node`, or drop --sink hydra";
    case "query_budget_exceeded":
      return "the engine refused a batch on a budget, lower --max-packages and rerun";
    case "unsupported":
      return "this slice needs a source this script does not fetch, see the message above";
    default:
      return null;
  }
}

function elapsedMsSince(startedAtMs: number): number {
  return Math.round(performance.now() - startedAtMs);
}

function sleepMs(durationMs: number): Promise<void> {
  return new Promise((resolveTimer) => setTimeout(resolveTimer, durationMs));
}

const exitCode = await runIngest(process.argv.slice(2));
process.exit(exitCode);
