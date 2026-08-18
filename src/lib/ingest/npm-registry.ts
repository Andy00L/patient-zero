import { z } from "zod";

import {
  type HttpClientOptions,
  fetchJson,
  parseTimestampMs,
} from "@/lib/ingest/fetch-json";
import { type Failure, type Result, fail, succeed } from "@/lib/result";

/**
 * The npm registry read client: packuments and weekly download counts.
 *
 * Every endpoint and field below was confirmed against a live response on 2026-08-17,
 * with the confirming call noted at each schema. The registry is a CouchDB document
 * store, so the shapes are historical accretion rather than a designed API: fields are
 * absent rather than null when they do not apply, and the `time` map mixes per-version
 * publish times with two non-version keys.
 *
 * sourceRef: https://github.com/npm/registry/blob/main/docs/responses/package-metadata.md
 */

/** Registry host for package metadata. */
const REGISTRY_BASE_URL = "https://registry.npmjs.org";

/** Download statistics host. A different service from the registry, with its own limits. */
const DOWNLOADS_BASE_URL = "https://api.npmjs.org";

/**
 * Download window. `last-week` is documented as "downloads for the last 7 available
 * days", which is what the graph's `weekly_downloads` property holds.
 * sourceRef: https://github.com/npm/registry/blob/main/docs/download-counts.md
 */
const DOWNLOADS_PERIOD = "last-week";

/**
 * Maximum packages per bulk download query: 128, documented as "Bulk queries are
 * limited to at most 128 packages at a time and at most 365 days of data". Confirmed
 * live: a 129-name request answers 400 with {"error":"exceeded max bulk size of 128"}.
 * sourceRef: https://github.com/npm/registry/blob/main/docs/download-counts.md
 */
const DOWNLOADS_BULK_MAX_PACKAGES = 128;

/**
 * The two `time` keys that are not version numbers. Excluding them is not cosmetic:
 * "created" would otherwise enter the graph as a Version node named "created".
 * Confirmed live on registry.npmjs.org/chalk.
 */
const NON_VERSION_TIME_KEYS = new Set(["created", "modified", "unpublished"]);

/**
 * The three npm lifecycle hooks that run arbitrary code at install time. These are the
 * execution surface this project models, so their names are spelled from the npm
 * scripts documentation rather than from memory.
 * sourceRef: https://docs.npmjs.com/cli/v10/using-npm/scripts#life-cycle-scripts
 */
export const INSTALL_SCRIPT_NAMES = ["preinstall", "install", "postinstall"] as const;

export type InstallScriptName = (typeof INSTALL_SCRIPT_NAMES)[number];

// ---------------------------------------------------------------------------
// Wire schemas
// ---------------------------------------------------------------------------

/**
 * `time.unpublished`, present only when a package was unpublished in full.
 *
 * INFERRED, not confirmed: no live packument with this key could be found on
 * 2026-08-17 (probes on flatmap-stream, kik, left-pad, fs-promise all returned normal
 * documents), and the npm package-metadata doc does not describe the key. The schema is
 * therefore loose and every field optional, so an unexpected inner shape cannot fail the
 * whole packument. What the client relies on is only the key's presence.
 */
const UNPUBLISHED_RECORD_SCHEMA = z.looseObject({
  time: z.string().optional(),
  versions: z.array(z.string()).optional(),
});

/**
 * The `time` map. Confirmed live on registry.npmjs.org/chalk: keys are version strings
 * plus "created" and "modified". String values are publish timestamps; the one object
 * value is `unpublished`.
 */
const PACKUMENT_TIME_SCHEMA = z.record(
  z.string(),
  z.union([z.string(), UNPUBLISHED_RECORD_SCHEMA]),
);

/**
 * One entry of the top-level `maintainers` array. Confirmed live: chalk gives
 * {"name":"sindresorhus","email":"sindresorhus@gmail.com"} and flatmap-stream gives
 * {"email":"npm@npmjs.com","name":"npm"}, so key order varies and `email` is treated as
 * optional even though both samples carry it.
 */
const MAINTAINER_SCHEMA = z.looseObject({
  name: z.string(),
  email: z.string().optional(),
});

/**
 * One entry of the `versions` map.
 *
 * Confirmed live: chalk 5.3.0 has `scripts` and `devDependencies` but no `dependencies`
 * key at all (absent, not null), request 2.88.2 carries `deprecated` as a string, and
 * flatmap-stream 0.0.1-security has neither `scripts` nor any dependency map. `null` is
 * accepted alongside absence because a registry mirror may serialise it that way.
 */
const PACKUMENT_VERSION_SCHEMA = z.looseObject({
  version: z.string(),
  scripts: z.record(z.string(), z.string()).nullish(),
  dependencies: z.record(z.string(), z.string()).nullish(),
  devDependencies: z.record(z.string(), z.string()).nullish(),
  deprecated: z.string().nullish(),
});

/** Confirmed live on registry.npmjs.org/chalk and registry.npmjs.org/@babel%2Fcore. */
const PACKUMENT_SCHEMA = z.looseObject({
  name: z.string(),
  "dist-tags": z.record(z.string(), z.string()).nullish(),
  time: PACKUMENT_TIME_SCHEMA.nullish(),
  maintainers: z.array(MAINTAINER_SCHEMA).nullish(),
  versions: z.record(z.string(), PACKUMENT_VERSION_SCHEMA).nullish(),
});

/**
 * Single-package download point. Confirmed live:
 * {"downloads":422199668,"start":"2026-08-09","end":"2026-08-15","package":"chalk"}
 */
const DOWNLOAD_POINT_SCHEMA = z.looseObject({
  downloads: z.number(),
  start: z.string(),
  end: z.string(),
  package: z.string(),
});

/**
 * Bulk download point. Confirmed live: a name with no data comes back as a JSON null
 * inside a 200 response, so the value is nullable rather than the request failing.
 * Example: {"chalk":{...},"this-pkg-pz-9931-nope":null}
 */
const DOWNLOAD_BULK_SCHEMA = z.record(z.string(), DOWNLOAD_POINT_SCHEMA.nullable());

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type NpmMaintainer = {
  name: string;
  email: string | null;
};

export type NpmDependency = {
  name: string;
  /** The declared range, verbatim. Resolution is deps.dev's job, not this client's. */
  versionRange: string;
};

export type NpmVersionFacts = {
  version: string;
  /** Publish time from the top-level `time` map. null when the map has no entry. */
  publishedAtMs: number | null;
  hasInstallScript: boolean;
  /** Which of preinstall, install, postinstall were declared. Empty when none were. */
  installScriptNames: InstallScriptName[];
  dependencies: NpmDependency[];
  devDependencies: NpmDependency[];
  isDeprecated: boolean;
  deprecationReason: string | null;
};

/** A version the registry timestamped and then removed from `versions`. */
export type NpmUnpublishedVersion = {
  version: string;
  publishedAtMs: number | null;
};

export type NpmPackageFacts = {
  name: string;
  /** `dist-tags.latest`. null only if the registry omitted it, which no sample did. */
  latestVersion: string | null;
  /**
   * Current maintainers, from the top-level `maintainers` array.
   *
   * Current-only, by construction: the registry publishes no maintainer history, so
   * this is a weak proxy for who held publish rights when a given version shipped. The
   * project states the maintainer model as a lower bound for exactly this reason, and
   * an inference that needs "who could publish in 2019" cannot be answered from here.
   */
  maintainers: NpmMaintainer[];
  versions: NpmVersionFacts[];
  /**
   * Versions present in `time` but absent from `versions`.
   *
   * Reported rather than dropped because this is precisely what this project studies: a
   * malicious version that was published, timestamped, then pulled. Confirmed live on
   * flatmap-stream, the event-stream attack payload, whose `time` map holds 11.1.1
   * while `versions` holds only 0.0.1-security.
   */
  unpublishedVersions: NpmUnpublishedVersion[];
  /** True when `time.unpublished` is present, meaning the whole package was withdrawn. */
  isFullyUnpublished: boolean;
  fullyUnpublishedAtMs: number | null;
};

export type NpmDownloadPoint = {
  packageName: string;
  weeklyDownloads: number;
  /** Window bounds as the API reports them, YYYY-MM-DD inclusive on both ends. */
  windowStart: string;
  windowEnd: string;
};

// ---------------------------------------------------------------------------
// URL building
// ---------------------------------------------------------------------------

/**
 * Builds a packument URL.
 *
 * A scoped name needs its slash percent-encoded, so `@babel/core` becomes
 * `@babel%2Fcore`. Confirmed live: both the encoded and the bare form answer 200 on
 * registry.npmjs.org, but deps.dev answers 404 for the bare form, so this project
 * encodes everywhere and keeps one rule. The leading "@" is left as-is because that is
 * the form the registry docs use and it is a legal path character.
 */
export function buildPackumentUrl(packageName: string): string {
  return `${REGISTRY_BASE_URL}/${encodeNpmPackageName(packageName)}`;
}

/** Percent-encodes the parts of an npm name that are not legal in one path segment. */
export function encodeNpmPackageName(packageName: string): string {
  return packageName.replace(/\//g, "%2F");
}

/** Builds a single-package weekly download URL. */
export function buildDownloadPointUrl(packageName: string): string {
  return `${DOWNLOADS_BASE_URL}/downloads/point/${DOWNLOADS_PERIOD}/${encodeNpmPackageName(packageName)}`;
}

/** True for a scoped name, which the bulk download endpoint cannot accept. */
export function isScopedNpmName(packageName: string): boolean {
  return packageName.startsWith("@");
}

// ---------------------------------------------------------------------------
// Packument
// ---------------------------------------------------------------------------

/**
 * Fetches and flattens a packument into the facts the graph loader needs.
 *
 * Failure cases handled here rather than left to the caller:
 *   - the package does not exist: a 404 becomes a `not_found` Failure (the registry
 *     answers {"error":"Not found"}), never a throw
 *   - the package was unpublished in full: `time.unpublished` is present and `versions`
 *     is empty, reported through `isFullyUnpublished` with an empty version list
 *   - a version is in `time` but not in `versions`: reported in `unpublishedVersions`
 */
export async function fetchNpmPackageFacts(
  packageName: string,
  options: HttpClientOptions = {},
): Promise<Result<NpmPackageFacts, Failure>> {
  if (packageName.trim().length === 0) {
    return fail("invalid_input", "[fetchNpmPackageFacts] package name is empty");
  }

  const fetched = await fetchJson(
    { url: buildPackumentUrl(packageName), ...options },
    PACKUMENT_SCHEMA,
  );
  if (!fetched.ok) return fetched;

  return succeed(readPackumentFacts(fetched.value));
}

type Packument = z.infer<typeof PACKUMENT_SCHEMA>;

/**
 * Flattens a validated packument. Split out from the fetch so the shape logic is
 * testable against a fixture without a stub network.
 */
export function readPackumentFacts(packument: Packument): NpmPackageFacts {
  const timeMap = packument.time ?? {};
  const versionMap = packument.versions ?? {};

  const unpublishedRecord = readUnpublishedRecord(timeMap);
  const publishTimeByVersion = readPublishTimes(timeMap);

  const versions: NpmVersionFacts[] = [];
  for (const [version, versionRecord] of Object.entries(versionMap)) {
    versions.push(readVersionFacts(version, versionRecord, publishTimeByVersion));
  }

  const unpublishedVersions: NpmUnpublishedVersion[] = [];
  for (const [version, publishedAtMs] of publishTimeByVersion) {
    if (Object.hasOwn(versionMap, version)) continue;
    unpublishedVersions.push({ version, publishedAtMs });
  }

  return {
    name: packument.name,
    latestVersion: packument["dist-tags"]?.latest ?? null,
    maintainers: (packument.maintainers ?? []).map((maintainer) => ({
      name: maintainer.name,
      email: maintainer.email ?? null,
    })),
    versions,
    unpublishedVersions,
    isFullyUnpublished: unpublishedRecord !== null,
    fullyUnpublishedAtMs: parseTimestampMs(unpublishedRecord?.time),
  };
}

/**
 * Reads the per-version publish times out of `time`, dropping the keys that are not
 * versions. Anything whose value is not a string is skipped too, which is how the
 * `unpublished` object stays out of the version set even if npm adds another such key.
 */
function readPublishTimes(
  timeMap: Record<string, string | z.infer<typeof UNPUBLISHED_RECORD_SCHEMA>>,
): Map<string, number | null> {
  const publishTimeByVersion = new Map<string, number | null>();
  for (const [key, value] of Object.entries(timeMap)) {
    if (NON_VERSION_TIME_KEYS.has(key)) continue;
    if (typeof value !== "string") continue;
    publishTimeByVersion.set(key, parseTimestampMs(value));
  }
  return publishTimeByVersion;
}

function readUnpublishedRecord(
  timeMap: Record<string, string | z.infer<typeof UNPUBLISHED_RECORD_SCHEMA>>,
): z.infer<typeof UNPUBLISHED_RECORD_SCHEMA> | null {
  const candidate = timeMap.unpublished;
  if (candidate === undefined || typeof candidate === "string") return null;
  return candidate;
}

/**
 * Flattens one version entry.
 *
 * On install scripts: presence is strong evidence, absence is weak. The per-version
 * `scripts` field in a packument is whatever was in the published package.json at the
 * time and is not guaranteed complete (flatmap-stream 0.0.1-security carries no
 * `scripts` key at all), so `hasInstallScript: false` means "the packument does not say
 * so", not "this version runs no install hook".
 */
function readVersionFacts(
  version: string,
  versionRecord: z.infer<typeof PACKUMENT_VERSION_SCHEMA>,
  publishTimeByVersion: Map<string, number | null>,
): NpmVersionFacts {
  const scripts = versionRecord.scripts ?? {};
  const installScriptNames = INSTALL_SCRIPT_NAMES.filter(
    (scriptName) => typeof scripts[scriptName] === "string" && scripts[scriptName].length > 0,
  );

  const deprecationReason = versionRecord.deprecated ?? null;

  return {
    version,
    publishedAtMs: publishTimeByVersion.get(version) ?? null,
    hasInstallScript: installScriptNames.length > 0,
    installScriptNames: [...installScriptNames],
    dependencies: readDependencyList(versionRecord.dependencies),
    devDependencies: readDependencyList(versionRecord.devDependencies),
    isDeprecated: deprecationReason !== null,
    deprecationReason,
  };
}

function readDependencyList(
  declared: Record<string, string> | null | undefined,
): NpmDependency[] {
  if (declared === null || declared === undefined) return [];
  return Object.entries(declared).map(([name, versionRange]) => ({ name, versionRange }));
}

// ---------------------------------------------------------------------------
// Download counts
// ---------------------------------------------------------------------------

/**
 * Weekly downloads for one package.
 *
 * A package with no download data answers 404 with {"error":"package X not found"}, so
 * the caller gets a `not_found` Failure and decides whether that means "absent" (the
 * graph writes -1) or "abort".
 */
export async function fetchNpmWeeklyDownloads(
  packageName: string,
  options: HttpClientOptions = {},
): Promise<Result<NpmDownloadPoint, Failure>> {
  const fetched = await fetchJson(
    { url: buildDownloadPointUrl(packageName), ...options },
    DOWNLOAD_POINT_SCHEMA,
  );
  if (!fetched.ok) return fetched;

  return succeed({
    packageName: fetched.value.package,
    weeklyDownloads: fetched.value.downloads,
    windowStart: fetched.value.start,
    windowEnd: fetched.value.end,
  });
}

/**
 * Weekly downloads for many packages, in as few requests as the documented limits allow.
 *
 * Two documented constraints shape this, both confirmed live on 2026-08-17:
 *   - at most 128 packages per bulk query (129 answers 400 "exceeded max bulk size of 128")
 *   - scoped packages are rejected outright: a bulk query containing "@babel/core"
 *     answers 400 "scoped packages are not currently supported in bulk lookups"
 * So unscoped names are chunked into bulk requests and scoped names fall back to one
 * point request each. Hiding that split here keeps the quirk out of every caller.
 * sourceRef: https://github.com/npm/registry/blob/main/docs/download-counts.md
 *
 * A name the API has no data for is simply absent from the returned map rather than
 * failing the batch, because one obscure package must not abort an ingest.
 */
export async function fetchNpmWeeklyDownloadsBatch(
  packageNames: readonly string[],
  options: HttpClientOptions = {},
): Promise<Result<Map<string, number>, Failure>> {
  const downloadsByPackage = new Map<string, number>();
  const unscopedNames = packageNames.filter((name) => !isScopedNpmName(name));
  const scopedNames = packageNames.filter((name) => isScopedNpmName(name));

  for (const chunk of chunkNames(unscopedNames, DOWNLOADS_BULK_MAX_PACKAGES)) {
    if (chunk.length === 0) continue;

    // A single-name bulk URL returns the point shape, not the map shape, so a chunk of
    // one goes through the point endpoint instead.
    if (chunk.length === 1) {
      const single = await fetchNpmWeeklyDownloads(chunk[0], options);
      if (single.ok) downloadsByPackage.set(single.value.packageName, single.value.weeklyDownloads);
      else if (single.failure.reason !== "not_found") return single;
      continue;
    }

    const url = `${DOWNLOADS_BASE_URL}/downloads/point/${DOWNLOADS_PERIOD}/${chunk.join(",")}`;
    const fetched = await fetchJson({ url, ...options }, DOWNLOAD_BULK_SCHEMA);
    if (!fetched.ok) return fetched;

    for (const [name, point] of Object.entries(fetched.value)) {
      if (point === null) continue;
      downloadsByPackage.set(name, point.downloads);
    }
  }

  for (const scopedName of scopedNames) {
    const single = await fetchNpmWeeklyDownloads(scopedName, options);
    if (single.ok) downloadsByPackage.set(single.value.packageName, single.value.weeklyDownloads);
    else if (single.failure.reason !== "not_found") return single;
  }

  return succeed(downloadsByPackage);
}

function chunkNames(names: readonly string[], chunkSize: number): string[][] {
  const chunks: string[][] = [];
  for (let startIndex = 0; startIndex < names.length; startIndex += chunkSize) {
    chunks.push([...names.slice(startIndex, startIndex + chunkSize)]);
  }
  return chunks;
}
