import { describe, expect, test } from "bun:test";

import { z } from "zod";

import type { AffectedPackage } from "@/lib/analysis/semver-facts";
import { isVersionAffected } from "@/lib/analysis/semver-facts";
import { ECOSYSTEMS } from "@/lib/graph/model";
import {
  fetchDepsDevDependencyGraph,
  fromDepsDevSystem,
  toDepsDevSystem,
} from "@/lib/ingest/deps-dev";
import {
  type FetchLike,
  createConcurrencyLimiter,
  fetchJson,
  parseRetryAfterMs,
} from "@/lib/ingest/fetch-json";
import { buildPackumentUrl, fetchNpmPackageFacts } from "@/lib/ingest/npm-registry";
import { fetchOsvVulnerability, queryOsvByPackage } from "@/lib/ingest/osv";
import { fetchPypiVersionFacts, normalizePypiName } from "@/lib/ingest/pypi";

/**
 * Ingest client tests.
 *
 * No test here touches the network: every client takes a `fetchImpl`, and these pass a
 * stub. That is not only for speed. These clients exist to survive four public APIs this
 * project does not control, so the interesting cases are a 429, a truncated body and a
 * renamed field, none of which a live call produces on demand.
 *
 * Every fixture below is trimmed from a real response captured on 2026-08-17, with the
 * source call named above it. Invented shapes would test the schema against itself.
 */

// ---------------------------------------------------------------------------
// Stub transport
// ---------------------------------------------------------------------------

type StubResponse = {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
};

type FetchStub = {
  fetchImpl: FetchLike;
  readCallCount: () => number;
  readRequestedUrls: () => string[];
};

/**
 * Serves the scripted responses in order, then repeats the last one, so "every attempt
 * fails" is a one-entry script.
 */
function createFetchStub(scripted: readonly StubResponse[]): FetchStub {
  const requestedUrls: string[] = [];

  const fetchImpl: FetchLike = (input) => {
    const scriptIndex = Math.min(requestedUrls.length, scripted.length - 1);
    requestedUrls.push(input);
    const scriptedResponse = scripted[scriptIndex];
    return Promise.resolve(
      new Response(scriptedResponse.body ?? "{}", {
        status: scriptedResponse.status ?? 200,
        headers: scriptedResponse.headers,
      }),
    );
  };

  return {
    fetchImpl,
    readCallCount: () => requestedUrls.length,
    readRequestedUrls: () => [...requestedUrls],
  };
}

/** Collects the delays the retry loop asks for instead of waiting them out. */
function createSleepRecorder(): { sleepImpl: (durationMs: number) => Promise<void>; readDelays: () => number[] } {
  const delays: number[] = [];
  return {
    sleepImpl: (durationMs) => {
      delays.push(durationMs);
      return Promise.resolve();
    },
    readDelays: () => [...delays],
  };
}

const ANY_OBJECT_SCHEMA = z.looseObject({});
const PROBE_URL = "https://registry.npmjs.org/chalk";

// ---------------------------------------------------------------------------
// Transport: retry policy
// ---------------------------------------------------------------------------

describe("fetchJson retry policy", () => {
  test("retries a 500 and succeeds on the next attempt", async () => {
    const stub = createFetchStub([
      { status: 500, body: "upstream boom" },
      { status: 200, body: '{"name":"chalk"}' },
    ]);
    const sleeper = createSleepRecorder();

    const fetched = await fetchJson(
      { url: PROBE_URL, fetchImpl: stub.fetchImpl, sleepImpl: sleeper.sleepImpl },
      ANY_OBJECT_SCHEMA,
    );

    expect(fetched.ok).toBe(true);
    expect(stub.readCallCount()).toBe(2);
    expect(sleeper.readDelays()).toHaveLength(1);
  });

  test("does not retry a 404 and reports only host and status", async () => {
    const stub = createFetchStub([{ status: 404, body: '{"error":"Not found"}' }]);

    const fetched = await fetchJson(
      { url: `${PROBE_URL}?write=token-shaped-value`, fetchImpl: stub.fetchImpl, maxAttempts: 4 },
      ANY_OBJECT_SCHEMA,
    );

    if (fetched.ok) return expect.unreachable("a 404 must not succeed");
    expect(fetched.failure.reason).toBe("not_found");
    // Retrying a permanent answer only makes an ingest of thousands of names slower.
    expect(stub.readCallCount()).toBe(1);
    expect(fetched.failure.message).toContain("registry.npmjs.org");
    expect(fetched.failure.message).toContain("404");
    // The query string is where a credential would land if any of these APIs grew one.
    expect(fetched.failure.message).not.toContain("token-shaped-value");
  });

  test("waits the Retry-After delay before retrying a 429", async () => {
    const stub = createFetchStub([
      { status: 429, body: "slow down", headers: { "retry-after": "1" } },
      { status: 200, body: "{}" },
    ]);
    const sleeper = createSleepRecorder();

    const fetched = await fetchJson(
      { url: PROBE_URL, fetchImpl: stub.fetchImpl, sleepImpl: sleeper.sleepImpl },
      ANY_OBJECT_SCHEMA,
    );

    expect(fetched.ok).toBe(true);
    expect(stub.readCallCount()).toBe(2);
    // The server's number wins over the backoff schedule, exactly once.
    expect(sleeper.readDelays()).toEqual([1_000]);
  });

  test("caps total attempts", async () => {
    const stub = createFetchStub([{ status: 503, body: "unavailable" }]);
    const sleeper = createSleepRecorder();

    const fetched = await fetchJson(
      { url: PROBE_URL, fetchImpl: stub.fetchImpl, sleepImpl: sleeper.sleepImpl, maxAttempts: 3 },
      ANY_OBJECT_SCHEMA,
    );

    if (fetched.ok) return expect.unreachable("a permanent 503 must not succeed");
    expect(fetched.failure.reason).toBe("upstream_unavailable");
    expect(stub.readCallCount()).toBe(3);
    expect(sleeper.readDelays()).toHaveLength(2);
  });

  test("honours Retry-After in both documented forms", () => {
    const nowMs = Date.parse("2026-08-17T12:00:00Z");

    expect(parseRetryAfterMs("30", nowMs)).toBe(30_000);
    // RFC 9110 also allows an HTTP-date, which CDNs in front of these APIs do send.
    expect(parseRetryAfterMs("Mon, 17 Aug 2026 12:00:20 GMT", nowMs)).toBe(20_000);
    expect(parseRetryAfterMs("Mon, 17 Aug 2026 11:59:00 GMT", nowMs)).toBe(0);
    expect(parseRetryAfterMs(null, nowMs)).toBeNull();
    expect(parseRetryAfterMs("not-a-delay", nowMs)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Transport: body validation and size
// ---------------------------------------------------------------------------

describe("fetchJson body handling", () => {
  test("reports a malformed body as a Failure naming the field path", async () => {
    const stub = createFetchStub([{ body: '{"info":{"version":42}}' }]);

    const fetched = await fetchJson(
      { url: "https://pypi.org/pypi/requests/json", fetchImpl: stub.fetchImpl },
      z.object({ info: z.object({ version: z.string() }) }),
    );

    if (fetched.ok) return expect.unreachable("a wrongly typed field must not validate");
    expect(fetched.failure.reason).toBe("upstream_rejected");
    // The path is the actionable part: it names which upstream field moved.
    expect(fetched.failure.message).toContain("info.version");
  });

  test("reports a body that is not JSON rather than throwing", async () => {
    const stub = createFetchStub([{ body: "<html>maintenance</html>" }]);

    const fetched = await fetchJson(
      { url: PROBE_URL, fetchImpl: stub.fetchImpl },
      ANY_OBJECT_SCHEMA,
    );

    if (fetched.ok) return expect.unreachable("an HTML error page must not validate");
    expect(fetched.failure.reason).toBe("upstream_rejected");
  });

  test("refuses a body over the size cap, declared or streamed", async () => {
    const oversizedBody = JSON.stringify({ padding: "x".repeat(64) });

    const streamed = await fetchJson(
      {
        url: PROBE_URL,
        fetchImpl: createFetchStub([{ body: oversizedBody }]).fetchImpl,
        maxResponseBytes: 16,
      },
      ANY_OBJECT_SCHEMA,
    );
    if (streamed.ok) return expect.unreachable("an oversized stream must not be buffered");
    expect(streamed.failure.reason).toBe("invalid_input");

    // The cheap path: a Content-Length claim is refused before a byte is read.
    const declared = await fetchJson(
      {
        url: PROBE_URL,
        fetchImpl: createFetchStub([
          { body: oversizedBody, headers: { "content-length": String(oversizedBody.length) } },
        ]).fetchImpl,
        maxResponseBytes: 16,
      },
      ANY_OBJECT_SCHEMA,
    );
    if (declared.ok) return expect.unreachable("an oversized Content-Length must not be fetched");
    expect(declared.failure.message).toContain("byte cap");
  });
});

// ---------------------------------------------------------------------------
// npm registry
// ---------------------------------------------------------------------------

/**
 * flatmap-stream, trimmed from registry.npmjs.org/flatmap-stream. The event-stream attack
 * payload: `time` holds 11.1.1, the malicious release, while `versions` holds only the
 * security placeholder that replaced it. This is the shape the project exists to read.
 */
const FLATMAP_STREAM_PACKUMENT = JSON.stringify({
  name: "flatmap-stream",
  "dist-tags": { latest: "0.0.1-security" },
  time: {
    "11.1.1": "2018-11-28T22:09:45.947Z",
    created: "2018-11-29T16:56:02.864Z",
    "0.0.1-security": "2018-11-29T16:56:02.951Z",
    modified: "2022-05-02T14:26:06.405Z",
  },
  maintainers: [{ email: "npm@npmjs.com", name: "npm" }],
  versions: { "0.0.1-security": { version: "0.0.1-security" } },
});

/**
 * esbuild 0.21.5 and chalk 5.3.0, trimmed from their packuments: one declares a
 * postinstall hook, the other declares only test scripts.
 */
const INSTALL_SCRIPT_PACKUMENT = JSON.stringify({
  name: "install-script-sample",
  "dist-tags": { latest: "0.21.5" },
  time: {
    created: "2020-01-01T00:00:00.000Z",
    "0.21.5": "2024-06-10T04:32:31.383Z",
    "5.3.0": "2023-06-29T10:58:11.887Z",
  },
  versions: {
    "0.21.5": { version: "0.21.5", scripts: { postinstall: "node install.js" } },
    "5.3.0": { version: "5.3.0", scripts: { test: "xo && c8 ava && tsd", bench: "matcha benchmark.js" } },
  },
});

describe("npm registry client", () => {
  test("keeps the created and modified time keys out of the version set", async () => {
    const stub = createFetchStub([{ body: FLATMAP_STREAM_PACKUMENT }]);

    const facts = await fetchNpmPackageFacts("flatmap-stream", { fetchImpl: stub.fetchImpl });
    if (!facts.ok) return expect.unreachable(facts.failure.message);

    const reportedNames = [
      ...facts.value.versions.map((entry) => entry.version),
      ...facts.value.unpublishedVersions.map((entry) => entry.version),
    ];
    // Without the exclusion, "created" would enter the graph as a Version node.
    expect(reportedNames).not.toContain("created");
    expect(reportedNames).not.toContain("modified");
    expect(facts.value.isFullyUnpublished).toBe(false);
  });

  test("reports a version present in time but absent from versions", async () => {
    const stub = createFetchStub([{ body: FLATMAP_STREAM_PACKUMENT }]);

    const facts = await fetchNpmPackageFacts("flatmap-stream", { fetchImpl: stub.fetchImpl });
    if (!facts.ok) return expect.unreachable(facts.failure.message);

    // Dropping it would erase the malicious release from the timeline entirely.
    expect(facts.value.unpublishedVersions).toEqual([
      { version: "11.1.1", publishedAtMs: Date.parse("2018-11-28T22:09:45.947Z") },
    ]);
    expect(facts.value.versions.map((entry) => entry.version)).toEqual(["0.0.1-security"]);
  });

  test("encodes a scoped name in the packument path", async () => {
    const stub = createFetchStub([{ body: '{"name":"@babel/core"}' }]);

    const fetched = await fetchNpmPackageFacts("@babel/core", { fetchImpl: stub.fetchImpl });

    expect(fetched.ok).toBe(true);
    expect(buildPackumentUrl("@babel/core")).toBe("https://registry.npmjs.org/@babel%2Fcore");
    expect(stub.readRequestedUrls()).toEqual(["https://registry.npmjs.org/@babel%2Fcore"]);
  });

  test("reads install hooks per version", async () => {
    const stub = createFetchStub([{ body: INSTALL_SCRIPT_PACKUMENT }]);

    const facts = await fetchNpmPackageFacts("install-script-sample", { fetchImpl: stub.fetchImpl });
    if (!facts.ok) return expect.unreachable(facts.failure.message);

    const withHook = facts.value.versions.find((entry) => entry.version === "0.21.5");
    const withoutHook = facts.value.versions.find((entry) => entry.version === "5.3.0");
    expect(withHook?.hasInstallScript).toBe(true);
    expect(withHook?.installScriptNames).toEqual(["postinstall"]);
    // A test script is not an install hook, so this must stay false.
    expect(withoutHook?.hasInstallScript).toBe(false);
    expect(withoutHook?.installScriptNames).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// OSV
// ---------------------------------------------------------------------------

/** GHSA-29mw-wpgm-hmr9, trimmed from POST api.osv.dev/v1/query for lodash 4.17.15. */
const LODASH_ADVISORY = {
  id: "GHSA-29mw-wpgm-hmr9",
  aliases: ["CVE-2020-28500"],
  published: "2022-01-06T20:30:46Z",
  modified: "2025-09-29T21:12:31.102523Z",
  summary: "Regular Expression Denial of Service (ReDoS) in lodash",
  severity: [
    { type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L" },
  ],
  affected: [
    {
      package: { name: "lodash", ecosystem: "npm", purl: "pkg:npm/lodash" },
      ranges: [
        { type: "SEMVER", events: [{ introduced: "4.0.0" }, { fixed: "4.17.21" }] },
      ],
    },
  ],
};

/**
 * PYSEC-2015-17, trimmed from POST api.osv.dev/v1/query for PyPI requests. Carries a GIT
 * range beside an ECOSYSTEM range, and its GHSA id only in `aliases`.
 */
const REQUESTS_ADVISORY = {
  id: "PYSEC-2015-17",
  aliases: ["CVE-2015-2296", "GHSA-pg2w-x9wp-vw92"],
  published: "2015-03-18T16:59:00Z",
  modified: "2026-06-10T17:02:37.461577652Z",
  affected: [
    {
      package: { name: "requests", ecosystem: "PyPI", purl: "pkg:pypi/requests" },
      ranges: [
        {
          type: "GIT",
          repo: "https://github.com/kennethreitz/requests",
          events: [{ introduced: "0" }, { fixed: "3bd8afbff29e50b38f889b2f688785a669b9aafc" }],
        },
        { type: "ECOSYSTEM", events: [{ introduced: "2.1.0" }, { fixed: "2.6.0" }] },
      ],
      versions: ["2.1.0", "2.2.0", "2.2.1"],
    },
  ],
};

describe("OSV client", () => {
  test("maps a SEMVER range onto the analysis layer's AffectedPackage", async () => {
    const stub = createFetchStub([{ body: JSON.stringify({ vulns: [LODASH_ADVISORY] }) }]);

    const queried = await queryOsvByPackage(
      { ecosystem: "npm", packageName: "lodash", version: "4.17.15" },
      { fetchImpl: stub.fetchImpl },
    );
    if (!queried.ok) return expect.unreachable(queried.failure.message);
    const advisory = queried.value[0];

    // Annotated as AffectedPackage so a drifted field is a type error, not a test failure:
    // this is the claim that semver-facts consumes the client's output with no adapter.
    const expectedAffected: AffectedPackage = {
      ecosystemName: "npm",
      packageName: "lodash",
      ranges: [
        {
          kind: "semver",
          events: [
            { type: "introduced", version: "4.0.0" },
            { type: "fixed", version: "4.17.21" },
          ],
        },
      ],
      explicitVersions: [],
    };
    expect(advisory.affected[0].affected).toEqual(expectedAffected);
    expect(advisory.affected[0].unusableRanges).toEqual([]);
    expect(advisory.ghsaId).toBe("GHSA-29mw-wpgm-hmr9");
    expect(advisory.publishedAtMs).toBe(Date.parse("2022-01-06T20:30:46Z"));
    expect(advisory.severities).toEqual([
      { type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L" },
    ]);
  });

  test("keeps a GIT range and marks it unusable", async () => {
    const stub = createFetchStub([{ body: JSON.stringify(REQUESTS_ADVISORY) }]);

    const fetched = await fetchOsvVulnerability("PYSEC-2015-17", { fetchImpl: stub.fetchImpl });
    if (!fetched.ok) return expect.unreachable(fetched.failure.message);
    const entry = fetched.value.affected[0];

    // Dropping the git range would silently claim the advisory is fully modelled.
    expect(entry.affected.ranges.map((range) => range.kind)).toEqual(["git", "ecosystem"]);
    expect(entry.unusableRanges).toEqual([
      {
        kind: "git",
        reason: "git_commit_range",
        detail: "https://github.com/kennethreitz/requests",
      },
    ]);
    // A PYSEC record carries its GHSA id only in aliases.
    expect(fetched.value.ghsaId).toBe("GHSA-pg2w-x9wp-vw92");

    // The git range must not block the sibling ecosystem range: 2.4.0 is inside
    // [2.1.0, 2.6.0) and is not one of the explicitly listed versions.
    const membership = isVersionAffected("2.4.0", entry.affected);
    if (!membership.ok) return expect.unreachable(membership.failure.message);
    expect(membership.value).toBe(true);
  });

  test("follows next_page_token until the server stops sending one", async () => {
    const stub = createFetchStub([
      {
        body: JSON.stringify({
          vulns: [LODASH_ADVISORY],
          next_page_token: "Ci0KC21vZGlmaWVkXzI",
        }),
      },
      { body: JSON.stringify({ vulns: [REQUESTS_ADVISORY] }) },
    ]);

    const queried = await queryOsvByPackage(
      { ecosystem: "npm", packageName: "lodash" },
      { fetchImpl: stub.fetchImpl },
    );
    if (!queried.ok) return expect.unreachable(queried.failure.message);

    // Stopping at page one would silently truncate a busy package's advisory list.
    expect(stub.readCallCount()).toBe(2);
    expect(queried.value.map((advisory) => advisory.id)).toEqual([
      "GHSA-29mw-wpgm-hmr9",
      "PYSEC-2015-17",
    ]);
  });
});

// ---------------------------------------------------------------------------
// deps.dev
// ---------------------------------------------------------------------------

/** chalk 4.1.2, trimmed from api.deps.dev/v3/.../versions/4.1.2:dependencies. */
const CHALK_DEPENDENCY_GRAPH = {
  nodes: [
    { versionKey: { system: "NPM", name: "chalk", version: "4.1.2" }, bundled: false, relation: "SELF", errors: [] },
    { versionKey: { system: "NPM", name: "ansi-styles", version: "4.3.0" }, bundled: false, relation: "DIRECT", errors: [] },
    { versionKey: { system: "NPM", name: "color-convert", version: "2.0.1" }, bundled: false, relation: "INDIRECT", errors: [] },
  ],
  edges: [
    { fromNode: 0, toNode: 1, requirement: "^4.1.0" },
    { fromNode: 1, toNode: 2, requirement: "^2.0.1" },
  ],
  error: "",
};

describe("deps.dev client", () => {
  test("round-trips the ecosystem mapping", () => {
    for (const ecosystem of ECOSYSTEMS) {
      const mappedBack = fromDepsDevSystem(toDepsDevSystem(ecosystem));
      if (!mappedBack.ok) return expect.unreachable(mappedBack.failure.message);
      expect(mappedBack.value).toBe(ecosystem);
    }

    expect(toDepsDevSystem("npm")).toBe("NPM");
    expect(toDepsDevSystem("pypi")).toBe("PYPI");
    // A system this project does not model must be reported, never coerced into npm.
    const unmapped = fromDepsDevSystem("CARGO");
    if (unmapped.ok) return expect.unreachable("CARGO is not a modelled ecosystem");
    expect(unmapped.failure.reason).toBe("unsupported");
  });

  test("preserves relation, requirement and root without flattening", async () => {
    const stub = createFetchStub([{ body: JSON.stringify(CHALK_DEPENDENCY_GRAPH) }]);

    const graph = await fetchDepsDevDependencyGraph("npm", "chalk", "4.1.2", {
      fetchImpl: stub.fetchImpl,
    });
    if (!graph.ok) return expect.unreachable(graph.failure.message);

    expect(stub.readRequestedUrls()).toEqual([
      "https://api.deps.dev/v3/systems/NPM/packages/chalk/versions/4.1.2:dependencies",
    ]);
    expect(graph.value.rootNodeIndex).toBe(0);
    expect(graph.value.nodes.map((node) => node.relation)).toEqual(["SELF", "DIRECT", "INDIRECT"]);
    expect(graph.value.edges[0]).toEqual({ fromNodeIndex: 0, toNodeIndex: 1, requirement: "^4.1.0" });
    expect(graph.value.graphError).toBeNull();
  });

  test("rejects an edge pointing outside the node list", async () => {
    const stub = createFetchStub([
      {
        body: JSON.stringify({
          ...CHALK_DEPENDENCY_GRAPH,
          edges: [{ fromNode: 0, toNode: 7, requirement: "^4.1.0" }],
        }),
      },
    ]);

    const graph = await fetchDepsDevDependencyGraph("npm", "chalk", "4.1.2", {
      fetchImpl: stub.fetchImpl,
    });

    // Dropping a dangling edge would shrink a blast radius, the one error this project
    // must not make silently.
    if (graph.ok) return expect.unreachable("a dangling edge must not be accepted");
    expect(graph.failure.reason).toBe("upstream_rejected");
  });
});

// ---------------------------------------------------------------------------
// PyPI
// ---------------------------------------------------------------------------

/** requests 2.31.0, trimmed from pypi.org/pypi/requests/2.31.0/json. */
const REQUESTS_VERSION_DOCUMENT = JSON.stringify({
  info: { name: "requests", version: "2.31.0" },
  urls: [
    {
      filename: "requests-2.31.0.tar.gz",
      packagetype: "sdist",
      upload_time: "2023-05-22T15:12:44",
      upload_time_iso_8601: "2023-05-22T15:12:44.175995Z",
      yanked: false,
      yanked_reason: null,
    },
    {
      filename: "requests-2.31.0-py3-none-any.whl",
      packagetype: "bdist_wheel",
      upload_time: "2023-05-22T15:12:42",
      yanked: false,
      yanked_reason: null,
    },
  ],
});

describe("PyPI client", () => {
  test("normalizes names per PEP 503", () => {
    expect(normalizePypiName("Foo.Bar_baz")).toBe("foo-bar-baz");
    // A mixed run of separators collapses to one hyphen, not to one per character.
    expect(normalizePypiName("a._-b")).toBe("a-b");
    expect(normalizePypiName("zope.interface")).toBe("zope-interface");
    expect(normalizePypiName("typing_extensions")).toBe("typing-extensions");
    expect(normalizePypiName("requests")).toBe("requests");
  });

  test("takes the earliest file upload as the publish moment, in UTC", async () => {
    const stub = createFetchStub([{ body: REQUESTS_VERSION_DOCUMENT }]);

    const facts = await fetchPypiVersionFacts("Requests", "2.31.0", { fetchImpl: stub.fetchImpl });
    if (!facts.ok) return expect.unreachable(facts.failure.message);

    expect(stub.readRequestedUrls()).toEqual(["https://pypi.org/pypi/requests/2.31.0/json"]);
    expect(facts.value.fileCount).toBe(2);
    // The wheel landed two seconds before the sdist and carries no ISO field, so the
    // fallback has to read a bare upload_time as UTC rather than as local time.
    expect(facts.value.uploadedAtMs).toBe(Date.parse("2023-05-22T15:12:42Z"));
    expect(facts.value.isYanked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Concurrency limiter
// ---------------------------------------------------------------------------

describe("concurrency limiter", () => {
  test("never exceeds its limit and frees a slot on rejection", async () => {
    const limiter = createConcurrencyLimiter(3);
    let inFlightCount = 0;
    let peakInFlightCount = 0;

    const runCountedTask = async (): Promise<void> => {
      inFlightCount += 1;
      peakInFlightCount = Math.max(peakInFlightCount, inFlightCount);
      await new Promise<void>((resolveTask) => setTimeout(resolveTask, 1));
      inFlightCount -= 1;
    };

    await Promise.all(Array.from({ length: 12 }, () => limiter.run(runCountedTask)));

    expect(peakInFlightCount).toBe(3);
    expect(limiter.readActiveCount()).toBe(0);

    // A leaked slot would deadlock the rest of an ingest, so a rejection must release it.
    // Settled through then/catch rather than the `rejects` matcher: that matcher returns
    // undefined here, so a broken assertion would surface as an unhandled rejection
    // instead of a failing test.
    const outcome = await limiter
      .run(() => Promise.reject(new Error("task failed")))
      .then(() => "resolved")
      .catch((caught: unknown) => (caught instanceof Error ? caught.message : "non-error"));

    expect(outcome).toBe("task failed");
    expect(limiter.readActiveCount()).toBe(0);
  });
});
