/**
 * Harvests the lockfile history of public git repositories into the bitemporal
 * `Service -[:RESOLVED {resolved_at_ms}]-> Version` edges the "resolved while live"
 * question runs on.
 *
 * Usage:
 *   bun run harvest:lockfiles                                  the default repository set
 *   bun run harvest:lockfiles -- --repo remy/nodemon           one repository (repeatable)
 *   bun run harvest:lockfiles -- --max-revisions 20            fewer commits per lockfile
 *   bun run harvest:lockfiles -- --since 2018-10-01            only commits after a date
 *   bun run harvest:lockfiles -- --lockfile yarn.lock          harvest one named lockfile
 *   bun run harvest:lockfiles -- --refresh                     re-read every revision
 *   bun run harvest:lockfiles -- --help                        flags and defaults
 *
 * WHAT THIS SCRIPT TALKS TO. One external program, `git`, and nothing else. No registry,
 * no HTTP client, no graph connection. It clones a public repository once into
 * data/harvest/repositories, then reads one lockfile path at each commit that touched it.
 * The commit time of that commit is the valid-time clock on the RESOLVED edge: the moment
 * the repository actually had those exact versions pinned.
 *
 * WALK RULE. Per repository, one lockfile path, newest commit first.
 *   1. discover which of the known lockfile names ever existed in the history
 *   2. list the commits that touched the chosen one (`git log -- <path>`)
 *   3. read the blob at each of those commits, size-capped, and parse it
 *   4. fold every parsed revision into one resolution set per service, keeping the
 *      earliest commit time per exact version, because "resolved while live" asks when a
 *      service first pinned the bad artifact, not when it last did
 *
 * COVERAGE IS THE POINT, NOT A FOOTNOTE. A lockfile history that is only partly walkable
 * must never look like a short history. Every bound (the revision cap, a --since window, an
 * oversized blob, an unreadable blob, an unparsable revision, a second lockfile path left
 * unharvested) is counted per service, listed as a reason, and turned into the
 * `service_history_partial` AnswerLimit the analysis layer raises verbatim.
 * sourceRef: src/lib/analysis/abstention.ts AnswerLimit, isTruncatingLimit.
 *
 * RESUMABLE. The output file is the state file. A rerun reads it, keeps every revision it
 * already recorded, and reads only the commits that are new, so an interrupted harvest
 * costs nothing to finish. A checkpoint is written after each repository, so a run killed
 * halfway still leaves valid history on disk. --refresh re-reads every revision instead.
 *
 * UNTRUSTED INPUT. A lockfile in someone else's repository is a file a stranger wrote
 * (plan.md section 11), so: the blob size is checked with `git cat-file -s` before a byte
 * is read, parsing goes through the existing hardened parser in src/lib/scanner/lockfile.ts,
 * nothing from a lockfile is ever executed, resolved, or fetched, and no file content
 * reaches a log line or a failure message. Clones are `--no-checkout`, so no content filter
 * from the cloned repository ever runs, and git never prompts for credentials.
 *
 * Errors are values everywhere below. Only `runHarvest` decides an exit code, and only the
 * last two lines of this file exit the process.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import type { AnswerLimit } from "@/lib/analysis/abstention";
import {
  ECOSYSTEMS,
  type Ecosystem,
  SERVICE_SOURCES,
  type ServiceSource,
  versionKey,
} from "@/lib/graph/model";
import { createConcurrencyLimiter, describeSchemaIssues } from "@/lib/ingest/fetch-json";
import type { ServiceResolution } from "@/lib/ingest/graph-builder";
import {
  MAX_LOCKFILE_CHARACTERS,
  MAX_LOCKFILE_DEPENDENCIES,
  parseLockfile,
} from "@/lib/scanner/lockfile";
import { type Failure, type Result, fail, fromThrowing, fromThrowingSync, succeed } from "@/lib/result";

/** History was harvested and the output file was written. */
const EXIT_HARVESTED = 0;

/** No history at all was harvested, or the output file could not be written. */
const EXIT_NOT_HARVESTED = 1;

/**
 * History was harvested and written, and at least one requested repository yielded nothing.
 * Non-zero so a gap is visible to a caller that only reads the exit code.
 */
const EXIT_HARVESTED_WITH_GAPS = 2;

/**
 * Repositories harvested when no --repo is given. These three are the public repositories
 * of the event-stream victims plan.md section 5 names (nodemon, karma, @vue/cli-service),
 * which is what makes the harvested edges land inside a real incident window instead of
 * next to it. A repository that never committed a lockfile this project can read is
 * recorded as a gap in the output, not treated as an error.
 */
const DEFAULT_REPOSITORY_SPECS: readonly string[] = [
  "remy/nodemon",
  "karma-runner/karma",
  "vuejs/vue-cli",
];

/**
 * Lockfile names looked for in a repository's history, in the order they are preferred.
 * The same six names the parser recognises from a filename.
 * sourceRef: src/lib/scanner/lockfile.ts FILENAME_HINTS.
 */
const LOCKFILE_CANDIDATE_PATHS: readonly string[] = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "requirements.txt",
  "poetry.lock",
];

/** Commits read per lockfile path, newest first. Each one costs two git calls. */
const DEFAULT_MAX_REVISIONS = 40;

/**
 * Largest lockfile blob read from history, in bytes. A UTF-8 byte count is never smaller
 * than the UTF-16 code unit count of the same text, so a blob that passes this cap always
 * passes the parser's own character cap, which means the parser's limit can never be the
 * one that trips first.
 * sourceRef: src/lib/scanner/lockfile.ts MAX_LOCKFILE_CHARACTERS.
 */
const DEFAULT_MAX_LOCKFILE_BYTES = MAX_LOCKFILE_CHARACTERS;

/**
 * Distinct resolutions kept per service, across the whole harvested history. Same number
 * as the parser's per-file dependency cap, because a service is one lockfile over time and
 * the two limits bound the same kind of work.
 * sourceRef: src/lib/scanner/lockfile.ts MAX_LOCKFILE_DEPENDENCIES.
 */
const MAX_RESOLUTIONS_PER_SERVICE = MAX_LOCKFILE_DEPENDENCIES;

/** Wall clock a single non-clone git call may take, in milliseconds. */
const DEFAULT_GIT_TIMEOUT_MS = 30_000;

/** Wall clock a clone or a fetch may take, in milliseconds (10 minutes). */
const DEFAULT_CLONE_TIMEOUT_MS = 600_000;

/** git processes allowed to run at once. Small because a clone is network bound and heavy. */
const DEFAULT_CONCURRENCY = 2;

/** Where clones live, one directory per repository. Reused across runs. */
const DEFAULT_CLONE_DIRECTORY = "data/harvest/repositories";

/** Where the harvested history is written. This file is also the resume state. */
const DEFAULT_OUTPUT_PATH = "data/harvest/lockfile-history.json";

/** Format version of the output file, bumped when its shape changes incompatibly. */
const HARVEST_FORMAT_VERSION = 1;

/** Value of `harvester` in the output. Log safe, never a path or a secret. */
const HARVESTER_NAME = "harvest-lockfile-history";

/** Every harvested service is curated by an operator, never uploaded by a visitor. */
const HARVESTED_SERVICE_SOURCE: ServiceSource = "seed";

/**
 * Value written for a timestamp no commit stated. The graph model reserves -1 for "the
 * source had none" and the analysis layer refuses to place a window on it.
 * sourceRef: src/lib/graph/model.ts VersionNode.published_at_ms.
 */
const UNKNOWN_TIMESTAMP_MS = -1;

/** Output cap for `git log`, in bytes. One revision line costs about 60 bytes. */
const LOG_OUTPUT_CAP_BYTES = 1_048_576;

/** Output cap for a short answer such as a sha or a blob size, in bytes. */
const SHORT_OUTPUT_CAP_BYTES = 4_096;

/**
 * Headroom over the blob cap for `git show`, in bytes. The size check already rejected an
 * oversized blob, so this only guards against a blob that grew between the two calls.
 */
const SUBPROCESS_OUTPUT_SLACK_BYTES = 65_536;

/** Revisions between progress lines, so a long walk reports without flooding the terminal. */
const PROGRESS_EVERY_REVISIONS = 10;

/** Longest note list printed before the tail is summarized, to keep the run readable. */
const MAX_PRINTED_NOTES = 25;

/** Characters of a commit sha printed in a log line. Full shas stay in the output file. */
const SHORT_SHA_LENGTH = 12;

/** Field separator inside a `git log` line. A tab cannot appear in a sha or in a timestamp. */
const LOG_FIELD_SEPARATOR = "\t";

/**
 * How that separator is spelled inside the `--format` argument. Git expands %x09 to a tab
 * itself, which keeps the argument this process passes free of control characters.
 * sourceRef: https://git-scm.com/docs/pretty-formats (%xNN, a byte from its hex code)
 */
const LOG_FIELD_SEPARATOR_PLACEHOLDER = "%x09";

/** A full or abbreviated commit sha, and nothing else. Checked before it enters an argument. */
const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,64}$/;

/** owner/name, the short form of a GitHub repository. */
const REPOSITORY_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** An https clone URL with no credentials, no port trickery and no remote helper prefix. */
const HTTPS_CLONE_URL_PATTERN =
  /^https:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(?::\d{1,5})?\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/;

/** A repository-relative lockfile path: no absolute path, no traversal, no leading dash. */
const LOCKFILE_PATH_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._][A-Za-z0-9._-]*)*$/;

/**
 * Service natural key, prefixed so it cannot collide with a package key.
 * sourceRef: src/lib/incidents/pack.ts SERVICE_KEY_PATTERN.
 */
const SERVICE_KEY_PATTERN = /^svc:[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Control characters, the one class of byte that changes how git reads an argument. */
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;

/** Runs of characters a service key may not contain, collapsed to a single hyphen. */
const NON_KEY_CHARACTER_RUN = /[^a-z0-9]+/g;

/**
 * Environment overrides for every git call. GIT_TERMINAL_PROMPT=0 makes a private or
 * misspelled repository fail immediately instead of blocking on a credential prompt, and
 * GIT_CONFIG_NOSYSTEM keeps a machine-wide config from redirecting the clone URL.
 * sourceRef: https://git-scm.com/docs/git#Documentation/git.txt-codeGITTERMINALPROMPTcode
 */
const GIT_ENVIRONMENT: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
};

const USAGE_LINE =
  "usage: bun run harvest:lockfiles [-- --repo <owner/name>] [-- --lockfile <path>] " +
  "[-- --max-revisions <n>] [-- --since <date>] [-- --max-bytes <n>] [-- --concurrency <n>] " +
  "[-- --git-timeout-ms <n>] [-- --clone-timeout-ms <n>] [-- --clone-dir <path>] " +
  "[-- --out <path>] [-- --blobless] [-- --refresh] [-- --help]";

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

/**
 * One commit that touched the lockfile, and what reading it produced.
 *
 * `lockfileFormat` is typed as a string rather than as the parser's union on purpose: a
 * resumed record carries whatever string the previous run wrote, and this field is
 * descriptive output that no decision here reads.
 */
type HarvestedRevision = {
  commitSha: string;
  /** Commit time as epoch milliseconds. The valid-time clock of this revision. */
  committedAtMs: number;
  lockfileFormat: string;
  /** Dependencies this revision pinned to an exact version. */
  resolutionCount: number;
  /** Entries that stated a range rather than a pin, so they carry no RESOLVED edge. */
  unpinnedCount: number;
  /** Entries the parser could not read. Counted, never quoted. */
  unparsableEntryCount: number;
  /** Entries dropped because the parser's per-file dependency cap was reached. */
  truncatedEntryCount: number;
};

/**
 * One RESOLVED edge, plus the two facts the edge property cannot carry: how long the
 * service kept that version pinned, and how many revisions showed it. `resolvedAtMs` is
 * the earliest commit time the version appeared at, which is the valid-time instant the
 * bitemporal query compares against the advisory window.
 *
 * Typed as the graph builder's own resolution shape so this file cannot drift from the
 * writer that consumes it.
 * sourceRef: src/lib/ingest/graph-builder.ts ServiceResolution.
 */
type HarvestedResolution = ServiceResolution & {
  /** Latest commit time this exact version was still pinned at, epoch milliseconds. */
  lastResolvedAtMs: number;
  revisionCount: number;
};

/** How much of one service's lockfile history is actually in this file. */
type ServiceCoverage = {
  /** True only when nothing bounded, skipped, or truncated the walk. */
  isComplete: boolean;
  harvestedRevisions: number;
  /** Revisions git named inside the requested window, before any read failed. */
  revisionsNamedByGit: number;
  revisionsUnreadable: number;
  revisionsOversized: number;
  revisionsUnparsable: number;
  /** Resolutions dropped because the per-service cap was reached. */
  resolutionsDropped: number;
  oldestCommitAtMs: number;
  newestCommitAtMs: number;
  /** Lockfile paths this repository also has in history and this run did not read. */
  unharvestedLockfilePaths: string[];
  /** One sentence per bound, written for a person reading the file. */
  reasons: string[];
  /**
   * The exact limit a caller raises for this service, or null when the history is whole.
   * sourceRef: src/lib/analysis/abstention.ts AnswerLimit service_history_partial.
   */
  answerLimit: Extract<AnswerLimit, { kind: "service_history_partial" }> | null;
};

type HarvestedService = {
  /** Natural key, "svc:" prefixed, stable across runs so a resume finds it. */
  key: string;
  name: string;
  source: ServiceSource;
  repositoryUrl: string;
  lockfilePath: string;
  ecosystem: Ecosystem;
  /** Commit the clone's default branch pointed at when this run read it. */
  headCommitSha: string;
  revisions: HarvestedRevision[];
  resolutions: HarvestedResolution[];
  coverage: ServiceCoverage;
};

/** A requested repository that produced no history at all. */
type HarvestGap = {
  serviceKey: string;
  repositoryUrl: string;
  /** Machine-readable failure reason, from the Result that stopped the walk. */
  reason: string;
  /** One log-safe sentence. Never carries file content or git stderr. */
  message: string;
};

/** The bounds this run applied, so a reader knows what shaped the coverage above. */
type HarvestSettings = {
  maxRevisions: number;
  sinceMs: number | null;
  maxLockfileBytes: number;
  isBlobless: boolean;
  isRefresh: boolean;
  /** `git --version` output, for reproducibility. Log safe. */
  gitDescription: string;
};

type HarvestFile = {
  formatVersion: number;
  generatedAtMs: number;
  harvester: string;
  settings: HarvestSettings;
  services: HarvestedService[];
  gaps: HarvestGap[];
  notes: string[];
};

// ---------------------------------------------------------------------------
// Output schema, used to read a previous run back for the resume path
// ---------------------------------------------------------------------------

const HARVESTED_REVISION_SCHEMA = z.object({
  commitSha: z.string().regex(COMMIT_SHA_PATTERN, "must be a commit sha"),
  committedAtMs: z.int().positive(),
  lockfileFormat: z.string().min(1),
  resolutionCount: z.int().nonnegative(),
  unpinnedCount: z.int().nonnegative(),
  unparsableEntryCount: z.int().nonnegative(),
  truncatedEntryCount: z.int().nonnegative(),
});

const HARVESTED_RESOLUTION_SCHEMA = z.object({
  ecosystem: z.enum(ECOSYSTEMS),
  name: z.string().min(1),
  version: z.string().min(1),
  resolvedAtMs: z.int().positive(),
  lastResolvedAtMs: z.int().positive(),
  revisionCount: z.int().positive(),
});

const SERVICE_COVERAGE_SCHEMA = z.object({
  isComplete: z.boolean(),
  harvestedRevisions: z.int().nonnegative(),
  revisionsNamedByGit: z.int().nonnegative(),
  revisionsUnreadable: z.int().nonnegative(),
  revisionsOversized: z.int().nonnegative(),
  revisionsUnparsable: z.int().nonnegative(),
  resolutionsDropped: z.int().nonnegative(),
  oldestCommitAtMs: z.int(),
  newestCommitAtMs: z.int(),
  unharvestedLockfilePaths: z.array(z.string().min(1)),
  reasons: z.array(z.string().min(1)),
  answerLimit: z
    .object({
      kind: z.literal("service_history_partial"),
      serviceKey: z.string().min(1),
      harvestedRevisions: z.int().nonnegative(),
    })
    .nullable(),
});

const HARVESTED_SERVICE_SCHEMA = z.object({
  key: z.string().regex(SERVICE_KEY_PATTERN, 'must look like "svc:remy-nodemon"'),
  name: z.string().min(1),
  source: z.enum(SERVICE_SOURCES),
  repositoryUrl: z.string().min(1),
  lockfilePath: z.string().min(1),
  ecosystem: z.enum(ECOSYSTEMS),
  headCommitSha: z.string().min(1),
  revisions: z.array(HARVESTED_REVISION_SCHEMA),
  resolutions: z.array(HARVESTED_RESOLUTION_SCHEMA),
  coverage: SERVICE_COVERAGE_SCHEMA,
});

const HARVEST_FILE_SCHEMA = z.object({
  formatVersion: z.int().positive(),
  generatedAtMs: z.int().positive(),
  harvester: z.string().min(1),
  settings: z.object({
    maxRevisions: z.int().positive(),
    sinceMs: z.int().positive().nullable(),
    maxLockfileBytes: z.int().positive(),
    isBlobless: z.boolean(),
    isRefresh: z.boolean(),
    gitDescription: z.string().min(1),
  }),
  services: z.array(HARVESTED_SERVICE_SCHEMA),
  gaps: z.array(
    z.object({
      serviceKey: z.string().min(1),
      repositoryUrl: z.string().min(1),
      reason: z.string().min(1),
      message: z.string().min(1),
    }),
  ),
  notes: z.array(z.string().min(1)),
});

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

type HarvestArguments = {
  /** null means the default repository set. */
  repositorySpecs: readonly string[] | null;
  /** null means "discover which lockfile the repository has in its history". */
  lockfilePath: string | null;
  maxRevisions: number;
  /** Lower bound on commit time, epoch milliseconds, or null for the whole history. */
  sinceMs: number | null;
  maxLockfileBytes: number;
  gitTimeoutMs: number;
  cloneTimeoutMs: number;
  concurrency: number;
  cloneDirectory: string;
  outputPath: string;
  isBlobless: boolean;
  isRefresh: boolean;
};

async function runHarvest(argumentValues: readonly string[]): Promise<number> {
  const startedAtMs = performance.now();

  if (argumentValues.includes("--help")) {
    printHelp();
    return EXIT_HARVESTED;
  }

  const parsed = parseArguments(argumentValues);
  if (!parsed.ok) {
    reportFailure("arguments", parsed.failure);
    return EXIT_NOT_HARVESTED;
  }
  printBudgets(parsed.value);

  const targets = resolveRepositoryTargets(parsed.value);
  if (!targets.ok) {
    reportFailure("repository selection", targets.failure);
    return EXIT_NOT_HARVESTED;
  }
  console.log(`[runHarvest] ${targets.value.length} repository(ies) selected`);

  const gitRunner = createGitRunner(parsed.value.concurrency);

  const gitDescription = await readGitDescription(gitRunner, parsed.value);
  if (!gitDescription.ok) {
    reportFailure("git probe", gitDescription.failure);
    return EXIT_NOT_HARVESTED;
  }
  console.log(`[runHarvest] ${gitDescription.value}`);

  const prior = await readPreviousHarvest(parsed.value.outputPath);
  const priorServicesByKey = new Map(
    prior.file === null ? [] : prior.file.services.map((service) => [service.key, service] as const),
  );
  if (prior.file !== null) {
    console.log(
      `[runHarvest] resuming over ${priorServicesByKey.size} service(s) already in ` +
        parsed.value.outputPath,
    );
  }

  const servicesByKey = new Map<string, HarvestedService>();
  const gaps: HarvestGap[] = [];
  const notes: string[] = [...prior.notes];
  const checkpoint = createCheckpointWriter(parsed.value.outputPath);

  const buildFile = (): HarvestFile => ({
    formatVersion: HARVEST_FORMAT_VERSION,
    generatedAtMs: Date.now(),
    harvester: HARVESTER_NAME,
    settings: {
      maxRevisions: parsed.value.maxRevisions,
      sinceMs: parsed.value.sinceMs,
      maxLockfileBytes: parsed.value.maxLockfileBytes,
      isBlobless: parsed.value.isBlobless,
      isRefresh: parsed.value.isRefresh,
      gitDescription: gitDescription.value,
    },
    services: [...servicesByKey.values()],
    gaps,
    notes,
  });

  let lastCheckpoint: Result<string, Failure> = succeed(parsed.value.outputPath);

  await Promise.all(
    targets.value.map(async (target) => {
      const outcome = await harvestRepository(
        target,
        parsed.value,
        gitRunner,
        parsed.value.isRefresh ? null : (priorServicesByKey.get(target.serviceKey) ?? null),
      );

      for (const note of outcome.notes) notes.push(note);
      if (outcome.kind === "harvested") servicesByKey.set(outcome.service.key, outcome.service);
      else gaps.push(outcome.gap);

      // Checkpoint after every repository: a run killed during the next clone still leaves
      // every revision it already read on disk, which is what makes the harvest resumable.
      lastCheckpoint = await checkpoint.write(buildFile());
      if (!lastCheckpoint.ok) {
        console.error(`[runHarvest] checkpoint failed: ${lastCheckpoint.failure.message}`);
      }
    }),
  );

  // A service the previous run harvested and this run did not reach stays in the file: it
  // was really observed, and dropping it would delete history nobody asked to delete.
  for (const [serviceKey, priorService] of priorServicesByKey) {
    if (servicesByKey.has(serviceKey)) continue;
    servicesByKey.set(serviceKey, priorService);
    notes.push(
      `${serviceKey} was not harvested by this run and is carried over from the previous ` +
        "harvest file unchanged",
    );
  }

  if (servicesByKey.size === 0) {
    console.error(
      "[runHarvest] no repository yielded a readable lockfile history, so " +
        `${parsed.value.outputPath} records the gaps below and no service history. Check the ` +
        "repository spelling and the network, then rerun.",
    );
    for (const gap of gaps) console.error(`[runHarvest]   ${gap.serviceKey}: ${gap.message}`);
    return EXIT_NOT_HARVESTED;
  }

  const written = await checkpoint.write(buildFile());
  if (!written.ok) {
    reportFailure("output write", written.failure);
    return EXIT_NOT_HARVESTED;
  }

  printHarvestReport({
    argumentValues: parsed.value,
    services: [...servicesByKey.values()],
    gaps,
    gitCounts: gitRunner.readCounts(),
    outputPath: written.value,
    elapsedMs: elapsedMsSince(startedAtMs),
    notes,
  });

  return gaps.length > 0 ? EXIT_HARVESTED_WITH_GAPS : EXIT_HARVESTED;
}

function parseArguments(argumentValues: readonly string[]): Result<HarvestArguments, Failure> {
  const repositorySpecs: string[] = [];
  let lockfilePath: string | null = null;
  let maxRevisions = DEFAULT_MAX_REVISIONS;
  let sinceMs: number | null = null;
  let maxLockfileBytes = DEFAULT_MAX_LOCKFILE_BYTES;
  let gitTimeoutMs = DEFAULT_GIT_TIMEOUT_MS;
  let cloneTimeoutMs = DEFAULT_CLONE_TIMEOUT_MS;
  let concurrency = DEFAULT_CONCURRENCY;
  let cloneDirectory = DEFAULT_CLONE_DIRECTORY;
  let outputPath = DEFAULT_OUTPUT_PATH;
  let isBlobless = false;
  let isRefresh = false;

  const numericFlags = new Map<string, (value: number) => void>([
    ["--max-revisions", (value) => (maxRevisions = value)],
    ["--max-bytes", (value) => (maxLockfileBytes = value)],
    ["--git-timeout-ms", (value) => (gitTimeoutMs = value)],
    ["--clone-timeout-ms", (value) => (cloneTimeoutMs = value)],
    ["--concurrency", (value) => (concurrency = value)],
  ]);

  const textFlags = new Map<string, (value: string) => void>([
    ["--repo", (value) => repositorySpecs.push(value)],
    ["--clone-dir", (value) => (cloneDirectory = value)],
    ["--out", (value) => (outputPath = value)],
  ]);

  for (let index = 0; index < argumentValues.length; index += 1) {
    const argument = argumentValues[index];

    if (argument === "--refresh") {
      isRefresh = true;
      continue;
    }

    if (argument === "--blobless") {
      isBlobless = true;
      continue;
    }

    const numericApply = numericFlags.get(argument);
    const textApply = textFlags.get(argument);
    const isLockfileFlag = argument === "--lockfile";
    const isSinceFlag = argument === "--since";

    if (numericApply === undefined && textApply === undefined && !isLockfileFlag && !isSinceFlag) {
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
      numericApply(parsedNumber);
      continue;
    }

    if (isLockfileFlag) {
      const validated = validateLockfilePath(value);
      if (!validated.ok) return validated;
      lockfilePath = validated.value;
      continue;
    }

    if (isSinceFlag) {
      const parsedSince = parseSinceValue(value);
      if (!parsedSince.ok) return parsedSince;
      sinceMs = parsedSince.value;
      continue;
    }

    if (textApply !== undefined) textApply(value);
  }

  if (maxLockfileBytes > DEFAULT_MAX_LOCKFILE_BYTES) {
    return fail(
      "invalid_input",
      `[parseArguments] --max-bytes cannot exceed ${DEFAULT_MAX_LOCKFILE_BYTES}, the cap the ` +
        "lockfile parser itself enforces",
    );
  }

  return succeed({
    repositorySpecs: repositorySpecs.length > 0 ? repositorySpecs : null,
    lockfilePath,
    maxRevisions,
    sinceMs,
    maxLockfileBytes,
    gitTimeoutMs,
    cloneTimeoutMs,
    concurrency,
    cloneDirectory,
    outputPath,
    isBlobless,
    isRefresh,
  });
}

/** Accepts a date or a full timestamp, and normalizes it before it reaches a git argument. */
function parseSinceValue(value: string): Result<number, Failure> {
  const parsedMs = Date.parse(value.trim());
  if (!Number.isFinite(parsedMs)) {
    return fail(
      "invalid_input",
      `[parseSinceValue] --since needs a date such as 2018-10-01, got "${value}"`,
    );
  }
  if (parsedMs <= 0) {
    return fail("invalid_input", "[parseSinceValue] --since must be after the epoch");
  }
  return succeed(parsedMs);
}

/**
 * A lockfile path is read straight into a git argument, so it is validated rather than
 * trusted: repository relative, no traversal, no leading dash, no control character.
 */
function validateLockfilePath(value: string): Result<string, Failure> {
  const path = value.trim();
  if (!LOCKFILE_PATH_PATTERN.test(path) || path.includes("..")) {
    return fail(
      "invalid_input",
      "[validateLockfilePath] --lockfile must be a repository relative path such as " +
        "package-lock.json or packages/app/yarn.lock",
    );
  }
  return succeed(path);
}

function printHelp(): void {
  const rows: readonly [string, string][] = [
    ["--repo <owner/name>", "repository to harvest, repeatable, also accepts an https clone URL"],
    ["--lockfile <path>", "harvest this path instead of discovering one"],
    ["--max-revisions <n>", `commits read per lockfile, newest first (default ${DEFAULT_MAX_REVISIONS})`],
    ["--since <date>", "ignore commits older than this date (default: whole history)"],
    ["--max-bytes <n>", `largest lockfile blob read (default ${DEFAULT_MAX_LOCKFILE_BYTES})`],
    ["--concurrency <n>", `git processes at once (default ${DEFAULT_CONCURRENCY})`],
    ["--git-timeout-ms <n>", `timeout per git call (default ${DEFAULT_GIT_TIMEOUT_MS})`],
    ["--clone-timeout-ms <n>", `timeout per clone or fetch (default ${DEFAULT_CLONE_TIMEOUT_MS})`],
    ["--clone-dir <path>", `where clones live (default ${DEFAULT_CLONE_DIRECTORY})`],
    ["--out <path>", `output and resume file (default ${DEFAULT_OUTPUT_PATH})`],
    ["--blobless", "clone with --filter=blob:none and fetch each lockfile blob on demand"],
    ["--refresh", "re-read every revision instead of resuming from the output file"],
    ["--help", "print this list and exit"],
  ];

  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  console.log(`[printHelp] ${USAGE_LINE}`);
  console.log("[printHelp] walks the lockfile history of public repositories into RESOLVED edges");
  for (const [label, description] of rows) {
    console.log(`[printHelp]   ${label.padEnd(labelWidth)}  ${description}`);
  }
  console.log(
    `[printHelp] exit codes: ${EXIT_HARVESTED} harvested, ${EXIT_NOT_HARVESTED} nothing ` +
      `harvested, ${EXIT_HARVESTED_WITH_GAPS} harvested with at least one empty repository`,
  );
}

// ---------------------------------------------------------------------------
// Repository selection
// ---------------------------------------------------------------------------

type RepositoryTarget = {
  /** owner/name, used as the service name and the clone directory name. */
  slug: string;
  cloneUrl: string;
  serviceKey: string;
};

function resolveRepositoryTargets(
  argumentValues: HarvestArguments,
): Result<RepositoryTarget[], Failure> {
  const specs = argumentValues.repositorySpecs ?? DEFAULT_REPOSITORY_SPECS;
  const byKey = new Map<string, RepositoryTarget>();

  for (const spec of specs) {
    const parsed = parseRepositorySpec(spec);
    if (!parsed.ok) return parsed;
    if (!byKey.has(parsed.value.serviceKey)) byKey.set(parsed.value.serviceKey, parsed.value);
  }

  if (byKey.size === 0) {
    return fail("invalid_input", `[resolveRepositoryTargets] no repository selected. ${USAGE_LINE}`);
  }
  return succeed([...byKey.values()]);
}

/**
 * Turns "owner/name" or an https clone URL into a target.
 *
 * The spec reaches `git clone` as an argument, so anything that could make git do
 * something other than an https fetch is refused outright: a remote helper prefix
 * (`ext::`, which runs a command), credentials in the URL, a path traversal, a leading
 * dash that git would read as an option, or any control character.
 * sourceRef: https://git-scm.com/docs/git-remote-ext (the ext:: transport runs a command)
 */
function parseRepositorySpec(spec: string): Result<RepositoryTarget, Failure> {
  const trimmed = spec.trim();
  if (trimmed.length === 0) {
    return fail("invalid_input", "[parseRepositorySpec] a --repo value is empty");
  }
  if (
    trimmed.startsWith("-") ||
    trimmed.includes("..") ||
    trimmed.includes("::") ||
    trimmed.includes("@") ||
    CONTROL_CHARACTER_PATTERN.test(trimmed)
  ) {
    return fail(
      "invalid_input",
      "[parseRepositorySpec] a repository must be owner/name or a plain https clone URL with " +
        "no credentials",
    );
  }

  if (REPOSITORY_SLUG_PATTERN.test(trimmed)) {
    const serviceKey = buildServiceKey(trimmed);
    if (!serviceKey.ok) return serviceKey;
    return succeed({
      slug: trimmed,
      cloneUrl: `https://github.com/${trimmed}.git`,
      serviceKey: serviceKey.value,
    });
  }

  if (!HTTPS_CLONE_URL_PATTERN.test(trimmed)) {
    return fail(
      "invalid_input",
      `[parseRepositorySpec] "${trimmed}" is neither owner/name nor an https clone URL`,
    );
  }

  const segments = trimmed.replace(/\.git$/, "").split("/");
  const slug = segments.slice(-2).join("/");
  if (!REPOSITORY_SLUG_PATTERN.test(slug)) {
    return fail("invalid_input", `[parseRepositorySpec] "${trimmed}" names no owner and repository`);
  }

  const serviceKey = buildServiceKey(slug);
  if (!serviceKey.ok) return serviceKey;
  return succeed({ slug, cloneUrl: trimmed, serviceKey: serviceKey.value });
}

/** "remy/nodemon" becomes "svc:remy-nodemon", the key shape the incident packs use. */
function buildServiceKey(slug: string): Result<string, Failure> {
  const body = slug.toLowerCase().replace(NON_KEY_CHARACTER_RUN, "-").replace(/^-+|-+$/g, "");
  const key = `svc:${body}`;
  if (!SERVICE_KEY_PATTERN.test(key)) {
    return fail("invalid_input", `[buildServiceKey] "${slug}" produces no usable service key`);
  }
  return succeed(key);
}

/** Filesystem-safe directory name for a clone. One directory per repository, reused. */
function buildCloneDirectoryName(serviceKey: string): string {
  return serviceKey.slice("svc:".length);
}

// ---------------------------------------------------------------------------
// git plumbing
// ---------------------------------------------------------------------------

type GitCallOptions = {
  /** Repository directory the command runs in, or null for the process directory. */
  cwd: string | null;
  timeoutMs: number;
  maxOutputBytes: number;
};

type GitCounts = { calls: number; failures: number };

/**
 * One place that owns every git call: the process bound, the timeouts, the output caps and
 * the counters. Nothing else in this file starts a process.
 */
type GitRunner = {
  run: (args: readonly string[], options: GitCallOptions) => Promise<Result<string, Failure>>;
  readCounts: () => GitCounts;
};

function createGitRunner(concurrency: number): GitRunner {
  const limiter = createConcurrencyLimiter(concurrency);
  const counts: GitCounts = { calls: 0, failures: 0 };

  return {
    run: async (args, options) =>
      await limiter.run(async () => {
        counts.calls += 1;
        const outcome = await runGitCommand(args, options);
        if (!outcome.ok) counts.failures += 1;
        return outcome;
      }),
    readCounts: () => ({ ...counts }),
  };
}

/** What one git process produced. Never a thrown value: the callback form cannot throw. */
type GitAttempt =
  | { didRun: true; stdout: string }
  | { didRun: false; failure: Failure };

/**
 * Runs git with an argument array, never a shell string, so no argument can be reinterpreted
 * as a command. Failures are classified from the typed exec error rather than from stderr
 * text: git writes URLs and paths to stderr, and a message this function returns can end up
 * in a log, so nothing from the child's own output is forwarded.
 */
async function runGitCommand(
  args: readonly string[],
  options: GitCallOptions,
): Promise<Result<string, Failure>> {
  const unsafeArgument = args.find(
    (argument) => argument.length === 0 || CONTROL_CHARACTER_PATTERN.test(argument),
  );
  if (unsafeArgument !== undefined) {
    return fail("invalid_input", "[runGitCommand] refused an empty or control-carrying argument");
  }

  const subcommand = args.find((argument) => !argument.startsWith("-")) ?? "git";

  const attempt = await fromThrowing<GitAttempt>(
    "internal",
    "[runGitCommand] git could not be started",
    () =>
      new Promise<GitAttempt>((resolveAttempt) => {
        execFile(
          "git",
          [...args],
          {
            cwd: options.cwd ?? process.cwd(),
            timeout: options.timeoutMs,
            killSignal: "SIGKILL",
            maxBuffer: options.maxOutputBytes,
            encoding: "utf8",
            env: { ...process.env, ...GIT_ENVIRONMENT },
            windowsHide: true,
          },
          (error, stdout) => {
            if (error === null) {
              resolveAttempt({ didRun: true, stdout });
              return;
            }
            resolveAttempt({ didRun: false, failure: classifyGitError(error, subcommand, options) });
          },
        );
      }),
  );

  if (!attempt.ok) return attempt;
  if (!attempt.value.didRun) return { ok: false, failure: attempt.value.failure };
  return succeed(attempt.value.stdout);
}

/**
 * Reads the three fields that classify an exec failure.
 *
 * Written as a narrowing read of an unknown value rather than as a typed parameter, because
 * the Node typings intersect an exec error's numeric `code` with an errno string `code`,
 * which leaves the field unreadable without a cast, and casts are not allowed here.
 */
function readExecErrorFields(error: unknown): {
  code: string | number | null;
  wasKilled: boolean;
  signal: string | null;
} {
  if (typeof error !== "object" || error === null) {
    return { code: null, wasKilled: false, signal: null };
  }

  const code = "code" in error ? error.code : null;
  const killed = "killed" in error ? error.killed : false;
  const signal = "signal" in error ? error.signal : null;

  return {
    code: typeof code === "string" || typeof code === "number" ? code : null,
    wasKilled: killed === true,
    signal: typeof signal === "string" ? signal : null,
  };
}

/**
 * Maps an exec failure onto a Failure reason. The three cases that matter here are the
 * timeout (a flaky network or a repository too large for the budget), the output cap (a
 * blob larger than this run accepts) and a plain non-zero exit (a missing path, a missing
 * repository, a refused fetch).
 */
function classifyGitError(error: unknown, subcommand: string, options: GitCallOptions): Failure {
  const fields = readExecErrorFields(error);

  if (fields.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return {
      reason: "invalid_input",
      message:
        `[classifyGitError] git ${subcommand} wrote more than the ` +
        `${options.maxOutputBytes} byte cap`,
    };
  }
  if (fields.wasKilled || fields.signal === "SIGKILL") {
    return {
      reason: "timeout",
      message: `[classifyGitError] git ${subcommand} was killed after ${options.timeoutMs} ms`,
    };
  }
  if (typeof fields.code === "number") {
    return {
      reason: "upstream_rejected",
      message:
        `[classifyGitError] git ${subcommand} exited with code ${fields.code}. Its stderr is ` +
        "not forwarded, because git echoes URLs and paths there",
    };
  }
  return {
    reason: "upstream_unavailable",
    message:
      `[classifyGitError] git ${subcommand} did not complete ` +
      `(${fields.code === null ? "no code" : String(fields.code)})`,
  };
}

/** Proves git exists before any clone is attempted, and records its version in the output. */
async function readGitDescription(
  gitRunner: GitRunner,
  argumentValues: HarvestArguments,
): Promise<Result<string, Failure>> {
  const probed = await gitRunner.run(["--version"], {
    cwd: null,
    timeoutMs: argumentValues.gitTimeoutMs,
    maxOutputBytes: SHORT_OUTPUT_CAP_BYTES,
  });
  if (!probed.ok) {
    return fail(
      "unsupported",
      "[readGitDescription] git is not runnable, and this harvester reads history through git " +
        `only (${probed.failure.reason})`,
    );
  }

  const description = probed.value.trim();
  return description.length === 0
    ? fail("unsupported", "[readGitDescription] git answered --version with nothing")
    : succeed(description);
}

/**
 * Makes sure a usable clone exists, and returns its directory.
 *
 * `--no-checkout` is not an optimization: it means no file from the cloned repository is
 * ever written to a working tree, so no `.gitattributes` filter and no checkout hook from
 * an untrusted repository runs on this machine. `--single-branch --no-tags` keeps the
 * download to the default branch, whose history is what the walk reads.
 */
async function ensureRepositoryClone(
  target: RepositoryTarget,
  argumentValues: HarvestArguments,
  gitRunner: GitRunner,
): Promise<Result<{ directory: string; wasCloned: boolean }, Failure>> {
  const directory = resolve(
    join(argumentValues.cloneDirectory, buildCloneDirectoryName(target.serviceKey)),
  );

  const probed = await gitRunner.run(["-C", directory, "rev-parse", "--git-dir"], {
    cwd: null,
    timeoutMs: argumentValues.gitTimeoutMs,
    maxOutputBytes: SHORT_OUTPUT_CAP_BYTES,
  });

  if (probed.ok) {
    if (!argumentValues.isRefresh) return succeed({ directory, wasCloned: false });

    const fetched = await gitRunner.run(
      ["-C", directory, "fetch", "--quiet", "--no-tags", "origin"],
      {
        cwd: null,
        timeoutMs: argumentValues.cloneTimeoutMs,
        maxOutputBytes: SHORT_OUTPUT_CAP_BYTES,
      },
    );
    if (!fetched.ok) {
      return fail(
        fetched.failure.reason,
        `[ensureRepositoryClone] ${target.slug} could not be refreshed: ${fetched.failure.message}`,
      );
    }
    return succeed({ directory, wasCloned: false });
  }

  const parentCreated = await fromThrowing(
    "internal",
    `[ensureRepositoryClone] cannot create the clone directory for ${target.slug}`,
    () => mkdir(dirname(directory), { recursive: true }).then(() => undefined),
  );
  if (!parentCreated.ok) return parentCreated;

  console.log(`[ensureRepositoryClone] cloning ${target.slug}, this is the slow part`);
  const cloneArguments = [
    "clone",
    "--quiet",
    "--no-checkout",
    "--single-branch",
    "--no-tags",
    ...(argumentValues.isBlobless ? ["--filter=blob:none"] : []),
    target.cloneUrl,
    directory,
  ];

  const cloned = await gitRunner.run(cloneArguments, {
    cwd: null,
    timeoutMs: argumentValues.cloneTimeoutMs,
    maxOutputBytes: SHORT_OUTPUT_CAP_BYTES,
  });
  if (!cloned.ok) {
    return fail(
      cloned.failure.reason,
      `[ensureRepositoryClone] ${target.slug} could not be cloned: ${cloned.failure.message}`,
    );
  }

  return succeed({ directory, wasCloned: true });
}

/**
 * Which lockfile names exist at some point in the history of this repository's default
 * branch.
 * A path is looked up with `git log --max-count=1`, which answers nothing at all for a path
 * that never existed, so this costs one cheap call per candidate.
 */
async function discoverLockfilePaths(
  directory: string,
  argumentValues: HarvestArguments,
  gitRunner: GitRunner,
): Promise<Result<string[], Failure>> {
  const found: string[] = [];

  for (const candidate of LOCKFILE_CANDIDATE_PATHS) {
    const logged = await gitRunner.run(
      ["-C", directory, "log", "--max-count=1", "--format=%H", "--", candidate],
      {
        cwd: null,
        timeoutMs: argumentValues.gitTimeoutMs,
        maxOutputBytes: SHORT_OUTPUT_CAP_BYTES,
      },
    );
    if (!logged.ok) return logged;
    if (logged.value.trim().length > 0) found.push(candidate);
  }

  return succeed(found);
}

/** One commit that touched the lockfile, as git named it. */
type RevisionReference = { commitSha: string; committedAtMs: number };

/**
 * The commits that touched one path, newest first.
 *
 * One extra commit past the cap is requested so truncation is observed rather than guessed:
 * if git names more than the cap, the history is longer than what this run reads, and that
 * is coverage the output has to disclose.
 */
async function listLockfileRevisions(
  directory: string,
  lockfilePath: string,
  argumentValues: HarvestArguments,
  gitRunner: GitRunner,
): Promise<Result<{ revisions: RevisionReference[]; wasTruncated: boolean }, Failure>> {
  const logArguments = [
    "-C",
    directory,
    "log",
    `--max-count=${argumentValues.maxRevisions + 1}`,
    `--format=%H${LOG_FIELD_SEPARATOR_PLACEHOLDER}%ct`,
    ...(argumentValues.sinceMs === null
      ? []
      : [`--since=${new Date(argumentValues.sinceMs).toISOString()}`]),
    "--",
    lockfilePath,
  ];

  const logged = await gitRunner.run(logArguments, {
    cwd: null,
    timeoutMs: argumentValues.gitTimeoutMs,
    maxOutputBytes: LOG_OUTPUT_CAP_BYTES,
  });
  if (!logged.ok) return logged;

  const revisions: RevisionReference[] = [];
  for (const line of logged.value.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    const [commitSha, commitSeconds] = trimmed.split(LOG_FIELD_SEPARATOR);
    if (commitSha === undefined || commitSeconds === undefined) continue;
    if (!COMMIT_SHA_PATTERN.test(commitSha)) continue;

    // %ct is the commit time in seconds since the epoch; the graph stores milliseconds.
    // sourceRef: https://git-scm.com/docs/pretty-formats (%ct, committer date, UNIX timestamp)
    const parsedSeconds = Number.parseInt(commitSeconds, 10);
    if (!Number.isInteger(parsedSeconds) || parsedSeconds <= 0) continue;

    revisions.push({ commitSha, committedAtMs: parsedSeconds * 1_000 });
  }

  const wasTruncated = revisions.length > argumentValues.maxRevisions;
  return succeed({
    revisions: revisions.slice(0, argumentValues.maxRevisions),
    wasTruncated,
  });
}

/** Blob size at one revision, in bytes, read before any content is transferred. */
async function readBlobSizeBytes(
  directory: string,
  commitSha: string,
  lockfilePath: string,
  argumentValues: HarvestArguments,
  gitRunner: GitRunner,
): Promise<Result<number, Failure>> {
  const sized = await gitRunner.run(
    ["-C", directory, "cat-file", "-s", `${commitSha}:${lockfilePath}`],
    {
      cwd: null,
      timeoutMs: argumentValues.gitTimeoutMs,
      maxOutputBytes: SHORT_OUTPUT_CAP_BYTES,
    },
  );
  if (!sized.ok) return sized;

  const parsedSize = Number.parseInt(sized.value.trim(), 10);
  if (!Number.isInteger(parsedSize) || parsedSize < 0) {
    return fail("upstream_rejected", "[readBlobSizeBytes] git cat-file answered no usable size");
  }
  return succeed(parsedSize);
}

/** Blob content at one revision. Only called after the size check passed. */
async function readBlobText(
  directory: string,
  commitSha: string,
  lockfilePath: string,
  argumentValues: HarvestArguments,
  gitRunner: GitRunner,
): Promise<Result<string, Failure>> {
  return await gitRunner.run(["-C", directory, "show", `${commitSha}:${lockfilePath}`], {
    cwd: null,
    timeoutMs: argumentValues.gitTimeoutMs,
    maxOutputBytes: argumentValues.maxLockfileBytes + SUBPROCESS_OUTPUT_SLACK_BYTES,
  });
}

// ---------------------------------------------------------------------------
// Harvest of one repository
// ---------------------------------------------------------------------------

type RepositoryOutcome =
  | { kind: "harvested"; service: HarvestedService; notes: string[] }
  | { kind: "gap"; gap: HarvestGap; notes: string[] };

/**
 * Walks one repository's lockfile history into one service.
 *
 * A repository that cannot be cloned, has no lockfile, or whose every revision is
 * unreadable becomes a gap, never a thrown error: one dead repository out of three must not
 * throw away the other two.
 */
async function harvestRepository(
  target: RepositoryTarget,
  argumentValues: HarvestArguments,
  gitRunner: GitRunner,
  priorService: HarvestedService | null,
): Promise<RepositoryOutcome> {
  const notes: string[] = [];

  const cloned = await ensureRepositoryClone(target, argumentValues, gitRunner);
  if (!cloned.ok) return buildGap(target, cloned.failure, notes);

  const headRead = await gitRunner.run(["-C", cloned.value.directory, "rev-parse", "HEAD"], {
    cwd: null,
    timeoutMs: argumentValues.gitTimeoutMs,
    maxOutputBytes: SHORT_OUTPUT_CAP_BYTES,
  });
  if (!headRead.ok) return buildGap(target, headRead.failure, notes);
  const headCommitSha = headRead.value.trim();

  const discovered = await discoverLockfilePaths(cloned.value.directory, argumentValues, gitRunner);
  if (!discovered.ok) return buildGap(target, discovered.failure, notes);

  const chosenPath = argumentValues.lockfilePath ?? discovered.value[0];
  if (chosenPath === undefined) {
    return buildGap(
      target,
      {
        reason: "not_found",
        message:
          `[harvestRepository] ${target.slug} has none of the ` +
          `${LOCKFILE_CANDIDATE_PATHS.length} lockfile names this project reads anywhere in ` +
          "its default branch history",
      },
      notes,
    );
  }

  const listed = await listLockfileRevisions(
    cloned.value.directory,
    chosenPath,
    argumentValues,
    gitRunner,
  );
  if (!listed.ok) return buildGap(target, listed.failure, notes);

  if (listed.value.revisions.length === 0) {
    return buildGap(
      target,
      {
        reason: "not_found",
        message:
          `[harvestRepository] no commit touched ${chosenPath} in ${target.slug} inside the ` +
          "requested window",
      },
      notes,
    );
  }

  console.log(
    `[harvestRepository] ${target.slug}: ${listed.value.revisions.length} revision(s) of ` +
      `${chosenPath} to read${listed.value.wasTruncated ? ", history is longer" : ""}`,
  );

  const reused =
    priorService !== null && priorService.lockfilePath === chosenPath ? priorService : null;
  if (priorService !== null && reused === null) {
    notes.push(
      `${target.serviceKey} previously harvested ${priorService.lockfilePath} and now harvests ` +
        `${chosenPath}, so the previous revisions were not reused`,
    );
  }

  const walked = await walkRevisions({
    target,
    directory: cloned.value.directory,
    lockfilePath: chosenPath,
    revisions: listed.value.revisions,
    argumentValues,
    gitRunner,
    reused,
  });

  for (const note of walked.notes) notes.push(note);

  if (walked.revisions.length === 0) {
    return buildGap(
      target,
      {
        reason: "upstream_unavailable",
        message:
          `[harvestRepository] every one of the ${listed.value.revisions.length} revision(s) of ` +
          `${chosenPath} in ${target.slug} was unreadable or unparsable`,
      },
      notes,
    );
  }

  const unharvestedPaths = discovered.value.filter((candidate) => candidate !== chosenPath);
  const coverage = buildCoverage({
    serviceKey: target.serviceKey,
    revisions: walked.revisions,
    revisionsNamedByGit: listed.value.revisions.length,
    wasRevisionListTruncated: listed.value.wasTruncated,
    counters: walked.counters,
    unharvestedPaths,
    sinceMs: argumentValues.sinceMs,
    maxRevisions: argumentValues.maxRevisions,
    priorCoverage: reused === null ? null : reused.coverage,
  });

  return {
    kind: "harvested",
    notes,
    service: {
      key: target.serviceKey,
      name: target.slug,
      source: HARVESTED_SERVICE_SOURCE,
      repositoryUrl: target.cloneUrl,
      lockfilePath: chosenPath,
      ecosystem: walked.ecosystem,
      headCommitSha,
      revisions: walked.revisions,
      resolutions: walked.resolutions,
      coverage,
    },
  };
}

function buildGap(
  target: RepositoryTarget,
  failure: Failure,
  notes: readonly string[],
): RepositoryOutcome {
  console.error(`[buildGap] ${target.slug} yielded no history: ${failure.message}`);
  return {
    kind: "gap",
    notes: [...notes],
    gap: {
      serviceKey: target.serviceKey,
      repositoryUrl: target.cloneUrl,
      reason: failure.reason,
      message: failure.message,
    },
  };
}

/** What the walk of one lockfile's revisions could not read, per cause. */
type WalkCounters = {
  unreadable: number;
  oversized: number;
  unparsable: number;
  resolutionsDropped: number;
  devOnlyResolutions: number;
  reusedRevisions: number;
};

type WalkOutcome = {
  revisions: HarvestedRevision[];
  resolutions: HarvestedResolution[];
  ecosystem: Ecosystem;
  counters: WalkCounters;
  notes: string[];
};

/**
 * Reads every listed revision and folds them into one resolution set.
 *
 * Revisions the previous run already recorded are reused rather than re-read, which is
 * what makes a resumed harvest cheap, and their aggregate is seeded from the previous
 * resolution list so no version is counted twice.
 */
async function walkRevisions(input: {
  target: RepositoryTarget;
  directory: string;
  lockfilePath: string;
  revisions: readonly RevisionReference[];
  argumentValues: HarvestArguments;
  gitRunner: GitRunner;
  reused: HarvestedService | null;
}): Promise<WalkOutcome> {
  const counters: WalkCounters = {
    unreadable: 0,
    oversized: 0,
    unparsable: 0,
    resolutionsDropped: 0,
    devOnlyResolutions: 0,
    reusedRevisions: 0,
  };
  const notes: string[] = [];

  const revisionsBySha = new Map<string, HarvestedRevision>();
  const resolutionsByKey = new Map<string, HarvestedResolution>();
  let ecosystem: Ecosystem = "npm";

  if (input.reused !== null) {
    for (const revision of input.reused.revisions) revisionsBySha.set(revision.commitSha, revision);
    for (const resolution of input.reused.resolutions) {
      resolutionsByKey.set(
        versionKey(resolution.ecosystem, resolution.name, resolution.version),
        { ...resolution },
      );
    }
    ecosystem = input.reused.ecosystem;
    counters.reusedRevisions = input.reused.revisions.length;
  }

  let readCount = 0;
  for (const reference of input.revisions) {
    if (revisionsBySha.has(reference.commitSha)) continue;

    readCount += 1;
    if (readCount % PROGRESS_EVERY_REVISIONS === 0) {
      console.log(
        `[walkRevisions] ${input.target.slug}: ${readCount} new revision(s) read, at ` +
          `${reference.commitSha.slice(0, SHORT_SHA_LENGTH)}`,
      );
    }

    const sized = await readBlobSizeBytes(
      input.directory,
      reference.commitSha,
      input.lockfilePath,
      input.argumentValues,
      input.gitRunner,
    );
    if (!sized.ok) {
      counters.unreadable += 1;
      continue;
    }
    if (sized.value > input.argumentValues.maxLockfileBytes) {
      counters.oversized += 1;
      notes.push(
        `${input.target.serviceKey}: ${input.lockfilePath} at ` +
          `${reference.commitSha.slice(0, SHORT_SHA_LENGTH)} is ${sized.value} bytes, over the ` +
          `${input.argumentValues.maxLockfileBytes} byte cap, so that revision was not read`,
      );
      continue;
    }

    const content = await readBlobText(
      input.directory,
      reference.commitSha,
      input.lockfilePath,
      input.argumentValues,
      input.gitRunner,
    );
    if (!content.ok) {
      counters.unreadable += 1;
      continue;
    }

    // The parser is the trust boundary for this content, and it returns a Failure for a
    // whole-file problem. Only its reason is kept: a failure message must never carry a
    // byte of the file it read.
    const parsed = parseLockfile(content.value, input.lockfilePath);
    if (!parsed.ok) {
      counters.unparsable += 1;
      notes.push(
        `${input.target.serviceKey}: ${input.lockfilePath} at ` +
          `${reference.commitSha.slice(0, SHORT_SHA_LENGTH)} did not parse ` +
          `(${parsed.failure.reason}), so that revision carries no edge`,
      );
      continue;
    }

    ecosystem = parsed.value.ecosystem;
    let pinnedCount = 0;

    for (const dependency of parsed.value.dependencies) {
      // A range is not a resolution, so an unpinned entry gets no RESOLVED edge. The
      // parser already counted it, and the count reaches the output.
      if (dependency.version === null) continue;
      if (dependency.isDevOnly) counters.devOnlyResolutions += 1;

      pinnedCount += 1;
      const identity = versionKey(dependency.ecosystem, dependency.name, dependency.version);
      const existing = resolutionsByKey.get(identity);

      if (existing !== undefined) {
        existing.resolvedAtMs = Math.min(existing.resolvedAtMs, reference.committedAtMs);
        existing.lastResolvedAtMs = Math.max(existing.lastResolvedAtMs, reference.committedAtMs);
        existing.revisionCount += 1;
        continue;
      }

      if (resolutionsByKey.size >= MAX_RESOLUTIONS_PER_SERVICE) {
        counters.resolutionsDropped += 1;
        continue;
      }

      resolutionsByKey.set(identity, {
        ecosystem: dependency.ecosystem,
        name: dependency.name,
        version: dependency.version,
        resolvedAtMs: reference.committedAtMs,
        lastResolvedAtMs: reference.committedAtMs,
        revisionCount: 1,
      });
    }

    revisionsBySha.set(reference.commitSha, {
      commitSha: reference.commitSha,
      committedAtMs: reference.committedAtMs,
      lockfileFormat: parsed.value.format,
      resolutionCount: pinnedCount,
      unpinnedCount: parsed.value.skipped.unpinnedCount,
      unparsableEntryCount: parsed.value.skipped.unparsableLineCount,
      truncatedEntryCount: parsed.value.skipped.truncatedCount,
    });
  }

  if (counters.reusedRevisions > 0) {
    notes.push(
      `${input.target.serviceKey}: ${counters.reusedRevisions} revision(s) came from the ` +
        `previous harvest file and ${readCount} were read from git`,
    );
  }
  if (counters.devOnlyResolutions > 0) {
    notes.push(
      `${input.target.serviceKey}: ${counters.devOnlyResolutions} resolution(s) are dev only in ` +
        "at least one revision, and they are kept, because a compromised dev dependency still " +
        "runs in the build",
    );
  }

  const revisions = [...revisionsBySha.values()].sort(
    (left, right) => right.committedAtMs - left.committedAtMs,
  );

  return {
    revisions,
    resolutions: [...resolutionsByKey.values()],
    ecosystem,
    counters,
    notes,
  };
}

/**
 * Turns everything that bounded the walk into a coverage record and, when anything did,
 * into the `service_history_partial` limit the analysis layer raises verbatim.
 *
 * A previous run's incompleteness is inherited: a resumed harvest that read only the new
 * commits cannot repair a gap the earlier run recorded.
 */
function buildCoverage(input: {
  serviceKey: string;
  revisions: readonly HarvestedRevision[];
  revisionsNamedByGit: number;
  wasRevisionListTruncated: boolean;
  counters: WalkCounters;
  unharvestedPaths: readonly string[];
  sinceMs: number | null;
  maxRevisions: number;
  priorCoverage: ServiceCoverage | null;
}): ServiceCoverage {
  const reasons: string[] = [];

  if (input.wasRevisionListTruncated) {
    reasons.push(
      `the revision cap of ${input.maxRevisions} was reached, so commits older than the oldest ` +
        "harvested one exist and were not read",
    );
  }
  if (input.sinceMs !== null) {
    reasons.push(
      `the walk was bounded to commits after ${new Date(input.sinceMs).toISOString()}, so any ` +
        "earlier resolution is absent",
    );
  }
  if (input.counters.unreadable > 0) {
    reasons.push(
      `${input.counters.unreadable} revision(s) could not be read from git, so their ` +
        "resolutions are unknown",
    );
  }
  if (input.counters.oversized > 0) {
    reasons.push(
      `${input.counters.oversized} revision(s) exceeded the lockfile size cap and were skipped`,
    );
  }
  if (input.counters.unparsable > 0) {
    reasons.push(`${input.counters.unparsable} revision(s) did not parse as a supported lockfile`);
  }
  if (input.counters.resolutionsDropped > 0) {
    reasons.push(
      `${input.counters.resolutionsDropped} resolution(s) were dropped at the per-service cap of ` +
        `${MAX_RESOLUTIONS_PER_SERVICE}`,
    );
  }
  if (input.unharvestedPaths.length > 0) {
    reasons.push(
      `this repository also has ${input.unharvestedPaths.join(", ")} in its history, and this ` +
        "run read one lockfile only",
    );
  }
  if (input.priorCoverage !== null && !input.priorCoverage.isComplete) {
    for (const inherited of input.priorCoverage.reasons) {
      if (!reasons.includes(inherited)) reasons.push(inherited);
    }
  }

  const commitTimes = input.revisions.map((revision) => revision.committedAtMs);
  const isComplete = reasons.length === 0;

  return {
    isComplete,
    harvestedRevisions: input.revisions.length,
    revisionsNamedByGit: input.revisionsNamedByGit,
    revisionsUnreadable: input.counters.unreadable,
    revisionsOversized: input.counters.oversized,
    revisionsUnparsable: input.counters.unparsable,
    resolutionsDropped: input.counters.resolutionsDropped,
    oldestCommitAtMs: commitTimes.length === 0 ? UNKNOWN_TIMESTAMP_MS : Math.min(...commitTimes),
    newestCommitAtMs: commitTimes.length === 0 ? UNKNOWN_TIMESTAMP_MS : Math.max(...commitTimes),
    unharvestedLockfilePaths: [...input.unharvestedPaths],
    reasons,
    answerLimit: isComplete
      ? null
      : {
          kind: "service_history_partial",
          serviceKey: input.serviceKey,
          harvestedRevisions: input.revisions.length,
        },
  };
}

// ---------------------------------------------------------------------------
// Output file
// ---------------------------------------------------------------------------

/**
 * Reads the previous harvest, which is also the resume state.
 *
 * An absent file is the normal first run and says nothing. A file that exists and cannot be
 * read or validated is a note, not a failure: the run continues and rewrites it, because
 * refusing to harvest because of a damaged state file would be worse than rebuilding it.
 */
async function readPreviousHarvest(
  outputPath: string,
): Promise<{ file: HarvestFile | null; notes: string[] }> {
  const stated = await fromThrowing("not_found", "[readPreviousHarvest] stat", () =>
    stat(resolve(outputPath)),
  );
  if (!stated.ok) return { file: null, notes: [] };

  const read = await fromThrowing("internal", "[readPreviousHarvest] read", () =>
    readFile(resolve(outputPath), "utf8"),
  );
  if (!read.ok) {
    return {
      file: null,
      notes: [
        `${outputPath} exists and could not be read, so this run harvested from scratch and ` +
          "overwrote it",
      ],
    };
  }

  const parsedJson = fromThrowingSync("invalid_input", "json", () => JSON.parse(read.value) as unknown);
  if (!parsedJson.ok) {
    return {
      file: null,
      notes: [`${outputPath} is not valid JSON, so this run harvested from scratch and rewrote it`],
    };
  }

  const validated = HARVEST_FILE_SCHEMA.safeParse(parsedJson.value);
  if (!validated.success) {
    return {
      file: null,
      notes: [
        `${outputPath} does not match the harvest format (${describeSchemaIssues(validated.error)}), ` +
          "so this run harvested from scratch and rewrote it",
      ],
    };
  }
  if (validated.data.formatVersion !== HARVEST_FORMAT_VERSION) {
    return {
      file: null,
      notes: [
        `${outputPath} is format version ${validated.data.formatVersion} and this harvester ` +
          `writes ${HARVEST_FORMAT_VERSION}, so nothing was resumed`,
      ],
    };
  }

  // Assigning the validated shape to the internal type is the compatibility check: if the
  // schema and the types above ever drift, this line stops compiling.
  const file: HarvestFile = validated.data;
  return { file, notes: [] };
}

/**
 * Serializes checkpoint writes.
 *
 * Repositories are harvested in parallel, so two of them can finish while a write is in
 * flight. Chaining every write behind the previous one keeps the file from being written by
 * two callers at once, which would leave truncated JSON on disk.
 */
function createCheckpointWriter(outputPath: string): {
  write: (file: HarvestFile) => Promise<Result<string, Failure>>;
} {
  let tail: Promise<unknown> = Promise.resolve();

  return {
    write: (file) => {
      const next = tail.then(() => writeHarvestFile(file, outputPath));
      tail = next;
      return next;
    },
  };
}

async function writeHarvestFile(
  file: HarvestFile,
  outputPath: string,
): Promise<Result<string, Failure>> {
  const path = resolve(outputPath);

  const directoryCreated = await fromThrowing(
    "internal",
    `[writeHarvestFile] cannot create the directory for ${outputPath}`,
    () => mkdir(dirname(path), { recursive: true }).then(() => undefined),
  );
  if (!directoryCreated.ok) return directoryCreated;

  const written = await fromThrowing(
    "internal",
    `[writeHarvestFile] cannot write ${outputPath}`,
    () => writeFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8"),
  );
  if (!written.ok) return written;

  return succeed(path);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printBudgets(argumentValues: HarvestArguments): void {
  const rows: readonly [string, string][] = [
    [
      "repositories",
      argumentValues.repositorySpecs?.join(", ") ??
        `the default set (${DEFAULT_REPOSITORY_SPECS.join(", ")})`,
    ],
    ["lockfile", argumentValues.lockfilePath ?? "discovered from the repository history"],
    ["max revisions per lockfile", String(argumentValues.maxRevisions)],
    [
      "commit window",
      argumentValues.sinceMs === null
        ? "the whole history"
        : `commits after ${new Date(argumentValues.sinceMs).toISOString()}`,
    ],
    ["max lockfile bytes", String(argumentValues.maxLockfileBytes)],
    ["concurrency", `${argumentValues.concurrency} git process(es)`],
    ["git timeout", `${argumentValues.gitTimeoutMs} ms`],
    ["clone timeout", `${argumentValues.cloneTimeoutMs} ms`],
    [
      "clones",
      argumentValues.isBlobless
        ? `${argumentValues.cloneDirectory} (blobless, blobs fetched on demand)`
        : argumentValues.cloneDirectory,
    ],
    [
      "output",
      argumentValues.isRefresh
        ? `${argumentValues.outputPath} (refreshing, every revision re-read)`
        : `${argumentValues.outputPath} (resumed when it exists)`,
    ],
  ];

  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  console.log("[printBudgets] budgets and destinations for this run");
  for (const [label, value] of rows) {
    console.log(`[printBudgets]   ${label.padEnd(labelWidth)}  ${value}`);
  }
}

type HarvestReport = {
  argumentValues: HarvestArguments;
  services: readonly HarvestedService[];
  gaps: readonly HarvestGap[];
  gitCounts: GitCounts;
  outputPath: string;
  elapsedMs: number;
  notes: readonly string[];
};

function printHarvestReport(report: HarvestReport): void {
  let revisionCount = 0;
  let resolutionCount = 0;
  let completeCount = 0;
  let oldestCommitAtMs = Number.POSITIVE_INFINITY;

  for (const service of report.services) {
    revisionCount += service.revisions.length;
    resolutionCount += service.resolutions.length;
    if (service.coverage.isComplete) completeCount += 1;
    if (
      service.coverage.oldestCommitAtMs !== UNKNOWN_TIMESTAMP_MS &&
      service.coverage.oldestCommitAtMs < oldestCommitAtMs
    ) {
      oldestCommitAtMs = service.coverage.oldestCommitAtMs;
    }
  }

  const rows: readonly [string, string][] = [
    ["services", String(report.services.length)],
    ["revisions harvested", String(revisionCount)],
    ["RESOLVED edges", String(resolutionCount)],
    ["complete histories", String(completeCount)],
    ["partial histories", String(report.services.length - completeCount)],
    [
      "oldest commit",
      Number.isFinite(oldestCommitAtMs)
        ? new Date(oldestCommitAtMs).toISOString()
        : "none harvested",
    ],
    [
      "repositories with no history",
      report.gaps.length === 0
        ? "none"
        : report.gaps.map((gap) => `${gap.serviceKey} (${gap.reason})`).join(", "),
    ],
    ["git calls", String(report.gitCounts.calls)],
    ["git call failures", String(report.gitCounts.failures)],
    ["wall clock", `${report.elapsedMs} ms`],
    ["output", report.outputPath],
  ];

  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  console.log("[printHarvestReport] harvest summary");
  for (const [label, value] of rows) {
    console.log(`[printHarvestReport]   ${label.padEnd(labelWidth)}  ${value}`);
  }

  for (const service of report.services) {
    if (service.coverage.isComplete) continue;
    console.log(
      `[printHarvestReport] ${service.key} is partial over ` +
        `${service.coverage.harvestedRevisions} revision(s): ` +
        service.coverage.reasons.join("; "),
    );
  }

  if (report.notes.length === 0) return;

  console.log(`[printHarvestReport] ${report.notes.length} disclosure(s) about this harvest`);
  for (const note of report.notes.slice(0, MAX_PRINTED_NOTES)) {
    console.log(`[printHarvestReport]   ${note}`);
  }
  if (report.notes.length > MAX_PRINTED_NOTES) {
    console.log(
      `[printHarvestReport]   ... ${report.notes.length - MAX_PRINTED_NOTES} more, all of them in ` +
        report.argumentValues.outputPath,
    );
  }
}

/**
 * Prints a Failure in full, then the next thing to try. Same shape as the one in
 * scripts/ingest-slice.ts, kept per script so a CLI carries no cross-script import.
 */
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
      return "check the repository spelling, and pass --lockfile when the path is unusual";
    case "timeout":
      return "raise --clone-timeout-ms, lower --concurrency, then rerun over the existing clones";
    case "upstream_unavailable":
      return "the git remote did not answer, rerun when it does; existing clones are reused";
    case "upstream_rejected":
      return "git refused the command, check that the repository is public and still exists";
    case "unsupported":
      return "install git, or put it on PATH, then rerun";
    default:
      return null;
  }
}

function elapsedMsSince(startedAtMs: number): number {
  return Math.round(performance.now() - startedAtMs);
}

const exitCode = await runHarvest(process.argv.slice(2));
process.exit(exitCode);
