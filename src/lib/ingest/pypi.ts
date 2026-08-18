import { z } from "zod";

import {
  type HttpClientOptions,
  fetchJson,
  parseTimestampMs,
} from "@/lib/ingest/fetch-json";
import { type Failure, type Result, fail, succeed } from "@/lib/result";

/**
 * PyPI JSON API read client.
 *
 * Every endpoint and field below was confirmed against a live response on 2026-08-17,
 * with the confirming call noted at each schema.
 *
 * Two things about PyPI shape the graph model:
 *   - a release can exist with no files at all (confirmed live: requests 0.0.1, 0.12.01
 *     and 2.15.0 all have empty arrays), so a version can have no upload time
 *   - upload time lives on the files, not on the release, so a version's publish moment
 *     is the earliest upload among its files
 */

const PYPI_BASE_URL = "https://pypi.org/pypi";

/**
 * PEP 503 name normalization, as a single expression: "The name should be lowercased
 * with all runs of the characters `.`, `-`, or `_` replaced with a single `-`
 * character." The reference implementation in the PEP is
 * `re.sub(r"[-_.]+", "-", name).lower()`, transcribed here.
 * sourceRef: https://peps.python.org/pep-0503/#normalized-names
 */
const PYPI_NAME_SEPARATOR_RUN = /[-_.]+/g;

// ---------------------------------------------------------------------------
// Wire schemas
// ---------------------------------------------------------------------------

/**
 * One distribution file. Confirmed live on pypi.org/pypi/requests/json:
 * upload_time is "2023-05-22T15:12:42" and upload_time_iso_8601 is
 * "2023-05-22T15:12:42.313790Z" for the same file, so both are UTC and only the second
 * carries the marker. That is why the second is preferred below.
 */
const PYPI_FILE_SCHEMA = z.looseObject({
  filename: z.string(),
  packagetype: z.string().nullish(),
  upload_time: z.string().nullish(),
  upload_time_iso_8601: z.string().nullish(),
  yanked: z.boolean().nullish(),
  yanked_reason: z.string().nullish(),
  size: z.number().nullish(),
});

/** Confirmed live: `info` carries the canonical display name and the newest version. */
const PYPI_INFO_SCHEMA = z.looseObject({
  name: z.string(),
  version: z.string(),
  yanked: z.boolean().nullish(),
  yanked_reason: z.string().nullish(),
});

/**
 * `ownership`, confirmed live on pypi.org/pypi/requests/json:
 * {"organization":null,"roles":[{"role":"Owner","user":"Lukasa"}, ...]}
 *
 * This corrects a common assumption: the JSON API does expose current owners and
 * maintainers, by username. What it does not expose is any history, an email, or who
 * held the right at the time a given release shipped. The project's maintainer model
 * stays scoped to npm because npm publishes per-version publish times alongside the
 * maintainer list, which is what the publish-rights proxy needs; PyPI ownership is
 * carried here as current-only metadata, not as a basis for the infection-surface model.
 */
const PYPI_OWNERSHIP_SCHEMA = z.looseObject({
  organization: z.string().nullish(),
  roles: z
    .array(z.looseObject({ role: z.string(), user: z.string() }))
    .nullish(),
});

/** GET /pypi/<name>/json. Confirmed live: keys are info, last_serial, ownership, releases, urls, vulnerabilities. */
const PYPI_PROJECT_SCHEMA = z.looseObject({
  info: PYPI_INFO_SCHEMA,
  ownership: PYPI_OWNERSHIP_SCHEMA.nullish(),
  releases: z.record(z.string(), z.array(PYPI_FILE_SCHEMA)),
});

/**
 * GET /pypi/<name>/<version>/json. Confirmed live: the same document minus `releases`,
 * with the requested version's files in `urls`.
 */
const PYPI_VERSION_SCHEMA = z.looseObject({
  info: PYPI_INFO_SCHEMA,
  ownership: PYPI_OWNERSHIP_SCHEMA.nullish(),
  urls: z.array(PYPI_FILE_SCHEMA),
});

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** A current PyPI owner or maintainer. Username only; PyPI publishes no email here. */
export type PypiOwner = {
  username: string;
  /** PyPI's role label, such as "Owner" or "Maintainer". */
  role: string;
};

export type PypiVersionFacts = {
  version: string;
  /** Earliest file upload for this version, epoch ms. null when the release has no files. */
  uploadedAtMs: number | null;
  isYanked: boolean;
  yankedReason: string | null;
  /** Number of distribution files. 0 means the release exists with nothing attached. */
  fileCount: number;
};

export type PypiPackageFacts = {
  /** The canonical display name from `info.name`, casing as the maintainer wrote it. */
  name: string;
  /** PEP 503 normalized name. This is what the graph keys on. */
  normalizedName: string;
  latestVersion: string;
  versions: PypiVersionFacts[];
  /**
   * Releases PyPI lists with an empty file array. Reported rather than dropped: the
   * version number was taken, which matters when reading a version timeline, but no
   * artifact exists so there is no upload time and nothing to install.
   */
  versionsWithoutFiles: string[];
  /** Current owners from `ownership.roles`. Current-only, see PYPI_OWNERSHIP_SCHEMA. */
  owners: PypiOwner[];
};

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/**
 * PEP 503 normalization: lowercase, and every run of `.`, `-` or `_` collapses to a
 * single `-`. So "Foo.Bar_baz" becomes "foo-bar-baz" and "a._-b" becomes "a-b".
 *
 * Needed for the graph key, not for the URL: confirmed live that PyPI itself resolves
 * "Zope.Interface", "zope-interface" and "typing_extensions" alike. Without this,
 * "typing_extensions" and "typing-extensions" would enter the graph as two packages.
 * sourceRef: https://peps.python.org/pep-0503/#normalized-names
 */
export function normalizePypiName(name: string): string {
  return name.replace(PYPI_NAME_SEPARATOR_RUN, "-").toLowerCase();
}

export function buildPypiProjectUrl(name: string): string {
  return `${PYPI_BASE_URL}/${encodeURIComponent(normalizePypiName(name))}/json`;
}

export function buildPypiVersionUrl(name: string, version: string): string {
  return `${PYPI_BASE_URL}/${encodeURIComponent(normalizePypiName(name))}/${encodeURIComponent(version)}/json`;
}

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

/**
 * Every release of one project, with upload times.
 *
 * A project that does not exist answers 404 with {"message": "Not Found"}, which arrives
 * as a `not_found` Failure rather than a throw.
 */
export async function fetchPypiPackageFacts(
  name: string,
  options: HttpClientOptions = {},
): Promise<Result<PypiPackageFacts, Failure>> {
  if (name.trim().length === 0) {
    return fail("invalid_input", "[fetchPypiPackageFacts] package name is empty");
  }

  const fetched = await fetchJson(
    { url: buildPypiProjectUrl(name), ...options },
    PYPI_PROJECT_SCHEMA,
  );
  if (!fetched.ok) return fetched;

  return succeed(readProjectFacts(fetched.value));
}

type PypiProject = z.infer<typeof PYPI_PROJECT_SCHEMA>;

/** Split from the fetch so the release flattening is testable against a fixture. */
export function readProjectFacts(project: PypiProject): PypiPackageFacts {
  const versions: PypiVersionFacts[] = [];
  const versionsWithoutFiles: string[] = [];

  for (const [version, files] of Object.entries(project.releases)) {
    if (files.length === 0) versionsWithoutFiles.push(version);
    versions.push(readVersionFacts(version, files));
  }

  return {
    name: project.info.name,
    normalizedName: normalizePypiName(project.info.name),
    latestVersion: project.info.version,
    versions,
    versionsWithoutFiles,
    owners: readOwners(project.ownership),
  };
}

/** One release, from the version-specific endpoint where the files arrive in `urls`. */
export async function fetchPypiVersionFacts(
  name: string,
  version: string,
  options: HttpClientOptions = {},
): Promise<Result<PypiVersionFacts, Failure>> {
  const fetched = await fetchJson(
    { url: buildPypiVersionUrl(name, version), ...options },
    PYPI_VERSION_SCHEMA,
  );
  if (!fetched.ok) return fetched;

  return succeed(readVersionFacts(fetched.value.info.version, fetched.value.urls));
}

// ---------------------------------------------------------------------------
// Wire to domain mapping
// ---------------------------------------------------------------------------

type PypiFile = z.infer<typeof PYPI_FILE_SCHEMA>;

/**
 * Flattens one release.
 *
 * The publish moment is the earliest upload across the release's files, because a wheel
 * and an sdist for the same version are uploaded seconds apart and the first one is when
 * the version became installable. A release is yanked only when every file is yanked:
 * one live file means the version is still installable.
 */
function readVersionFacts(version: string, files: readonly PypiFile[]): PypiVersionFacts {
  let earliestUploadMs: number | null = null;
  let yankedReason: string | null = null;

  for (const file of files) {
    const uploadedAtMs = readFileUploadMs(file);
    if (uploadedAtMs !== null && (earliestUploadMs === null || uploadedAtMs < earliestUploadMs)) {
      earliestUploadMs = uploadedAtMs;
    }
    if (yankedReason === null && typeof file.yanked_reason === "string") {
      yankedReason = file.yanked_reason;
    }
  }

  const isYanked = files.length > 0 && files.every((file) => file.yanked === true);

  return {
    version,
    uploadedAtMs: earliestUploadMs,
    isYanked,
    yankedReason: isYanked ? yankedReason : null,
    fileCount: files.length,
  };
}

/**
 * Reads a file's upload time. `upload_time_iso_8601` is preferred because it carries the
 * UTC marker. The bare `upload_time` is the same instant without the marker (confirmed
 * live on the same file: "2023-05-22T15:12:42" versus
 * "2023-05-22T15:12:42.313790Z"), so the fallback appends "Z" rather than letting the
 * runtime guess a local zone and shift the timestamp by hours.
 */
function readFileUploadMs(file: PypiFile): number | null {
  const isoWithZone = parseTimestampMs(file.upload_time_iso_8601);
  if (isoWithZone !== null) return isoWithZone;

  if (typeof file.upload_time === "string" && file.upload_time.length > 0) {
    return parseTimestampMs(`${file.upload_time}Z`);
  }
  return null;
}

function readOwners(
  ownership: z.infer<typeof PYPI_OWNERSHIP_SCHEMA> | null | undefined,
): PypiOwner[] {
  if (ownership === null || ownership === undefined) return [];
  return (ownership.roles ?? []).map((entry) => ({ username: entry.user, role: entry.role }));
}
