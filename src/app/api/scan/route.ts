/**
 * POST /api/scan
 *
 * "Scan my project": the request body is a lockfile, and the answer is a verdict per dependency
 * that the slice can decide, plus an honest unknown for every one it cannot.
 *
 * This is the one route that takes untrusted input, so the rules it follows are worth stating in
 * full:
 *   - The body is capped twice. A declared `Content-Length` over the cap is refused before a
 *     byte is read, and the stream is then counted as it arrives, because a declared length can
 *     be absent or a lie.
 *   - The bytes are decoded as strict UTF-8 and handed to the lockfile parser. Nothing from the
 *     file is executed, evaluated, interpolated into a shell command, or used to build a path.
 *   - Nothing is written anywhere. No file, no graph node, no log line carrying file content. The
 *     answer is computed in memory and returned, and the upload is gone when the request ends.
 *   - No failure message quotes the file. A parser that names an offending line names the line
 *     number, never its text.
 *
 * Query and headers:
 *   ?filename=<name>       optional, or the `x-lockfile-name` header. A bare file name, used
 *                          only as a format hint when the content itself is ambiguous.
 *
 * The matching runs against an index built from the graph once per request: every Advisory node
 * with its AFFECTS_VERSION and AFFECTS edges. Cost therefore scales with the number of advisories
 * in the slice, not with the size of the upload, and no query is issued per dependency.
 *
 * A dependency whose package is under an advisory but whose exact version was never materialised
 * is reported as unknown, never as clean. That is the entire point of the abstention model here:
 * a lockfile scan that answered "no known advisory" for a version it never checked would be the
 * one failure mode this tool must not have.
 */

import { z } from "zod";

import {
  type AnswerLimit,
  type Verdict,
  buildAnswer,
  buildUnknownAnswer,
  decideVerdict,
} from "@/lib/analysis/abstention";
import { jsonFailure, jsonOk, parseQuery, runRoute } from "@/lib/api/http";
import {
  type GraphGateway,
  type GraphProperties,
  isGraphEmpty,
  readNumberProperty,
  readStringProperty,
} from "@/lib/graph/gateway";
import { loadGraph } from "@/lib/graph/load-graph";
import { type Ecosystem, packageKey, versionKey } from "@/lib/graph/model";
import type { Coverage, SliceCoverage } from "@/lib/graph/slice-manifest";
import { MAX_LOCKFILE_CHARACTERS, type ParsedDependency, parseLockfile } from "@/lib/scanner/lockfile";
import { type Failure, type Result, fail, fromThrowing, succeed } from "@/lib/result";

const ROUTE_NAME = "POST /api/scan";

/**
 * Hard ceiling on the upload, in bytes.
 *
 * Shared with the parser's own character cap on purpose: a UTF-8 byte count is never smaller than
 * the UTF-16 length of the same text, so a body that passes this cap cannot trip the parser's.
 */
const MAX_UPLOAD_BYTES = MAX_LOCKFILE_CHARACTERS;

/** HTTP status for a body over the cap. A 400 would understate what happened. */
const PAYLOAD_TOO_LARGE = 413;

/** Advisory nodes indexed per request. The committed slice holds under a hundred. */
const MAX_ADVISORIES_SCANNED = 5_000;

/** Edges read per advisory, per relationship type. */
const MAX_EDGES_PER_ADVISORY = 20_000;

/** Rows returned per bucket. The counts are always complete; only the listing is paginated. */
const MAX_REPORTED_ROWS = 200;

/** A bare file name: no separators, no leading dot, nothing that could read as a path. */
const FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const FILENAME_HEADER = "x-lockfile-name";

const QUERY_SCHEMA = z.object({
  filename: z.string().regex(FILENAME_PATTERN, "must be a bare file name").optional(),
});

/** One advisory, as much of it as a scan result needs to name it. */
type AdvisoryRef = {
  advisoryId: string;
  publishedAtMs: number | null;
  summary: string | null;
};

type AdvisoryIndex = {
  /** Version key to the advisories that name that exact version. */
  byVersionKey: Map<string, AdvisoryRef[]>;
  /** Package key to the advisories that name the package without a materialised version. */
  byPackageKey: Map<string, AdvisoryRef[]>;
  advisoriesInGraph: number;
  advisoriesExamined: number;
  affectedVersionsIndexed: number;
  affectedPackagesIndexed: number;
  limits: AnswerLimit[];
};

type DependencyAnswer = {
  ecosystem: Ecosystem;
  name: string;
  /** null when the lockfile did not pin a version, which is undecidable by itself. */
  version: string | null;
  versionKey: string | null;
  packageKey: string;
  isDevOnly: boolean;
  depth: number;
  coverage: Coverage;
  verdict: Verdict;
  rationale: string;
  limits: AnswerLimit[];
  /** Advisories naming this exact version. Non-empty only on an exposed verdict. */
  advisories: AdvisoryRef[];
  /** Advisories naming the package while this version was never checked. */
  packageAdvisories: AdvisoryRef[];
};

type ScanEvidence = {
  counts: Record<Verdict, number>;
  exposed: DependencyAnswer[];
  /** Dependencies the slice could not decide. Never folded into `clearedCount`. */
  unknown: DependencyAnswer[];
  /** Dependencies with a real negative: closed coverage, no advisory, nothing truncated. */
  clearedCount: number;
};

export async function POST(request: Request): Promise<Response> {
  return runRoute(ROUTE_NAME, async () => {
    const query = parseQuery(request, QUERY_SCHEMA, ROUTE_NAME);
    if (!query.ok) return jsonFailure(query.failure);

    const filenameHint = readFilenameHint(request, query.value.filename);
    if (!filenameHint.ok) return jsonFailure(filenameHint.failure);

    const body = await readCappedBody(request);
    if (!body.ok) {
      return jsonFailure(
        body.failure,
        body.failure.context?.overCap === true ? PAYLOAD_TOO_LARGE : undefined,
      );
    }

    const parsed = parseLockfile(body.value.text, filenameHint.value ?? undefined);
    if (!parsed.ok) return jsonFailure(parsed.failure);

    const loaded = await loadGraph();
    if (!loaded.ok) return jsonFailure(loaded.failure);

    const { gateway, coverage, source } = loaded.value;

    const empty = await isGraphEmpty(gateway);
    if (!empty.ok) return jsonFailure(empty.failure);

    const index = await buildAdvisoryIndex(gateway);
    if (!index.ok) return jsonFailure(index.failure);

    const lockfile = {
      format: parsed.value.format,
      ecosystem: parsed.value.ecosystem,
      dependencyCount: parsed.value.dependencies.length,
      skipped: parsed.value.skipped,
      byteSize: body.value.byteSize,
      filenameHint: filenameHint.value,
    };

    const scanLimits: AnswerLimit[] = [
      ...index.value.limits,
      ...limitsFromLockfile(parsed.value.dependencies.length, parsed.value.skipped),
    ];

    const rows = parsed.value.dependencies.map((dependency) =>
      answerForDependency(dependency, index.value, coverage, empty.value),
    );

    const counts: Record<Verdict, number> = { exposed: 0, not_exposed: 0, unknown: 0 };
    const exposed: DependencyAnswer[] = [];
    const unknown: DependencyAnswer[] = [];
    for (const row of rows) {
      counts[row.verdict] += 1;
      if (row.verdict === "exposed" && exposed.length < MAX_REPORTED_ROWS) exposed.push(row);
      if (row.verdict === "unknown" && unknown.length < MAX_REPORTED_ROWS) unknown.push(row);
    }

    const evidence: ScanEvidence = {
      counts,
      exposed,
      unknown,
      clearedCount: counts.not_exposed,
    };

    return jsonOk({
      lockfile,
      source,
      answer: aggregate(counts, evidence, scanLimits, empty.value),
      advisoryScan: {
        advisoriesInGraph: index.value.advisoriesInGraph,
        advisoriesExamined: index.value.advisoriesExamined,
        affectedVersionsIndexed: index.value.affectedVersionsIndexed,
        affectedPackagesIndexed: index.value.affectedPackagesIndexed,
      },
      reporting: {
        rowCap: MAX_REPORTED_ROWS,
        exposedReported: exposed.length,
        exposedTotal: counts.exposed,
        unknownReported: unknown.length,
        unknownTotal: counts.unknown,
      },
    });
  });
}

/**
 * The overall verdict over a whole lockfile.
 *
 * Not a single `decideVerdict` call over every package at once: absence outranks found evidence
 * inside that function, so one dependency outside the slice would turn a real match on another
 * dependency into an unknown. Each dependency is decided against its own coverage, and the
 * lockfile verdict is the worst of them, with exposure winning over abstention.
 */
function aggregate(
  counts: Record<Verdict, number>,
  evidence: ScanEvidence,
  limits: AnswerLimit[],
  graphIsEmpty: boolean,
) {
  const tally = `${counts.exposed} exposed, ${counts.unknown} undecidable, ${counts.not_exposed} cleared`;

  if (counts.exposed > 0) {
    return buildAnswer(
      {
        verdict: "exposed",
        rationale: `At least one pinned dependency is named by an advisory in the slice (${tally}). Each exposed row names the advisory that matched.`,
        limits,
      },
      evidence,
    );
  }

  if (graphIsEmpty) {
    return buildUnknownAnswer(
      "The graph is empty, so no dependency in this lockfile could be checked against anything. Run an ingest first.",
      evidence,
      [{ kind: "empty_graph" }, ...limits],
    );
  }

  if (counts.unknown > 0) {
    return buildUnknownAnswer(
      `No pinned dependency matched an advisory, but ${counts.unknown} of them could not be decided (${tally}), so this is not a clean bill of health. Each undecided row carries its own reason.`,
      evidence,
      limits,
    );
  }

  return buildAnswer(
    {
      verdict: "not_exposed",
      rationale: `Every dependency in this lockfile has its full closure in the slice, none is named by an advisory, and nothing was truncated (${tally}).`,
      limits,
    },
    evidence,
  );
}

/** Decides one dependency against the advisory index and its own coverage. */
function answerForDependency(
  dependency: ParsedDependency,
  index: AdvisoryIndex,
  coverage: SliceCoverage,
  graphIsEmpty: boolean,
): DependencyAnswer {
  const subjectPackageKey = packageKey(dependency.ecosystem, dependency.name);
  const subjectVersionKey =
    dependency.version === null
      ? null
      : versionKey(dependency.ecosystem, dependency.name, dependency.version);

  const advisories =
    subjectVersionKey === null ? [] : (index.byVersionKey.get(subjectVersionKey) ?? []);
  const packageAdvisories =
    advisories.length > 0 ? [] : (index.byPackageKey.get(subjectPackageKey) ?? []);

  const limits: AnswerLimit[] = [];
  if (dependency.version === null) {
    // A range with no resolved version cannot be placed against an advisory range at all.
    limits.push({ kind: "undecidable_versions", count: 1 });
  } else if (advisories.length === 0 && packageAdvisories.length > 0) {
    // The package is under an advisory and this exact version was never materialised, so the
    // honest answer is that it was not checked.
    limits.push({ kind: "undecidable_versions", count: 1 });
  }

  const packageCoverage = coverage.describePackageCoverage(subjectPackageKey);
  const decided = decideVerdict({
    foundEvidence: advisories.length > 0,
    subjectCoverage: packageCoverage,
    subjectKey: subjectVersionKey ?? subjectPackageKey,
    limits,
    graphIsEmpty,
  });

  return {
    ecosystem: dependency.ecosystem,
    name: dependency.name,
    version: dependency.version,
    versionKey: subjectVersionKey,
    packageKey: subjectPackageKey,
    isDevOnly: dependency.isDevOnly,
    depth: dependency.depth,
    coverage: packageCoverage,
    verdict: decided.verdict,
    rationale: decided.rationale,
    limits: decided.limits,
    advisories,
    packageAdvisories,
  };
}

/**
 * What the lockfile itself lost, in the shared limit vocabulary.
 *
 * All three are truncating limits, which is what stops a lockfile with unreadable lines from ever
 * reaching a clean verdict.
 */
function limitsFromLockfile(
  dependencyCount: number,
  skipped: { unpinnedCount: number; unparsableLineCount: number; truncatedCount: number },
): AnswerLimit[] {
  const limits: AnswerLimit[] = [];

  const lost = skipped.unparsableLineCount + skipped.truncatedCount;
  if (lost > 0) {
    limits.push({ kind: "scan_capped", examined: dependencyCount, total: dependencyCount + lost });
  }
  if (skipped.unpinnedCount > 0) {
    limits.push({ kind: "undecidable_versions", count: skipped.unpinnedCount });
  }

  return limits;
}

/**
 * Every advisory in the slice, with the versions and packages it names.
 *
 * Two neighbour reads per advisory rather than one traversal: AFFECTS_VERSION and AFFECTS carry
 * different meanings and the answer needs them apart. AFFECTS_VERSION is a materialised match on
 * an exact version, so it decides an exposure. AFFECTS names the package while leaving the
 * version range to be interpreted, so it can only ever produce an unknown here.
 */
async function buildAdvisoryIndex(gateway: GraphGateway): Promise<Result<AdvisoryIndex, Failure>> {
  const total = await gateway.countNodes("Advisory");
  if (!total.ok) return total;

  const nodeIds = await gateway.listNodeIds({
    label: "Advisory",
    limit: Math.max(Math.min(total.value, MAX_ADVISORIES_SCANNED), 1),
  });
  if (!nodeIds.ok) return nodeIds;

  const advisoryNodes = await gateway.readNodes({ nodeIds: nodeIds.value, label: "Advisory" });
  if (!advisoryNodes.ok) return advisoryNodes;

  const versionEdges = new Map<number, number[]>();
  const packageEdges = new Map<number, number[]>();
  const versionNodeIds = new Set<number>();
  const packageNodeIds = new Set<number>();

  for (const advisory of advisoryNodes.value) {
    const affectedVersions = await gateway.neighbors({
      nodeId: advisory.id,
      nodeLabel: "Advisory",
      relType: "AFFECTS_VERSION",
      direction: "outgoing",
      limit: MAX_EDGES_PER_ADVISORY,
    });
    if (!affectedVersions.ok) return affectedVersions;

    const affectedPackages = await gateway.neighbors({
      nodeId: advisory.id,
      nodeLabel: "Advisory",
      relType: "AFFECTS",
      direction: "outgoing",
      limit: MAX_EDGES_PER_ADVISORY,
    });
    if (!affectedPackages.ok) return affectedPackages;

    const versionTargets = affectedVersions.value.map((edge) => edge.otherNodeId);
    const packageTargets = affectedPackages.value.map((edge) => edge.otherNodeId);
    versionEdges.set(advisory.id, versionTargets);
    packageEdges.set(advisory.id, packageTargets);
    for (const nodeId of versionTargets) versionNodeIds.add(nodeId);
    for (const nodeId of packageTargets) packageNodeIds.add(nodeId);
  }

  const versionKeys = await readKeysById(gateway, [...versionNodeIds], "Version");
  if (!versionKeys.ok) return versionKeys;

  const packageKeys = await readKeysById(gateway, [...packageNodeIds], "Package");
  if (!packageKeys.ok) return packageKeys;

  const byVersionKey = new Map<string, AdvisoryRef[]>();
  const byPackageKey = new Map<string, AdvisoryRef[]>();

  for (const advisory of advisoryNodes.value) {
    const ref = toAdvisoryRef(advisory.properties);
    if (ref === null) continue;

    for (const nodeId of versionEdges.get(advisory.id) ?? []) {
      const key = versionKeys.value.get(nodeId);
      if (key !== undefined) appendRef(byVersionKey, key, ref);
    }
    for (const nodeId of packageEdges.get(advisory.id) ?? []) {
      const key = packageKeys.value.get(nodeId);
      if (key !== undefined) appendRef(byPackageKey, key, ref);
    }
  }

  const limits: AnswerLimit[] = [];
  if (advisoryNodes.value.length < total.value) {
    limits.push({
      kind: "scan_capped",
      examined: advisoryNodes.value.length,
      total: total.value,
    });
  }

  return succeed({
    byVersionKey,
    byPackageKey,
    advisoriesInGraph: total.value,
    advisoriesExamined: advisoryNodes.value.length,
    affectedVersionsIndexed: byVersionKey.size,
    affectedPackagesIndexed: byPackageKey.size,
    limits,
  });
}

/** Natural keys for a set of node ids, as a lookup from id to key. */
async function readKeysById(
  gateway: GraphGateway,
  nodeIds: readonly number[],
  label: "Version" | "Package",
): Promise<Result<Map<number, string>, Failure>> {
  if (nodeIds.length === 0) return succeed(new Map());

  const nodes = await gateway.readNodes({ nodeIds, label });
  if (!nodes.ok) return nodes;

  const keys = new Map<number, string>();
  for (const node of nodes.value) {
    const key = readStringProperty(node.properties, "key");
    if (key !== null) keys.set(node.id, key);
  }
  return succeed(keys);
}

function appendRef(target: Map<string, AdvisoryRef[]>, key: string, ref: AdvisoryRef): void {
  const existing = target.get(key);
  if (existing === undefined) target.set(key, [ref]);
  else existing.push(ref);
}

function toAdvisoryRef(properties: GraphProperties): AdvisoryRef | null {
  const advisoryId =
    readStringProperty(properties, "ghsa_id") ?? readStringProperty(properties, "key");
  if (advisoryId === null) return null;

  return {
    advisoryId,
    publishedAtMs: readNumberProperty(properties, "published_at_ms"),
    summary: readStringProperty(properties, "summary"),
  };
}

/** The format hint, from the query or the header, whichever is present. Query wins. */
function readFilenameHint(
  request: Request,
  fromQuery: string | undefined,
): Result<string | null, Failure> {
  if (fromQuery !== undefined) return succeed(fromQuery);

  const header = request.headers.get(FILENAME_HEADER);
  if (header === null) return succeed(null);
  if (!FILENAME_PATTERN.test(header)) {
    return fail(
      "invalid_input",
      `[${ROUTE_NAME}] the ${FILENAME_HEADER} header must be a bare file name such as package-lock.json`,
    );
  }
  return succeed(header);
}

type BodyRead = { text: string; byteSize: number };

type StreamedBody =
  | { kind: "read"; text: string; byteSize: number }
  | { kind: "over_cap"; byteSize: number };

/**
 * Reads the request body with a hard byte ceiling.
 *
 * The declared length is checked first because refusing a 100 MB upload should not require
 * receiving it. The stream is then counted as it arrives: `Content-Length` is a claim, and a
 * chunked request carries none at all.
 *
 * Decoding is strict UTF-8. A lockfile is text, and accepting replacement characters would mean
 * parsing something the client did not send.
 */
async function readCappedBody(request: Request): Promise<Result<BodyRead, Failure>> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const declaredBytes = Number.parseInt(declared, 10);
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_UPLOAD_BYTES) {
      return overCapFailure(declaredBytes);
    }
  }

  const stream = request.body;
  if (stream === null) {
    return fail("invalid_input", `[${ROUTE_NAME}] the request has no body to scan`);
  }

  const streamed = await fromThrowing(
    "invalid_input",
    `[${ROUTE_NAME}] the request body could not be read as UTF-8 text`,
    async (): Promise<StreamedBody> => {
      const reader = stream.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const chunks: string[] = [];
      let byteSize = 0;

      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;

          byteSize += next.value.byteLength;
          if (byteSize > MAX_UPLOAD_BYTES) {
            await reader.cancel();
            return { kind: "over_cap", byteSize };
          }
          chunks.push(decoder.decode(next.value, { stream: true }));
        }
        chunks.push(decoder.decode());
      } finally {
        reader.releaseLock();
      }

      return { kind: "read", text: chunks.join(""), byteSize };
    },
  );
  if (!streamed.ok) return streamed;

  if (streamed.value.kind === "over_cap") return overCapFailure(streamed.value.byteSize);

  if (streamed.value.text.trim().length === 0) {
    return fail("invalid_input", `[${ROUTE_NAME}] the request body is empty`);
  }

  return succeed({ text: streamed.value.text, byteSize: streamed.value.byteSize });
}

/**
 * The refusal, carrying the cap and nothing from the file.
 *
 * `overCap` in the context is what the handler turns into a 413; the reason stays
 * `invalid_input` because that is what it is, and the reason codes are a closed set the whole
 * codebase branches on.
 */
function overCapFailure(byteSize: number): Result<never, Failure> {
  return fail(
    "invalid_input",
    `[${ROUTE_NAME}] the uploaded lockfile is over the ${MAX_UPLOAD_BYTES} byte cap and was refused without being parsed`,
    { context: { overCap: true, capBytes: MAX_UPLOAD_BYTES, observedBytes: byteSize } },
  );
}
