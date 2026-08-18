import type { Stats } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, relative, sep } from "node:path";

import {
  LOCAL_SCAN_REFUSALS,
  LOCAL_SCAN_REQUEST_SCHEMA,
  type LocalScanLimit,
  type LocalScanRefusalKind,
  type LocalScanSuccessBody,
  SEVERITY_RANK,
  isLocalScanGateOpen,
} from "@/components/local/scan-contract";
import type { Verdict } from "@/lib/analysis/abstention";
import { jsonFailure, jsonOk, runRoute } from "@/lib/api/http";
import { formatCount } from "@/lib/format";
import type { IndicatorSeverity } from "@/lib/scanner/indicators";
import {
  type ScanFinding,
  type ScanReport,
  type ScanTruncationReason,
  scanForPersistence,
} from "@/lib/scanner/persistence";
import { type Failure, type FailureReason, type Result, fail, fromThrowing, fromThrowingSync, succeed } from "@/lib/result";

/**
 * POST /api/local-scan
 *
 * "Is one of the known supply-chain persistence artifacts sitting in this directory?" The body
 * carries an absolute path and an explicit consent flag; the answer names which indicators
 * matched, where, and what the walk could not cover.
 *
 * This route reads the filesystem of whatever machine runs it, which makes it the widest trust
 * boundary in the project. Every rule below is load-bearing, so they are stated in full rather
 * than left to be inferred from the code.
 *
 * 1. Gated by environment, closed by default. The handler answers 404 unless
 *    HYDRA_LOCAL_SCAN=enabled is set for the server process (see `isLocalScanGateOpen` in
 *    src/components/local/scan-contract.ts). A 404 rather than a 403 because on a deployment
 *    with the variable unset this route should not appear to exist at all. The gate is checked
 *    before the body is read, so a closed gate parses no untrusted input whatsoever.
 * 2. Read-only. The only filesystem calls in this file are `realpath` and `stat`, and the only
 *    ones in the library it calls are `realpath`, `stat`, `readdir` and `open` for reading.
 *    Nothing writes, moves, deletes, chmods, spawns or executes, and no scanned byte is ever
 *    parsed as code.
 * 3. Opt-in per request. There is no default path, no cached path, no timer and no GET handler.
 *    A GET could be prefetched by a browser, a link checker or a crawler, which would turn a
 *    page visit into a filesystem walk; POST cannot be prefetched and is never cached (Next 16
 *    caches no route handler by default, and never a POST). The consent flag is a literal
 *    `true` in the request schema, so no request shape exists that scans without asking.
 * 4. The path is untrusted input and is contained before it is used. It is resolved to its real
 *    path first, so `..` segments and symlink chains are collapsed, and the containment test
 *    then runs on the real path. A drive root, a home directory, a shared temporary directory
 *    and a WSL /mnt/<drive> mount are refused by name; everything outside the directory the
 *    server was started in is refused by default. The library re-resolves and re-checks every
 *    file it is about to open against the same root, which closes the window between this
 *    check and the walk.
 * 5. No content crosses this boundary, in either direction. A finding carries an indicator id,
 *    a severity, a root-relative path, a line number and the catalog's own fixed explanation.
 *    It never carries a matched line, a snippet, an absolute path, an environment value or a
 *    token, not even truncated. Assume every file that matches is a credential stealer holding
 *    live credentials, because that is exactly what several of these indicators look for.
 * 6. Every wire message is a fixed string from LOCAL_SCAN_REFUSALS. The requested path is never
 *    echoed back, in any form, so a refusal cannot be used to map the machine's layout. That
 *    also rules out `fromThrowing` around the filesystem calls: a Node fs error message embeds
 *    the absolute path it failed on, so each one catches locally, reads the errno and drops the
 *    message. Same reasoning as the library, src/lib/scanner/persistence.ts rule 4.
 * 7. Nothing is logged. Not the path, not a count, not a finding. The route has no log line at
 *    all, which is the only version of "never log content" with no room for a mistake in it.
 * 8. Bounded, and honest when the bound was hit. The library caps files visited, bytes per file,
 *    total bytes, directory depth and finding count. Any cap that fired, any unreadable path and
 *    any symlink that left the root becomes a limit in the response, and a single limit is
 *    enough to make the verdict `unknown` rather than `not_exposed`. A scan that stopped early
 *    and found nothing has not found nothing, and reporting one as clean is the single failure
 *    this feature must not have.
 *
 * The contract, the refusal kinds and their copy live in src/components/local/scan-contract.ts,
 * next to the surface, because the route, the page and the console all have to agree on them.
 */

const ROUTE_NAME = "POST /api/local-scan";

/**
 * Cap on the request body, in bytes. The body carries one path and one boolean, and the path
 * itself is capped at PATH_MAX by the schema, so this leaves room for JSON punctuation only.
 */
const MAX_REQUEST_BYTES = 8 * 1024;

/** HTTP status for a closed gate. See rule 1 in the doc block above. */
const GATE_CLOSED_STATUS = 404;

/** The POSIX shared temporary directory, checked alongside whatever `tmpdir()` reports. */
const POSIX_SHARED_TEMP = "/tmp";

/**
 * WSL mounts the Windows filesystem under /mnt/<drive>. Those paths are the other side of the
 * machine, and coding-standards section 3 puts them out of scope without explicit authorization.
 */
const FOREIGN_MOUNT_PATTERN = /^\/mnt\/[a-z](?:\/|$)/i;

/**
 * The `FailureReason` each refusal reports, which is what decides the HTTP status through
 * `failureStatus`. Most are `invalid_input` (400): the caller asked for something this route
 * will not do. `path_not_found` is the one 404 that means what a 404 usually means, and the
 * closed gate overrides its status explicitly below.
 *
 * `permission_denied` is `invalid_input` rather than a 403 on purpose. A 403 would say the
 * caller is forbidden, when in fact the server process cannot read the path it was handed.
 *
 * sourceRef: src/lib/api/http.ts (failureStatus), src/lib/result.ts (FailureReason)
 */
const REFUSAL_REASONS: Record<LocalScanRefusalKind, FailureReason> = {
  gate_closed: "unsupported",
  malformed_request: "invalid_input",
  blank_path: "invalid_input",
  relative_path: "invalid_input",
  filesystem_root: "invalid_input",
  home_directory: "invalid_input",
  shared_temp: "invalid_input",
  foreign_mount: "invalid_input",
  outside_root: "invalid_input",
  path_not_found: "not_found",
  not_a_directory: "invalid_input",
  permission_denied: "invalid_input",
  scan_root_changed: "internal",
};

/**
 * What each cap means for the person reading the result.
 *
 * The cap values themselves are private to src/lib/scanner/persistence.ts, so these sentences
 * name the cap that fired rather than quoting a number. A number copied here would be a second
 * source of truth and would drift the first time the library is tuned.
 *
 * sourceRef: src/lib/scanner/persistence.ts (ScanTruncationReason)
 */
const CAP_DESCRIPTIONS: Record<Exclude<ScanTruncationReason, null>, string> = {
  file_cap: "The walk stopped at its file-count cap, so files past that point were never read.",
  byte_cap: "The walk stopped at its total-bytes cap, so files past that point were never read.",
  depth_cap: "The walk stopped at its directory-depth cap, so anything deeper was never read.",
  finding_cap:
    "The finding list stopped at its cap, so this tree holds more matches than the ones listed.",
};

/**
 * The one place a refusal's wire shape is built: the fixed message from the copy table, plus
 * the kind in `context` so the surface can name the reason instead of printing one generic
 * error, and so a test can assert on the kind rather than on prose.
 */
function refusalFailure(kind: LocalScanRefusalKind): Failure {
  return {
    reason: REFUSAL_REASONS[kind],
    message: `[${ROUTE_NAME}] ${LOCAL_SCAN_REFUSALS[kind].title}`,
    context: { refusal: kind },
  };
}

/** The same refusal as a Result, for the helpers below that return one. */
function refuse(kind: LocalScanRefusalKind): Result<never, Failure> {
  const failure = refusalFailure(kind);
  return fail(failure.reason, failure.message, { context: failure.context });
}

/** A closed gate answers 404; every other refusal takes the status its reason maps to. */
function respondWithFailure(failure: Failure): Response {
  const isGateClosed = failure.context?.refusal === "gate_closed";
  return jsonFailure(failure, isGateClosed ? GATE_CLOSED_STATUS : undefined);
}

export async function POST(request: Request): Promise<Response> {
  return runRoute(ROUTE_NAME, async () => {
    // First, before the body is touched. A machine that has not opted in reads no input.
    if (!isLocalScanGateOpen(process.env)) {
      return respondWithFailure(refusalFailure("gate_closed"));
    }

    const requested = await readScanRequest(request);
    if (!requested.ok) return respondWithFailure(requested.failure);

    // The directory the server process was started in. On a checkout this is the project root,
    // which is the same value the surface offers as the default path.
    const contained = await containScanRoot(requested.value.path, process.cwd());
    if (!contained.ok) return respondWithFailure(contained.failure);

    const report = await scanForPersistence({
      rootPath: contained.value,
      consentGiven: true,
    });
    if (!report.ok) {
      // Every refusal the library can return was already decided above, against this same real
      // path, so arriving here means the tree changed between the check and the walk. Its own
      // message is path-free by design but is still not forwarded: every message this route
      // sends is a fixed string, which is a property that holds only if it has no exceptions.
      return respondWithFailure(refusalFailure("scan_root_changed"));
    }

    return jsonOk(summarizeReport(report.value));
  });
}

/**
 * Reads the request body into the request schema.
 *
 * The body is capped twice, by the declared `Content-Length` and again by what actually
 * arrived, because a declared length can be absent or a lie. Both the read failure and the
 * schema failure collapse into one fixed refusal: a zod issue path is safe to show, but the
 * body it describes came from the network and this route quotes nothing it was sent.
 */
async function readScanRequest(
  request: Request,
): Promise<Result<{ path: string }, Failure>> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const declared = Number.parseInt(declaredLength, 10);
    if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
      return refuse("malformed_request");
    }
  }

  const read = await fromThrowing(
    "invalid_input",
    `[${ROUTE_NAME}] the request body could not be read`,
    () => request.text(),
  );
  if (!read.ok) return refuse("malformed_request");
  if (read.value.length > MAX_REQUEST_BYTES) return refuse("malformed_request");

  const decoded = fromThrowingSync(
    "invalid_input",
    `[${ROUTE_NAME}] the request body is not JSON`,
    () => parseJsonBody(read.value),
  );
  if (!decoded.ok) return refuse("malformed_request");

  const parsed = LOCAL_SCAN_REQUEST_SCHEMA.safeParse(decoded.value);
  if (!parsed.success) return refuse("malformed_request");

  return succeed({ path: parsed.data.path });
}

/** `JSON.parse` is typed `any`; this declares the truth about it without a type assertion. */
function parseJsonBody(text: string): unknown {
  return JSON.parse(text);
}

/**
 * Turns a requested path into the one real, contained directory the scan may walk.
 *
 * The order of the checks is the design. Resolution comes first, so `..` segments and symlink
 * chains are already collapsed and every later test runs on a real path. The named locations
 * come next, so the refusal says what is actually wrong instead of "outside the project". On a
 * normal checkout each of them is also outside the project and the generic refusal would be
 * correct but useless; they are not redundant, though, because if this app were ever started
 * from `/` or from a home directory they would be the only checks left standing between a
 * request and a walk of somebody's keys. The default-deny against the server's own directory
 * comes last and catches everything else.
 */
async function containScanRoot(
  requestedPath: string,
  allowedRootPath: string,
): Promise<Result<string, Failure>> {
  const trimmed = requestedPath.trim();
  if (trimmed.length === 0) return refuse("blank_path");
  if (!isAbsolute(trimmed)) return refuse("relative_path");

  const realPath = await resolveRealPath(trimmed);
  if (!realPath.ok) return realPath;

  if (dirname(realPath.value) === realPath.value) return refuse("filesystem_root");
  if (realPath.value === homedir()) return refuse("home_directory");
  for (const tempRoot of await readSharedTempRoots()) {
    if (isAtOrUnder(realPath.value, tempRoot)) return refuse("shared_temp");
  }
  if (FOREIGN_MOUNT_PATTERN.test(realPath.value)) return refuse("foreign_mount");

  // The allowed root is resolved too, so a checkout reached through a symlinked parent compares
  // equal instead of reading as an escape.
  const allowedRoot = await resolveRealPath(allowedRootPath);
  if (!allowedRoot.ok) return refuse("scan_root_changed");
  if (!isAtOrUnder(realPath.value, allowedRoot.value)) return refuse("outside_root");

  const stats = await statPath(realPath.value);
  if (!stats.ok) return stats;
  if (!stats.value.isDirectory()) return refuse("not_a_directory");

  return succeed(realPath.value);
}

/**
 * Resolves a path to its real location, or refuses with the reason the errno gives.
 *
 * Deliberately not wrapped in `fromThrowing`: a Node fs error message embeds the absolute path
 * it failed on, and this route echoes no path back. The errno is read, the message is dropped.
 */
async function resolveRealPath(candidatePath: string): Promise<Result<string, Failure>> {
  try {
    return succeed(await realpath(candidatePath));
  } catch (caught) {
    return refuse(refusalForErrorCode(readErrorCode(caught)));
  }
}

/** `stat` with the same errno handling and the same reason for not using `fromThrowing`. */
async function statPath(candidatePath: string): Promise<Result<Stats, Failure>> {
  try {
    return succeed(await stat(candidatePath));
  } catch (caught) {
    return refuse(refusalForErrorCode(readErrorCode(caught)));
  }
}

/** Reads a Node errno without a type assertion. `in` narrows the value to carry the key. */
function readErrorCode(caught: unknown): string | null {
  if (typeof caught !== "object" || caught === null || !("code" in caught)) return null;
  const { code } = caught;
  return typeof code === "string" ? code : null;
}

/**
 * Maps a filesystem errno onto a refusal the person who typed the path can act on.
 *
 * ENOENT and anything unmapped answer "no directory exists at that path", which is what an
 * unresolvable path means to a caller. A symlink loop and an over-long name land there too:
 * both describe a path that does not name a real directory, and a separate wording for each
 * would add states to the surface without adding an action to take.
 */
function refusalForErrorCode(code: string | null): LocalScanRefusalKind {
  if (code === "EACCES" || code === "EPERM") return "permission_denied";
  if (code === "ENOTDIR") return "not_a_directory";
  return "path_not_found";
}

/**
 * Temporary roots this scan refuses. Both the raw value and its resolved form are returned,
 * because /tmp is a symlink on some systems and the containment test runs on real paths.
 */
async function readSharedTempRoots(): Promise<string[]> {
  const roots: string[] = [];
  for (const candidate of [tmpdir(), POSIX_SHARED_TEMP]) {
    roots.push(candidate);
    const resolved = await resolveRealPath(candidate);
    if (resolved.ok) roots.push(resolved.value);
  }
  return roots;
}

/**
 * True when `candidatePath` is `ancestorPath` itself or sits underneath it.
 *
 * Both arguments must already be real paths, or a symlink defeats the comparison. The first
 * segment of the relative step is tested exactly rather than with `startsWith("..")`, which
 * would refuse a legitimately named `..config` directory inside the root.
 */
function isAtOrUnder(candidatePath: string, ancestorPath: string): boolean {
  if (candidatePath === ancestorPath) return true;
  const step = relative(ancestorPath, candidatePath);
  if (step.length === 0 || isAbsolute(step)) return false;
  return step.split(sep)[0] !== "..";
}

/** Turns the library's report into the wire payload. `jsonOk` adds the `ok` field itself. */
function summarizeReport(report: ScanReport): Omit<LocalScanSuccessBody, "ok"> {
  const limits = collectLimits(report);
  const findings = [...report.findings].sort(compareFindingsWorstFirst);
  const decided = decideScanVerdict(findings.length, limits);

  return {
    rootLabel: report.rootRelativeLabel,
    verdict: decided.verdict,
    rationale: decided.rationale,
    limits,
    findings,
    counts: countBySeverity(findings),
    walk: {
      filesVisited: report.filesVisited,
      bytesRead: report.bytesRead,
      unreadablePathCount: report.unreadablePathCount,
      skippedOutsideRootCount: report.skippedOutsideRootCount,
      durationMs: report.durationMs,
    },
  };
}

/**
 * Every reason this walk cannot support "nothing is here".
 *
 * A skipped symlink counts as a limit even though skipping it is the containment rule working
 * as designed: from the caller's point of view a subtree they can see was not read, and that is
 * the same gap in coverage as a cap firing.
 */
function collectLimits(report: ScanReport): LocalScanLimit[] {
  const limits: LocalScanLimit[] = [];

  const capReason = report.truncated.reason;
  if (capReason !== null) limits.push({ id: capReason, described: CAP_DESCRIPTIONS[capReason] });

  if (report.unreadablePathCount > 0) {
    limits.push({
      id: "unreadable_paths",
      described: `${formatCount(report.unreadablePathCount)} paths could not be read, or their containment could not be decided, and were skipped.`,
    });
  }

  if (report.skippedOutsideRootCount > 0) {
    limits.push({
      id: "skipped_symlinks",
      described: `${formatCount(report.skippedOutsideRootCount)} symlinks resolved outside the scanned directory and were not followed, so those subtrees were never read.`,
    });
  }

  return limits;
}

/**
 * The verdict, on the same rule the graph answers use: `not_exposed` is reachable only when
 * nothing matched AND nothing was left unread.
 *
 * `decideVerdict` in src/lib/analysis/abstention.ts is not reused here because its input is a
 * graph question (a subject key and its slice coverage) and its `not_exposed` sentence talks
 * about a closure in the slice, which would be nonsense about a directory. The discipline is
 * the one that transfers, so it is restated: one limit present is enough to abstain.
 */
function decideScanVerdict(
  findingCount: number,
  limits: readonly LocalScanLimit[],
): { verdict: Verdict; rationale: string } {
  if (findingCount > 0) {
    return {
      verdict: "exposed",
      rationale:
        limits.length > 0
          ? "At least one indicator matched. The walk did not cover the whole tree, so this is a floor, not a total."
          : "At least one indicator matched, and the walk covered the whole tree.",
    };
  }

  if (limits.length > 0) {
    return {
      verdict: "unknown",
      rationale:
        "Nothing matched in what was read, but the walk did not read everything, so absence here is not a result.",
    };
  }

  return {
    verdict: "not_exposed",
    rationale:
      "No indicator in this set matched, and the walk covered the whole tree. The set is the only thing that was checked.",
  };
}

/** Worst severity first, then by path, then by line, so two runs of one tree print alike. */
function compareFindingsWorstFirst(first: ScanFinding, second: ScanFinding): number {
  const bySeverity = SEVERITY_RANK[first.severity] - SEVERITY_RANK[second.severity];
  if (bySeverity !== 0) return bySeverity;
  const byPath = first.relativePath.localeCompare(second.relativePath);
  if (byPath !== 0) return byPath;
  return (first.lineNumber ?? 0) - (second.lineNumber ?? 0);
}

/** Counts per severity. The `Record` annotation is what makes a new severity a compile error. */
function countBySeverity(findings: readonly ScanFinding[]): LocalScanSuccessBody["counts"] {
  const bySeverity: Record<IndicatorSeverity, number> = { high: 0, medium: 0, low: 0 };
  for (const finding of findings) bySeverity[finding.severity] += 1;
  return { bySeverity, total: findings.length };
}
