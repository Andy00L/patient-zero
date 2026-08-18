import { describe, expect, test } from "bun:test";

import {
  MAX_ADVISORY_CHIPS_PER_ROW,
  MAX_LIMIT_SENTENCES,
  type ScanReport,
  type ScanRow,
  chooseHeadlineReading,
  classifyFailureAudience,
  decodeScanReport,
  describeReportLimits,
  describeReportingCaps,
  describeRowsCaption,
  describeScanStatus,
  describeSkipped,
  isEmptyScan,
  orderScanRows,
  readPaste,
  readScanFailure,
  refusePaste,
  summariseAdvisories,
} from "@/components/scan/scan-report";
import type { AnswerLimit, Verdict } from "@/lib/analysis/abstention";
import { MAX_LOCKFILE_CHARACTERS } from "@/lib/scanner/lockfile";

/**
 * One rule: this surface never turns a scan it could not decide into a clean result.
 *
 * Everything asserted here is a defect that renders perfectly. A table that sorts a cleared
 * dependency above an exposure, a large "0" over the word exposed while twelve rows are
 * undecided, a live region that reads a tally out loud after a request that failed, a lockfile
 * with nothing in it reported as cleared, an oversized paste that travels for a while before
 * being refused, and a response whose undecided rows went missing on the way all look like
 * working software in a screenshot. The components are not tested here: they render these
 * values. sourceRef: src/components/scan/scan-report.ts
 */

/** A real instant, so the receipt readings in these fixtures are recognisable. */
const GENERATED_AT_MS = Date.UTC(2018, 10, 26, 3, 31);

function buildRow(overrides: Partial<ScanRow> = {}): ScanRow {
  return {
    ecosystem: "npm",
    name: "left-pad",
    version: "1.3.0",
    versionKey: "npm:left-pad:1.3.0",
    packageKey: "npm:left-pad",
    isDevOnly: false,
    depth: 1,
    coverage: "closed",
    verdict: "unknown",
    rationale: "Test rationale.",
    limits: [],
    advisories: [],
    packageAdvisories: [],
    ...overrides,
  };
}

/** The route's own order of preference when it names the whole lockfile's verdict. */
function defaultVerdict(exposedCount: number, unknownCount: number): Verdict {
  if (exposedCount > 0) return "exposed";
  if (unknownCount > 0) return "unknown";
  return "not_exposed";
}

type ReportOptions = {
  exposed?: ScanRow[];
  undecided?: ScanRow[];
  clearedCount?: number;
  dependencyCount?: number;
  verdict?: Verdict;
  limits?: AnswerLimit[];
  reporting?: Partial<ScanReport["reporting"]>;
  skipped?: Partial<ScanReport["lockfile"]["skipped"]>;
};

/**
 * A response in the shape the route returns, with only the fields under test set to anything
 * interesting. Typed as ScanReport so a change to the wire contract breaks this file rather
 * than letting these assertions pass against a shape that no longer exists.
 */
function buildReport(options: ReportOptions = {}): ScanReport {
  const exposed = options.exposed ?? [];
  const undecided = options.undecided ?? [];
  const clearedCount = options.clearedCount ?? 0;

  return {
    lockfile: {
      format: "npm-lock-v2",
      ecosystem: "npm",
      dependencyCount:
        options.dependencyCount ?? exposed.length + undecided.length + clearedCount,
      skipped: {
        unpinnedCount: 0,
        unparsableLineCount: 0,
        truncatedCount: 0,
        ...options.skipped,
      },
      byteSize: 2_651,
      filenameHint: null,
    },
    source: {
      kind: "snapshot",
      detail: "data/graph/demo-snapshot.json written by a test",
      generatedAtMs: GENERATED_AT_MS,
      degradedReason: null,
    },
    answer: {
      verdict: options.verdict ?? defaultVerdict(exposed.length, undecided.length),
      rationale: "Test rationale.",
      limits: options.limits ?? [],
      evidence: {
        counts: { exposed: exposed.length, not_exposed: clearedCount, unknown: undecided.length },
        exposed,
        unknown: undecided,
        clearedCount,
      },
    },
    advisoryScan: {
      advisoriesInGraph: 48,
      advisoriesExamined: 48,
      affectedVersionsIndexed: 90,
      affectedPackagesIndexed: 12,
    },
    reporting: {
      rowCap: 200,
      exposedReported: exposed.length,
      exposedTotal: exposed.length,
      unknownReported: undecided.length,
      unknownTotal: undecided.length,
      ...options.reporting,
    },
  };
}

describe("readPaste and refusePaste", () => {
  test("an empty or whitespace-only tray is refused without a request", () => {
    for (const text of ["", "   \n\t "]) {
      const reading = readPaste(text, MAX_LOCKFILE_CHARACTERS);
      expect(reading.isEmpty).toBe(true);

      const refusal = refusePaste(reading);
      expect(refusal?.reason).toBe("invalid_input");
      expect(refusal?.message).toContain("Nothing is pasted yet");
    }
  });

  test("the size is counted in UTF-8 bytes, which is the unit the route counts in", () => {
    // Two bytes per accented character and four per emoji. Counting characters instead would
    // let a paste through the client cap and come back from the route as a 413.
    const text = `{"name":"${"é".repeat(10)}"}`;
    const reading = readPaste(text, MAX_LOCKFILE_CHARACTERS);

    expect(text.length).toBe(21);
    expect(reading.byteSize).toBe(31);
    expect(readPaste("🔒", MAX_LOCKFILE_CHARACTERS).byteSize).toBe(4);
  });

  test("a paste exactly at the cap is sent and one byte over is refused with both numbers", () => {
    const atCap = readPaste("12345678", 8);
    expect(atCap.isOverCap).toBe(false);
    expect(refusePaste(atCap)).toBeNull();

    const overCap = readPaste("123456789", 8);
    expect(overCap.isOverCap).toBe(true);
    const refusal = refusePaste(overCap);
    expect(refusal?.reason).toBe("invalid_input");
    expect(refusal?.message).toContain("9 bytes");
    expect(refusal?.message).toContain("cap is 8 bytes");
    expect(refusal?.message).toContain("Nothing was sent");
  });

  test("the refusal states the real cap, so a reader is not told to guess it", () => {
    const reading = readPaste("x".repeat(MAX_LOCKFILE_CHARACTERS + 1), MAX_LOCKFILE_CHARACTERS);
    expect(refusePaste(reading)?.message).toContain("4,194,304");
  });
});

describe("orderScanRows", () => {
  const exposedDeep = buildRow({ verdict: "exposed", packageKey: "npm:deep", depth: 4 });
  const exposedDirect = buildRow({ verdict: "exposed", packageKey: "npm:direct", depth: 1 });
  const underAdvisory = buildRow({
    packageKey: "npm:under-advisory",
    packageAdvisories: [{ advisoryId: "GHSA-0001", publishedAtMs: null, summary: null }],
  });
  const unpinned = buildRow({ packageKey: "npm:unpinned", version: null, versionKey: null });
  const absent = buildRow({ packageKey: "npm:absent", coverage: "absent" });
  const cleared = buildRow({ verdict: "not_exposed", packageKey: "npm:cleared", depth: 0 });

  test("worst first, and an undecided row under an advisory outranks the rest of the undecided", () => {
    const ordered = orderScanRows([cleared, absent, unpinned, underAdvisory, exposedDeep, exposedDirect]);

    expect(ordered.map((row) => row.packageKey)).toEqual([
      "npm:direct",
      "npm:deep",
      "npm:under-advisory",
      "npm:unpinned",
      "npm:absent",
      "npm:cleared",
    ]);
  });

  test("no row is dropped or merged, whatever the order", () => {
    const rows = [cleared, absent, unpinned, underAdvisory, exposedDeep, exposedDirect];
    expect(orderScanRows(rows)).toHaveLength(rows.length);
    // The input is left alone: the table reads the returned array, and a sort in place would
    // reorder the response object the rest of the surface is still reading from.
    expect(rows[0]).toBe(cleared);
  });

  test("a dependency with no known depth sorts last rather than above the direct ones", () => {
    // The parser writes -1 for a format that carries no tree position. As a number that is
    // below every real depth, which would put the least known rows where the closest ones go.
    const unknownDepth = buildRow({ packageKey: "npm:no-depth", depth: -1 });
    const deep = buildRow({ packageKey: "npm:deep", depth: 9 });

    expect(orderScanRows([unknownDepth, deep]).map((row) => row.packageKey)).toEqual([
      "npm:deep",
      "npm:no-depth",
    ]);
  });

  test("a runtime dependency comes before a dev-only one at the same depth", () => {
    const devOnly = buildRow({ packageKey: "npm:tooling", isDevOnly: true });
    const runtime = buildRow({ packageKey: "npm:shipped", isDevOnly: false });

    expect(orderScanRows([devOnly, runtime]).map((row) => row.packageKey)).toEqual([
      "npm:shipped",
      "npm:tooling",
    ]);
  });
});

describe("chooseHeadlineReading", () => {
  test("never leads with a zero exposure count while rows are undecided", () => {
    const headline = chooseHeadlineReading(
      buildReport({ undecided: [buildRow(), buildRow()], clearedCount: 10 }),
    );

    expect(headline.value).toBe(2);
    expect(headline.unit).toBe("of 12 undecided");
  });

  test("leads with exposures when there are any", () => {
    const headline = chooseHeadlineReading(
      buildReport({
        exposed: [buildRow({ verdict: "exposed" })],
        undecided: [buildRow()],
        clearedCount: 8,
      }),
    );

    expect(headline.value).toBe(1);
    expect(headline.unit).toBe("of 10 exposed");
  });

  test("reads as cleared only when every dependency was decided", () => {
    const headline = chooseHeadlineReading(buildReport({ clearedCount: 6 }));
    expect(headline).toEqual({ value: 6, unit: "of 6 cleared" });
  });

  test("a lockfile with nothing in it reads as nothing read, not as cleared", () => {
    const report = buildReport({ dependencyCount: 0 });

    // The route answers not_exposed here: zero dependencies were all cleared. That is true and
    // it is also the exact shape of a false negative, so the headline counts what was read.
    expect(report.answer.verdict).toBe("not_exposed");
    expect(isEmptyScan(report)).toBe(true);
    expect(chooseHeadlineReading(report)).toEqual({ value: 0, unit: "dependencies read" });
  });
});

describe("describeScanStatus", () => {
  test("a failed request never announces a tally", () => {
    const spoken = describeScanStatus({
      kind: "failed",
      failure: { reason: "graph_unavailable", message: "The graph could not be opened." },
    });

    expect(spoken).toContain("no dependency was decided");
    expect(spoken).toContain("The graph could not be opened.");
    expect(spoken).not.toContain("cleared");
  });

  test("idle and submitting say nothing, because the screen already does", () => {
    expect(describeScanStatus({ kind: "idle" })).toBe("");
    expect(describeScanStatus({ kind: "submitting" })).toBe("");
  });

  test("an answer is announced with its verdict and its three counts", () => {
    const report = buildReport({
      exposed: [buildRow({ verdict: "exposed" })],
      undecided: [buildRow(), buildRow()],
      clearedCount: 7,
    });

    const spoken = describeScanStatus({ kind: "answered", report, scannedText: "{}" });
    expect(spoken).toContain("Exposed");
    expect(spoken).toContain("1 exposed, 2 undecided and 7 cleared");
    expect(spoken).toContain("10 dependencies");
  });

  test("an empty lockfile is announced as nothing checked", () => {
    const report = buildReport({ dependencyCount: 0 });
    expect(describeScanStatus({ kind: "answered", report, scannedText: "{}" })).toBe(
      "Nothing was checked: the file parsed as npm-lock-v2 and held no dependency entry.",
    );
  });
});

describe("decodeScanReport", () => {
  test("a well formed payload decodes to the same verdict and rows", () => {
    const report = buildReport({ exposed: [buildRow({ verdict: "exposed" })], clearedCount: 3 });
    const decoded = decodeScanReport(report);

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.answer.verdict).toBe("exposed");
    expect(decoded.value.answer.evidence.exposed).toHaveLength(1);
    expect(decoded.value.answer.evidence.clearedCount).toBe(3);
  });

  test("a payload whose undecided rows went missing is a failure, not a partial answer", () => {
    const report = buildReport({ undecided: [buildRow()] });
    const { counts, exposed, clearedCount } = report.answer.evidence;
    const payload: unknown = {
      ...report,
      // Every field but the undecided rows, which is what a truncating proxy or a renamed
      // upstream field would leave behind.
      answer: { ...report.answer, evidence: { counts, exposed, clearedCount } },
    };

    const decoded = decodeScanReport(payload);
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.failure.reason).toBe("internal");
    expect(decoded.failure.message).toContain("answer.evidence.unknown");
  });

  test("a limit kind this page does not know is refused rather than dropped", () => {
    const report = buildReport({ undecided: [buildRow()] });
    const payload: unknown = {
      ...report,
      answer: { ...report.answer, limits: [{ kind: "moon_phase" }] },
    };

    expect(decodeScanReport(payload).ok).toBe(false);
  });

  test("a failure envelope is not read as an answer", () => {
    expect(decodeScanReport({ ok: false, error: { reason: "timeout", message: "too slow" } }).ok).toBe(
      false,
    );
  });
});

describe("readScanFailure", () => {
  test("the route's own account of a refusal is carried through unchanged", () => {
    const failure = readScanFailure(413, {
      ok: false,
      error: {
        reason: "invalid_input",
        message:
          "[POST /api/scan] the uploaded lockfile is over the 4194304 byte cap and was refused without being parsed",
        context: { overCap: true },
      },
    });

    expect(failure.reason).toBe("invalid_input");
    expect(failure.status).toBe(413);
    expect(failure.message).toContain("over the 4194304 byte cap");
  });

  test("a body it cannot read still produces a failure naming the status", () => {
    const failure = readScanFailure(502, "<html>a proxy wrote this</html>");
    expect(failure.reason).toBe("internal");
    expect(failure.message).toContain("502");
  });
});

describe("classifyFailureAudience", () => {
  test("only a refusal about the file is put under the field", () => {
    expect(classifyFailureAudience({ reason: "invalid_input", message: "bad json" })).toBe("file");
    expect(classifyFailureAudience({ reason: "unsupported", message: "unknown format" })).toBe(
      "file",
    );
    // Telling a reader to check their lockfile because the graph is down sends them to fix the
    // one thing that was not wrong.
    expect(classifyFailureAudience({ reason: "graph_unavailable", message: "no graph" })).toBe(
      "tool",
    );
    expect(classifyFailureAudience({ reason: "timeout", message: "slow" })).toBe("tool");
  });
});

describe("the sentences under the answer", () => {
  test("a repeated limit is stated once, because the notice keys its list on the sentence", () => {
    const sentences = describeReportLimits(
      buildReport({
        limits: [
          { kind: "package_absent", subjectKey: "npm:left-pad" },
          { kind: "package_absent", subjectKey: "npm:left-pad" },
          { kind: "package_absent", subjectKey: "npm:chalk" },
        ],
      }),
      MAX_LIMIT_SENTENCES,
    );

    expect(sentences).toHaveLength(2);
    expect(sentences[0]).toContain("npm:left-pad");
    expect(sentences[1]).toContain("npm:chalk");
  });

  test("the reasons carried by the rows are stated, not only the answer-level ones", () => {
    // The live route answers an all-absent lockfile with an empty answer-level list and one
    // limit per row. Reading only the answer level renders "the reason was not recorded" over a
    // response that recorded one per dependency, which is the notice calling itself a defect.
    const report = buildReport({
      undecided: [
        buildRow({
          packageKey: "npm:@babel/core",
          limits: [{ kind: "package_absent", subjectKey: "npm:@babel/core:7.24.0" }],
        }),
      ],
    });

    expect(report.answer.limits).toHaveLength(0);
    const sentences = describeReportLimits(report, MAX_LIMIT_SENTENCES);
    expect(sentences).toHaveLength(1);
    expect(sentences[0]).toContain("npm:@babel/core:7.24.0");
  });

  test("past the cap the remainder is counted, never dropped", () => {
    const undecided = ["a", "b", "c", "d", "e", "f", "g"].map((name) =>
      buildRow({
        packageKey: `npm:${name}`,
        limits: [{ kind: "package_absent", subjectKey: `npm:${name}` }],
      }),
    );

    const sentences = describeReportLimits(buildReport({ undecided }), MAX_LIMIT_SENTENCES);
    expect(sentences).toHaveLength(MAX_LIMIT_SENTENCES + 1);
    expect(sentences[MAX_LIMIT_SENTENCES]).toBe(
      "3 more dependencies each carry a reason of their own, stated on their row.",
    );
  });

  test("a table that lists everything it was given says nothing about caps", () => {
    expect(describeReportingCaps(buildReport({ undecided: [buildRow()] }).reporting)).toBeNull();
  });

  test("a capped table says how many rows are missing and that the counts are not", () => {
    const capped = describeReportingCaps(
      buildReport({
        exposed: [buildRow({ verdict: "exposed" })],
        reporting: { exposedReported: 200, exposedTotal: 431, rowCap: 200 },
      }).reporting,
    );

    expect(capped).toContain("200 of 431 exposed rows");
    expect(capped).toContain("The counts above are complete.");
  });

  test("nothing skipped reads as null, so the receipt states it in its own words", () => {
    expect(describeSkipped({ unpinnedCount: 0, unparsableLineCount: 0, truncatedCount: 0 })).toBeNull();
  });

  test("every kind of skipped entry is named with its count", () => {
    expect(
      describeSkipped({ unpinnedCount: 2, unparsableLineCount: 3, truncatedCount: 4 }),
    ).toBe(
      "Skipped 2 without an exact version, 3 on a line it could not read, 4 past the dependency cap.",
    );
  });

  test("the caption says cleared rows are counted and not listed", () => {
    expect(describeRowsCaption(buildReport({ undecided: [buildRow()], clearedCount: 5 }))).toContain(
      "5 cleared dependencies are counted in the readout and not listed here",
    );
    // With nothing cleared there is nothing to disclose, and a "0 cleared" clause would read as
    // a finding of its own.
    expect(describeRowsCaption(buildReport({ undecided: [buildRow()] }))).toBe(
      "Every dependency the scan could not clear, worst first.",
    );
  });
});

describe("summariseAdvisories", () => {
  test("what does not fit in a row is counted, never silently dropped", () => {
    const references = ["GHSA-1", "GHSA-2", "GHSA-3", "GHSA-4"].map((advisoryId) => ({
      advisoryId,
      publishedAtMs: null,
      summary: null,
    }));

    const summary = summariseAdvisories(references, MAX_ADVISORY_CHIPS_PER_ROW);
    expect(summary.shown).toHaveLength(MAX_ADVISORY_CHIPS_PER_ROW);
    expect(summary.omittedCount).toBe(references.length - MAX_ADVISORY_CHIPS_PER_ROW);
  });

  test("a short list is shown whole with nothing omitted", () => {
    const summary = summariseAdvisories(
      [{ advisoryId: "GHSA-1", publishedAtMs: null, summary: null }],
      MAX_ADVISORY_CHIPS_PER_ROW,
    );

    expect(summary.shown).toHaveLength(1);
    expect(summary.omittedCount).toBe(0);
  });
});
