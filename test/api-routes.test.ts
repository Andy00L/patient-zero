import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { GET as blastRadiusRoute } from "@/app/api/blast-radius/route";
import { GET as incidentsRoute } from "@/app/api/incidents/route";
import { GET as maintainersRoute } from "@/app/api/maintainers/route";
import { GET as replayRoute } from "@/app/api/replay/route";
import { POST as scanRoute } from "@/app/api/scan/route";
import { GET as statusRoute } from "@/app/api/status/route";
import { GET as typosquatsRoute } from "@/app/api/typosquats/route";
import { resetLoadedGraph } from "@/lib/graph/load-graph";
import { SLICE_MANIFEST_VERSION, type SliceManifest } from "@/lib/graph/slice-manifest";
import { buildGraphSnapshot, writeGraphSnapshot } from "@/lib/graph/snapshot";
import { MAX_LOCKFILE_CHARACTERS } from "@/lib/scanner/lockfile";

import {
  EVENT_STREAM_KEYS,
  FIXTURE_RESOLVED_AT_MS,
  buildEventStreamScenario,
} from "./fixtures/graph";

/**
 * Route handler tests.
 *
 * The handlers are called directly with a constructed Request. No server is started: the
 * contract being defended is the one a browser sees in the body, and a fetch through a port
 * would test Next.js rather than these seven files.
 *
 * Four risks, one cluster of assertions each.
 *
 * 1. Shape. Every response is parsed with a zod schema instead of being poked field by field,
 *    so a renamed or dropped field fails here rather than in a component.
 * 2. Refusal. A malformed query is a 400 carrying a reason a client can branch on, never a
 *    throw and never a 500. The size cap on the upload is refused before the file is parsed.
 * 3. Silence about the upload. A lockfile is untrusted input, and a response that echoed its
 *    registry URLs or integrity hashes back would turn a scanner into a leak. The assertion
 *    is that nothing but the dependency identity survives the round trip.
 * 4. Abstention. The three verdicts and the limit list have to reach the client intact. An
 *    `unknown` that serialised as an empty exposure list would read exactly like safety, and
 *    that is the one failure this project cannot ship, so it is asserted against a pinned
 *    fixture slice where all three verdicts are reachable from the same route.
 */

const BASE_URL = "http://patient-zero.test/api";

/** The incident every pack set in this repo carries, used for the replay happy path. */
const REPLAY_SLUG = "event-stream-2018";

/** Fixed clocks for the pinned fixture, so no assertion depends on when the suite runs. */
const FIXTURE_SNAPSHOT_GENERATED_AT_MS = 1_543_104_000_000;
const FIXTURE_MANIFEST_GENERATED_AT_MS = 1_543_017_600_000;

/** Bytes streamed by the oversized upload test: one MiB past the cap. */
const OVERSIZED_CHUNK_BYTES = 1_048_576;

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

const LIMIT_SCHEMA = z.object({
  kind: z.string().min(1),
  subjectKey: z.string().optional(),
  count: z.number().optional(),
  examined: z.number().optional(),
  total: z.number().optional(),
  field: z.string().optional(),
  maxHops: z.number().optional(),
});

/** The abstention envelope, identical on every route that decides anything. */
function answerSchema<TEvidence extends z.ZodType>(evidence: TEvidence) {
  return z.object({
    verdict: z.enum(["exposed", "not_exposed", "unknown"]),
    rationale: z.string().min(1),
    limits: z.array(LIMIT_SCHEMA),
    evidence,
  });
}

const FAILURE_SCHEMA = z.object({
  ok: z.literal(false),
  error: z.object({
    reason: z.string().min(1),
    message: z.string().min(1),
    context: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  }),
});

const STATUS_SCHEMA = z.object({
  ok: z.literal(true),
  available: z.boolean(),
  degraded: z.boolean(),
  source: z
    .object({
      kind: z.enum(["hydradb", "snapshot"]),
      detail: z.string().min(1),
      generatedAtMs: z.number(),
      degradedReason: z.string().nullable(),
    })
    .nullable(),
  graph: z
    .object({
      isEmpty: z.boolean().nullable(),
      nodeCounts: z.object({
        Package: z.number().nullable(),
        Version: z.number().nullable(),
        Maintainer: z.number().nullable(),
        Service: z.number().nullable(),
        Advisory: z.number().nullable(),
      }),
      unreadableLabels: z.array(z.string()),
    })
    .nullable(),
  slice: z
    .object({
      version: z.number(),
      ecosystems: z.array(z.string()),
      counts: z.record(z.string(), z.number()),
      closedPackageCount: z.number(),
      partialPackageCount: z.number(),
      claimsEmpty: z.boolean(),
    })
    .nullable(),
});

const INCIDENTS_SCHEMA = z.object({
  ok: z.literal(true),
  count: z.number(),
  incidents: z.array(
    z.object({
      slug: z.string().min(1),
      title: z.string().min(1),
      ecosystem: z.string().min(1),
      window: z.object({ startMs: z.number(), endMs: z.number() }),
      timelineBounds: z.object({ firstEventMs: z.number(), lastEventMs: z.number() }),
      blindSpot: z
        .object({ startMs: z.number(), endMs: z.number(), durationMs: z.number() })
        .nullable(),
      counts: z.object({ compromisedVersions: z.number(), advisories: z.number() }),
    }),
  ),
});

const SERVICE_EXPOSURE_SCHEMA = z.object({
  serviceKey: z.string().min(1),
  hopCount: z.number(),
  shortestPath: z.object({
    hopCount: z.number(),
    steps: z.array(
      z.object({
        nodeKind: z.enum(["service", "version"]),
        key: z.string().min(1),
        resolvedAtMs: z.number().nullable(),
      }),
    ),
  }),
});

const BLAST_RADIUS_SCHEMA = z.object({
  ok: z.literal(true),
  query: z.object({
    packageKey: z.string(),
    version: z.string(),
    versionKey: z.string(),
    maxHops: z.number().nullable(),
    atMs: z.number().nullable(),
  }),
  answer: answerSchema(
    z.object({
      compromised: z.object({ versionKey: z.string(), packageKey: z.string() }),
      exposedServices: z.array(SERVICE_EXPOSURE_SCHEMA),
      exposedVersions: z.array(z.object({ versionKey: z.string() })),
    }),
  ),
  asOf: z
    .object({
      atMs: z.number(),
      exposedServiceCount: z.number(),
      notYetExposedServiceKeys: z.array(z.string()),
      undatedServiceKeys: z.array(z.string()),
    })
    .nullable(),
});

const REPLAY_FRAME_SCHEMA = z.object({
  index: z.number(),
  atMs: z.number(),
  label: z.string(),
  answer: answerSchema(
    z.object({
      atMs: z.number(),
      exposedServices: z.array(z.object({ serviceKey: z.string() })),
      advisoryPublic: z.boolean(),
      unknownWindowServiceKeys: z.array(z.string()),
    }),
  ),
});

const REPLAY_SCHEMA = z.object({
  ok: z.literal(true),
  timeline: z.object({
    packSlug: z.string().min(1),
    payloadLiveAtMs: z.number(),
    disclosedAtMs: z.number(),
    blindSpot: z
      .object({ startMs: z.number(), endMs: z.number(), durationMs: z.number() })
      .nullable(),
    frameCount: z.number(),
    frameInstants: z.array(z.number()),
  }),
  frame: REPLAY_FRAME_SCHEMA.nullable(),
  frames: z.array(REPLAY_FRAME_SCHEMA).nullable(),
  frameSelection: z
    .object({
      requestedAtMs: z.number(),
      frameIndex: z.number(),
      frameAtMs: z.number(),
      clamped: z.enum(["before_window", "after_window"]).nullable(),
    })
    .nullable(),
});

const MAINTAINERS_SCHEMA = z.object({
  ok: z.literal(true),
  answer: answerSchema(
    z.object({
      rows: z.array(
        z.object({
          subject: z.object({ maintainerKey: z.string().min(1), username: z.string().min(1) }),
          direct: z.object({ packages: z.array(z.object({ packageKey: z.string() })) }),
        }),
      ),
      unrankedMaintainerKeys: z.array(z.string()),
      isSliceLowerBound: z.literal(true),
    }),
  ),
  pagination: z.object({ limit: z.number(), returnedRows: z.number(), rankedRows: z.number() }),
  enumeration: z.object({ maintainersInGraph: z.number(), capped: z.boolean() }),
});

const TYPOSQUATS_SCHEMA = z.object({
  ok: z.literal(true),
  answer: answerSchema(
    z.object({
      findings: z.array(
        z.object({
          suspect: z.object({ ecosystem: z.string().min(1), name: z.string().min(1) }),
          target: z.object({ name: z.string().min(1), weeklyDownloads: z.number() }),
          confidence: z.string().min(1),
          signals: z.array(z.object({ kind: z.string().min(1) })).min(1),
          editDistance: z.number(),
        }),
      ),
      candidatesScanned: z.number(),
      packagesInGraph: z.number(),
    }),
  ),
  pagination: z.object({ limit: z.number(), returnedFindings: z.number() }),
});

const SCAN_ROW_SCHEMA = z.object({
  ecosystem: z.string().min(1),
  name: z.string().min(1),
  version: z.string().nullable(),
  versionKey: z.string().nullable(),
  packageKey: z.string().min(1),
  coverage: z.enum(["closed", "partial", "absent"]),
  verdict: z.enum(["exposed", "not_exposed", "unknown"]),
  rationale: z.string().min(1),
  limits: z.array(LIMIT_SCHEMA),
  advisories: z.array(z.object({ advisoryId: z.string().min(1), publishedAtMs: z.number().nullable() })),
});

const SCAN_SCHEMA = z.object({
  ok: z.literal(true),
  lockfile: z.object({
    format: z.string().min(1),
    ecosystem: z.string().min(1),
    dependencyCount: z.number(),
    skipped: z.object({
      unpinnedCount: z.number(),
      unparsableLineCount: z.number(),
      truncatedCount: z.number(),
    }),
    byteSize: z.number(),
    filenameHint: z.string().nullable(),
  }),
  answer: answerSchema(
    z.object({
      counts: z.object({ exposed: z.number(), not_exposed: z.number(), unknown: z.number() }),
      exposed: z.array(SCAN_ROW_SCHEMA),
      unknown: z.array(SCAN_ROW_SCHEMA),
      clearedCount: z.number(),
    }),
  ),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parses a body against its schema, failing the test with the issue list rather than a cast. */
async function readBody<TSchema extends z.ZodType>(
  response: Response,
  schema: TSchema,
  context: string,
): Promise<z.infer<TSchema>> {
  const text = await response.text();
  const decoded = schema.safeParse(JSON.parse(text));
  if (!decoded.success) {
    return expect.unreachable(
      `${context}: response does not match its schema: ${JSON.stringify(decoded.error.issues)}`,
    );
  }
  return decoded.data;
}

async function readFailure(response: Response, context: string) {
  return readBody(response, FAILURE_SCHEMA, context);
}

type UploadBody = string | Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array<ArrayBuffer>>;

function scanRequest(body: UploadBody | null, search = ""): Request {
  const url = `${BASE_URL}/scan${search}`;
  return body === null ? new Request(url, { method: "POST" }) : new Request(url, { method: "POST", body });
}

/**
 * An npm lockfileVersion 3 file, with the fields a real one carries.
 *
 * `resolved` and `integrity` are here on purpose: they are the parts of a lockfile a scanner
 * must read past and never repeat, and one of them holds a credential in the test below.
 */
function npmLockfile(pinned: Readonly<Record<string, string>>, registry = "https://registry.npmjs.org"): string {
  const packages: Record<string, { name?: string; version?: string; resolved?: string; integrity?: string }> = {
    "": { name: "scan-fixture", version: "1.0.0" },
  };
  for (const [name, version] of Object.entries(pinned)) {
    packages[`node_modules/${name}`] = {
      version,
      resolved: `${registry}/${name}/-/${name}-${version}.tgz`,
      integrity: `sha512-${name}${version}integrityplaceholder`,
    };
  }
  return JSON.stringify({ name: "scan-fixture", lockfileVersion: 3, packages });
}

/** A stream with no content-length, so the byte ceiling is what has to stop it. */
function oversizedStream(): ReadableStream<Uint8Array<ArrayBuffer>> {
  let sent = 0;
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      if (sent > MAX_LOCKFILE_CHARACTERS) {
        controller.close();
        return;
      }
      const chunk = new Uint8Array(OVERSIZED_CHUNK_BYTES);
      chunk.fill(0x78);
      sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
}

/**
 * The fixture slice, pinned through the operator seam.
 *
 * The committed demo graph claims no closed packages, so a negative answer over it is honestly
 * unknown and `not_exposed` is unreachable. A slice that claims closed coverage is the only way
 * to prove the routes decide from the data rather than defaulting to one verdict.
 */
function buildFixtureManifest(): SliceManifest {
  return {
    version: SLICE_MANIFEST_VERSION,
    generatedAtMs: FIXTURE_MANIFEST_GENERATED_AT_MS,
    ecosystems: ["npm"],
    closedPackageKeys: [
      EVENT_STREAM_KEYS.flatmapStreamPackage,
      EVENT_STREAM_KEYS.eventStreamPackage,
      EVENT_STREAM_KEYS.psTreePackage,
      EVENT_STREAM_KEYS.nodemonPackage,
      EVENT_STREAM_KEYS.chalkPackage,
    ],
    partialPackageKeys: [],
    closedServiceKeys: [
      EVENT_STREAM_KEYS.checkoutApiService,
      EVENT_STREAM_KEYS.walletWebService,
      EVENT_STREAM_KEYS.docsSiteService,
    ],
    counts: {
      packages: 5,
      versions: 5,
      maintainers: 1,
      services: 3,
      advisories: 1,
      resolutionEdges: 3,
    },
    notes: ["fixture slice written by test/api-routes.test.ts"],
  };
}

/**
 * Runs a body against a snapshot written for the test, restoring the environment after.
 *
 * `resetLoadedGraph` runs on both sides because the loader caches its graph in module scope,
 * which is what makes a warm request cheap and what would otherwise leak one test's slice into
 * the next one.
 */
async function withFixtureSlice(run: () => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(import.meta.dir, ".tmp-api-routes-"));
  const path = join(directory, "snapshot.json");
  const previous = process.env.HYDRA_SNAPSHOT_PATH;

  try {
    const written = await writeGraphSnapshot(
      buildGraphSnapshot({
        graph: buildEventStreamScenario().graph,
        manifest: buildFixtureManifest(),
        generatedAtMs: FIXTURE_SNAPSHOT_GENERATED_AT_MS,
        source: "api-routes-test",
      }),
      path,
    );
    if (!written.ok) {
      expect.unreachable(`cannot write the fixture snapshot: ${written.failure.message}`);
      return;
    }

    process.env.HYDRA_SNAPSHOT_PATH = path;
    await resetLoadedGraph();
    await run();
  } finally {
    if (previous === undefined) delete process.env.HYDRA_SNAPSHOT_PATH;
    else process.env.HYDRA_SNAPSHOT_PATH = previous;
    await resetLoadedGraph();
    await rm(directory, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Shape, against the committed data
// ---------------------------------------------------------------------------

describe("route shapes over the committed slice", () => {
  test("GET /api/status reports the live source and a readable graph", async () => {
    const response = await statusRoute();
    expect(response.status).toBe(200);

    const body = await readBody(response, STATUS_SCHEMA, "status");
    expect(body.available).toBe(true);
    if (body.graph === null || body.slice === null || body.source === null) {
      return expect.unreachable("a status with available true carries a source, a graph and a slice");
    }

    // A count of null means unreadable and 0 means empty. Neither is acceptable here: the
    // committed snapshot is the source the whole demo answers from.
    expect(body.graph.nodeCounts.Version).toBeGreaterThan(0);
    expect(body.graph.isEmpty).toBe(false);
    expect(body.graph.unreadableLabels).toEqual([]);
    expect(body.slice.counts.versions).toBe(body.graph.nodeCounts.Version ?? -1);
    expect(body.source.detail).not.toContain("://");
  });

  test("GET /api/incidents lists every pack with its window and its blind spot", async () => {
    const response = await incidentsRoute();
    expect(response.status).toBe(200);

    const body = await readBody(response, INCIDENTS_SCHEMA, "incidents");
    expect(body.count).toBe(body.incidents.length);
    expect(body.count).toBeGreaterThanOrEqual(1);

    for (const incident of body.incidents) {
      expect(incident.window.endMs).toBeGreaterThan(incident.window.startMs);
      expect(incident.timelineBounds.firstEventMs).toBeGreaterThanOrEqual(incident.window.startMs);
      expect(incident.timelineBounds.lastEventMs).toBeLessThanOrEqual(incident.window.endMs);
    }

    const replayed = body.incidents.find((incident) => incident.slug === REPLAY_SLUG);
    if (replayed === undefined) return expect.unreachable(`${REPLAY_SLUG} is not installed`);
    // The gap between the payload shipping and the advisory landing is the number the product
    // is about, so a pack that lost it would render a scrubber with nothing to point at.
    expect(replayed.blindSpot?.durationMs).toBeGreaterThan(0);
  });

  test("GET /api/blast-radius answers with paths that start at a service and end at the subject", async () => {
    const response = await blastRadiusRoute(
      new Request(`${BASE_URL}/blast-radius?package=npm:flatmap-stream&version=0.1.1`),
    );
    expect(response.status).toBe(200);

    const body = await readBody(response, BLAST_RADIUS_SCHEMA, "blast radius");
    expect(body.query.versionKey).toBe("npm:flatmap-stream:0.1.1");
    expect(body.asOf).toBeNull();
    expect(body.answer.verdict).toBe("exposed");
    expect(body.answer.evidence.exposedServices.length).toBeGreaterThan(0);

    for (const exposure of body.answer.evidence.exposedServices) {
      const steps = exposure.shortestPath.steps;
      expect(steps[0]?.nodeKind).toBe("service");
      expect(steps[steps.length - 1]?.key).toBe(body.answer.evidence.compromised.versionKey);
    }
  });

  test("GET /api/replay returns one frame per instant, and one frame when asked as of an instant", async () => {
    const whole = await replayRoute(new Request(`${BASE_URL}/replay?incident=${REPLAY_SLUG}`));
    expect(whole.status).toBe(200);

    const timeline = await readBody(whole, REPLAY_SCHEMA, "replay timeline");
    expect(timeline.frameSelection).toBeNull();
    expect(timeline.frame).toBeNull();
    const frames = timeline.frames;
    if (frames === null) return expect.unreachable("a replay with no instant returns every frame");
    expect(frames.length).toBe(timeline.timeline.frameCount);
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.map((frame) => frame.atMs)).toEqual(timeline.timeline.frameInstants);
    expect(timeline.timeline.disclosedAtMs).toBeGreaterThan(timeline.timeline.payloadLiveAtMs);

    const exposureGrows = frames.map((frame) => frame.answer.evidence.exposedServices.length);
    expect(exposureGrows[exposureGrows.length - 1]).toBeGreaterThanOrEqual(exposureGrows[0] ?? 0);

    // An instant before the window is clamped to the first frame rather than refused: the
    // scrubber can only ask for an instant, and the honest answer at t0 is the first frame.
    const clamped = await replayRoute(new Request(`${BASE_URL}/replay?incident=${REPLAY_SLUG}&at=1`));
    const selected = await readBody(clamped, REPLAY_SCHEMA, "replay frame");
    expect(selected.frames).toBeNull();
    expect(selected.frame?.index).toBe(0);
    expect(selected.frameSelection?.clamped).toBe("before_window");
    expect(selected.frameSelection?.frameIndex).toBe(0);
  });

  test("GET /api/maintainers ranks accounts and never claims a global bound", async () => {
    const response = await maintainersRoute(new Request(`${BASE_URL}/maintainers?limit=3`));
    expect(response.status).toBe(200);

    const body = await readBody(response, MAINTAINERS_SCHEMA, "maintainers");
    expect(body.pagination.limit).toBe(3);
    expect(body.answer.evidence.rows.length).toBeLessThanOrEqual(3);
    expect(body.pagination.returnedRows).toBe(body.answer.evidence.rows.length);
    expect(body.pagination.rankedRows).toBeGreaterThanOrEqual(body.pagination.returnedRows);
    expect(body.answer.evidence.isSliceLowerBound).toBe(true);
    expect(body.enumeration.maintainersInGraph).toBeGreaterThan(0);
  });

  test("GET /api/typosquats returns findings for the requested ecosystem only", async () => {
    const response = await typosquatsRoute(new Request(`${BASE_URL}/typosquats?ecosystem=npm&limit=5`));
    expect(response.status).toBe(200);

    const body = await readBody(response, TYPOSQUATS_SCHEMA, "typosquats");
    expect(body.pagination.limit).toBe(5);
    expect(body.answer.evidence.findings.length).toBeLessThanOrEqual(5);
    expect(body.pagination.returnedFindings).toBe(body.answer.evidence.findings.length);

    for (const finding of body.answer.evidence.findings) {
      expect(finding.suspect.ecosystem).toBe("npm");
      expect(finding.suspect.name).not.toBe(finding.target.name);
    }
  });

  test("POST /api/scan decides per dependency and reports the advisory it matched", async () => {
    const response = await scanRoute(
      scanRequest(
        npmLockfile({ "event-stream": "3.3.6", "left-pad": "1.3.0" }),
        "?filename=package-lock.json",
      ),
    );
    expect(response.status).toBe(200);

    const body = await readBody(response, SCAN_SCHEMA, "scan");
    expect(body.lockfile.format).toBe("npm-lock-v2");
    expect(body.lockfile.dependencyCount).toBe(2);
    expect(body.lockfile.filenameHint).toBe("package-lock.json");

    const exposed = body.answer.evidence.exposed.find((row) => row.name === "event-stream");
    if (exposed === undefined) return expect.unreachable("event-stream 3.3.6 is under an advisory in the committed slice");
    expect(exposed.verdict).toBe("exposed");
    expect(exposed.advisories.length).toBeGreaterThan(0);
    expect(body.answer.verdict).toBe("exposed");

    // A package the slice never ingested is unknown, not clean. This is the whole point.
    const absent = body.answer.evidence.unknown.find((row) => row.name === "left-pad");
    expect(absent?.verdict).toBe("unknown");
    expect(absent?.coverage).toBe("absent");
    expect(body.answer.evidence.clearedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Refusal
// ---------------------------------------------------------------------------

describe("malformed input is a machine-readable 400", () => {
  test.each([
    ["no package at all", `${BASE_URL}/blast-radius?version=0.1.1`],
    ["a name with no ecosystem", `${BASE_URL}/blast-radius?package=flatmap-stream&version=0.1.1`],
    ["a hop count of zero", `${BASE_URL}/blast-radius?package=npm:chalk&version=5.3.1&maxHops=0`],
    ["a non-numeric instant", `${BASE_URL}/blast-radius?package=npm:chalk&version=5.3.1&at=yesterday`],
  ])("GET /api/blast-radius rejects %s", async (_case, url) => {
    const response = await blastRadiusRoute(new Request(url));
    expect(response.status).toBe(400);

    const body = await readFailure(response, "blast radius rejection");
    expect(body.error.reason).toBe("invalid_input");
  });

  test("GET /api/replay rejects a slug that is a path rather than a name", async () => {
    const response = await replayRoute(
      new Request(`${BASE_URL}/replay?incident=${encodeURIComponent("../../etc/passwd")}`),
    );
    // 400, not 404: the slug is refused by its pattern, so nothing on disk was ever consulted.
    expect(response.status).toBe(400);

    const body = await readFailure(response, "replay rejection");
    expect(body.error.reason).toBe("invalid_input");
    expect(body.error.message).not.toContain("etc/passwd");
  });

  test("GET /api/replay answers 404 for a well-formed slug nobody has, without naming a path", async () => {
    const response = await replayRoute(new Request(`${BASE_URL}/replay?incident=no-such-incident-1999`));
    expect(response.status).toBe(404);

    const body = await readFailure(response, "replay miss");
    expect(body.error.reason).toBe("not_found");
    expect(body.error.message).toContain("no-such-incident-1999");
    // The loader reports the absolute path it tried. That is a server detail, not an answer.
    expect(body.error.message).not.toContain(import.meta.dir);
    expect(body.error.message).not.toContain(".json");
  });

  test("limits outside their documented range are refused on every paged route", async () => {
    const maintainers = await maintainersRoute(new Request(`${BASE_URL}/maintainers?limit=101`));
    expect(maintainers.status).toBe(400);
    expect((await readFailure(maintainers, "maintainers limit")).error.reason).toBe("invalid_input");

    const typosquats = await typosquatsRoute(new Request(`${BASE_URL}/typosquats?ecosystem=cargo`));
    expect(typosquats.status).toBe(400);
    expect((await readFailure(typosquats, "typosquats ecosystem")).error.reason).toBe("invalid_input");
  });
});

// ---------------------------------------------------------------------------
// The upload trust boundary
// ---------------------------------------------------------------------------

describe("POST /api/scan treats the upload as hostile", () => {
  test("a body over the cap is refused before it is parsed, even with no declared length", async () => {
    const request = scanRequest(oversizedStream());
    // No content-length: the streaming byte counter is the only thing that can stop this.
    expect(request.headers.get("content-length")).toBeNull();

    const response = await scanRoute(request);
    expect(response.status).toBe(413);

    const body = await readFailure(response, "oversized upload");
    expect(body.error.reason).toBe("invalid_input");
    expect(body.error.context?.overCap).toBe(true);
    expect(body.error.context?.capBytes).toBe(MAX_LOCKFILE_CHARACTERS);
  });

  test.each([
    ["an empty body", "", "invalid_input"],
    ["json that is not a lockfile", JSON.stringify({ hello: "world" }), "unsupported"],
  ])("%s is a 400 rather than a guess", async (_case, body, reason) => {
    const response = await scanRoute(scanRequest(body));
    expect(response.status).toBe(400);
    expect((await readFailure(response, "unusable upload")).error.reason).toBe(reason);
  });

  test("bytes that are not utf-8 are refused rather than decoded loosely", async () => {
    const response = await scanRoute(scanRequest(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])));
    expect(response.status).toBe(400);
    expect((await readFailure(response, "invalid encoding")).error.reason).toBe("invalid_input");
  });

  test("a filename hint that is a path is refused from the query and from the header", async () => {
    const fromQuery = await scanRoute(
      scanRequest(npmLockfile({ chalk: "5.3.1" }), `?filename=${encodeURIComponent("../../etc/passwd")}`),
    );
    expect(fromQuery.status).toBe(400);

    const fromHeader = await scanRoute(
      new Request(`${BASE_URL}/scan`, {
        method: "POST",
        body: npmLockfile({ chalk: "5.3.1" }),
        headers: { "x-lockfile-name": "../package-lock.json" },
      }),
    );
    expect(fromHeader.status).toBe(400);
    expect((await readFailure(fromHeader, "filename hint")).error.reason).toBe("invalid_input");
  });

  test("nothing from the uploaded file comes back except the dependency identity", async () => {
    const registry = "https://ci-token:s3cr3t-deploy-key@registry.internal.example";
    const upload = npmLockfile({ "event-stream": "3.3.6", chalk: "5.3.1" }, registry);

    const response = await scanRoute(scanRequest(upload, "?filename=package-lock.json"));
    expect(response.status).toBe(200);

    // Asserted on the wire text, not on a parsed field: the risk is a value surviving anywhere
    // in the body, including inside a rationale or a limit.
    const text = await response.text();
    expect(text).not.toContain("s3cr3t-deploy-key");
    expect(text).not.toContain("registry.internal.example");
    expect(text).not.toContain("integrityplaceholder");
    expect(text).not.toContain("sha512-");
    expect(text).toContain("event-stream");
  });
});

// ---------------------------------------------------------------------------
// Abstention
// ---------------------------------------------------------------------------

describe("abstention survives serialisation", () => {
  test("one scan decides exposed, not_exposed and unknown from the same slice", async () => {
    await withFixtureSlice(async () => {
      const response = await scanRoute(
        scanRequest(
          npmLockfile({
            "flatmap-stream": "0.1.1",
            chalk: "5.3.1",
            "left-pad": "1.3.0",
          }),
          "?filename=package-lock.json",
        ),
      );
      expect(response.status).toBe(200);

      const body = await readBody(response, SCAN_SCHEMA, "fixture scan");
      expect(body.answer.evidence.counts).toEqual({ exposed: 1, not_exposed: 1, unknown: 1 });

      // Cleared means a closed slice looked and found nothing. It is the only verdict that
      // may be reported as safety, and it is counted separately from the unknown rows.
      expect(body.answer.evidence.clearedCount).toBe(1);
      expect(body.answer.verdict).toBe("exposed");

      const exposed = body.answer.evidence.exposed;
      expect(exposed.map((row) => row.name)).toEqual(["flatmap-stream"]);
      expect(exposed[0]?.advisories.map((advisory) => advisory.advisoryId)).toEqual([
        "GHSA-fixture-flatmap",
      ]);

      const undecided = body.answer.evidence.unknown;
      expect(undecided.map((row) => row.name)).toEqual(["left-pad"]);
      expect(undecided[0]?.verdict).toBe("unknown");
      expect(undecided[0]?.limits.map((limit) => limit.kind)).toContain("package_absent");
    });
  });

  test("a lockfile the slice cannot decide answers unknown with its reason, never an empty pass", async () => {
    await withFixtureSlice(async () => {
      const response = await scanRoute(scanRequest(npmLockfile({ "left-pad": "1.3.0" })));
      expect(response.status).toBe(200);

      const body = await readBody(response, SCAN_SCHEMA, "undecidable scan");
      expect(body.answer.verdict).toBe("unknown");
      expect(body.answer.evidence.counts).toEqual({ exposed: 0, not_exposed: 0, unknown: 1 });

      // The failure mode this guards: an unknown that serialised as zero exposures and no
      // stated reason, which a UI would render exactly like a clean bill of health. The reason
      // travels on the row, which is where a per-dependency verdict is decided.
      const row = body.answer.evidence.unknown[0];
      if (row === undefined) return expect.unreachable("an undecidable dependency must be listed");
      expect(row.verdict).toBe("unknown");
      expect(row.limits.map((limit) => limit.kind)).toContain("package_absent");
      expect(body.answer.evidence.clearedCount).toBe(0);
      expect(body.answer.rationale).toContain("not a clean bill of health");
    });
  });

  test("a subject outside the slice is unknown with package_absent, not an empty blast radius", async () => {
    await withFixtureSlice(async () => {
      const response = await blastRadiusRoute(
        new Request(`${BASE_URL}/blast-radius?package=npm:not-in-the-slice&version=1.0.0`),
      );
      expect(response.status).toBe(200);

      const body = await readBody(response, BLAST_RADIUS_SCHEMA, "absent subject");
      expect(body.answer.verdict).toBe("unknown");
      expect(body.answer.evidence.exposedServices).toEqual([]);
      expect(body.answer.limits.map((limit) => limit.kind)).toContain("package_absent");
    });
  });

  test("asking as of an instant before any lockfile was resolved does not report exposure", async () => {
    await withFixtureSlice(async () => {
      const before = await blastRadiusRoute(
        new Request(
          `${BASE_URL}/blast-radius?package=npm:flatmap-stream&version=0.1.1&at=${FIXTURE_RESOLVED_AT_MS - 1}`,
        ),
      );
      const beforeBody = await readBody(before, BLAST_RADIUS_SCHEMA, "as of before");
      expect(beforeBody.asOf?.exposedServiceCount).toBe(0);
      expect(beforeBody.answer.evidence.exposedServices).toEqual([]);
      expect(beforeBody.answer.verdict).not.toBe("exposed");
      expect(beforeBody.asOf?.notYetExposedServiceKeys.length).toBeGreaterThan(0);

      const after = await blastRadiusRoute(
        new Request(
          `${BASE_URL}/blast-radius?package=npm:flatmap-stream&version=0.1.1&at=${FIXTURE_RESOLVED_AT_MS}`,
        ),
      );
      const afterBody = await readBody(after, BLAST_RADIUS_SCHEMA, "as of after");
      expect(afterBody.asOf?.exposedServiceCount).toBeGreaterThan(0);
      expect(afterBody.answer.verdict).toBe("exposed");
    });
  });
});
