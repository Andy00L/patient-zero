/**
 * Scans one checked-out project tree for supply chain persistence indicators.
 *
 * Usage:
 *   bun run scan:local -- --path <directory>              prints the plan, reads nothing
 *   bun run scan:local -- --path <directory> --consent    runs the scan
 *
 * Three properties this script is answerable for. They are security properties, not
 * preferences (plan.md section 11).
 *
 *   1. OPT IN PER RUN. `consentGiven` is true only when the human typed --consent on
 *      this invocation. It is never defaulted, and it is never read from the
 *      environment, so no stale shell variable and no inherited CI variable can turn a
 *      filesystem walk on. Without the flag this script prints what it would read and
 *      exits before anything touches the filesystem.
 *
 *   2. READ ONLY. Nothing here writes, moves, deletes, or executes anything inside the
 *      scanned tree. There is no write call in this file, and the scanner it calls only
 *      opens files for reading.
 *
 *   3. NO CONTENT IN THE OUTPUT. Every printed fact comes from `ScanReport`, which is
 *      safe to print by construction: `rootRelativeLabel` is the basename of the
 *      resolved root, every finding path is root relative, and the matched line itself
 *      is deliberately absent from `ScanFinding` because a matched line can hold a
 *      token. So the output carries no absolute path, no file content, and no secret,
 *      and it can be pasted into an issue as it stands.
 *      sourceRef: src/lib/scanner/persistence.ts, types ScanReport and ScanFinding.
 *
 * A capped scan that printed "no findings" would be a false clean bill of health, so
 * truncation is reported on its own line and changes the exit code.
 *
 * Errors are values everywhere below. Only `runLocalScan` decides an exit code, and
 * only the last two lines of this file exit the process.
 */

import { basename, resolve } from "node:path";

import { type Failure, type Result, fail, succeed } from "@/lib/result";
import { type IndicatorSeverity, PERSISTENCE_INDICATORS } from "@/lib/scanner/indicators";
import {
  type ScanFinding,
  type ScanReport,
  type ScanTruncationReason,
  scanForPersistence,
} from "@/lib/scanner/persistence";

/** The scan ran, coverage was complete, and no high severity indicator matched. */
const EXIT_CLEAN = 0;

/** The scan did not run: bad arguments, no consent, or a root the scanner refused. */
const EXIT_NOT_RUN = 1;

/** The scan ran and at least one high severity indicator matched. */
const EXIT_HIGH_SEVERITY_FOUND = 2;

/**
 * The scan ran, nothing high severity matched, and a cap cut the walk short. Separate
 * from EXIT_CLEAN because an incomplete walk cannot support "this tree is clean", and a
 * CI job that treated it as a pass would be trusting a partial answer.
 */
const EXIT_INCOMPLETE = 3;

/**
 * Print order for severities. Unit: sort rank, lowest first. High severity leads
 * because it is the only class that changes the exit code.
 */
const SEVERITY_PRINT_RANK: Record<IndicatorSeverity, number> = { high: 0, medium: 1, low: 2 };

/** The flag that turns the walk on. Typed per run, by a human, and nowhere else. */
const CONSENT_FLAG = "--consent";

/** The flag naming the tree to walk. There is no default: an unstated root is refused. */
const PATH_FLAG = "--path";

const USAGE_LINE = `usage: bun run scan:local -- ${PATH_FLAG} <directory> [${CONSENT_FLAG}]`;

type ScanArguments = {
  /** Absolute path, resolved from what the human typed against the working directory. */
  rootPath: string;
  /** True only when CONSENT_FLAG was present in this invocation's arguments. */
  consentGiven: boolean;
};

type SeverityCounts = Record<IndicatorSeverity, number>;

async function runLocalScan(argumentValues: readonly string[]): Promise<number> {
  const parsed = parseArguments(argumentValues);
  if (!parsed.ok) {
    reportFailure("arguments", parsed.failure);
    return EXIT_NOT_RUN;
  }

  // The plan is printed before the consent check so the human sees exactly what the
  // flag would authorise, rather than being asked to authorise an unnamed action.
  printScanPlan(parsed.value);

  if (!parsed.value.consentGiven) {
    console.error(
      `[runLocalScan] no ${CONSENT_FLAG} flag, so nothing was read. This scan is opt in per run: ` +
        `add ${CONSENT_FLAG} to the command above to authorise reading the tree named in the plan.`,
    );
    return EXIT_NOT_RUN;
  }

  const scanned = await scanForPersistence({
    rootPath: parsed.value.rootPath,
    consentGiven: parsed.value.consentGiven,
  });
  if (!scanned.ok) {
    reportFailure("scan", scanned.failure);
    return EXIT_NOT_RUN;
  }

  const report = scanned.value;
  const counts = countBySeverity(report.findings);

  printScanReport(report, counts);
  printFindings(report.findings);

  if (counts.high > 0) {
    console.error(
      `[runLocalScan] ${counts.high} high severity indicator(s) matched. Treat the paths above as ` +
        "compromised until each one is explained, and do not run install scripts in this tree.",
    );
    return EXIT_HIGH_SEVERITY_FOUND;
  }

  if (report.truncated.reason !== null) {
    console.error(
      `[runLocalScan] INCOMPLETE SCAN (${report.truncated.reason}): no high severity indicator matched the ` +
        "part of the tree that was read, which is not the same as a clean tree. Narrow the root and rerun.",
    );
    return EXIT_INCOMPLETE;
  }

  console.log(
    `[runLocalScan] scan complete over ${report.filesVisited} file(s), no high severity indicator matched`,
  );
  return EXIT_CLEAN;
}

/**
 * Parses the arguments.
 *
 * Unknown flags are refused rather than ignored, because a mistyped consent flag that
 * was silently dropped would read as "the human declined" on a run they meant to
 * authorise, and a mistyped path flag would scan the wrong tree.
 */
function parseArguments(argumentValues: readonly string[]): Result<ScanArguments, Failure> {
  let rawRootPath: string | null = null;
  let consentGiven = false;

  for (let index = 0; index < argumentValues.length; index += 1) {
    const argument = argumentValues[index];

    if (argument === CONSENT_FLAG) {
      consentGiven = true;
      continue;
    }

    if (argument === PATH_FLAG) {
      const value = argumentValues[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return fail("invalid_input", `[parseArguments] ${PATH_FLAG} needs a directory. ${USAGE_LINE}`);
      }
      rawRootPath = value;
      index += 1;
      continue;
    }

    return fail(
      "invalid_input",
      `[parseArguments] unknown argument "${argument}". ${USAGE_LINE}`,
    );
  }

  if (rawRootPath === null) {
    return fail(
      "invalid_input",
      `[parseArguments] ${PATH_FLAG} is required and has no default, so no tree is scanned by accident. ${USAGE_LINE}`,
    );
  }

  // The scanner refuses a relative root on purpose, so the resolution happens here,
  // once, against the working directory the human ran the command in.
  return succeed({ rootPath: resolve(rawRootPath), consentGiven });
}

/**
 * States what the scan would read, in terms that carry no absolute path.
 *
 * The basename is the same label the report will carry, so the plan and the report name
 * the same tree without either of them printing where it sits on this machine.
 */
function printScanPlan(argumentValues: ScanArguments): void {
  const rows: readonly [string, string][] = [
    ["scan root", basename(argumentValues.rootPath)],
    ["indicators", `${PERSISTENCE_INDICATORS.length} from the catalog`],
    ["mode", "read only, no file is written, moved, deleted, or executed"],
    ["reported", "indicator id, severity, root relative path, line number, title, reason"],
    ["never reported", "file contents, secrets, tokens, absolute paths"],
    ["consent", argumentValues.consentGiven ? `given by ${CONSENT_FLAG}` : "absent, nothing is read"],
  ];

  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  console.log("[printScanPlan] local persistence scan plan");
  for (const [label, value] of rows) {
    console.log(`[printScanPlan]   ${label.padEnd(labelWidth)}  ${value}`);
  }
}

/** The counters a human reads to judge whether the scan covered what they meant. */
function printScanReport(report: ScanReport, counts: SeverityCounts): void {
  const rows: readonly [string, string][] = [
    ["scan root", report.rootRelativeLabel],
    ["files visited", String(report.filesVisited)],
    ["bytes read", String(report.bytesRead)],
    ["unreadable paths", String(report.unreadablePathCount)],
    ["paths outside root", String(report.skippedOutsideRootCount)],
    ["duration ms", String(report.durationMs)],
    ["coverage", describeCoverage(report.truncated.reason)],
    [
      "findings",
      `${report.findings.length} total, high ${counts.high}, medium ${counts.medium}, low ${counts.low}`,
    ],
  ];

  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  console.log("[printScanReport] persistence scan report");
  for (const [label, value] of rows) {
    console.log(`[printScanReport]   ${label.padEnd(labelWidth)}  ${value}`);
  }

  if (report.truncated.reason !== null) {
    console.warn(
      `[printScanReport] WARNING: the walk stopped at a cap (${report.truncated.reason}), so part of the ` +
        "tree was never read. An indicator absent from the list below may still be present in the tree.",
    );
  }
  if (report.unreadablePathCount > 0) {
    console.warn(
      `[printScanReport] WARNING: ${report.unreadablePathCount} path(s) could not be read, usually a ` +
        "permission denial. Those paths were not examined.",
    );
  }
  if (report.skippedOutsideRootCount > 0) {
    console.warn(
      `[printScanReport] NOTE: ${report.skippedOutsideRootCount} path(s) resolved outside the scan root ` +
        "and were skipped, which is the symlink escape guard doing its job.",
    );
  }
}

/**
 * Prints one block per finding, highest severity first.
 *
 * Every field printed here comes from `ScanFinding`, which holds no file content: the
 * line number locates the match so a human can open the file themselves, and the
 * explanation is fixed catalog text rather than anything read off disk.
 */
function printFindings(findings: readonly ScanFinding[]): void {
  if (findings.length === 0) {
    console.log("[printFindings] no indicator matched");
    return;
  }

  const ordered = [...findings].sort(compareFindings);

  console.log(`[printFindings] ${ordered.length} finding(s), highest severity first`);
  ordered.forEach((finding, findingIndex) => {
    const location =
      finding.lineNumber === null ? finding.relativePath : `${finding.relativePath}:${finding.lineNumber}`;
    const packageSuffix = finding.packageName === null ? "" : ` package=${finding.packageName}`;
    console.log(
      `[printFindings]   ${findingIndex + 1}. [${finding.severity}] ${finding.indicatorId}` +
        ` at ${location}${packageSuffix}`,
    );
    console.log(`[printFindings]      what  ${finding.title}`);
    console.log(`[printFindings]      why   ${finding.explanation}`);
  });
}

/** High severity first, then by path and line, so two runs over one tree print alike. */
function compareFindings(left: ScanFinding, right: ScanFinding): number {
  const bySeverity = SEVERITY_PRINT_RANK[left.severity] - SEVERITY_PRINT_RANK[right.severity];
  if (bySeverity !== 0) return bySeverity;

  const byPath = left.relativePath.localeCompare(right.relativePath);
  if (byPath !== 0) return byPath;

  return (left.lineNumber ?? 0) - (right.lineNumber ?? 0);
}

function countBySeverity(findings: readonly ScanFinding[]): SeverityCounts {
  const counts: SeverityCounts = { high: 0, medium: 0, low: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

/** Says plainly whether the walk finished, and which cap stopped it when it did not. */
function describeCoverage(reason: ScanTruncationReason): string {
  return reason === null ? "complete, every eligible file was read" : `INCOMPLETE, stopped at ${reason}`;
}

/** Prints a Failure in full, then the next thing to try. Same shape as hydra-health. */
function reportFailure(stage: string, failure: Failure): void {
  console.error(`[reportFailure] FAILED at ${stage}, reason=${failure.reason}`);
  console.error(`[reportFailure] ${failure.message}`);
  if (failure.context !== undefined) {
    const pairs = Object.entries(failure.context).map(([name, value]) => `${name}=${String(value)}`);
    if (pairs.length > 0) console.error(`[reportFailure] context ${pairs.join(" ")}`);
  }
  const remedy = describeRemedy(failure);
  if (remedy !== null) console.error(`[reportFailure] next step: ${remedy}`);
}

/** Maps a failure reason onto the next thing to try. */
function describeRemedy(failure: Failure): string | null {
  switch (failure.reason) {
    case "invalid_input":
      return USAGE_LINE;
    case "not_found":
      return `check the directory passed to ${PATH_FLAG} exists and is readable`;
    default:
      return null;
  }
}

const exitCode = await runLocalScan(process.argv.slice(2));
process.exit(exitCode);
