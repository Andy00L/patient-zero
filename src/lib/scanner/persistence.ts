import type { Dirent } from "node:fs";
import { type FileHandle, open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative } from "node:path";

import {
  type Indicator,
  type IndicatorId,
  type IndicatorSeverity,
  NODE_MODULES_DIRECTORY_NAME,
  PERSISTENCE_INDICATORS,
} from "@/lib/scanner/indicators";
import { type Failure, type Result, fail, succeed } from "@/lib/result";

/**
 * Local persistence scanner: a strictly read-only walk of one checked-out
 * repository, looking for the artifacts the npm worms of 2025 left behind so the
 * payload survived a clean reinstall.
 *
 * The whole module is a trust boundary, because the paths it touches belong to the
 * person running it and not to this project. Four rules hold everywhere below and
 * are the reason several things are done the long way:
 *
 * 1. Read-only. Nothing here writes, moves, deletes, chmods or executes. There is
 *    no child_process, no Bun.spawn, no eval, and no dynamic import of scanned
 *    content. Scanned bytes are data, never code.
 * 2. Opt-in. There is no default root and no fallback to the home directory. The
 *    caller passes an absolute root and an explicit consent flag.
 * 3. Confined. The root is resolved to a real path once, and every file that is
 *    about to be read is resolved and checked against it again. Symlinks that
 *    leave the root are counted and skipped, never followed, because a repository
 *    can legitimately contain a link to ~/.ssh.
 * 4. Never report content. A finding carries a root-relative path, an indicator
 *    id, a line number and a fixed explanation from the catalog. It never carries
 *    the matched line, a snippet, an absolute path or anything that could be
 *    credential material. That also rules out `fromThrowing` around filesystem
 *    calls: a Node fs error message embeds the absolute path it failed on, so
 *    every fs boundary below catches locally and builds a path-free message.
 *
 * The indicator catalog lives in src/lib/scanner/indicators.ts so it can be
 * reviewed as data without reading this walker.
 */

/** Root-relative POSIX path plus one indicator hit. Carries no scanned bytes. */
export type ScanFinding = {
  indicatorId: IndicatorId;
  severity: IndicatorSeverity;
  /** Root-relative POSIX path. Never absolute. */
  relativePath: string;
  /** 1-indexed line of the content match, or null for a path-only indicator. */
  lineNumber: number | null;
  /** The indicator's title and rationale, copied so the UI needs no second lookup. */
  title: string;
  explanation: string;
  /** When the hit is inside node_modules, the package this path belongs to, for graph linkage. */
  packageName: string | null;
};

/**
 * Which cap ended the walk, or null when the tree was covered completely. A
 * non-null reason means the report is a lower bound: "no findings" plus a
 * truncation reason is not a clean bill of health, and the UI must say so.
 */
export type ScanTruncationReason = "file_cap" | "byte_cap" | "depth_cap" | "finding_cap" | null;

export type ScanReport = {
  /** A safe label for the scanned root (its directory name), never the absolute path. */
  rootRelativeLabel: string;
  findings: ScanFinding[];
  filesVisited: number;
  bytesRead: number;
  /** Paths that could not be read or whose containment could not be decided. */
  unreadablePathCount: number;
  /** Symlinks resolving outside the root. Counted, never followed. */
  skippedOutsideRootCount: number;
  truncated: { reason: ScanTruncationReason };
  durationMs: number;
};

export type ScanOptions = {
  /** Absolute path. Required. There is no default. */
  rootPath: string;
  /** Explicit opt-in. The scan refuses to run when false. */
  consentGiven: boolean;
  /** Overrides the catalog. Used by tests; production passes nothing. */
  indicators?: readonly Indicator[];
};

/**
 * Max files the walk visits. Unit: files. Sized so a mid-sized application's full
 * node_modules tree (roughly 30,000 files for a Next.js app of this shape) is
 * covered, while an accidental scan of a huge tree still terminates.
 */
const MAX_FILES_VISITED = 40_000;

/**
 * Max bytes read from one file. Unit: bytes (512 KiB). Every indicator lives in a
 * manifest, an instruction file or a workflow file, and a legitimate one of those
 * is orders of magnitude smaller. A minified payload larger than this is still
 * detected through its install hook in package.json.
 */
const MAX_BYTES_PER_FILE = 512 * 1024;

/** Max bytes read across one scan. Unit: bytes (64 MiB). */
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/**
 * Max directory levels below the root. Unit: directory levels. npm 7 and later
 * hoist dependencies, so real node_modules nesting stays well under this; pnpm
 * stores flat under node_modules/.pnpm.
 */
const MAX_DIRECTORY_DEPTH = 32;

/**
 * Max findings retained. Unit: findings. A worm hit produces a handful; anything
 * near this cap means the pattern set is matching a tree it should not, and the
 * report says so through `truncated` instead of growing without bound.
 */
const MAX_FINDINGS = 500;

/**
 * Directories the walk does not enter, as root-relative patterns in the same
 * grammar the catalog uses. Patterns, not bare names, because the decision depends
 * on where the directory sits:
 *
 * - `.git` is not skipped wholesale. Its packed object store, refs and logs hold
 *   nothing an indicator can match, but `.git/hooks` holds planted pre-commit and
 *   pre-push hooks, which are reported persistence.
 * - `dist`, `build` and friends are listed without a leading double-star segment,
 *   so they are skipped only directly under the root. Inside node_modules those
 *   same names are where a package ships the code its install hook runs.
 * - node_modules is deliberately absent from this list at every depth: the
 *   installed-package indicators live there.
 */
const SKIPPED_DIRECTORY_PATTERNS: readonly string[] = [
  "**/.git/objects",
  "**/.git/refs",
  "**/.git/logs",
  "**/.git/lfs",
  "**/.git/modules",
  "**/.git/info",
  "**/.hg",
  "**/.svn",
  "**/.next",
  "**/.turbo",
  "**/__pycache__",
  "**/.pytest_cache",
  "**/node_modules/.cache",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
  "venv",
  ".venv",
];

/** Label used when the root's directory name is empty. */
const FALLBACK_ROOT_LABEL = "scan-root";

/**
 * Walks `rootPath` and reports persistence indicators. Never writes, never
 * executes, and never leaves the root.
 */
export async function scanForPersistence(options: ScanOptions): Promise<Result<ScanReport, Failure>> {
  const startedAtMs = Date.now();

  // Consent is checked before anything touches the filesystem, so a caller that
  // forgot the flag reads nothing at all.
  if (!options.consentGiven) {
    return fail(
      "invalid_input",
      "[scanForPersistence] the scan is opt-in: consentGiven must be true and nothing is read without it",
    );
  }

  if (options.rootPath.trim() === "") {
    return fail("invalid_input", "[scanForPersistence] rootPath is required and has no default");
  }

  if (!isAbsolute(options.rootPath)) {
    return fail(
      "invalid_input",
      "[scanForPersistence] rootPath must be an absolute path, so the scanned tree never depends on the process working directory",
    );
  }

  const resolvedRoot = await resolveRealPath(options.rootPath);
  if (resolvedRoot === null) {
    return fail("not_found", "[scanForPersistence] the scan root does not exist or cannot be resolved");
  }

  // Refusing the filesystem root and the home directory is a guard against the
  // footgun this scanner exists to avoid: it is meant for one checked-out
  // repository, and a whole-home walk would read paths nobody opted in to.
  if (dirname(resolvedRoot) === resolvedRoot) {
    return fail("invalid_input", "[scanForPersistence] the filesystem root is not a valid scan root");
  }
  if (resolvedRoot === homedir()) {
    return fail(
      "invalid_input",
      "[scanForPersistence] the home directory is not a valid scan root, point the scan at one repository",
    );
  }

  const rootIsDirectory = await checkIsDirectory(resolvedRoot);
  if (!rootIsDirectory) {
    return fail("invalid_input", "[scanForPersistence] the scan root is not a directory");
  }

  const state: ScanState = {
    realRootPath: resolvedRoot,
    indicators: options.indicators ?? PERSISTENCE_INDICATORS,
    // One buffer for the whole scan. Every read slices it down to the bytes it
    // actually got, so reuse cannot surface a previous file's bytes.
    readBuffer: new Uint8Array(MAX_BYTES_PER_FILE),
    findings: [],
    recordedFindingKeys: new Set<string>(),
    filesVisited: 0,
    bytesRead: 0,
    unreadablePathCount: 0,
    skippedOutsideRootCount: 0,
    truncationReason: null,
  };

  await walkDirectoryTree(state);

  return succeed({
    rootRelativeLabel: describeScanRootLabel(resolvedRoot),
    findings: sortFindingsForDisplay(state.findings),
    filesVisited: state.filesVisited,
    bytesRead: state.bytesRead,
    unreadablePathCount: state.unreadablePathCount,
    skippedOutsideRootCount: state.skippedOutsideRootCount,
    truncated: { reason: state.truncationReason },
    durationMs: Date.now() - startedAtMs,
  });
}

/**
 * Maps a root-relative path to the installed package that owns it, or null when
 * the path is not inside a node_modules tree.
 *
 * The last node_modules segment wins, which is what makes nesting and the pnpm
 * store resolve correctly: node_modules/a/node_modules/@scope/b belongs to
 * @scope/b, not to a. Kept pure and exported because the graph linkage depends on
 * it and it must be testable without a filesystem.
 */
export function resolvePackageNameFromRelativePath(relativePath: string): string | null {
  const segments = relativePath.split(posix.sep).filter((segment) => segment !== "");
  const lastMarkerIndex = segments.lastIndexOf(NODE_MODULES_DIRECTORY_NAME);
  if (lastMarkerIndex === -1) return null;

  const firstSegment = segments[lastMarkerIndex + 1];
  if (firstSegment === undefined) return null;

  // npm reserves dot-prefixed entries inside node_modules (.bin, .package-lock.json,
  // .pnpm), so none of them names a package.
  // sourceRef: https://docs.npmjs.com/cli/v11/configuring-npm/folders#node-modules
  if (firstSegment.startsWith(".")) return null;

  if (!firstSegment.startsWith("@")) return firstSegment;

  const scopedName = segments[lastMarkerIndex + 2];
  if (scopedName === undefined) return null;
  return `${firstSegment}/${scopedName}`;
}

/**
 * Whether a root-relative path matches one glob-ish indicator pattern.
 *
 * Grammar, as documented on `Indicator.pathPatterns`: `**` crosses directory
 * separators, `*` matches inside one segment, `?` matches one non-separator
 * character, everything else is literal. Matching is case-insensitive because
 * macOS and Windows filesystems are, so `claude.md` and `CLAUDE.md` are the same
 * file there and a worm must not hide behind the difference.
 */
export function matchesIndicatorPathPattern(pattern: string, relativePath: string): boolean {
  return compilePathPattern(pattern).test(relativePath);
}

type ScanState = {
  readonly realRootPath: string;
  readonly indicators: readonly Indicator[];
  readonly readBuffer: Uint8Array;
  readonly findings: ScanFinding[];
  /** One finding per file and indicator: the first hit is enough to act on. */
  readonly recordedFindingKeys: Set<string>;
  filesVisited: number;
  bytesRead: number;
  unreadablePathCount: number;
  skippedOutsideRootCount: number;
  truncationReason: ScanTruncationReason;
};

type WalkFrame = {
  absolutePath: string;
  /** Root-relative POSIX path of this directory. Empty string for the root. */
  relativePath: string;
  depth: number;
};

type FileReadOutcome =
  | { kind: "text"; text: string; bytesRead: number }
  /** A NUL byte in the head, so the file is not scannable text. */
  | { kind: "binary"; bytesRead: number }
  | { kind: "unreadable" };

/**
 * Iterative depth-first walk. Iterative rather than recursive so a pathological
 * tree cannot overflow the stack and so any cap can end the whole walk at once.
 */
async function walkDirectoryTree(state: ScanState): Promise<void> {
  const frames: WalkFrame[] = [
    { absolutePath: state.realRootPath, relativePath: "", depth: 0 },
  ];

  while (frames.length > 0) {
    if (state.truncationReason !== null) return;

    const frame = frames.pop();
    if (frame === undefined) return;

    if (frame.depth > MAX_DIRECTORY_DEPTH) {
      state.truncationReason = "depth_cap";
      return;
    }

    const entries = await readDirectoryEntries(frame.absolutePath);
    if (entries === null) {
      // A directory we cannot list (permission denied, removed mid-walk) is
      // recorded, never swallowed: an unlistable node_modules must not read as
      // "clean".
      state.unreadablePathCount += 1;
      continue;
    }

    const subdirectoryFrames: WalkFrame[] = [];

    for (const entry of entries) {
      if (state.truncationReason !== null) return;

      const entryAbsolutePath = join(frame.absolutePath, entry.name);
      const entryRelativePath =
        frame.relativePath === "" ? entry.name : posix.join(frame.relativePath, entry.name);

      // Symlinks are resolved before anything else, because the type flags on a
      // link describe the link, and following one is how a scanner gets walked
      // out of its own root.
      if (entry.isSymbolicLink()) {
        await handleSymbolicLink(state, entryAbsolutePath);
        continue;
      }

      if (entry.isDirectory()) {
        if (matchesAnyPathPattern(SKIPPED_DIRECTORY_PATTERNS, entryRelativePath)) continue;
        subdirectoryFrames.push({
          absolutePath: entryAbsolutePath,
          relativePath: entryRelativePath,
          depth: frame.depth + 1,
        });
        continue;
      }

      // Sockets, FIFOs and device nodes carry no scannable text and reading one
      // can block, so they are skipped without being counted as unreadable.
      if (!entry.isFile()) continue;

      if (state.filesVisited >= MAX_FILES_VISITED) {
        state.truncationReason = "file_cap";
        return;
      }
      state.filesVisited += 1;

      await inspectCandidateFile(state, entryAbsolutePath, entryRelativePath);
    }

    // Pushed in reverse so the pops come out in the sorted order readDirectoryEntries
    // established. Deterministic order makes a cap-truncated report reproducible.
    for (let index = subdirectoryFrames.length - 1; index >= 0; index -= 1) {
      const subdirectoryFrame = subdirectoryFrames[index];
      if (subdirectoryFrame !== undefined) frames.push(subdirectoryFrame);
    }
  }
}

/**
 * Decides what to do with a symlink. A link resolving outside the root is the
 * containment case: counted and skipped, never opened. A link resolving inside the
 * root points at a tree the walk already reaches directly, so following it would
 * duplicate work and could form a cycle.
 */
async function handleSymbolicLink(state: ScanState, linkAbsolutePath: string): Promise<void> {
  const linkTargetRealPath = await resolveRealPath(linkAbsolutePath);
  if (linkTargetRealPath === null) {
    // A broken or unresolvable link is containment we could not decide, so it is
    // reported as unreadable rather than assumed safe.
    state.unreadablePathCount += 1;
    return;
  }

  if (!isPathInsideRoot(state.realRootPath, linkTargetRealPath)) {
    state.skippedOutsideRootCount += 1;
  }
}

/**
 * Matches one file against the catalog, then reads it only when a content-gated
 * indicator asked for it.
 */
async function inspectCandidateFile(
  state: ScanState,
  absolutePath: string,
  relativePath: string,
): Promise<void> {
  const pathOnlyIndicators: Indicator[] = [];
  const contentGatedIndicators: Indicator[] = [];

  for (const indicator of state.indicators) {
    if (!matchesAnyPathPattern(indicator.pathPatterns, relativePath)) continue;
    if (indicator.isPathOnly) pathOnlyIndicators.push(indicator);
    else if (indicator.contentPatterns !== undefined) contentGatedIndicators.push(indicator);
  }

  if (pathOnlyIndicators.length === 0 && contentGatedIndicators.length === 0) return;

  // The containment re-check for every file that is about to be reported or read.
  // The walk never traverses a symlink, so this only fires when a directory in the
  // chain was swapped for one between the readdir and now, but that race is
  // exactly the one that would take a scanner outside its root.
  const candidateRealPath = await resolveRealPath(absolutePath);
  if (candidateRealPath === null) {
    state.unreadablePathCount += 1;
    return;
  }
  if (!isPathInsideRoot(state.realRootPath, candidateRealPath)) {
    state.skippedOutsideRootCount += 1;
    return;
  }

  const packageName = resolvePackageNameFromRelativePath(relativePath);

  for (const indicator of pathOnlyIndicators) {
    recordFinding(state, {
      indicatorId: indicator.id,
      severity: indicator.severity,
      relativePath,
      lineNumber: null,
      title: indicator.title,
      explanation: indicator.rationale,
      packageName,
    });
  }

  if (contentGatedIndicators.length === 0 || state.truncationReason !== null) return;

  const remainingTotalBytes = MAX_TOTAL_BYTES - state.bytesRead;
  if (remainingTotalBytes <= 0) {
    state.truncationReason = "byte_cap";
    return;
  }

  const outcome = await readFileHeadAsText(
    absolutePath,
    state.readBuffer,
    Math.min(MAX_BYTES_PER_FILE, remainingTotalBytes),
  );

  if (outcome.kind === "unreadable") {
    state.unreadablePathCount += 1;
    return;
  }

  state.bytesRead += outcome.bytesRead;

  // A binary file is skipped rather than scanned: matching text patterns against
  // compressed or compiled bytes produces noise, not findings.
  if (outcome.kind === "binary") return;

  matchContentIndicators(state, contentGatedIndicators, outcome.text, relativePath, packageName);
}

/**
 * Tests every content pattern line by line. Line-scoped matching is what makes the
 * line number reportable and keeps each regex bounded to one line of input.
 */
function matchContentIndicators(
  state: ScanState,
  indicators: readonly Indicator[],
  text: string,
  relativePath: string,
  packageName: string | null,
): void {
  const lines = text.split(LINE_BREAK_PATTERN);

  for (const indicator of indicators) {
    const patterns = indicator.contentPatterns;
    if (patterns === undefined) continue;

    let matchedLineNumber: number | null = null;

    for (let lineIndex = 0; lineIndex < lines.length && matchedLineNumber === null; lineIndex += 1) {
      const line = lines[lineIndex];
      if (line === undefined) continue;
      for (const pattern of patterns) {
        if (pattern.test(line)) {
          matchedLineNumber = lineIndex + 1;
          break;
        }
      }
    }

    if (matchedLineNumber === null) continue;

    recordFinding(state, {
      indicatorId: indicator.id,
      severity: indicator.severity,
      relativePath,
      // 1-indexed, and the only thing carried over from the match. The matched
      // line itself is deliberately dropped: it can hold a token.
      lineNumber: matchedLineNumber,
      title: indicator.title,
      explanation: indicator.rationale,
      packageName,
    });

    if (state.truncationReason !== null) return;
  }
}

/**
 * Separator for the deduplication key. NUL is the one byte a POSIX path cannot
 * contain, so no path and indicator id pair can collide with another. Written as an
 * escape rather than as a raw byte, because a raw NUL would make this source file
 * binary to grep and diff, and would trip this scanner's own binary check.
 */
const FINDING_KEY_SEPARATOR = "\u0000";

/**
 * Appends a finding unless the same file and indicator already produced one. When
 * the cap is already full the finding is dropped and the report is marked
 * truncated, so a full list always means "there was at least one more".
 */
function recordFinding(state: ScanState, finding: ScanFinding): void {
  const findingKey = `${finding.relativePath}${FINDING_KEY_SEPARATOR}${finding.indicatorId}`;
  if (state.recordedFindingKeys.has(findingKey)) return;

  if (state.findings.length >= MAX_FINDINGS) {
    state.truncationReason = "finding_cap";
    return;
  }

  state.recordedFindingKeys.add(findingKey);
  state.findings.push(finding);
}

/** Splits on LF and CRLF. One alternation over two literals, so no backtracking. */
const LINE_BREAK_PATTERN = /\r?\n/;

const SEVERITY_DISPLAY_ORDER: Readonly<Record<IndicatorSeverity, number>> = {
  high: 0,
  medium: 1,
  low: 2,
};

/** Highest severity first, then by path, so the report is stable across runs. */
function sortFindingsForDisplay(findings: readonly ScanFinding[]): ScanFinding[] {
  return [...findings].sort((leftFinding, rightFinding) => {
    const severityDelta =
      SEVERITY_DISPLAY_ORDER[leftFinding.severity] - SEVERITY_DISPLAY_ORDER[rightFinding.severity];
    if (severityDelta !== 0) return severityDelta;

    const pathDelta = leftFinding.relativePath.localeCompare(rightFinding.relativePath);
    if (pathDelta !== 0) return pathDelta;

    const indicatorDelta = leftFinding.indicatorId.localeCompare(rightFinding.indicatorId);
    if (indicatorDelta !== 0) return indicatorDelta;

    return (leftFinding.lineNumber ?? 0) - (rightFinding.lineNumber ?? 0);
  });
}

function matchesAnyPathPattern(patterns: readonly string[], relativePath: string): boolean {
  for (const pattern of patterns) {
    if (compilePathPattern(pattern).test(relativePath)) return true;
  }
  return false;
}

/**
 * Compiled path patterns, keyed by pattern text. The catalog is small and fixed,
 * so this compiles once per pattern instead of once per visited file.
 */
const COMPILED_PATH_PATTERNS = new Map<string, RegExp>();

function compilePathPattern(pattern: string): RegExp {
  const cached = COMPILED_PATH_PATTERNS.get(pattern);
  if (cached !== undefined) return cached;

  let source = "^";
  let index = 0;

  while (index < pattern.length) {
    const character = pattern[index];
    if (character === undefined) break;

    if (character === "*") {
      const isDoubleStar = pattern[index + 1] === "*";

      if (isDoubleStar && pattern[index + 2] === "/") {
        // Any number of leading directories, including none. `[\s\S]` rather than
        // `.` because a POSIX filename may contain a newline. One greedy
        // quantifier followed by a literal separator, so no nested quantifier and
        // no catastrophic backtracking.
        source += "(?:[\\s\\S]*\\/)?";
        index += 3;
        continue;
      }

      if (isDoubleStar) {
        source += "[\\s\\S]*";
        index += 2;
        continue;
      }

      source += "[^/]*";
      index += 1;
      continue;
    }

    if (character === "?") {
      source += "[^/]";
      index += 1;
      continue;
    }

    source += escapeRegexCharacter(character);
    index += 1;
  }

  source += "$";
  const compiled = new RegExp(source, "i");
  COMPILED_PATH_PATTERNS.set(pattern, compiled);
  return compiled;
}

function escapeRegexCharacter(character: string): string {
  return character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Containment test. Uses `relative` rather than a prefix comparison so a sibling
 * directory whose name starts with the root's name (/repo-backup next to /repo)
 * cannot pass, and so a different Windows drive is rejected too.
 */
function isPathInsideRoot(realRootPath: string, candidateRealPath: string): boolean {
  if (candidateRealPath === realRootPath) return true;

  const relativeToRoot = relative(realRootPath, candidateRealPath);
  if (relativeToRoot === "") return true;
  if (isAbsolute(relativeToRoot)) return false;
  return relativeToRoot !== ".." && !relativeToRoot.startsWith(`..${posix.sep}`) && !relativeToRoot.startsWith("..\\");
}

/** The root's own directory name, which is safe to show. Never the full path. */
function describeScanRootLabel(realRootPath: string): string {
  const label = basename(realRootPath);
  return label === "" ? FALLBACK_ROOT_LABEL : label;
}

/**
 * Reads at most `byteBudget` bytes and decodes them as UTF-8.
 *
 * The decoder is fatal so genuinely invalid UTF-8 is reported as unreadable
 * instead of being silently turned into replacement characters, and it decodes in
 * streaming mode so a multi-byte character cut in half by the byte cap is held
 * back rather than treated as corruption.
 */
async function readFileHeadAsText(
  absolutePath: string,
  readBuffer: Uint8Array,
  byteBudget: number,
): Promise<FileReadOutcome> {
  let handle: FileHandle;
  try {
    handle = await open(absolutePath, "r");
  } catch {
    // Deliberately no error text: a Node fs message embeds the absolute path.
    return { kind: "unreadable" };
  }

  try {
    const readResult = await handle.read(readBuffer, 0, byteBudget, 0);
    const chunk = readBuffer.subarray(0, readResult.bytesRead);

    if (chunk.indexOf(0) !== -1) return { kind: "binary", bytesRead: readResult.bytesRead };

    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      return {
        kind: "text",
        text: decoder.decode(chunk, { stream: true }),
        bytesRead: readResult.bytesRead,
      };
    } catch {
      return { kind: "unreadable" };
    }
  } catch {
    return { kind: "unreadable" };
  } finally {
    // A failure to close a read-only handle is not actionable and must not mask
    // the read outcome, so it is dropped here rather than turned into a count.
    await handle.close().catch(() => undefined);
  }
}

/** Directory entries sorted by name, or null when the directory cannot be listed. */
async function readDirectoryEntries(absolutePath: string): Promise<Dirent[] | null> {
  try {
    const entries = await readdir(absolutePath, { withFileTypes: true });
    return [...entries].sort((leftEntry, rightEntry) => leftEntry.name.localeCompare(rightEntry.name));
  } catch {
    return null;
  }
}

/** Resolves a path to its real path, or null when it cannot be resolved. */
async function resolveRealPath(absolutePath: string): Promise<string | null> {
  try {
    return await realpath(absolutePath);
  } catch {
    return null;
  }
}

async function checkIsDirectory(absolutePath: string): Promise<boolean> {
  try {
    const stats = await stat(absolutePath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}
