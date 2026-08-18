/**
 * Loads the curated incident replay packs into the graph, so the time scrubber replays
 * real timestamps instead of invented ones.
 *
 * Usage:
 *   bun run seed                                     every pack, into a snapshot
 *   bun run seed -- --incident event-stream-2018     one pack (repeatable)
 *   bun run seed -- --live                           into a running HydraDB
 *   bun run seed -- --snapshot data/graph/demo.json  another snapshot path
 *   bun run seed -- --directory test/fixtures/packs  another pack directory
 *
 * The default sink is in process on purpose. HydraDB needs Docker, the app already knows
 * how to answer from an exported snapshot (HYDRA_SNAPSHOT_PATH), and a seed that only
 * worked with a server would leave the demo with an empty graph on the machines that
 * matter most. `--live` is the opt in for a real node. The snapshot itself is written by
 * the shared serialiser in src/lib/graph/snapshot.ts, which validates the graph before
 * anything reaches the disk and embeds the slice manifest in the same file, so this
 * script never invents a format the app's loader would refuse.
 *
 * WHAT AN INCIDENT PACK DOES AND DOES NOT CARRY. A pack states, with sources: which
 * artifacts turned malicious and when they became installable, which advisories were
 * published and when, and which services pinned which versions at which instant. It
 * carries no dependency closure: no pack says that version X resolves to version Y. So
 * the seeded graph fully supports the bitemporal question ("which services pinned this
 * while it was live and before the advisory") and supports no multi-hop blast radius at
 * all. Every version written here is therefore marked `closureTruncated`, which the
 * builder propagates to the slice manifest as `partial`. That is what makes an empty
 * dependency traversal read as `unknown` instead of as a clean `not_exposed`.
 * sourceRef: src/lib/incidents/pack.ts, src/lib/ingest/graph-builder.ts,
 * src/lib/analysis/abstention.ts decideVerdict.
 *
 * Errors are values everywhere below. Only `runSeed` decides an exit code, and only the
 * last two lines of this file exit the process.
 */

import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { partitionVersionsByAffected } from "@/lib/analysis/semver-facts";
import { type CoverageRecord, recordLiveGraphCoverage } from "@/lib/graph/coverage-record";
import { MemoryGraph } from "@/lib/graph/memory-gateway";
import { type Ecosystem, UNKNOWN_NUMERIC_VALUE, packageKey, versionKey } from "@/lib/graph/model";
import type { SliceManifest } from "@/lib/graph/slice-manifest";
import {
  DEFAULT_GRAPH_SNAPSHOT_PATH,
  buildGraphSnapshot,
  writeGraphSnapshot,
} from "@/lib/graph/snapshot";
import { BoltTransport } from "@/lib/hydra/bolt-transport";
import { type HydraConfig, describeTokenForLog, readHydraConfigFromEnv } from "@/lib/hydra/config";
import { HttpTransport } from "@/lib/hydra/http-transport";
import { HydraGateway } from "@/lib/hydra/hydra-gateway";
import { DEFAULT_ID_MAP_PATHS, IdMap } from "@/lib/hydra/id-map";
import type { GraphTransport } from "@/lib/hydra/transport";
import {
  type IncidentAdvisory,
  type IncidentPack,
  INCIDENT_PACK_DIRECTORY,
  computeExposureWindow,
  loadIncidentPack,
} from "@/lib/incidents/pack";
import {
  type AdvisoryAffected,
  type AdvisoryFacts,
  type IngestSlice,
  type PackageFacts,
  type ServiceFacts,
  type ServiceResolution,
  type VersionFacts,
  buildGraph,
} from "@/lib/ingest/graph-builder";
import { GraphWriter, MemorySink, TransportSink } from "@/lib/ingest/writer";
import { type Failure, type Result, fail, fromThrowing, succeed } from "@/lib/result";

/** Every pack loaded and the graph was written. */
const EXIT_SEEDED = 0;

/** Nothing was written: no pack loaded, or the write failed. */
const EXIT_NOT_SEEDED = 1;

/**
 * The graph was written, but at least one pack failed validation and is missing from it.
 * Non-zero so a run that silently seeded three incidents out of four is visible.
 */
const EXIT_SEEDED_INCOMPLETE = 2;

/**
 * The live graph was written but its coverage record was not.
 *
 * Non-zero because the record is not bookkeeping: without it the app reads the previous
 * ingest's manifest as a description of a graph that has since grown, and reports counts
 * for a graph that is not the one answering.
 */
const EXIT_SEEDED_NO_COVERAGE = 3;

/** Which writer produced a snapshot, recorded in the file. Log safe: never a path. */
const SNAPSHOT_SOURCE = "seed-incidents";

/**
 * Extension of a pack file. The name without it is the slug.
 * sourceRef: src/lib/incidents/pack.ts.
 */
const JSON_FILE_EXTENSION = ".json";

/** Where a Service node written by this script came from. sourceRef: src/lib/graph/model.ts. */
const SEEDED_SERVICE_SOURCE = "seed";

/**
 * Value written for a fact the pack does not state. Unit: epoch milliseconds when used as
 * a clock, downloads when used as a count. The graph model reserves this value for "the source
 * had none", the merge lets a real reading from any other input win over it, and the analysis
 * layer refuses to place a window on it, which is what keeps an unstated timestamp out of the
 * scrubber.
 * sourceRef: src/lib/graph/model.ts UNKNOWN_NUMERIC_VALUE.
 */
const UNKNOWN_NUMERIC_FACT = UNKNOWN_NUMERIC_VALUE;

/** Milliseconds in a day, for reporting an exposure window in the unit humans use. */
const MS_PER_DAY = 86_400_000;

const USAGE_LINE =
  "usage: bun run seed [-- --live] [-- --incident <slug>] [-- --snapshot <path>] [-- --directory <path>]";

/** memory writes a JSON snapshot, live writes into a running HydraDB. */
type SeedSink = "memory" | "live";

type SeedArguments = {
  sink: SeedSink;
  /** Empty means every pack in the directory. */
  requestedSlugs: readonly string[];
  packDirectory: string;
  snapshotPath: string;
};

type PackOutcome =
  | { slug: string; isLoaded: true; pack: IncidentPack }
  | { slug: string; isLoaded: false; failure: Failure };

type SeedSummary = {
  sink: SeedSink;
  destination: string;
  outcomes: readonly PackOutcome[];
  manifest: SliceManifest;
  nodesWritten: number;
  edgesWritten: number;
  /** Disclosures about what the mapping had to assume. Never silent. */
  notes: readonly string[];
  snapshotPath: string | null;
  /** Where the coverage record for this graph lives. */
  coverageLocation: string;
};

async function runSeed(argumentValues: readonly string[]): Promise<number> {
  const parsed = parseArguments(argumentValues);
  if (!parsed.ok) {
    reportFailure("arguments", parsed.failure);
    return EXIT_NOT_SEEDED;
  }

  const slugs = await resolveSlugs(parsed.value);
  if (!slugs.ok) {
    reportFailure("pack discovery", slugs.failure);
    return EXIT_NOT_SEEDED;
  }

  const outcomes = await loadPacks(slugs.value, parsed.value.packDirectory);
  printLoadResults(outcomes);

  const loadedPacks = outcomes.filter(isLoadedOutcome).map((outcome) => outcome.pack);
  if (loadedPacks.length === 0) {
    console.error(
      "[runSeed] no pack passed validation, so nothing was written. Fix the field paths named above and rerun.",
    );
    return EXIT_NOT_SEEDED;
  }

  const mapped = mapPacksToSlice(loadedPacks);

  const seeded =
    parsed.value.sink === "live"
      ? await seedLiveGraph(mapped.slice)
      : await seedSnapshot(mapped.slice, parsed.value.snapshotPath);
  if (!seeded.ok) {
    reportFailure(`${parsed.value.sink} write`, seeded.failure);
    return EXIT_NOT_SEEDED;
  }

  printSeedSummary({
    sink: parsed.value.sink,
    destination: seeded.value.destination,
    outcomes,
    manifest: seeded.value.manifest,
    nodesWritten: seeded.value.nodesWritten,
    edgesWritten: seeded.value.edgesWritten,
    notes: [...mapped.notes, ...seeded.value.notes],
    snapshotPath: seeded.value.snapshotPath,
    coverageLocation: seeded.value.coverage.location,
  });

  const coverageFailure = seeded.value.coverage.failure;
  if (coverageFailure !== null) reportFailure("coverage record", coverageFailure);

  const failedCount = outcomes.length - loadedPacks.length;
  if (failedCount > 0) {
    console.error(
      `[runSeed] seeded ${loadedPacks.length} of ${outcomes.length} pack(s): ${failedCount} failed ` +
        "validation and is absent from the graph",
    );
    // Ordered before the coverage code because a pack that never loaded is the upstream problem:
    // the record can only describe the graph once the graph holds what it was meant to hold.
    // Both diagnostics are already printed, so neither is hidden by the code that is returned.
    return EXIT_SEEDED_INCOMPLETE;
  }

  if (coverageFailure !== null) {
    console.error(
      "[runSeed] the graph was written but nothing on disk describes it, so the app will read the " +
        "previous record as a description of this graph",
    );
    return EXIT_SEEDED_NO_COVERAGE;
  }

  console.log(`[runSeed] seeded ${loadedPacks.length} incident pack(s)`);
  return EXIT_SEEDED;
}

// ---------------------------------------------------------------------------
// Arguments and pack discovery
// ---------------------------------------------------------------------------

function parseArguments(argumentValues: readonly string[]): Result<SeedArguments, Failure> {
  let sink: SeedSink = "memory";
  const requestedSlugs: string[] = [];
  let packDirectory = INCIDENT_PACK_DIRECTORY;
  let snapshotPath: string | null = null;

  for (let index = 0; index < argumentValues.length; index += 1) {
    const argument = argumentValues[index];

    if (argument === "--live") {
      sink = "live";
      continue;
    }
    if (argument === "--memory") {
      sink = "memory";
      continue;
    }

    if (argument === "--incident" || argument === "--snapshot" || argument === "--directory") {
      const value = argumentValues[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return fail("invalid_input", `[parseArguments] ${argument} needs a value. ${USAGE_LINE}`);
      }
      if (argument === "--incident") requestedSlugs.push(value);
      else if (argument === "--snapshot") snapshotPath = value;
      else packDirectory = value;

      index += 1;
      continue;
    }

    return fail("invalid_input", `[parseArguments] unknown argument "${argument}". ${USAGE_LINE}`);
  }

  if (sink === "live" && snapshotPath !== null) {
    return fail(
      "invalid_input",
      "[parseArguments] --snapshot and --live ask for two different destinations. Pick one.",
    );
  }

  return succeed({
    sink,
    requestedSlugs,
    packDirectory,
    snapshotPath: snapshotPath ?? DEFAULT_GRAPH_SNAPSHOT_PATH,
  });
}

/**
 * The slugs to load, in a stable order.
 *
 * Named slugs are taken as given so a typo fails loudly at load time, naming the file
 * that is missing, rather than being silently dropped from the seed.
 */
async function resolveSlugs(argumentValues: SeedArguments): Promise<Result<string[], Failure>> {
  if (argumentValues.requestedSlugs.length > 0) {
    return succeed([...argumentValues.requestedSlugs]);
  }

  const resolvedDirectory = resolve(argumentValues.packDirectory);
  const entries = await fromThrowing(
    "not_found",
    `[resolveSlugs] cannot read the pack directory ${argumentValues.packDirectory}`,
    () => readdir(resolvedDirectory),
  );
  if (!entries.ok) return entries;

  const slugs = entries.value
    .filter((entry) => entry.endsWith(JSON_FILE_EXTENSION))
    .map((entry) => entry.slice(0, -JSON_FILE_EXTENSION.length))
    .sort((left, right) => left.localeCompare(right));

  if (slugs.length === 0) {
    return fail(
      "not_found",
      `[resolveSlugs] no ${JSON_FILE_EXTENSION} pack in ${argumentValues.packDirectory}`,
    );
  }
  return succeed(slugs);
}

/**
 * Loads and validates each pack on its own.
 *
 * One pack at a time rather than `loadAllIncidentPacks`, which fails the whole call on
 * the first invalid file: this script has to report which packs loaded and which did not,
 * and seed the ones that did.
 */
async function loadPacks(
  slugs: readonly string[],
  packDirectory: string,
): Promise<PackOutcome[]> {
  const outcomes: PackOutcome[] = [];

  for (const slug of slugs) {
    const loaded = await loadIncidentPack(slug, packDirectory);
    outcomes.push(
      loaded.ok
        ? { slug, isLoaded: true, pack: loaded.value }
        : { slug, isLoaded: false, failure: loaded.failure },
    );
  }

  return outcomes;
}

function isLoadedOutcome(outcome: PackOutcome): outcome is Extract<PackOutcome, { isLoaded: true }> {
  return outcome.isLoaded;
}

// ---------------------------------------------------------------------------
// Pack to IngestSlice
// ---------------------------------------------------------------------------

/** One service as the packs describe it: its readable name and every line it pins. */
type SeededService = {
  /** The pack's readable name, such as "ledger-api". Held beside the key, not instead of it. */
  name: string;
  resolutions: ServiceResolution[];
};

/** Accumulates the merged slice, keyed so two packs cannot write one node twice. */
type SliceAccumulator = {
  packagesByKey: Map<string, PackageFacts>;
  versionsByKey: Map<string, VersionFacts>;
  /** Service key to that service. Keyed by the pack's prefixed key, see mapService. */
  servicesByKey: Map<string, SeededService>;
  advisoriesById: Map<string, IncidentAdvisory>;
  notes: string[];
};

/**
 * Turns the loaded packs into one slice.
 *
 * Merged rather than seeded pack by pack so the manifest describes the whole graph once,
 * and so a package two packs both mention gets one node instead of two.
 */
function mapPacksToSlice(packs: readonly IncidentPack[]): { slice: IngestSlice; notes: string[] } {
  const accumulator: SliceAccumulator = {
    packagesByKey: new Map(),
    versionsByKey: new Map(),
    servicesByKey: new Map(),
    advisoriesById: new Map(),
    notes: [],
  };

  for (const pack of packs) {
    for (const compromised of pack.compromisedVersions) {
      recordPackage(accumulator, compromised.ecosystem, compromised.name);
      recordVersion(accumulator, {
        ecosystem: compromised.ecosystem,
        name: compromised.name,
        version: compromised.version,
        publishedAtMs: compromised.publishedAtMs,
        hasInstallScript: compromised.hasInstallScript,
        declaredDependencies: [],
        resolvedDependencies: [],
        // No pack states a dependency closure, so no package in this slice can support a
        // negative answer about who depends on it.
        closureTruncated: true,
      });
    }

    for (const service of pack.services) {
      mapService(accumulator, pack, service.key, service.name, service.resolved);
    }

    for (const advisory of pack.advisories) {
      const existing = accumulator.advisoriesById.get(advisory.advisoryId);
      if (existing !== undefined) {
        accumulator.notes.push(
          `advisory ${advisory.advisoryId} appears in more than one pack, the first occurrence was kept`,
        );
        continue;
      }
      accumulator.advisoriesById.set(advisory.advisoryId, advisory);
    }
  }

  const versionsByPackageKey = groupVersionsByPackageKey(accumulator);
  const advisories = [...accumulator.advisoriesById.values()].map((advisory) =>
    mapAdvisory(advisory, versionsByPackageKey, accumulator.notes),
  );

  const services: ServiceFacts[] = [...accumulator.servicesByKey.entries()].map(
    ([serviceKeyValue, service]) => ({
      // The prefixed key is what every query, manifest entry and fixture addresses a
      // service by, and the pack's readable name rides along beside it so a rail can print
      // "ledger-api" without re-deriving it from the key.
      // sourceRef: src/lib/graph/model.ts NODE_PROPERTY_NAMES.Service.
      key: serviceKeyValue,
      name: service.name,
      source: SEEDED_SERVICE_SOURCE,
      resolutions: service.resolutions,
    }),
  );

  return {
    slice: {
      packages: [...accumulator.packagesByKey.values()],
      versions: [...accumulator.versionsByKey.values()],
      services,
      advisories,
      // Packs record incidents, not name similarity. Typosquat edges come from the
      // detector over ingested registry data, never from a curated file.
      typosquats: [],
    },
    notes: accumulator.notes,
  };
}

/** Records one service's lockfile lines, and the versions they pin. */
function mapService(
  accumulator: SliceAccumulator,
  pack: IncidentPack,
  serviceKeyValue: string,
  serviceName: string,
  resolved: IncidentPack["services"][number]["resolved"],
): void {
  const existing = accumulator.servicesByKey.get(serviceKeyValue);
  if (existing !== undefined) {
    // Union rather than first-wins: every resolution is a fact one pack states about one
    // service, and dropping the second pack's lines would understate that service's
    // exposure, which is the one error direction this project must not make.
    accumulator.notes.push(
      `service ${serviceKeyValue} appears in more than one pack (${pack.slug} among them), ` +
        "its lockfile lines were merged",
    );
  }
  // The first pack to name the service names it. Two packs describing one key describe one
  // service, so the readable name is not something the second one gets to overwrite.
  const resolutions = existing?.resolutions ?? [];
  const name = existing?.name ?? serviceName;

  for (const resolution of resolved) {
    recordPackage(accumulator, resolution.ecosystem, resolution.name);

    const key = versionKey(resolution.ecosystem, resolution.name, resolution.version);
    if (!accumulator.versionsByKey.has(key)) {
      // A version known only as a lockfile line. Its publish clock is unstated by the
      // pack, so it is written as the unknown sentinel rather than invented, and the
      // install-script flag is written false because the pack makes no claim either way.
      accumulator.notes.push(
        `${key} is known only from a lockfile line, so its publish time is unknown (${UNKNOWN_NUMERIC_FACT}) ` +
          "and its install-script flag is false because no pack states it",
      );
      recordVersion(accumulator, {
        ecosystem: resolution.ecosystem,
        name: resolution.name,
        version: resolution.version,
        publishedAtMs: UNKNOWN_NUMERIC_FACT,
        hasInstallScript: false,
        declaredDependencies: [],
        resolvedDependencies: [],
        closureTruncated: true,
      });
    }

    resolutions.push({
      ecosystem: resolution.ecosystem,
      name: resolution.name,
      version: resolution.version,
      resolvedAtMs: resolution.resolvedAtMs,
    });
  }

  accumulator.servicesByKey.set(serviceKeyValue, { name, resolutions });
}

/**
 * Turns a pack advisory into advisory facts, with range membership precomputed.
 *
 * HydraDB cannot parse a semver range, so which versions an advisory covers has to be
 * decided here and written as AFFECTS_VERSION edges. A version the range logic cannot
 * place is left out of the edges and reported as a note: it is unknown, and folding it
 * into "unaffected" would be a false clean answer.
 */
function mapAdvisory(
  advisory: IncidentAdvisory,
  versionsByPackageKey: Map<string, string[]>,
  notes: string[],
): AdvisoryFacts {
  const affected: AdvisoryAffected[] = advisory.affects.map((entry) => {
    const candidates = versionsByPackageKey.get(packageKey(entry.ecosystem, entry.name)) ?? [];

    const partitioned = partitionVersionsByAffected(candidates, {
      ecosystemName: entry.ecosystem,
      packageName: entry.name,
      ranges: [
        {
          kind: "semver",
          events:
            entry.fixed === null
              ? [{ type: "introduced", version: entry.introduced }]
              : [
                  { type: "introduced", version: entry.introduced },
                  { type: "fixed", version: entry.fixed },
                ],
        },
      ],
      explicitVersions: [],
    });

    for (const undecided of partitioned.undecided) {
      notes.push(
        `${advisory.advisoryId}: cannot place ${entry.ecosystem}:${entry.name}@${undecided} in the ` +
          `range introduced ${entry.introduced} fixed ${entry.fixed ?? "none"}, so it carries no ` +
          "AFFECTS_VERSION edge and stays unknown",
      );
    }

    return {
      ecosystem: entry.ecosystem,
      name: entry.name,
      introduced: entry.introduced,
      // The graph model spells an unfixed range as the empty string, the pack spells it
      // as null. sourceRef: src/lib/ingest/graph-builder.ts AdvisoryAffected.fixed.
      fixed: entry.fixed ?? "",
      affectedVersions: partitioned.affected,
    };
  });

  return {
    ghsaId: advisory.advisoryId,
    publishedAtMs: advisory.publishedAtMs,
    modifiedAtMs: advisory.modifiedAtMs,
    summary: advisory.summary,
    affected,
  };
}

function recordPackage(accumulator: SliceAccumulator, ecosystem: Ecosystem, name: string): void {
  const key = packageKey(ecosystem, name);
  if (accumulator.packagesByKey.has(key)) return;

  accumulator.packagesByKey.set(key, {
    ecosystem,
    name,
    // A pack records an incident, not registry statistics, and the graph model reserves
    // -1 for a count the source did not give rather than a misleading 0.
    weeklyDownloads: UNKNOWN_NUMERIC_FACT,
    // Maintainer edges come from the registry ingest. A pack names no accounts.
    maintainerUsernames: [],
  });
}

/** First writer wins, and a disagreement between two packs is reported rather than merged. */
function recordVersion(accumulator: SliceAccumulator, facts: VersionFacts): void {
  const key = versionKey(facts.ecosystem, facts.name, facts.version);
  const existing = accumulator.versionsByKey.get(key);

  if (existing === undefined) {
    accumulator.versionsByKey.set(key, facts);
    return;
  }

  if (
    existing.publishedAtMs !== facts.publishedAtMs ||
    existing.hasInstallScript !== facts.hasInstallScript
  ) {
    accumulator.notes.push(
      `${key} is stated twice with different facts (published ${existing.publishedAtMs} vs ` +
        `${facts.publishedAtMs}), the first was kept`,
    );
  }
}

function groupVersionsByPackageKey(accumulator: SliceAccumulator): Map<string, string[]> {
  const versionsByPackageKey = new Map<string, string[]>();

  for (const facts of accumulator.versionsByKey.values()) {
    const key = packageKey(facts.ecosystem, facts.name);
    const versions = versionsByPackageKey.get(key);
    if (versions === undefined) versionsByPackageKey.set(key, [facts.version]);
    else versions.push(facts.version);
  }

  return versionsByPackageKey;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

type SeedOutcome = {
  destination: string;
  manifest: SliceManifest;
  nodesWritten: number;
  edgesWritten: number;
  notes: string[];
  snapshotPath: string | null;
  /**
   * What became of the coverage record. Carried out of the sink rather than derived from the
   * outcome, because only the sink knows: a snapshot embeds its manifest and cannot be separated
   * from it, while a live seed has to read the engine back and write a file.
   */
  coverage: CoverageRecord;
};

/**
 * Builds the graph in process and writes it as a snapshot.
 *
 * Reproducible by construction: the id map starts empty, so the same packs produce the
 * same ids in the same order, and the shared serialiser sorts rows by id, so two runs
 * differ only in the timestamp they record and a snapshot diff reads as a change in the
 * data. The snapshot carries its own slice manifest, which is what stops a graph and its
 * coverage record from being separated.
 */
async function seedSnapshot(
  slice: IngestSlice,
  snapshotPath: string,
): Promise<Result<SeedOutcome, Failure>> {
  const graph = new MemoryGraph();
  const writer = new GraphWriter(new MemorySink(graph), new IdMap());

  const written = await stageAndFlush(writer, slice);
  if (!written.ok) return written;

  const snapshot = buildGraphSnapshot({
    graph,
    manifest: written.value.manifest,
    generatedAtMs: written.value.manifest.generatedAtMs,
    source: SNAPSHOT_SOURCE,
  });

  const saved = await writeGraphSnapshot(snapshot, snapshotPath);
  if (!saved.ok) return saved;

  return succeed({
    destination: `${graph.describe()}, exported to ${saved.value.path} (${saved.value.byteSize} bytes)`,
    manifest: written.value.manifest,
    nodesWritten: written.value.nodesWritten,
    edgesWritten: written.value.edgesWritten,
    notes: written.value.notes,
    snapshotPath: saved.value.path,
    coverage: { location: "embedded in the snapshot", failure: null },
  });
}

/**
 * Builds the graph in a running HydraDB, then writes the coverage record that describes it.
 *
 * The id map is loaded from disk first and persisted on flush, because reassigning ids
 * for keys the graph already holds would write a second node for the same package rather
 * than updating the first one.
 *
 * Two scripts push into one engine: the registry ingest and this one. Neither can describe the
 * result from its own half, so the record is read back out of the engine while the transport is
 * still open, which is why the coverage record is written between the flush and the close.
 * sourceRef: src/lib/graph/coverage-record.ts.
 */
async function seedLiveGraph(slice: IngestSlice): Promise<Result<SeedOutcome, Failure>> {
  const config = readHydraConfigFromEnv();
  if (!config.ok) return config;

  console.log(
    `[seedLiveGraph] config read, transport=${config.value.transport} graph=${config.value.graphId} ` +
      `namespace=${config.value.namespace} cell=${config.value.cellId} ` +
      `token=${describeTokenForLog(config.value.authToken)}`,
  );

  const idMap = await IdMap.load(DEFAULT_ID_MAP_PATHS);
  if (!idMap.ok) return idMap;

  const transport = createTransport(config.value);
  const writer = new GraphWriter(new TransportSink(transport), idMap.value, {
    idMapPaths: DEFAULT_ID_MAP_PATHS,
  });

  const written = await stageAndFlush(writer, slice);
  const destination = transport.describe();

  // Only attempted when the write succeeded: a coverage record read after a failed flush would
  // describe a half-written graph, and the run is about to be reported as not seeded anyway.
  const coverage: CoverageRecord = written.ok
    ? await recordLiveGraphCoverage(new HydraGateway(transport), written.value.manifest)
    : { location: "not written, the graph write failed", failure: null };

  const closed = await closeTransport(transport);
  if (!closed.ok) console.warn(`[seedLiveGraph] ${closed.failure.message}`);

  if (!written.ok) return written;

  return succeed({
    destination,
    manifest: written.value.manifest,
    nodesWritten: written.value.nodesWritten,
    edgesWritten: written.value.edgesWritten,
    notes: written.value.notes,
    snapshotPath: null,
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
      `${built.value.stubVersionKeys.length} version(s) were written as stubs: ${built.value.stubVersionKeys
        .slice(0, 5)
        .join(", ")}`,
    );
  }
  if (built.value.skipped.unselectableKeys > 0) {
    notes.push(
      `${built.value.skipped.unselectableKeys} key(s) were refused as selector values and are absent from the graph`,
    );
  }
  if (built.value.skipped.advisoryVersionsWithoutNode > 0) {
    notes.push(
      `${built.value.skipped.advisoryVersionsWithoutNode} advisory version edge(s) had no node to attach to`,
    );
  }

  return succeed({
    manifest: built.value.manifest,
    nodesWritten: flushed.value.nodesWritten,
    edgesWritten: flushed.value.edgesWritten,
    notes,
  });
}

async function closeTransport(transport: GraphTransport): Promise<Result<void, Failure>> {
  return fromThrowing("internal", "[closeTransport] transport did not close cleanly", async () => {
    await transport.close();
  });
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** One line per pack, so a failed pack is named next to the ones that loaded. */
function printLoadResults(outcomes: readonly PackOutcome[]): void {
  console.log(`[printLoadResults] validating ${outcomes.length} pack(s)`);

  for (const outcome of outcomes) {
    if (!outcome.isLoaded) {
      console.error(
        `[printLoadResults]   FAILED  ${outcome.slug}  reason=${outcome.failure.reason}  ${outcome.failure.message}`,
      );
      continue;
    }

    const pack = outcome.pack;
    const window = computeExposureWindow(pack);
    const exposure =
      window === null
        ? "no exposure window, the advisory predates the artifact"
        : `${formatDays(window.durationMs)} day exposure window`;

    console.log(
      `[printLoadResults]   loaded  ${pack.slug}  ${pack.dataOrigin}  ` +
        `${pack.compromisedVersions.length} version(s), ${pack.advisories.length} advisory(ies), ` +
        `${pack.services.length} service(s), ${exposure}`,
    );
  }
}

function printSeedSummary(summary: SeedSummary): void {
  const loadedCount = summary.outcomes.filter(isLoadedOutcome).length;
  const counts = summary.manifest.counts;

  const rows: readonly [string, string][] = [
    ["sink", summary.sink === "live" ? "live HydraDB" : "in-process MemoryGraph"],
    ["destination", summary.destination],
    ["packs seeded", `${loadedCount} of ${summary.outcomes.length}`],
    ["nodes written", String(summary.nodesWritten)],
    ["edges written", String(summary.edgesWritten)],
    ["packages", String(counts.packages)],
    ["versions", String(counts.versions)],
    ["services", String(counts.services)],
    ["advisories", String(counts.advisories)],
    ["resolution edges", String(counts.resolutionEdges)],
    ["closed packages", String(summary.manifest.closedPackageKeys.length)],
    ["partial packages", String(summary.manifest.partialPackageKeys.length)],
    ["closed services", String(summary.manifest.closedServiceKeys.length)],
    ["coverage record", summary.coverageLocation],
    ["snapshot", summary.snapshotPath ?? "not written, the live graph holds the data"],
  ];

  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  console.log("[printSeedSummary] incident seed summary");
  for (const [label, value] of rows) {
    console.log(`[printSeedSummary]   ${label.padEnd(labelWidth)}  ${value}`);
  }

  console.log(
    "[printSeedSummary] every package is partial by design: packs carry lockfile ground truth and no " +
      "dependency closure, so a dependency traversal over this graph abstains instead of answering not_exposed",
  );

  if (summary.notes.length > 0) {
    console.log(`[printSeedSummary] ${summary.notes.length} disclosure(s) about this seed`);
    for (const note of summary.notes) console.log(`[printSeedSummary]   ${note}`);
  }
}

function formatDays(durationMs: number): string {
  return (durationMs / MS_PER_DAY).toFixed(1);
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
      return `fix the field path or argument named above. ${USAGE_LINE}`;
    case "not_found":
      return "check the pack directory and the slug spelling, packs live in data/incidents";
    case "graph_unavailable":
      return "start HydraDB with `docker compose up -d graph-node`, or drop --live to write a snapshot";
    case "query_budget_exceeded":
      return "the engine refused a batch on a budget, seed fewer packs per run with --incident";
    default:
      return null;
  }
}

const exitCode = await runSeed(process.argv.slice(2));
process.exit(exitCode);
