import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import semver from "semver";
import { z } from "zod";

import { ECOSYSTEMS } from "@/lib/graph/model";
import { describeSchemaIssues } from "@/lib/ingest/fetch-json";
import {
  type Failure,
  type Result,
  collect,
  fail,
  fromThrowing,
  fromThrowingSync,
  succeed,
} from "@/lib/result";

/**
 * Incident replay packs: the curated, on-disk record of a real supply chain compromise.
 *
 * A pack is the demo's ground truth, so it carries both clocks the bitemporal query
 * needs and keeps them apart. Valid time is when a version became installable
 * (`compromisedVersions[].publishedAtMs`, `services[].resolved[].resolvedAtMs`). Known
 * time is when the world learned of it (`advisories[].publishedAtMs`). The gap between
 * the two is the exposure window, and it is the only interval in which a lockfile could
 * pin a malicious version while every scanner on earth still reported the build clean.
 *
 * Validation here is deliberately strict. A pack is hand curated from advisory and
 * registry records, so the failure mode is a typo in a timestamp, and a timestamp typo
 * that survives into the graph produces a confident wrong answer rather than a crash.
 * Every failure names the field path so the offending line is found by reading, not by
 * diffing JSON by hand.
 */

/**
 * Where packs live, as a path relative to the process working directory. One JSON file
 * per incident, named after its slug.
 */
export const INCIDENT_PACK_DIRECTORY = "data/incidents";

/** File extension every pack carries. The name without it is the pack slug. */
const PACK_FILE_EXTENSION = ".json";

/**
 * OSV writes `introduced: "0"` to mean "from the first version ever published", which is
 * not a semver string. It is accepted verbatim so a pack can state what the advisory
 * literally says instead of inventing a lowest version. src/lib/analysis/semver-facts.ts
 * resolves the same sentinel when it turns range events into intervals.
 * sourceRef: https://ossf.github.io/osv-schema/#affectedranges-field
 */
const RANGE_START_SENTINEL = "0";

/** kebab-case, and identical to the file name without the extension. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Service natural key, prefixed so it cannot collide with a package key. */
const SERVICE_KEY_PATTERN = /^svc:[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Advisory identifier. An uppercase source prefix and an identifier body, which covers
 * both forms this project cites: GHSA-mh6f-8j2x-4483 and MAL-2025-191335.
 */
const ADVISORY_ID_PATTERN = /^[A-Z][A-Z0-9]*-[A-Za-z0-9-]+$/;

// ---------------------------------------------------------------------------
// Field schemas
// ---------------------------------------------------------------------------

/**
 * Built from the graph model's ecosystem list rather than a fresh literal union, so a
 * new ecosystem cannot be supported by the graph and rejected by the pack loader.
 */
const ECOSYSTEM_SCHEMA = z.enum(ECOSYSTEMS);

const DATA_ORIGIN_SCHEMA = z.enum(["historical", "modeled"]);

/**
 * Epoch milliseconds. `z.int()` rejects anything outside the safe integer range, which
 * is what stops a pasted nanosecond timestamp from silently becoming a date in the year
 * 50000, and `positive()` rejects the 0 that a failed date conversion produces.
 */
const EPOCH_MS_SCHEMA = z.int().positive();

/** A concrete published version, so strict semver with no range syntax. */
const VERSION_SCHEMA = z
  .string()
  .refine((candidate) => semver.valid(candidate, { loose: true }) !== null, {
    message: "must be a semver version",
  });

/** An advisory lower bound, which may be the OSV "from the first version" sentinel. */
const INTRODUCED_SCHEMA = z
  .string()
  .refine(
    (candidate) =>
      candidate === RANGE_START_SENTINEL || semver.valid(candidate, { loose: true }) !== null,
    { message: `must be a semver version or "${RANGE_START_SENTINEL}"` },
  );

const SOURCE_URL_SCHEMA = z.url();

const NON_EMPTY_TEXT_SCHEMA = z.string().min(1);

// ---------------------------------------------------------------------------
// Object schemas
// ---------------------------------------------------------------------------

/** One malicious artifact, at the instant it became installable. */
const INCIDENT_COMPROMISED_VERSION_SCHEMA = z.object({
  ecosystem: ECOSYSTEM_SCHEMA,
  name: NON_EMPTY_TEXT_SCHEMA,
  version: VERSION_SCHEMA,
  /** Epoch milliseconds. The moment this version became installable. */
  publishedAtMs: EPOCH_MS_SCHEMA,
  hasInstallScript: z.boolean(),
  /** What is known about this artifact, including how its timestamp was established. */
  note: NON_EMPTY_TEXT_SCHEMA,
});

/** What one advisory says about one package. */
const INCIDENT_ADVISORY_AFFECTS_SCHEMA = z.object({
  ecosystem: ECOSYSTEM_SCHEMA,
  name: NON_EMPTY_TEXT_SCHEMA,
  /** Semver, the first affected version. */
  introduced: INTRODUCED_SCHEMA,
  /** First fixed version, or null when never fixed (package unpublished). */
  fixed: VERSION_SCHEMA.nullable(),
});

const INCIDENT_ADVISORY_SCHEMA = z.object({
  /** A real GHSA id, or an OSV id when no GHSA exists. */
  advisoryId: z
    .string()
    .regex(ADVISORY_ID_PATTERN, "must be an advisory id such as GHSA-mh6f-8j2x-4483"),
  /** Epoch milliseconds. Known time: when the world learned of it. */
  publishedAtMs: EPOCH_MS_SCHEMA,
  modifiedAtMs: EPOCH_MS_SCHEMA,
  summary: NON_EMPTY_TEXT_SCHEMA,
  affects: z.array(INCIDENT_ADVISORY_AFFECTS_SCHEMA).min(1),
});

/** One line of a service lockfile: this service pinned exactly this version. */
const INCIDENT_RESOLUTION_SCHEMA = z.object({
  ecosystem: ECOSYSTEM_SCHEMA,
  name: NON_EMPTY_TEXT_SCHEMA,
  version: VERSION_SCHEMA,
  /** Epoch milliseconds. When this service's lockfile recorded this exact version. */
  resolvedAtMs: EPOCH_MS_SCHEMA,
});

const INCIDENT_SERVICE_SCHEMA = z.object({
  /** Stable natural key, prefixed. Example: "svc:analytics-api". */
  key: z.string().regex(SERVICE_KEY_PATTERN, 'must look like "svc:analytics-api"'),
  name: NON_EMPTY_TEXT_SCHEMA,
  /** One line on what this service is, so the demo reads as real rather than as placeholders. */
  description: NON_EMPTY_TEXT_SCHEMA,
  resolved: z.array(INCIDENT_RESOLUTION_SCHEMA).min(1),
});

const INCIDENT_TIMELINE_KIND_SCHEMA = z.enum([
  "published",
  "resolved",
  "detected",
  "disclosed",
  "patched",
  "unpublished",
]);

const INCIDENT_TIMELINE_ENTRY_SCHEMA = z.object({
  atMs: EPOCH_MS_SCHEMA,
  kind: INCIDENT_TIMELINE_KIND_SCHEMA,
  label: NON_EMPTY_TEXT_SCHEMA,
  /** URL backing this specific timestamp, or null when it is derived from another entry. */
  sourceUrl: SOURCE_URL_SCHEMA.nullable(),
});

/**
 * The pack shape before cross-field validation. Split from the checked schema below so
 * the per-field errors are reported even when a cross-field rule also fails.
 */
const INCIDENT_PACK_FIELDS_SCHEMA = z.object({
  /** kebab-case, matches the file name without .json. */
  slug: z.string().regex(SLUG_PATTERN, "must be kebab-case"),
  title: NON_EMPTY_TEXT_SCHEMA,
  ecosystem: ECOSYSTEM_SCHEMA,
  dataOrigin: DATA_ORIGIN_SCHEMA,
  /** Two sentences at most, factual, and it states what in the pack is constructed. */
  summary: NON_EMPTY_TEXT_SCHEMA,
  /** Epoch ms bounds for the scrubber. */
  windowStartMs: EPOCH_MS_SCHEMA,
  windowEndMs: EPOCH_MS_SCHEMA,
  compromisedVersions: z.array(INCIDENT_COMPROMISED_VERSION_SCHEMA).min(1),
  advisories: z.array(INCIDENT_ADVISORY_SCHEMA).min(1),
  services: z.array(INCIDENT_SERVICE_SCHEMA).min(1),
  timeline: z.array(INCIDENT_TIMELINE_ENTRY_SCHEMA).min(1),
  /** Every URL used to establish the facts above. */
  sources: z.array(SOURCE_URL_SCHEMA).min(1),
});

export const INCIDENT_PACK_SCHEMA = INCIDENT_PACK_FIELDS_SCHEMA.superRefine((pack, context) => {
  if (pack.windowStartMs >= pack.windowEndMs) {
    context.addIssue({
      code: "custom",
      path: ["windowEndMs"],
      message: `window end ${pack.windowEndMs} is not after window start ${pack.windowStartMs}`,
      continue: true,
    });
  }

  // The scrubber can only reach timestamps inside the window, so an entry outside it is
  // an entry the demo would silently never show.
  pack.timeline.forEach((entry, entryIndex) => {
    if (entry.atMs >= pack.windowStartMs && entry.atMs <= pack.windowEndMs) return;
    context.addIssue({
      code: "custom",
      path: ["timeline", entryIndex, "atMs"],
      message: `${entry.atMs} falls outside the pack window ${pack.windowStartMs} to ${pack.windowEndMs}`,
      continue: true,
    });
  });

  const compromisedPackages = new Set(
    pack.compromisedVersions.map((compromised) =>
      buildPackageIdentity(compromised.ecosystem, compromised.name),
    ),
  );

  // An advisory may legitimately name a package this pack holds no artifact for (a
  // transitive victim, or a range the curator did not enumerate). What it may not do is
  // leave that package unexplained, so the advisory summary has to mention it by name.
  pack.advisories.forEach((advisory, advisoryIndex) => {
    advisory.affects.forEach((affected, affectedIndex) => {
      if (compromisedPackages.has(buildPackageIdentity(affected.ecosystem, affected.name))) return;
      if (advisory.summary.includes(affected.name)) return;
      context.addIssue({
        code: "custom",
        path: ["advisories", advisoryIndex, "affects", affectedIndex, "name"],
        message: `"${affected.name}" is absent from compromisedVersions and unexplained by the advisory summary`,
        continue: true,
      });
    });
  });

  const seenServiceKeys = new Set<string>();
  pack.services.forEach((service, serviceIndex) => {
    if (seenServiceKeys.has(service.key)) {
      context.addIssue({
        code: "custom",
        path: ["services", serviceIndex, "key"],
        message: `duplicate service key "${service.key}"`,
        continue: true,
      });
    }
    seenServiceKeys.add(service.key);
  });
});

// ---------------------------------------------------------------------------
// Types, derived from the schemas so the two cannot drift
// ---------------------------------------------------------------------------

export type Ecosystem = z.infer<typeof ECOSYSTEM_SCHEMA>;
/** Whether the pack's facts come from public reporting or are a constructed scenario. */
export type DataOrigin = z.infer<typeof DATA_ORIGIN_SCHEMA>;
export type IncidentCompromisedVersion = z.infer<typeof INCIDENT_COMPROMISED_VERSION_SCHEMA>;
export type IncidentAdvisoryAffects = z.infer<typeof INCIDENT_ADVISORY_AFFECTS_SCHEMA>;
export type IncidentAdvisory = z.infer<typeof INCIDENT_ADVISORY_SCHEMA>;
export type IncidentResolution = z.infer<typeof INCIDENT_RESOLUTION_SCHEMA>;
export type IncidentService = z.infer<typeof INCIDENT_SERVICE_SCHEMA>;
export type IncidentTimelineKind = z.infer<typeof INCIDENT_TIMELINE_KIND_SCHEMA>;
export type IncidentTimelineEntry = z.infer<typeof INCIDENT_TIMELINE_ENTRY_SCHEMA>;
export type IncidentPack = z.infer<typeof INCIDENT_PACK_SCHEMA>;

/** Ecosystem and name together, because "chalk" on npm and on PyPI are two packages. */
function buildPackageIdentity(ecosystem: Ecosystem, name: string): string {
  return `${ecosystem}:${name}`;
}

// ---------------------------------------------------------------------------
// Parsing and loading
// ---------------------------------------------------------------------------

/**
 * Validates one already-decoded pack. Use this when the JSON came from somewhere other
 * than the pack directory, such as an upload or a test fixture.
 */
export function parseIncidentPack(raw: unknown): Result<IncidentPack, Failure> {
  const parsed = INCIDENT_PACK_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    return fail("invalid_input", `[parseIncidentPack] ${describeSchemaIssues(parsed.error)}`);
  }
  return succeed(parsed.data);
}

/** Absolute path of one pack file. A relative directory resolves against the cwd. */
function buildPackFilePath(slug: string, directory: string): string {
  return join(resolve(directory), `${slug}${PACK_FILE_EXTENSION}`);
}

/**
 * Loads and validates one pack by slug.
 *
 * The slug is both the lookup key and the file name, and the loader checks that the
 * file agrees: a pack whose `slug` field drifted from its file name would be reachable
 * under one name and self-describe under another, which breaks every link into it.
 *
 * Failure cases, all as values: the file is missing (`not_found`), the file is not JSON
 * (`invalid_input`, naming the file), a field or cross-field rule fails
 * (`invalid_input`, naming the field path), or the slug and file name disagree.
 */
export async function loadIncidentPack(
  slug: string,
  directory: string = INCIDENT_PACK_DIRECTORY,
): Promise<Result<IncidentPack, Failure>> {
  if (!SLUG_PATTERN.test(slug)) {
    return fail("invalid_input", `[loadIncidentPack] "${slug}" is not a kebab-case pack slug`);
  }

  const filePath = buildPackFilePath(slug, directory);
  const fileName = basename(filePath);

  const text = await fromThrowing("not_found", `[loadIncidentPack] cannot read ${fileName}`, () =>
    readFile(filePath, "utf8"),
  );
  if (!text.ok) return text;

  const decoded = fromThrowingSync(
    "invalid_input",
    `[loadIncidentPack] ${fileName} is not valid JSON`,
    (): unknown => JSON.parse(text.value),
  );
  if (!decoded.ok) return decoded;

  const parsed = INCIDENT_PACK_SCHEMA.safeParse(decoded.value);
  if (!parsed.success) {
    return fail(
      "invalid_input",
      `[loadIncidentPack] ${fileName} is invalid: ${describeSchemaIssues(parsed.error)}`,
    );
  }

  if (parsed.data.slug !== slug) {
    return fail(
      "invalid_input",
      `[loadIncidentPack] ${fileName} declares slug "${parsed.data.slug}", which does not match its file name`,
    );
  }

  return succeed(parsed.data);
}

/**
 * Loads every pack in the directory, ordered by slug so the demo's incident list is
 * stable rather than filesystem dependent.
 *
 * One invalid pack fails the whole call. Silently dropping it would leave the demo
 * short an incident with nothing on screen to say why.
 */
export async function loadAllIncidentPacks(
  directory: string = INCIDENT_PACK_DIRECTORY,
): Promise<Result<IncidentPack[], Failure>> {
  const resolvedDirectory = resolve(directory);

  const entries = await fromThrowing(
    "not_found",
    `[loadAllIncidentPacks] cannot read directory ${resolvedDirectory}`,
    () => readdir(resolvedDirectory),
  );
  if (!entries.ok) return entries;

  const slugs = entries.value
    .filter((entry) => entry.endsWith(PACK_FILE_EXTENSION))
    .map((entry) => basename(entry, PACK_FILE_EXTENSION))
    .sort((left, right) => left.localeCompare(right));

  if (slugs.length === 0) {
    return fail(
      "not_found",
      `[loadAllIncidentPacks] no ${PACK_FILE_EXTENSION} pack found in ${resolvedDirectory}`,
    );
  }

  const loaded: Result<IncidentPack, Failure>[] = [];
  for (const slug of slugs) {
    loaded.push(await loadIncidentPack(slug, directory));
  }

  return collect(loaded);
}

// ---------------------------------------------------------------------------
// Exposure window
// ---------------------------------------------------------------------------

/**
 * The gap between a version being installable and the advisory being published. This is
 * the window the bitemporal query answers.
 *
 * Start is the earliest malicious publish (valid time opens), end is the earliest
 * advisory publication (known time opens, and the world can act). Earliest on both
 * sides is the honest choice: the window has to cover the first moment a build could
 * pull the payload and close at the first moment any public record existed.
 *
 * Returns null when there is no window to report, which happens when the advisory
 * preceded the artifact. That is not an error and callers render it as "no blind spot"
 * rather than as a zero-length window.
 */
export function computeExposureWindow(
  pack: IncidentPack,
): { startMs: number; endMs: number; durationMs: number } | null {
  const startMs = Math.min(...pack.compromisedVersions.map((entry) => entry.publishedAtMs));
  const endMs = Math.min(...pack.advisories.map((advisory) => advisory.publishedAtMs));
  if (endMs <= startMs) return null;

  return { startMs, endMs, durationMs: endMs - startMs };
}
