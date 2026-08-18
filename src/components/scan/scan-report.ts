import { z } from "zod";

import {
  type AnswerLimit,
  type Verdict,
  describeLimit,
  describeLimitIdentity,
  describeVerdict,
} from "@/lib/analysis/abstention";
import { describeZodIssues } from "@/lib/api/http";
import { formatCount, isKnownNumber } from "@/lib/format";
import type { GraphSource } from "@/lib/graph/load-graph";
import type { Coverage } from "@/lib/graph/slice-manifest";
import { type Failure, type Result, fail, succeed } from "@/lib/result";
import type { SkippedCounts } from "@/lib/scanner/lockfile";

/**
 * Everything the scan surface decides that is not a rendering decision.
 *
 * The wire decode, the size check that runs before a request is sent, the row order, the
 * headline choice, and every sentence the surface says out loud live here, because those are
 * the parts that go wrong in ways a screenshot cannot show: a table that puts a cleared
 * dependency above an exposed one, or a live region that announces a tally after a request
 * that failed, both look fine in a picture. test/scan-form.test.ts tests this file, and the
 * two components under src/components/scan only render what it returns.
 *
 * Nothing here re-decides anything the route decided. Every verdict, limit and count arrives
 * from POST /api/scan and is carried through untouched, because a second opinion computed in
 * the browser from a partial payload is exactly how an abstention turns into an all clear.
 * sourceRef: src/app/api/scan/route.ts
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Where a scan is posted.
 *
 * A module constant with no interpolation, on purpose: nothing a reader pasted ever reaches a
 * URL, a path, or a header on this surface. The route detects all seven formats from the
 * content itself, so there is no filename to send either.
 * sourceRef: src/lib/scanner/lockfile.ts (detectLockfileFormat reads content first).
 */
export const SCAN_ENDPOINT = "/api/scan";

/**
 * How long the browser waits for an answer, in milliseconds.
 *
 * A cold request loads the graph and indexes up to 5,000 advisories before it can answer, so
 * this is generous. The point of having a cap at all is that a request which never comes back
 * ends as a failure the reader can see and retry, instead of a button that spins forever.
 * sourceRef: src/app/api/scan/route.ts (MAX_ADVISORIES_SCANNED).
 */
export const SCAN_TIMEOUT_MS = 45_000;

/** Advisory chips rendered in one row before the rest fold into a count. */
export const MAX_ADVISORY_CHIPS_PER_ROW = 2;

/** Limit sentences the readout states in full before the remainder is counted. */
export const MAX_LIMIT_SENTENCES = 4;

/**
 * The filenames the parser recognises by name, listed for a reader who does not know what to
 * paste. Content detection runs first and covers every supported format, so this is a list of
 * files to look for in a project, not a list of names the paste has to carry.
 * sourceRef: src/lib/scanner/lockfile.ts (FILENAME_FORMATS).
 */
export const SUPPORTED_LOCKFILE_NAMES =
  "package-lock.json, npm-shrinkwrap.json, yarn.lock, pnpm-lock.yaml, requirements.txt, poetry.lock";

// ---------------------------------------------------------------------------
// The wire contract
// ---------------------------------------------------------------------------

/** One advisory named by a row. sourceRef: src/app/api/scan/route.ts (AdvisoryRef). */
export type AdvisoryReference = {
  advisoryId: string;
  publishedAtMs: number | null;
  summary: string | null;
};

/** One dependency, as the route decided it. sourceRef: src/app/api/scan/route.ts (DependencyAnswer). */
export type ScanRow = {
  ecosystem: string;
  name: string;
  /** null when the lockfile pinned no exact version, which is undecidable rather than clean. */
  version: string | null;
  versionKey: string | null;
  packageKey: string;
  isDevOnly: boolean;
  /** UNKNOWN_DEPTH (-1) when the format does not carry a tree position. */
  depth: number;
  coverage: Coverage;
  verdict: Verdict;
  rationale: string;
  limits: AnswerLimit[];
  /** Advisories naming this exact version. Non-empty means exposed. */
  advisories: AdvisoryReference[];
  /** Advisories naming the package at some other version. Non-empty means read the row twice. */
  packageAdvisories: AdvisoryReference[];
};

/** The whole success payload. sourceRef: src/app/api/scan/route.ts (POST). */
export type ScanReport = {
  lockfile: {
    /** Printed, never branched on, so a format added to the parser needs no change here. */
    format: string;
    ecosystem: string;
    dependencyCount: number;
    skipped: SkippedCounts;
    byteSize: number;
    filenameHint: string | null;
  };
  source: GraphSource;
  answer: {
    verdict: Verdict;
    rationale: string;
    limits: AnswerLimit[];
    evidence: {
      counts: Record<Verdict, number>;
      exposed: ScanRow[];
      unknown: ScanRow[];
      /** Cleared rows are counted, never listed. The table says so where a reader will see it. */
      clearedCount: number;
    };
  };
  advisoryScan: {
    advisoriesInGraph: number;
    advisoriesExamined: number;
    affectedVersionsIndexed: number;
    affectedPackagesIndexed: number;
  };
  reporting: {
    rowCap: number;
    exposedReported: number;
    exposedTotal: number;
    unknownReported: number;
    unknownTotal: number;
  };
};

const ADVISORY_REFERENCE_SCHEMA = z.object({
  advisoryId: z.string(),
  publishedAtMs: z.number().nullable(),
  summary: z.string().nullable(),
});

/**
 * Every limit variant the answer can carry.
 * sourceRef: src/lib/analysis/abstention.ts (AnswerLimit).
 *
 * A variant added there and not added here makes the decode fail, which shows the reader a
 * failure instead of an answer with a reason quietly missing from it. That is the direction
 * this should fail in.
 */
const ANSWER_LIMIT_SCHEMA = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("empty_graph") }),
  z.object({ kind: z.literal("package_absent"), subjectKey: z.string() }),
  z.object({ kind: z.literal("package_partial"), subjectKey: z.string() }),
  z.object({ kind: z.literal("hop_limit"), maxHops: z.number() }),
  z.object({ kind: z.literal("path_limit"), pathCount: z.number() }),
  z.object({ kind: z.literal("budget_rejected"), operation: z.string() }),
  z.object({ kind: z.literal("scan_capped"), examined: z.number(), total: z.number() }),
  z.object({ kind: z.literal("undecidable_versions"), count: z.number() }),
  z.object({
    kind: z.literal("service_history_partial"),
    serviceKey: z.string(),
    harvestedRevisions: z.number(),
  }),
  z.object({ kind: z.literal("timestamp_missing"), field: z.string() }),
]);

const VERDICT_SCHEMA = z.enum(["exposed", "not_exposed", "unknown"]);

const ROW_SCHEMA = z.object({
  ecosystem: z.string(),
  name: z.string(),
  version: z.string().nullable(),
  versionKey: z.string().nullable(),
  packageKey: z.string(),
  isDevOnly: z.boolean(),
  depth: z.number(),
  coverage: z.enum(["closed", "partial", "absent"]),
  verdict: VERDICT_SCHEMA,
  rationale: z.string(),
  limits: z.array(ANSWER_LIMIT_SCHEMA),
  advisories: z.array(ADVISORY_REFERENCE_SCHEMA),
  packageAdvisories: z.array(ADVISORY_REFERENCE_SCHEMA),
});

const REPORT_SCHEMA = z.object({
  lockfile: z.object({
    format: z.string(),
    ecosystem: z.string(),
    dependencyCount: z.number(),
    skipped: z.object({
      unpinnedCount: z.number(),
      unparsableLineCount: z.number(),
      truncatedCount: z.number(),
    }),
    byteSize: z.number(),
    filenameHint: z.string().nullable(),
  }),
  source: z.object({
    kind: z.enum(["hydradb", "snapshot"]),
    detail: z.string(),
    generatedAtMs: z.number(),
    degradedReason: z.string().nullable(),
  }),
  answer: z.object({
    verdict: VERDICT_SCHEMA,
    rationale: z.string(),
    limits: z.array(ANSWER_LIMIT_SCHEMA),
    evidence: z.object({
      counts: z.object({ exposed: z.number(), not_exposed: z.number(), unknown: z.number() }),
      exposed: z.array(ROW_SCHEMA),
      unknown: z.array(ROW_SCHEMA),
      clearedCount: z.number(),
    }),
  }),
  advisoryScan: z.object({
    advisoriesInGraph: z.number(),
    advisoriesExamined: z.number(),
    affectedVersionsIndexed: z.number(),
    affectedPackagesIndexed: z.number(),
  }),
  reporting: z.object({
    rowCap: z.number(),
    exposedReported: z.number(),
    exposedTotal: z.number(),
    unknownReported: z.number(),
    unknownTotal: z.number(),
  }),
});

/** sourceRef: src/lib/result.ts (FailureReason). */
const FAILURE_REASON_SCHEMA = z.enum([
  "not_found",
  "invalid_input",
  "upstream_unavailable",
  "upstream_rejected",
  "rate_limited",
  "graph_unavailable",
  "graph_rejected",
  "query_budget_exceeded",
  "timeout",
  "unsupported",
  "internal",
]);

/**
 * The failure envelope. The wire key is `error` while a Result carries `failure`, and the two
 * are deliberately different names for different things.
 * sourceRef: src/lib/api/http.ts (ApiFailureBody).
 */
const FAILURE_BODY_SCHEMA = z.object({
  ok: z.literal(false),
  error: z.object({
    reason: FAILURE_REASON_SCHEMA,
    message: z.string(),
  }),
});

/**
 * Decodes a 200 body into a report, or fails.
 *
 * A body that does not match is a failure and not a partial answer: the surface would have to
 * guess which half of the payload it got, and a missing `unknown` array would render as a
 * clean result. The annotation on `report` is the contract check, not decoration. It makes
 * tsc compare this schema against the exported types, which are written against the route and
 * against abstention.ts, so a renamed field upstream stops the build here.
 */
export function decodeScanReport(payload: unknown): Result<ScanReport, Failure> {
  const parsed = REPORT_SCHEMA.safeParse(payload);
  if (!parsed.success) {
    return fail(
      "internal",
      `The scan answered in a shape this page cannot read (${describeZodIssues(parsed.error)}). Nothing is shown, because a half-read answer would look like a clean one.`,
    );
  }

  const report: ScanReport = parsed.data;
  return succeed(report);
}

/**
 * Turns a non-200 response into a Failure. Never fails itself: the failure path is the one
 * place that cannot afford a second failure, so a body it cannot read still produces a
 * Failure naming the status.
 */
export function readScanFailure(status: number, payload: unknown): Failure {
  const parsed = FAILURE_BODY_SCHEMA.safeParse(payload);
  if (!parsed.success) {
    return {
      reason: "internal",
      message: `The scan route answered with status ${status} and a body this page could not read.`,
      status,
    };
  }

  return { reason: parsed.data.error.reason, message: parsed.data.error.message, status };
}

// ---------------------------------------------------------------------------
// Before the request
// ---------------------------------------------------------------------------

/** Encoded once per module. Reused because the tray is measured on every keystroke. */
const UTF8_ENCODER = new TextEncoder();

/** What the tray currently holds, measured in the units the route counts in. */
export type PasteReading = {
  /** UTF-8 bytes, because that is what the route counts as it reads the body. */
  byteSize: number;
  capBytes: number;
  isEmpty: boolean;
  isOverCap: boolean;
};

/**
 * Measures the tray in UTF-8 bytes.
 *
 * The route counts the bytes of the body as it streams it and refuses at the cap before
 * parsing anything, so bytes are the only unit in which the client and the server agree.
 * Characters would undercount every non-ASCII lockfile.
 * sourceRef: src/app/api/scan/route.ts (readCappedBody).
 */
export function readPaste(text: string, capBytes: number): PasteReading {
  const byteSize = UTF8_ENCODER.encode(text).byteLength;
  return {
    byteSize,
    capBytes,
    isEmpty: text.trim().length === 0,
    isOverCap: byteSize > capBytes,
  };
}

/**
 * The reason not to send this paste, or null to send it.
 *
 * The cap is enforced here as well as in the route so that an oversized paste is refused with
 * both numbers on screen, instead of travelling for a while and coming back as a 413. The
 * messages are read by a person under the field, so they carry no function prefix.
 */
export function refusePaste(reading: PasteReading): Failure | null {
  if (reading.isEmpty) {
    return {
      reason: "invalid_input",
      message: `Nothing is pasted yet. Paste the contents of a lockfile (${SUPPORTED_LOCKFILE_NAMES}), or fill the tray with the sample.`,
    };
  }

  if (reading.isOverCap) {
    return {
      reason: "invalid_input",
      message: `This paste is ${formatCount(reading.byteSize)} bytes and the cap is ${formatCount(reading.capBytes)} bytes. Nothing was sent. Scan a smaller lockfile, or scan one workspace at a time.`,
    };
  }

  return null;
}

/** Who a failure is about. */
export type FailureAudience = "file" | "tool";

/**
 * Whether a failure is about the pasted file or about the tool.
 *
 * `invalid_input` and `unsupported` are the only reasons the route returns for something a
 * reader can fix by pasting something else, so those go under the field. Everything else is
 * the graph, a budget, or this page, and putting "check your file" on a graph outage sends a
 * reader to fix the one thing that was not wrong.
 * sourceRef: src/app/api/scan/route.ts (every fail() call site), src/lib/api/http.ts (failureStatus).
 */
export function classifyFailureAudience(failure: Failure): FailureAudience {
  return failure.reason === "invalid_input" || failure.reason === "unsupported" ? "file" : "tool";
}

// ---------------------------------------------------------------------------
// The phases of the surface
// ---------------------------------------------------------------------------

/**
 * Every state this surface can be in. Kept here rather than in the component so that the
 * sentence a screen reader hears can be tested against the phase that produced it.
 */
export type ScanPhase =
  | { kind: "idle" }
  | { kind: "submitting" }
  | {
      kind: "answered";
      report: ScanReport;
      /** The exact text that produced this report, to detect an edited tray afterwards. */
      scannedText: string;
    }
  /** The paste was refused, by this page or by the route. The field carries the reason. */
  | { kind: "refused"; failure: Failure }
  /** The request or the answer failed. Nothing about the file is known. */
  | { kind: "failed"; failure: Failure };

/**
 * The one line announced to a screen reader when a phase settles.
 *
 * Empty while idle and while submitting: the idle state is already on screen, and the
 * skeleton announces its own label, so a second live region would say it twice. A failed
 * request never produces a tally, which is the whole reason this is a function and not a
 * template inside the component.
 */
export function describeScanStatus(phase: ScanPhase): string {
  switch (phase.kind) {
    case "idle":
    case "submitting":
      return "";
    case "refused":
      return `Nothing was scanned. ${phase.failure.message}`;
    case "failed":
      return `The scan failed and no dependency was decided. ${phase.failure.message}`;
    case "answered":
      return describeScanOutcome(phase.report);
  }
}

/** The tally, as one sentence. Read out loud when an answer settles, never printed twice. */
function describeScanOutcome(report: ScanReport): string {
  if (isEmptyScan(report)) {
    return `Nothing was checked: the file parsed as ${report.lockfile.format} and held no dependency entry.`;
  }

  const { counts, clearedCount } = report.answer.evidence;
  return `${describeVerdict(report.answer.verdict)}: ${formatCount(counts.exposed)} exposed, ${formatCount(counts.unknown)} undecided and ${formatCount(clearedCount)} cleared, out of ${formatCount(report.lockfile.dependencyCount)} dependencies read from a ${report.lockfile.format} file.`;
}

// ---------------------------------------------------------------------------
// Ordering the rows
// ---------------------------------------------------------------------------

/**
 * How bad a row is, lowest first.
 *
 * Exposed rows lead. Then the undecided rows in the order a reader should look at them: a
 * package that is under an advisory at some other version is the one worth checking by hand,
 * an unpinned dependency is the next, and a package the slice never ingested is last because
 * nothing about it is actionable from here. Cleared rows sort last and are only ever present
 * in a table that was given them.
 */
function rankScanRow(row: ScanRow): number {
  if (row.verdict === "exposed") return 0;
  if (row.verdict === "unknown") {
    if (row.packageAdvisories.length > 0) return 1;
    if (row.version === null) return 2;
    return 3;
  }
  return 4;
}

/**
 * Worst first, and stable for everything the rank ties.
 *
 * No row is ever dropped or merged: the count above the table and the number of rows in it
 * have to agree, or the table is lying about what was reported.
 */
export function orderScanRows(rows: readonly ScanRow[]): ScanRow[] {
  return [...rows].sort(compareScanRows);
}

function compareScanRows(left: ScanRow, right: ScanRow): number {
  const byRank = rankScanRow(left) - rankScanRow(right);
  if (byRank !== 0) return byRank;

  const byDepth = sortableDepth(left.depth) - sortableDepth(right.depth);
  if (byDepth !== 0) return byDepth;

  if (left.isDevOnly !== right.isDevOnly) return left.isDevOnly ? 1 : -1;
  if (left.packageKey !== right.packageKey) return left.packageKey < right.packageKey ? -1 : 1;
  return compareVersions(left.version, right.version);
}

/**
 * An absent depth sorts last instead of first.
 *
 * The parser writes -1 for a format that carries no tree position, and -1 as a number would
 * put those rows above the direct dependencies, which reads as "closest to you" when the truth
 * is "position unknown". `isKnownNumber` is the same test the formatters use, so the sort and
 * the cell agree about which readings are real.
 * sourceRef: src/lib/scanner/lockfile.ts (UNKNOWN_DEPTH), src/lib/format.ts (isKnownNumber).
 */
function sortableDepth(depth: number): number {
  return isKnownNumber(depth) ? depth : Number.MAX_SAFE_INTEGER;
}

/** Unpinned last, then plain text order. Versions are not compared as semver: this is a tiebreak. */
function compareVersions(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left < right ? -1 : 1;
}

// ---------------------------------------------------------------------------
// Sentences the surface says
// ---------------------------------------------------------------------------

/** An advisory list cut to what fits in a row, with the remainder counted. */
export type AdvisorySummary = {
  shown: AdvisoryReference[];
  omittedCount: number;
};

/** Folds a row's advisories down to the chips that fit. Nothing is hidden without a count. */
export function summariseAdvisories(
  references: readonly AdvisoryReference[],
  maxShown: number,
): AdvisorySummary {
  return {
    shown: references.slice(0, maxShown),
    omittedCount: Math.max(references.length - maxShown, 0),
  };
}

/**
 * Why this answer is not the whole picture, as sentences.
 *
 * The route records limits in two places: on the answer, when something about the whole read
 * was incomplete, and on each row, when that one dependency could not be decided. A lockfile
 * whose packages are all outside the ingested slice comes back with an empty answer-level list
 * and a limit on every row, so a readout that only read `answer.limits` would render "the
 * reason was not recorded" over a response that recorded one per dependency. Both are read.
 *
 * Sentences fold on limit identity, because two limits with the same identity say the same
 * thing to a reader and `AbstainNotice` keys its list on the sentence. The remainder past
 * `maxSentences` is counted rather than dropped: the counts above the table are complete
 * either way, and a list of two hundred near-identical sentences is a list nobody reads.
 * sourceRef: src/app/api/scan/route.ts (answerForDependency, limitsFromLockfile),
 * src/lib/analysis/abstention.ts (describeLimitIdentity).
 */
export function describeReportLimits(report: ScanReport, maxSentences: number): string[] {
  const limits: AnswerLimit[] = [...report.answer.limits];
  for (const row of [...report.answer.evidence.exposed, ...report.answer.evidence.unknown]) {
    limits.push(...row.limits);
  }

  const sentences = foldLimitSentences(limits);
  if (sentences.length <= maxSentences) return sentences;

  const omittedCount = sentences.length - maxSentences;
  return [
    ...sentences.slice(0, maxSentences),
    `${formatCount(omittedCount)} more dependencies each carry a reason of their own, stated on their row.`,
  ];
}

function foldLimitSentences(limits: readonly AnswerLimit[]): string[] {
  const seenIdentities = new Set<string>();
  const sentences: string[] = [];

  for (const limit of limits) {
    const identity = describeLimitIdentity(limit);
    if (seenIdentities.has(identity)) continue;
    seenIdentities.add(identity);
    sentences.push(describeLimit(limit));
  }

  return sentences;
}

/** What the parser could not use, or null when it used everything. */
export function describeSkipped(skipped: SkippedCounts): string | null {
  const parts: string[] = [];
  if (skipped.unpinnedCount > 0) {
    parts.push(`${formatCount(skipped.unpinnedCount)} without an exact version`);
  }
  if (skipped.unparsableLineCount > 0) {
    parts.push(`${formatCount(skipped.unparsableLineCount)} on a line it could not read`);
  }
  if (skipped.truncatedCount > 0) {
    parts.push(`${formatCount(skipped.truncatedCount)} past the dependency cap`);
  }
  return parts.length === 0 ? null : `Skipped ${parts.join(", ")}.`;
}

/**
 * What the table is not showing, or null when it shows every row it was given.
 *
 * The route caps the rows it returns but not the counts it reports, so this sentence is the
 * only place a reader learns that the table is shorter than the tally above it.
 * sourceRef: src/app/api/scan/route.ts (MAX_REPORTED_ROWS).
 */
export function describeReportingCaps(reporting: ScanReport["reporting"]): string | null {
  const isExposedCut = reporting.exposedTotal > reporting.exposedReported;
  const isUnknownCut = reporting.unknownTotal > reporting.unknownReported;
  if (!isExposedCut && !isUnknownCut) return null;

  return `The table lists ${formatCount(reporting.exposedReported)} of ${formatCount(reporting.exposedTotal)} exposed rows and ${formatCount(reporting.unknownReported)} of ${formatCount(reporting.unknownTotal)} undecided rows, because the route returns at most ${formatCount(reporting.rowCap)} of each. The counts above are complete.`;
}

/** The large reading at the top of the readout. */
export type HeadlineReading = {
  value: number;
  /** Read immediately after the number, so it says what the number counts. */
  unit: string;
};

/**
 * Which count gets the large type.
 *
 * Never a zero exposure count while undecided rows exist. A large 0 next to the word exposed
 * is read as "clear" from across a room, and the whole point of the abstention model is that
 * an undecided scan is not a clear one. So the headline leads with exposures when there are
 * any, with the undecided count when there are none, and only reads as cleared when the
 * answer really is that every dependency was decided and none was affected.
 */
export function chooseHeadlineReading(report: ScanReport): HeadlineReading {
  const { counts, clearedCount } = report.answer.evidence;
  const read = formatCount(report.lockfile.dependencyCount);

  if (isEmptyScan(report)) {
    return { value: 0, unit: "dependencies read" };
  }

  if (counts.exposed > 0) {
    return { value: counts.exposed, unit: `of ${read} exposed` };
  }
  if (counts.unknown > 0) {
    return { value: counts.unknown, unit: `of ${read} undecided` };
  }
  return { value: clearedCount, unit: `of ${read} cleared` };
}

/**
 * True when the file parsed and held no dependency at all.
 *
 * The route answers `not_exposed` for an empty lockfile, because every one of its zero
 * dependencies really was cleared, and on its own terms that is consistent. On a screen it is
 * not: a cleared reading over a file nothing was read from is the exact shape of a false
 * negative. The surface keeps the route's verdict, changes no count, and says out loud that
 * nothing was checked.
 * sourceRef: src/app/api/scan/route.ts (aggregate falls through to not_exposed at zero counts).
 */
export function isEmptyScan(report: ScanReport): boolean {
  return report.lockfile.dependencyCount === 0;
}

/**
 * The caption above the table, rendered visibly because it carries the two things a reader
 * would otherwise assume wrongly: that the order is arbitrary, and that the table lists every
 * dependency. Cleared dependencies come back from the route as a count and never as rows.
 */
export function describeRowsCaption(report: ScanReport): string {
  const { clearedCount } = report.answer.evidence;
  const cleared =
    clearedCount > 0
      ? ` ${formatCount(clearedCount)} cleared dependencies are counted in the readout and not listed here.`
      : "";
  return `Every dependency the scan could not clear, worst first.${cleared}`;
}
