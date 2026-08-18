import { z } from "zod";

import type {
  AffectedPackage,
  AffectedRange,
  RangeEvent,
  RangeKind,
} from "@/lib/analysis/semver-facts";
import { type Ecosystem } from "@/lib/graph/model";
import {
  type HttpClientOptions,
  fetchJson,
  parseTimestampMs,
} from "@/lib/ingest/fetch-json";
import { type Failure, type Result, fail, succeed } from "@/lib/result";

/**
 * OSV.dev read client.
 *
 * This module returns OSV's facts and interprets none of them. Range resolution and
 * version membership already live in src/lib/analysis/semver-facts.ts, so the affected
 * shape produced here is literally that module's `AffectedPackage`, with no adapter in
 * between. If OSV changes shape, this file changes and semver-facts does not.
 *
 * Every endpoint, field name and enum value below was confirmed against a live response
 * on 2026-08-17, with the confirming call noted at each schema.
 * sourceRef: https://google.github.io/osv.dev/api/
 * sourceRef: https://ossf.github.io/osv-schema/
 */

const OSV_BASE_URL = "https://api.osv.dev/v1";

/**
 * Queries per querybatch request.
 *
 * OSV documents no cap on the number of queries in a batch. It documents when a batch
 * starts paginating: "An individual query within the queryset returns more than 1,000
 * vulnerabilities" or "The entire queryset returns more than 3,000 vulnerabilities
 * total". 100 queries per batch keeps a typical npm or PyPI batch under the 3,000 total
 * threshold (the busiest package sampled, django on PyPI, carries a few dozen
 * advisories), so most batches resolve in one round trip. Pagination is still handled,
 * because a chunk can exceed the threshold.
 * sourceRef: https://google.github.io/osv.dev/post-v1-querybatch/
 */
const BATCH_MAX_QUERIES = 100;

/**
 * Page ceiling per query, a guard against a page token that never terminates. Confirmed
 * live that pagination is real: a Linux Kernel query returned 2,339 vulnerabilities and
 * a next_page_token, and the follow-up returned 2,079 more.
 */
const MAX_PAGES_PER_QUERY = 64;

/**
 * OSV ecosystem names for this project's two ecosystems. Case matters: "npm" is
 * lowercase and "PyPI" is not. Confirmed live, both accepted by /v1/query and
 * /v1/querybatch and both echoed back in affected[].package.ecosystem.
 * sourceRef: https://ossf.github.io/osv-schema/#affectedpackage-field
 */
const OSV_ECOSYSTEM_BY_ECOSYSTEM: Record<Ecosystem, string> = {
  npm: "npm",
  pypi: "PyPI",
};

/**
 * OSV range type to the project's RangeKind. The three type values are the whole enum:
 * "SEMVER", "ECOSYSTEM", "GIT" per the schema, matching the swagger enum
 * ["UNSPECIFIED","GIT","SEMVER","ECOSYSTEM"].
 * sourceRef: https://ossf.github.io/osv-schema/#affectedranges-field
 */
const RANGE_KIND_BY_OSV_TYPE: Record<string, RangeKind> = {
  SEMVER: "semver",
  ECOSYSTEM: "ecosystem",
  GIT: "git",
};

/** Prefix of a GitHub Security Advisory id, which is the project's advisory key. */
const GHSA_ID_PREFIX = "GHSA-";

// ---------------------------------------------------------------------------
// Wire schemas
// ---------------------------------------------------------------------------

/**
 * One range event. Exactly one key is set per object, per the schema: "Only a single
 * type (either introduced, fixed, last_affected, limit) is allowed in each event
 * object". Confirmed live that the wire is snake_case (`last_affected`); `lastAffected`
 * is also accepted because that is the name in OSV's own swagger definition, so a
 * protobuf-JSON gateway could emit it.
 * sourceRef: https://osv.dev/docs/osv_service_v1.swagger.json
 */
const OSV_EVENT_SCHEMA = z.looseObject({
  introduced: z.string().optional(),
  fixed: z.string().optional(),
  last_affected: z.string().optional(),
  lastAffected: z.string().optional(),
  limit: z.string().optional(),
});

/**
 * One version range. `repo` is required by the schema when type is GIT. Confirmed live
 * on PYSEC-2015-17, which carries both a GIT range (with `repo`) and an ECOSYSTEM range.
 */
const OSV_RANGE_SCHEMA = z.looseObject({
  type: z.string(),
  repo: z.string().optional(),
  events: z.array(OSV_EVENT_SCHEMA),
});

/**
 * One affected package entry. Confirmed live on GHSA-29mw-wpgm-hmr9 (npm/lodash) and
 * PYSEC-2015-17 (PyPI/requests): `package` carries name, ecosystem and purl, `ranges`
 * is optional, and `versions` is an explicit list some advisories give as well as or
 * instead of a range.
 */
const OSV_AFFECTED_SCHEMA = z.looseObject({
  package: z
    .looseObject({
      name: z.string(),
      ecosystem: z.string(),
      purl: z.string().optional(),
    })
    .optional(),
  ranges: z.array(OSV_RANGE_SCHEMA).nullish(),
  versions: z.array(z.string()).nullish(),
});

/**
 * Severity entry. Confirmed live: {"type":"CVSS_V3","score":"CVSS:3.1/AV:N/..."} and
 * CVSS_V4 both appear. `type` stays a string rather than an enum because the schema
 * table is explicitly extensible ("Your quantitative severity type here") and adding
 * Ubuntu-style values must not fail an ingest.
 */
const OSV_SEVERITY_SCHEMA = z.looseObject({
  type: z.string(),
  score: z.string(),
});

/**
 * A full vulnerability record. Confirmed live on GET /v1/vulns/GHSA-29mw-wpgm-hmr9 and
 * inside POST /v1/query responses. `summary` and `severity` are genuinely absent on some
 * records (PYSEC-2015-17 has neither), which is why both are optional.
 */
const OSV_VULNERABILITY_SCHEMA = z.looseObject({
  id: z.string(),
  aliases: z.array(z.string()).nullish(),
  published: z.string().nullish(),
  modified: z.string().nullish(),
  summary: z.string().nullish(),
  severity: z.array(OSV_SEVERITY_SCHEMA).nullish(),
  affected: z.array(OSV_AFFECTED_SCHEMA).nullish(),
});

/**
 * POST /v1/query response. Confirmed live that pagination uses snake_case
 * `next_page_token`: a Linux Kernel query returned it alongside 2,339 vulns.
 */
const OSV_QUERY_RESPONSE_SCHEMA = z.looseObject({
  vulns: z.array(OSV_VULNERABILITY_SCHEMA).nullish(),
  next_page_token: z.string().nullish(),
});

/**
 * POST /v1/querybatch response. Confirmed live: each result holds only `id` and
 * `modified` per vulnerability, so a full record needs a follow-up GET /v1/vulns/<id>.
 * The page token is per-result, not per-batch.
 */
const OSV_BATCH_RESPONSE_SCHEMA = z.looseObject({
  results: z.array(
    z.looseObject({
      vulns: z
        .array(z.looseObject({ id: z.string(), modified: z.string().nullish() }))
        .nullish(),
      next_page_token: z.string().nullish(),
    }),
  ),
});

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type OsvSeverity = {
  type: string;
  score: string;
};

/** Why a range cannot be answered from a version string. */
export type UnusableRangeReason =
  /** A GIT range compares commit hashes, which no version string can be placed in. */
  | "git_commit_range"
  /**
   * A `limit` event, which the project's RangeEvent type cannot express. Recorded rather
   * than dropped, because a dropped bound understates exposure.
   */
  | "limit_event";

export type UnusableRange = {
  kind: RangeKind;
  reason: UnusableRangeReason;
  /** Short human-readable context, such as the repo URL or the limit value. */
  detail: string;
};

/**
 * What an advisory says about one package.
 *
 * `affected` is exactly `AffectedPackage` from src/lib/analysis/semver-facts.ts, so the
 * analysis layer consumes it with no adapter. `unusableRanges` is the honesty channel
 * beside it: a caller that sees a non-empty list knows the affected set is a lower
 * bound, and can report the version as undecided instead of safe.
 */
export type OsvAffectedFacts = {
  affected: AffectedPackage;
  unusableRanges: UnusableRange[];
};

export type OsvVulnerability = {
  id: string;
  aliases: string[];
  /**
   * The GHSA id, from `id` when the record is a GHSA and from `aliases` otherwise. The
   * graph keys advisories by GHSA id, so a PYSEC or CVE primary id needs this lookup.
   */
  ghsaId: string | null;
  /** Disclosure time. This is the project's known-time clock. */
  publishedAtMs: number | null;
  modifiedAtMs: number | null;
  summary: string | null;
  severities: OsvSeverity[];
  affected: OsvAffectedFacts[];
  /**
   * Affected entries that carried no `package` object, so no ecosystem or name could be
   * read. Counted rather than ignored so a caller can see the record is partial.
   */
  skippedAffectedCount: number;
};

export type OsvPackageQuery = {
  ecosystem: Ecosystem;
  packageName: string;
  /** Omit to ask for every advisory touching the package, any version. */
  version?: string;
};

/** One querybatch result: ids only, by design of the endpoint. */
export type OsvBatchResult = {
  query: OsvPackageQuery;
  vulnerabilityIds: string[];
};

// ---------------------------------------------------------------------------
// Ecosystem naming
// ---------------------------------------------------------------------------

export function toOsvEcosystem(ecosystem: Ecosystem): string {
  return OSV_ECOSYSTEM_BY_ECOSYSTEM[ecosystem];
}

/**
 * OSV ecosystem name back to an ecosystem.
 *
 * The suffix is stripped first: OSV qualifies some ecosystems with a release, as in
 * "Debian:11" or "AlmaLinux:8", and the schema says the part before the colon is the
 * ecosystem. Neither npm nor PyPI uses a suffix today, but stripping costs one split and
 * removes a whole class of future mismatch.
 * sourceRef: https://ossf.github.io/osv-schema/#affectedpackage-field
 */
export function fromOsvEcosystem(ecosystemName: string): Result<Ecosystem, Failure> {
  const baseName = ecosystemName.split(":")[0];
  for (const [ecosystem, osvName] of Object.entries(OSV_ECOSYSTEM_BY_ECOSYSTEM)) {
    if (osvName === baseName) return succeed(ecosystem as Ecosystem);
  }
  return fail(
    "unsupported",
    `[fromOsvEcosystem] OSV ecosystem "${ecosystemName}" is not an ecosystem this project models`,
  );
}

/**
 * Finds the GHSA id for a record. GitHub advisories carry it as the primary `id`; PYSEC
 * and CVE records carry it in `aliases`, which is the only place it exists for them.
 */
export function extractGhsaId(id: string, aliases: readonly string[]): string | null {
  if (id.startsWith(GHSA_ID_PREFIX)) return id;
  return aliases.find((alias) => alias.startsWith(GHSA_ID_PREFIX)) ?? null;
}

// ---------------------------------------------------------------------------
// Wire to domain mapping
// ---------------------------------------------------------------------------

type OsvRange = z.infer<typeof OSV_RANGE_SCHEMA>;
type OsvAffected = z.infer<typeof OSV_AFFECTED_SCHEMA>;
type OsvVulnerabilityRecord = z.infer<typeof OSV_VULNERABILITY_SCHEMA>;
type OsvQueryResponse = z.infer<typeof OSV_QUERY_RESPONSE_SCHEMA>;

/**
 * Maps one range's event list.
 *
 * `limit` events are pulled out rather than mapped, because the project's RangeEvent
 * union has three members (introduced, fixed, last_affected) and no fourth. This is a
 * deliberate lower-bound choice: OSV says an absent limit means an implicit
 * `{"limit": "*"}`, and says limits "should not be used" for numbered versions, so
 * ignoring the bound can only widen the affected set, never shrink it. The event is
 * still reported as unusable so the caller knows the range is not fully modelled.
 * sourceRef: https://ossf.github.io/osv-schema/#affectedranges-field
 */
function readRangeEvents(range: OsvRange): { events: RangeEvent[]; limitValues: string[] } {
  const events: RangeEvent[] = [];
  const limitValues: string[] = [];

  for (const event of range.events) {
    if (event.introduced !== undefined) {
      events.push({ type: "introduced", version: event.introduced });
      continue;
    }
    if (event.fixed !== undefined) {
      events.push({ type: "fixed", version: event.fixed });
      continue;
    }
    const lastAffected = event.last_affected ?? event.lastAffected;
    if (lastAffected !== undefined) {
      events.push({ type: "last_affected", version: lastAffected });
      continue;
    }
    if (event.limit !== undefined) limitValues.push(event.limit);
  }

  return { events, limitValues };
}

/**
 * Maps one `affected` entry onto the analysis layer's `AffectedPackage`.
 *
 * A GIT range is kept in `ranges` with kind "git" rather than dropped: semver-facts
 * already skips git kinds when testing membership, so keeping it loses nothing, and
 * dropping it would erase the fact that the advisory has a bound this project cannot
 * evaluate. It is listed in `unusableRanges` at the same time, which is what turns a
 * silent understatement into a reported one.
 *
 * Returns null when the entry carries no `package` object, which the caller counts.
 */
export function readAffectedFacts(affected: OsvAffected): OsvAffectedFacts | null {
  const affectedPackage = affected.package;
  if (affectedPackage === undefined) return null;

  const ranges: AffectedRange[] = [];
  const unusableRanges: UnusableRange[] = [];

  for (const range of affected.ranges ?? []) {
    const kind = RANGE_KIND_BY_OSV_TYPE[range.type];
    if (kind === undefined) {
      unusableRanges.push({
        kind: "ecosystem",
        reason: "limit_event",
        detail: `unknown OSV range type "${range.type}"`,
      });
      continue;
    }

    const { events, limitValues } = readRangeEvents(range);
    ranges.push({ kind, events });

    if (kind === "git") {
      unusableRanges.push({
        kind,
        reason: "git_commit_range",
        detail: range.repo ?? "no repo reported",
      });
    }
    for (const limitValue of limitValues) {
      unusableRanges.push({ kind, reason: "limit_event", detail: limitValue });
    }
  }

  return {
    affected: {
      ecosystemName: affectedPackage.ecosystem,
      packageName: affectedPackage.name,
      ranges,
      explicitVersions: [...(affected.versions ?? [])],
    },
    unusableRanges,
  };
}

/**
 * Maps a full OSV record.
 *
 * Affected entries for other ecosystems are kept, not filtered: one advisory can list an
 * npm package and a RubyGems package (confirmed live, a lodash query returns records
 * whose affected array spans both), and dropping the other entries here would hide a
 * cross-ecosystem advisory from a caller that wants it. The caller filters on
 * `affected[].affected.ecosystemName`.
 */
export function readVulnerability(record: OsvVulnerabilityRecord): OsvVulnerability {
  const aliases = record.aliases ?? [];
  const affectedFacts: OsvAffectedFacts[] = [];
  let skippedAffectedCount = 0;

  for (const affected of record.affected ?? []) {
    const facts = readAffectedFacts(affected);
    if (facts === null) {
      skippedAffectedCount += 1;
      continue;
    }
    affectedFacts.push(facts);
  }

  return {
    id: record.id,
    aliases: [...aliases],
    ghsaId: extractGhsaId(record.id, aliases),
    publishedAtMs: parseTimestampMs(record.published),
    modifiedAtMs: parseTimestampMs(record.modified),
    summary: record.summary ?? null,
    severities: (record.severity ?? []).map((severity) => ({
      type: severity.type,
      score: severity.score,
    })),
    affected: affectedFacts,
    skippedAffectedCount,
  };
}

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

/**
 * Every advisory touching one package, or one exact version when `version` is set.
 *
 * Follows `next_page_token` until the server stops sending one. Confirmed live that this
 * is necessary and not theoretical.
 */
export async function queryOsvByPackage(
  query: OsvPackageQuery,
  options: HttpClientOptions = {},
): Promise<Result<OsvVulnerability[], Failure>> {
  const vulnerabilities: OsvVulnerability[] = [];
  let pageToken: string | null = null;

  for (let pageIndex = 0; pageIndex < MAX_PAGES_PER_QUERY; pageIndex += 1) {
    // Annotated rather than inferred, and this is load bearing: `pageToken` is read here
    // and reassigned from `fetched.value` below, so the loop's back edge makes each type
    // depend on the other and the checker gives up (TS7022). Naming the response type
    // breaks the cycle without widening anything.
    const fetched: Result<OsvQueryResponse, Failure> = await fetchJson(
      {
        url: `${OSV_BASE_URL}/query`,
        method: "POST",
        body: buildQueryBody(query, pageToken),
        ...options,
      },
      OSV_QUERY_RESPONSE_SCHEMA,
    );
    if (!fetched.ok) return fetched;

    for (const record of fetched.value.vulns ?? []) {
      vulnerabilities.push(readVulnerability(record));
    }

    pageToken = fetched.value.next_page_token ?? null;
    if (pageToken === null) return succeed(vulnerabilities);
  }

  return fail(
    "upstream_rejected",
    `[queryOsvByPackage] OSV kept paging past ${MAX_PAGES_PER_QUERY} pages for ${query.ecosystem}:${query.packageName}`,
    { context: { pageCap: MAX_PAGES_PER_QUERY, collected: vulnerabilities.length } },
  );
}

/**
 * Batch lookup. Returns ids only, which is what the endpoint returns: "the response
 * returns vulnerability ids and modified field". Use `fetchOsvVulnerability` for the
 * full record of an id that matters.
 *
 * Queries are chunked at BATCH_MAX_QUERIES and each chunk's per-result page tokens are
 * followed, so the caller can hand this a few thousand package versions in one call.
 */
export async function queryOsvBatch(
  queries: readonly OsvPackageQuery[],
  options: HttpClientOptions = {},
): Promise<Result<OsvBatchResult[], Failure>> {
  const results: OsvBatchResult[] = queries.map((query) => ({
    query,
    vulnerabilityIds: [],
  }));

  for (let chunkStart = 0; chunkStart < queries.length; chunkStart += BATCH_MAX_QUERIES) {
    const chunkEnd = Math.min(chunkStart + BATCH_MAX_QUERIES, queries.length);
    // Index into `results`, so a page token maps back to the right query after chunking.
    let pendingIndices = rangeOfIndices(chunkStart, chunkEnd);
    let pageTokenByIndex = new Map<number, string | null>(
      pendingIndices.map((resultIndex) => [resultIndex, null]),
    );

    for (let pageIndex = 0; pageIndex < MAX_PAGES_PER_QUERY; pageIndex += 1) {
      const fetched = await fetchJson(
        {
          url: `${OSV_BASE_URL}/querybatch`,
          method: "POST",
          body: {
            queries: pendingIndices.map((resultIndex) =>
              buildQueryBody(queries[resultIndex], pageTokenByIndex.get(resultIndex) ?? null),
            ),
          },
          ...options,
        },
        OSV_BATCH_RESPONSE_SCHEMA,
      );
      if (!fetched.ok) return fetched;

      if (fetched.value.results.length !== pendingIndices.length) {
        return fail(
          "upstream_rejected",
          `[queryOsvBatch] OSV returned ${fetched.value.results.length} results for ${pendingIndices.length} queries, so positional alignment is broken`,
        );
      }

      const nextPending: number[] = [];
      const nextTokens = new Map<number, string | null>();

      for (let position = 0; position < fetched.value.results.length; position += 1) {
        const resultIndex = pendingIndices[position];
        const batchResult = fetched.value.results[position];
        for (const vulnerability of batchResult.vulns ?? []) {
          results[resultIndex].vulnerabilityIds.push(vulnerability.id);
        }
        const nextToken = batchResult.next_page_token ?? null;
        if (nextToken !== null) {
          nextPending.push(resultIndex);
          nextTokens.set(resultIndex, nextToken);
        }
      }

      if (nextPending.length === 0) break;

      if (pageIndex === MAX_PAGES_PER_QUERY - 1) {
        return fail(
          "upstream_rejected",
          `[queryOsvBatch] OSV kept paging past ${MAX_PAGES_PER_QUERY} pages for ${nextPending.length} queries`,
          { context: { pageCap: MAX_PAGES_PER_QUERY } },
        );
      }

      pendingIndices = nextPending;
      pageTokenByIndex = nextTokens;
    }
  }

  return succeed(results);
}

/**
 * The full record for one id. This is the follow-up querybatch requires, since the batch
 * endpoint returns nothing but ids and modification times.
 * A missing id answers 404 with {"code":5,"message":"Vulnerability not found"}, which
 * arrives here as a `not_found` Failure.
 */
export async function fetchOsvVulnerability(
  vulnerabilityId: string,
  options: HttpClientOptions = {},
): Promise<Result<OsvVulnerability, Failure>> {
  if (vulnerabilityId.trim().length === 0) {
    return fail("invalid_input", "[fetchOsvVulnerability] vulnerability id is empty");
  }

  const fetched = await fetchJson(
    { url: `${OSV_BASE_URL}/vulns/${encodeURIComponent(vulnerabilityId)}`, ...options },
    OSV_VULNERABILITY_SCHEMA,
  );
  if (!fetched.ok) return fetched;

  return succeed(readVulnerability(fetched.value));
}

/**
 * The request body for /v1/query and for one entry of /v1/querybatch. Both take the same
 * fields. `page_token` is snake_case on the wire, confirmed live by advancing a paged
 * Linux Kernel query with it.
 */
function buildQueryBody(
  query: OsvPackageQuery,
  pageToken: string | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    package: { ecosystem: toOsvEcosystem(query.ecosystem), name: query.packageName },
  };
  if (query.version !== undefined) body.version = query.version;
  if (pageToken !== null) body.page_token = pageToken;
  return body;
}

function rangeOfIndices(startIndex: number, endIndex: number): number[] {
  const indices: number[] = [];
  for (let index = startIndex; index < endIndex; index += 1) indices.push(index);
  return indices;
}
