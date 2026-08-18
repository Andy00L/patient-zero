import { type Ecosystem, parsePackageSpec } from "@/lib/graph/model";
import { type Failure, type Result, fail, fromThrowingSync, succeed } from "@/lib/result";

/**
 * Lockfile parsing for "Scan my project".
 *
 * This module is a trust boundary. Everything it receives is a file a stranger
 * pasted or uploaded, so it obeys four rules without exception:
 *
 * 1. Pure text in, data out. Nothing here executes, spawns, fetches, resolves, or
 *    reads from the filesystem. Paths found inside a lockfile are treated as opaque
 *    strings and are never interpreted as locations, and the optional filename hint
 *    is string-matched on its last segment only.
 * 2. Bounded work. Input length and extracted dependency count are both capped
 *    before any allocation grows with the input.
 * 3. No content in failures. A Failure may name the format, a character offset, and
 *    the reason. Failure messages reach logs, so no byte of the file ever enters
 *    one. Per-line problems are counted in `skipped` instead of being reported.
 * 4. No prototype reads. Parsed JSON is walked with `Object.entries` and
 *    `Object.hasOwn`, the three prototype-carrying keys are dropped, and results
 *    accumulate in a `Map`, never in an object literal keyed by untrusted strings.
 *
 * Losing a dependency is worse than reporting an uncertain one: a missed entry
 * understates exposure, which is the one error direction this project must not
 * make. So nothing is dropped in silence. Every skipped entry lands in a counter
 * the UI can show.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The concrete on-disk shapes this module reads. `npm-lock-v2` covers
 * package-lock.json `lockfileVersion` 2 and 3, which share the `packages` map;
 * `npm-lock-v1` is the older recursive `dependencies` tree.
 * sourceRef: https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json
 */
export type LockfileFormat =
  | "npm-lock-v1"
  | "npm-lock-v2"
  | "yarn-classic"
  | "yarn-berry"
  | "pnpm"
  | "requirements-txt"
  | "poetry-lock";

/** Depth value for formats that record no nesting (a flat store or a flat list). */
export const UNKNOWN_DEPTH = -1;

export type ParsedDependency = {
  ecosystem: Ecosystem;
  name: string;
  /** null when the source line pinned no exact version (a requirements.txt range). */
  version: string | null;
  isDevOnly: boolean;
  /** 0 for a direct dependency of the root, deeper for a nested resolution. -1 when the format does not say. */
  depth: number;
};

/** Counts of what was skipped, so the UI can be honest instead of silently lossy. */
export type SkippedCounts = {
  /** Emitted with `version: null` because the source stated a range, not a pin. */
  unpinnedCount: number;
  /**
   * Entries dropped because they carried no usable name or version. Named for the
   * line-oriented formats; for the JSON formats it counts map entries.
   */
  unparsableLineCount: number;
  /** Entries dropped after the dependency cap was reached. */
  truncatedCount: number;
};

export type ParsedLockfile = {
  format: LockfileFormat;
  ecosystem: Ecosystem;
  dependencies: ParsedDependency[];
  skipped: SkippedCounts;
};

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Longest accepted input, in UTF-16 code units (what `String.length` counts).
 * 4 MiB worth of units. A UTF-8 encoding of the same text is never smaller than
 * its UTF-16 code unit count, so a file that passed a 4 MiB byte cap upstream
 * always passes this one too, and a 4 Mi unit string is already 8 MiB of heap.
 *
 * Scale check: an npm `packages` entry is roughly 200 characters with its resolved
 * URL and integrity hash, so this cap admits about 20,000 entries, which is the
 * dependency cap below. The two numbers are chosen to bound the same amount of work.
 */
export const MAX_LOCKFILE_CHARACTERS = 4_194_304;

/**
 * Most distinct dependencies returned. Real npm trees for large applications sit
 * in the low thousands, so this leaves headroom while keeping a crafted file from
 * making the caller allocate without bound.
 */
export const MAX_LOCKFILE_DEPENDENCIES = 20_000;

/**
 * Deepest nesting walked in a lockfileVersion 1 `dependencies` tree. npm v5 and v6
 * trees deduplicate aggressively and rarely pass 10 levels; the cap exists so a
 * crafted file cannot drive the walk without bound.
 */
const MAX_NPM_V1_DEPTH = 32;

/**
 * Longest accepted package name, in characters. npm rejects names over 214 and
 * PEP 508 states no maximum, so the npm number is applied to both. Both stay well
 * inside the 512 character ceiling the query layer enforces.
 * sourceRef: https://github.com/npm/validate-npm-package-name ("cannot exceed
 * 214"), and src/lib/hydra/cypher.ts MAX_LITERAL_LENGTH.
 */
const MAX_PACKAGE_NAME_LENGTH = 214;

/**
 * Longest accepted version string, in characters. A semver with prerelease and
 * build metadata fits comfortably; anything longer is not a version this project
 * can place in the graph.
 */
const MAX_VERSION_LENGTH = 64;

/**
 * Characters a version may contain. A deliberate subset of the query layer's
 * literal allowlist, so a version accepted here can always be spelled in a query.
 * sourceRef: src/lib/hydra/cypher.ts SAFE_LITERAL_PATTERN.
 */
const SAFE_VERSION_PATTERN = /^[A-Za-z0-9._+-]+$/;

/**
 * npm name grammar. Names must be URL safe, carry no spaces, and exclude
 * `~)('!*`; the surviving set is letters, digits, dot, underscore and hyphen,
 * optionally behind an `@scope/` prefix.
 *
 * Mixed case is accepted on purpose. npm rejects uppercase for new packages but
 * keeps it valid for existing ones, and real dependencies such as `JSONStream`
 * still resolve in live lockfiles. Rejecting them would drop true exposure, and
 * case is not a safety property here: the character allowlist is.
 * sourceRef: https://github.com/npm/validate-npm-package-name
 */
const NPM_UNSCOPED_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const NPM_SCOPED_NAME_PATTERN = /^@[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * Names npm refuses outright, whatever the client version. Core module names such
 * as `http` and `stream` are deliberately absent: npm blocks them only for new
 * packages, and both are real published packages that a live lockfile can pin.
 * sourceRef: https://github.com/npm/validate-npm-package-name
 */
const NPM_RESERVED_NAMES: readonly string[] = ["node_modules", "favicon.ico"];

/**
 * PyPI name grammar, applied case-insensitively.
 * sourceRef: https://packaging.python.org/en/latest/specifications/name-normalization/
 * (`^([A-Z0-9]|[A-Z0-9][A-Z0-9._-]*[A-Z0-9])\Z` with re.IGNORECASE)
 */
const PYPI_NAME_PATTERN = /^([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9])$/;

/**
 * PyPI name normalization: collapse runs of `.`, `-` and `_` to a single hyphen,
 * then lowercase. Two spellings that normalize alike are the same project.
 * sourceRef: https://packaging.python.org/en/latest/specifications/name-normalization/
 * (`re.sub(r"[-_.]+", "-", name).lower()`)
 */
const PYPI_NAME_SEPARATOR_RUN = /[-_.]+/g;

/** JSON keys that carry a prototype. Never read, never written, never forwarded. */
const PROTOTYPE_KEYS: readonly string[] = ["__proto__", "constructor", "prototype"];

/**
 * Separator inside a deduplication key. Neither a validated package name nor a
 * validated version can contain a NUL, so no crafted lockfile can forge a key that
 * collides two distinct identities. Written as an escape, never as a raw byte: a
 * control character in source makes the file binary to grep and invisible in review.
 */
const IDENTITY_SEPARATOR = "\u0000";

/** Path segment npm uses to nest a resolution inside another package. */
const NODE_MODULES_SEGMENT = "node_modules/";

/** pnpm sections whose keys are dependency paths. Other sections are ignored. */
const PNPM_DEPENDENCY_SECTIONS: readonly string[] = ["packages", "snapshots"];

/**
 * Yarn Berry resolution protocol for the project's own workspaces. Those entries
 * are the user's code, not a dependency, so they are skipped rather than counted.
 * sourceRef: yarn.lock from yarnpkg/berry, `resolution: "<name>@workspace:."`.
 */
const YARN_WORKSPACE_PROTOCOL = "workspace";

/** requirements.txt version operators, longest first so `===` wins over `==`. */
const REQUIREMENT_OPERATORS: readonly string[] = ["===", "==", ">=", "<=", "~=", "!=", ">", "<"];

/** Filename to format map, used only as a tiebreaker when the content is silent. */
const FILENAME_HINTS: readonly { filename: string; format: LockfileFormat }[] = [
  { filename: "package-lock.json", format: "npm-lock-v2" },
  { filename: "npm-shrinkwrap.json", format: "npm-lock-v2" },
  { filename: "yarn.lock", format: "yarn-classic" },
  { filename: "pnpm-lock.yaml", format: "pnpm" },
  { filename: "requirements.txt", format: "requirements-txt" },
  { filename: "poetry.lock", format: "poetry-lock" },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Which registry a format resolves against. */
export function ecosystemForFormat(format: LockfileFormat): Ecosystem {
  return format === "requirements-txt" || format === "poetry-lock" ? "pypi" : "npm";
}

/**
 * Identifies the format from the content itself. The filename hint is consulted
 * only when no structural marker matched, so a file renamed to `yarn.lock` is
 * still read as whatever it actually is.
 */
export function detectLockfileFormat(
  content: string,
  filenameHint?: string,
): Result<LockfileFormat, Failure> {
  const detected = detectFormatAndParseJson(content, filenameHint);
  return detected.ok ? succeed(detected.value.format) : detected;
}

/**
 * Reads a lockfile into the dependency set it pins. Returns a Failure only for a
 * whole-file problem (too large, empty, unknown format, malformed JSON); a
 * problem confined to one entry is counted in `skipped` so the caller can report
 * the loss instead of hiding it.
 */
export function parseLockfile(
  content: string,
  filenameHint?: string,
): Result<ParsedLockfile, Failure> {
  const detected = detectFormatAndParseJson(content, filenameHint);
  if (!detected.ok) return detected;

  const { format, parsedJson } = detected.value;
  const accumulator = createDependencyAccumulator();

  if (format === "npm-lock-v2" && parsedJson !== null) {
    collectNpmPackagesMap(parsedJson, accumulator);
  } else if (format === "npm-lock-v1" && parsedJson !== null) {
    collectNpmDependencyTree(parsedJson, accumulator);
  } else if (format === "yarn-classic") {
    collectYarnClassicEntries(content, accumulator);
  } else if (format === "yarn-berry") {
    collectYarnBerryEntries(content, accumulator);
  } else if (format === "pnpm") {
    collectPnpmEntries(content, accumulator);
  } else if (format === "requirements-txt") {
    collectRequirementLines(content, accumulator);
  } else if (format === "poetry-lock") {
    collectPoetryPackages(content, accumulator);
  } else {
    // A JSON format detected without a parsed root cannot happen: detection
    // returns the parsed object alongside the format. Fail loudly rather than
    // report an empty dependency set as a successful scan.
    return fail("internal", `[parseLockfile] format "${format}" reached the dispatch with no data`);
  }

  return succeed(finishDependencyAccumulator(accumulator, format));
}

/**
 * Validates a package name against its registry's grammar and returns the
 * normalized form: unchanged for npm (names are case sensitive there), lowercased
 * with separator runs collapsed for PyPI.
 *
 * Names read from a lockfile end up in a graph query, so this is defense in depth
 * rather than decoration: a name that cannot exist upstream never reaches the
 * query layer.
 */
export function validatePackageName(
  ecosystem: Ecosystem,
  rawName: string,
): Result<string, Failure> {
  const name = rawName.trim();

  if (name.length === 0) {
    return fail("invalid_input", "[validatePackageName] empty package name");
  }
  if (name.length > MAX_PACKAGE_NAME_LENGTH) {
    return fail(
      "invalid_input",
      `[validatePackageName] ${ecosystem} name of ${name.length} characters exceeds ${MAX_PACKAGE_NAME_LENGTH}`,
    );
  }
  if (isPrototypeKey(name)) {
    return fail("invalid_input", `[validatePackageName] ${ecosystem} name is a prototype key`);
  }

  if (ecosystem === "pypi") {
    if (!PYPI_NAME_PATTERN.test(name)) {
      return fail("invalid_input", "[validatePackageName] name is not a valid PyPI project name");
    }
    return succeed(name.replace(PYPI_NAME_SEPARATOR_RUN, "-").toLowerCase());
  }

  const isScoped = name.startsWith("@");
  const matchesGrammar = isScoped
    ? NPM_SCOPED_NAME_PATTERN.test(name)
    : NPM_UNSCOPED_NAME_PATTERN.test(name);
  if (!matchesGrammar) {
    return fail("invalid_input", "[validatePackageName] name is not a valid npm package name");
  }
  if (NPM_RESERVED_NAMES.includes(name)) {
    return fail("invalid_input", "[validatePackageName] npm name is reserved");
  }

  // npm forbids a leading dot or underscore on the published name. For a scoped
  // name the rule applies to both halves, so check the segment after the slash.
  const publishedSegment = isScoped ? name.slice(name.indexOf("/") + 1) : name;
  if (publishedSegment.startsWith(".") || publishedSegment.startsWith("_")) {
    return fail("invalid_input", "[validatePackageName] npm name starts with a dot or underscore");
  }

  return succeed(name);
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detection carries the parsed JSON root forward for the npm formats so the file
 * is parsed exactly once, whichever public entry point the caller used.
 */
type DetectionOutcome = {
  format: LockfileFormat;
  parsedJson: Record<string, unknown> | null;
};

function detectFormatAndParseJson(
  content: string,
  filenameHint?: string,
): Result<DetectionOutcome, Failure> {
  if (content.length > MAX_LOCKFILE_CHARACTERS) {
    return fail(
      "invalid_input",
      `[detectFormatAndParseJson] input of ${content.length} characters exceeds the ${MAX_LOCKFILE_CHARACTERS} character cap`,
    );
  }

  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return fail("invalid_input", "[detectFormatAndParseJson] input is empty");
  }

  // JSON first: package-lock.json is the only JSON shape among the formats, and
  // its declared lockfileVersion is the authority on which of the two it is.
  if (trimmed.startsWith("{")) return detectNpmLockfile(trimmed);

  // A poetry.lock is the only TOML shape, and `[[package]]` is unambiguous.
  if (hasLineStartingWith(content, "[[package]]")) {
    return succeed({ format: "poetry-lock", parsedJson: null });
  }

  // pnpm is checked before Yarn Berry: both are YAML and pnpm entries carry a
  // nested `resolution:` field that would otherwise read as a Berry marker.
  if (looksLikePnpmLockfile(content)) return succeed({ format: "pnpm", parsedJson: null });

  if (hasLineStartingWith(content, "__metadata:")) {
    return succeed({ format: "yarn-berry", parsedJson: null });
  }

  const blocks = splitIntoIndentedBlocks(content);
  if (blocks.some((block) => readBerryResolution(block) !== null)) {
    return succeed({ format: "yarn-berry", parsedJson: null });
  }
  if (blocks.some((block) => readClassicVersion(block) !== null)) {
    return succeed({ format: "yarn-classic", parsedJson: null });
  }

  if (looksLikeRequirementsFile(content)) {
    return succeed({ format: "requirements-txt", parsedJson: null });
  }

  const hinted = readFormatFromFilenameHint(filenameHint);
  if (hinted !== null) return succeed({ format: hinted, parsedJson: null });

  return fail(
    "unsupported",
    "[detectFormatAndParseJson] content matches no supported lockfile format",
  );
}

function detectNpmLockfile(trimmed: string): Result<DetectionOutcome, Failure> {
  const parsed = fromThrowingSync("invalid_input", "json", () => JSON.parse(trimmed) as unknown);
  if (!parsed.ok) {
    // The thrown message embeds a slice of the input, so only the offset survives.
    return fail(
      "invalid_input",
      `[detectNpmLockfile] content is not valid JSON (${describeJsonFailurePosition(parsed.failure.message)})`,
    );
  }
  if (!isPlainRecord(parsed.value)) {
    return fail("invalid_input", "[detectNpmLockfile] JSON root is not an object");
  }

  const root = parsed.value;
  const declaredVersion = readOwnProperty(root, "lockfileVersion");

  if (typeof declaredVersion === "number" && Number.isInteger(declaredVersion)) {
    if (declaredVersion === 1) return succeed({ format: "npm-lock-v1", parsedJson: root });
    if (declaredVersion === 2 || declaredVersion === 3) {
      return succeed({ format: "npm-lock-v2", parsedJson: root });
    }
    return fail(
      "unsupported",
      `[detectNpmLockfile] npm lockfileVersion ${declaredVersion} is not supported`,
    );
  }

  // An absent lockfileVersion marks a pre-npm-v5 shrinkwrap. Fall back on shape.
  // sourceRef: https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json
  if (isPlainRecord(readOwnProperty(root, "packages"))) {
    return succeed({ format: "npm-lock-v2", parsedJson: root });
  }
  if (isPlainRecord(readOwnProperty(root, "dependencies"))) {
    return succeed({ format: "npm-lock-v1", parsedJson: root });
  }

  return fail("unsupported", "[detectNpmLockfile] JSON object is not a package lockfile");
}

function looksLikePnpmLockfile(content: string): boolean {
  if (!hasLineStartingWith(content, "lockfileVersion:")) return false;
  return (
    hasLineStartingWith(content, "packages:") ||
    hasLineStartingWith(content, "snapshots:") ||
    hasLineStartingWith(content, "importers:") ||
    hasLineStartingWith(content, "dependencies:") ||
    hasLineStartingWith(content, "devDependencies:")
  );
}

/**
 * True when every meaningful line reads as a pip requirement. Requiring all of
 * them, not just one, keeps arbitrary prose out: a single line with a space or a
 * stray bracket disqualifies the file.
 */
function looksLikeRequirementsFile(content: string): boolean {
  let requirementCount = 0;

  for (const logicalLine of joinContinuedLines(content)) {
    const stripped = stripRequirementComment(logicalLine).trim();
    if (stripped.length === 0) continue;
    if (stripped.startsWith("-")) continue; // A pip option line, never followed.

    const requirement = parseRequirementSpecifier(stripped);
    if (requirement === null) return false;
    requirementCount += 1;
  }

  return requirementCount > 0;
}

/**
 * Maps a filename to a format. Only the last path segment is read, and it is read
 * as a string: nothing here touches the filesystem.
 */
function readFormatFromFilenameHint(filenameHint?: string): LockfileFormat | null {
  if (filenameHint === undefined) return null;

  const segments = filenameHint.split(/[/\\]/);
  const basename = (segments[segments.length - 1] ?? "").trim().toLowerCase();
  if (basename.length === 0) return null;

  const matched = FILENAME_HINTS.find((candidate) => candidate.filename === basename);
  return matched === undefined ? null : matched.format;
}

/** Keeps only the decimal offset from a JSON.parse message, never its content slice. */
function describeJsonFailurePosition(message: string): string {
  const positionMatch = /position (\d+)/.exec(message);
  const position = positionMatch?.[1];
  return position === undefined ? "offset unreported" : `at character offset ${position}`;
}

// ---------------------------------------------------------------------------
// Accumulation, validation and deduplication
// ---------------------------------------------------------------------------

/**
 * Dependencies land in a `Map`, not an object literal. A crafted lockfile controls
 * every key here, and a `Map` has no prototype chain to reach.
 */
type DependencyAccumulator = {
  byIdentity: Map<string, ParsedDependency>;
  unpinnedCount: number;
  unparsableLineCount: number;
  truncatedCount: number;
};

/** What a per-format collector hands over before validation and deduplication. */
type DependencyCandidate = {
  ecosystem: Ecosystem;
  rawName: string;
  rawVersion: string | null;
  isDevOnly: boolean;
  depth: number;
};

function createDependencyAccumulator(): DependencyAccumulator {
  return { byIdentity: new Map(), unpinnedCount: 0, unparsableLineCount: 0, truncatedCount: 0 };
}

/**
 * Validates a candidate, then merges it into the accumulated set. Deduplication
 * keeps the shallowest depth and clears `isDevOnly` as soon as one occurrence is a
 * production dependency, because the same resolution reached from production is a
 * production exposure whatever the other paths say.
 */
function addDependencyCandidate(
  accumulator: DependencyAccumulator,
  candidate: DependencyCandidate,
): void {
  const validatedName = validatePackageName(candidate.ecosystem, candidate.rawName);
  if (!validatedName.ok) {
    accumulator.unparsableLineCount += 1;
    return;
  }

  let version: string | null = null;
  if (candidate.rawVersion !== null) {
    const validatedVersion = validateVersion(candidate.rawVersion);
    if (validatedVersion === null) {
      accumulator.unparsableLineCount += 1;
      return;
    }
    version = validatedVersion;
  }

  const identity = [candidate.ecosystem, validatedName.value, version ?? ""].join(
    IDENTITY_SEPARATOR,
  );
  const existing = accumulator.byIdentity.get(identity);

  if (existing !== undefined) {
    existing.depth = mergeDepth(existing.depth, candidate.depth);
    existing.isDevOnly = existing.isDevOnly && candidate.isDevOnly;
    return;
  }

  if (accumulator.byIdentity.size >= MAX_LOCKFILE_DEPENDENCIES) {
    accumulator.truncatedCount += 1;
    return;
  }

  if (version === null) accumulator.unpinnedCount += 1;

  accumulator.byIdentity.set(identity, {
    ecosystem: candidate.ecosystem,
    name: validatedName.value,
    version,
    isDevOnly: candidate.isDevOnly,
    depth: candidate.depth,
  });
}

/** A stated depth always beats an unknown one; otherwise the shallowest wins. */
function mergeDepth(existingDepth: number, incomingDepth: number): number {
  if (existingDepth === UNKNOWN_DEPTH) return incomingDepth;
  if (incomingDepth === UNKNOWN_DEPTH) return existingDepth;
  return Math.min(existingDepth, incomingDepth);
}

function finishDependencyAccumulator(
  accumulator: DependencyAccumulator,
  format: LockfileFormat,
): ParsedLockfile {
  return {
    format,
    ecosystem: ecosystemForFormat(format),
    dependencies: [...accumulator.byIdentity.values()],
    skipped: {
      unpinnedCount: accumulator.unpinnedCount,
      unparsableLineCount: accumulator.unparsableLineCount,
      truncatedCount: accumulator.truncatedCount,
    },
  };
}

/** Returns the version unchanged when it is safe to carry, null when it is not. */
function validateVersion(rawVersion: string): string | null {
  const version = rawVersion.trim();
  if (version.length === 0 || version.length > MAX_VERSION_LENGTH) return null;
  return SAFE_VERSION_PATTERN.test(version) ? version : null;
}

// ---------------------------------------------------------------------------
// npm: lockfileVersion 2 and 3 (the `packages` map)
// ---------------------------------------------------------------------------

/**
 * Reads the `packages` map, whose keys are paths relative to the project root:
 * `node_modules/chalk` at the top level, `node_modules/a/node_modules/b` for a
 * nested resolution, and `""` for the project itself.
 * sourceRef: https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json
 */
function collectNpmPackagesMap(
  root: Record<string, unknown>,
  accumulator: DependencyAccumulator,
): void {
  const packages = readOwnProperty(root, "packages");
  if (!isPlainRecord(packages)) return;

  for (const [entryPath, entryValue] of Object.entries(packages)) {
    // The root project is not one of its own dependencies.
    if (entryPath.length === 0) continue;
    if (isPrototypeKey(entryPath)) {
      accumulator.unparsableLineCount += 1;
      continue;
    }
    if (!isPlainRecord(entryValue)) {
      accumulator.unparsableLineCount += 1;
      continue;
    }

    // A path with no node_modules segment is a workspace member: the user's own
    // code, which npm lists separately from the resolution that links to it.
    const located = locateNpmPackageInPath(entryPath);
    if (located === null) continue;

    // A link entry carries no version of its own; its target is listed separately.
    if (readOwnProperty(entryValue, "link") === true) continue;

    const version = readOwnProperty(entryValue, "version");
    if (typeof version !== "string") {
      accumulator.unparsableLineCount += 1;
      continue;
    }

    // `dev` marks the dev tree only. `devOptional` marks a package that is also an
    // optional dependency of a non-dev package, so it stays a production exposure.
    addDependencyCandidate(accumulator, {
      ecosystem: "npm",
      rawName: located.name,
      rawVersion: version,
      isDevOnly: readOwnProperty(entryValue, "dev") === true,
      depth: located.depth,
    });
  }
}

/**
 * Splits `node_modules/a/node_modules/b` into the name `b` at depth 1. The name is
 * everything after the last `node_modules/`, which keeps a scoped name whole, and
 * the depth is the number of nesting segments minus one.
 */
function locateNpmPackageInPath(entryPath: string): { name: string; depth: number } | null {
  const lastSegment = entryPath.lastIndexOf(NODE_MODULES_SEGMENT);
  if (lastSegment === -1) return null;

  const name = entryPath.slice(lastSegment + NODE_MODULES_SEGMENT.length);
  if (name.length === 0) return null;

  return { name, depth: countOccurrences(entryPath, NODE_MODULES_SEGMENT) - 1 };
}

// ---------------------------------------------------------------------------
// npm: lockfileVersion 1 (the recursive `dependencies` tree)
// ---------------------------------------------------------------------------

/** One level of the v1 tree waiting to be walked. */
type NpmV1Frame = { entries: Record<string, unknown>; depth: number };

/**
 * Walks the recursive `dependencies` tree with an explicit worklist. A crafted
 * lockfile controls the nesting, and a worklist cannot overflow the stack the way
 * recursion would.
 * sourceRef: https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json
 */
function collectNpmDependencyTree(
  root: Record<string, unknown>,
  accumulator: DependencyAccumulator,
): void {
  const rootDependencies = readOwnProperty(root, "dependencies");
  if (!isPlainRecord(rootDependencies)) return;

  const pending: NpmV1Frame[] = [{ entries: rootDependencies, depth: 0 }];

  while (pending.length > 0) {
    const frame = pending.pop();
    if (frame === undefined) break;

    for (const [name, entryValue] of Object.entries(frame.entries)) {
      if (isPrototypeKey(name)) {
        accumulator.unparsableLineCount += 1;
        continue;
      }
      if (!isPlainRecord(entryValue)) {
        accumulator.unparsableLineCount += 1;
        continue;
      }

      const version = readOwnProperty(entryValue, "version");
      if (typeof version !== "string") {
        // v1 omits `version` for an uninstalled optional or peer dependency; the
        // entry is real but unresolved, so report it rather than lose it.
        accumulator.unparsableLineCount += 1;
      } else {
        addDependencyCandidate(accumulator, {
          ecosystem: "npm",
          rawName: name,
          rawVersion: version,
          isDevOnly: readOwnProperty(entryValue, "dev") === true,
          depth: frame.depth,
        });
      }

      const nested = readOwnProperty(entryValue, "dependencies");
      if (isPlainRecord(nested) && frame.depth + 1 <= MAX_NPM_V1_DEPTH) {
        pending.push({ entries: nested, depth: frame.depth + 1 });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Yarn: classic (v1 text) and Berry (v2 and later YAML)
// ---------------------------------------------------------------------------

/**
 * A column-zero header line and the indented lines under it. Both Yarn formats and
 * poetry share this layout, so the split is written once.
 */
type IndentedBlock = { header: string; fields: string[] };

function splitIntoIndentedBlocks(content: string): IndentedBlock[] {
  const blocks: IndentedBlock[] = [];
  let currentHeader: string | null = null;
  let currentFields: string[] = [];

  const closeCurrentBlock = (): void => {
    if (currentHeader !== null) blocks.push({ header: currentHeader, fields: currentFields });
    currentHeader = null;
    currentFields = [];
  };

  for (const line of splitIntoLines(content)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;

    if (/^\s/.test(line)) {
      if (currentHeader !== null) currentFields.push(trimmed);
      continue;
    }

    closeCurrentBlock();
    if (line.endsWith(":")) currentHeader = line.slice(0, -1);
  }

  closeCurrentBlock();
  return blocks;
}

/**
 * Classic yarn.lock: a header of comma-separated descriptors, then a quoted
 * `version "1.2.3"` field. The format records no dev flag and no nesting.
 * sourceRef: node_modules/uri-js/yarn.lock (a real `# yarn lockfile v1` file).
 */
function collectYarnClassicEntries(content: string, accumulator: DependencyAccumulator): void {
  for (const block of splitIntoIndentedBlocks(content)) {
    const version = readClassicVersion(block);
    if (version === null) continue;

    const firstDescriptor = block.header.split(",")[0] ?? "";
    const name = readNpmNameFromDescriptor(firstDescriptor);
    if (name === null) {
      accumulator.unparsableLineCount += 1;
      continue;
    }

    addDependencyCandidate(accumulator, {
      ecosystem: "npm",
      rawName: name,
      rawVersion: version,
      isDevOnly: false,
      depth: UNKNOWN_DEPTH,
    });
  }
}

/**
 * Berry yarn.lock: a quoted descriptor header, then `version: 5.3.1` and
 * `resolution: "chalk@npm:5.3.1"`. The resolution is the authority on the name,
 * because the header holds the requested range and can be an alias.
 * sourceRef: yarn.lock from yarnpkg/berry (`__metadata: version: 10`).
 */
function collectYarnBerryEntries(content: string, accumulator: DependencyAccumulator): void {
  for (const block of splitIntoIndentedBlocks(content)) {
    const resolution = readBerryResolution(block);
    if (resolution === null) continue;

    const version = readFieldValue(block, "version:");
    if (version === null) {
      accumulator.unparsableLineCount += 1;
      continue;
    }

    // The user's own workspaces are not dependencies of themselves.
    if (resolution.protocol === YARN_WORKSPACE_PROTOCOL) continue;

    addDependencyCandidate(accumulator, {
      ecosystem: "npm",
      rawName: resolution.name,
      rawVersion: version,
      isDevOnly: false,
      depth: UNKNOWN_DEPTH,
    });
  }
}

/** The classic `version "1.2.3"` field, or null when the block has none. */
function readClassicVersion(block: IndentedBlock): string | null {
  for (const field of block.fields) {
    const match = /^version\s+"([^"]*)"$/.exec(field);
    const captured = match?.[1];
    if (captured !== undefined && captured.length > 0) return captured;
  }
  return null;
}

/** Splits `chalk@npm:5.3.1` into the package name and the protocol before the selector. */
function readBerryResolution(block: IndentedBlock): { name: string; protocol: string } | null {
  const resolution = readFieldValue(block, "resolution:");
  if (resolution === null) return null;

  const selectorStart = resolution.indexOf(":");
  if (selectorStart === -1) return null;

  const spec = parsePackageSpec(resolution.slice(0, selectorStart));
  if (spec === null) return null;

  return { name: spec.name, protocol: spec.version };
}

/** Reads a `key: value` field from a block, unquoting the value. */
function readFieldValue(block: IndentedBlock, keyWithColon: string): string | null {
  for (const field of block.fields) {
    if (!field.startsWith(keyWithColon)) continue;
    const value = stripSurroundingQuotes(field.slice(keyWithColon.length).trim());
    if (value.length > 0) return value;
  }
  return null;
}

/**
 * Reads the package name out of a Yarn descriptor such as `chalk@^5.3.1` or
 * `"@babel/core@^7.24.0"`, where a leading `@` is a scope marker rather than a
 * separator.
 */
function readNpmNameFromDescriptor(descriptor: string): string | null {
  const spec = parsePackageSpec(stripSurroundingQuotes(descriptor.trim()));
  return spec === null ? null : spec.name;
}

// ---------------------------------------------------------------------------
// pnpm
// ---------------------------------------------------------------------------

/**
 * Reads the dependency paths that key the `packages:` and `snapshots:` sections.
 * The two sections list the same identities in lockfileVersion 9 (metadata in one,
 * the resolved graph in the other), and the accumulator deduplicates them.
 *
 * pnpm records no nesting (the store is flat) and lockfileVersion 9 dropped the
 * per-package `dev` flag, so both are reported as unknown rather than guessed.
 * sourceRef: https://github.com/pnpm/spec/blob/master/lockfile/9.0.md and
 * https://github.com/pnpm/spec/blob/master/lockfile/6.0.md
 */
function collectPnpmEntries(content: string, accumulator: DependencyAccumulator): void {
  let currentSection: string | null = null;

  for (const line of splitIntoLines(content)) {
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;

    const sectionMatch = /^([A-Za-z_][A-Za-z0-9_-]*):\s*$/.exec(line);
    if (sectionMatch !== null) {
      currentSection = sectionMatch[1] ?? null;
      continue;
    }
    if (!line.startsWith(" ")) {
      currentSection = null;
      continue;
    }
    if (currentSection === null || !PNPM_DEPENDENCY_SECTIONS.includes(currentSection)) continue;

    // Entries sit at exactly two spaces; their own fields are indented deeper.
    if (!/^ {2}\S/.test(line)) continue;

    // The value after the colon is `{}` in a snapshots entry and absent in a
    // packages entry, so both endings are accepted and only the key is read.
    const entryMatch = /^ {2}(\S[^:]*):(?:\s.*)?$/.exec(line);
    const entryKey = entryMatch?.[1];
    if (entryKey === undefined) {
      accumulator.unparsableLineCount += 1;
      continue;
    }

    const parsed = parsePnpmDependencyPath(entryKey);
    if (parsed === null) {
      accumulator.unparsableLineCount += 1;
      continue;
    }

    addDependencyCandidate(accumulator, {
      ecosystem: "npm",
      rawName: parsed.name,
      rawVersion: parsed.version,
      isDevOnly: false,
      depth: UNKNOWN_DEPTH,
    });
  }
}

/**
 * Splits a pnpm dependency path into a name and a version. Three shapes exist
 * across lockfile versions: `chalk@5.3.1` (v9), `/chalk@5.3.1` (v6) and
 * `/chalk/5.3.1` (v5 and earlier). A peer suffix such as
 * `react-dom@18.2.0(react@18.2.0)` is dropped: neither an npm name nor a semver
 * version may contain a parenthesis, so the first one always opens the suffix.
 */
function parsePnpmDependencyPath(entryKey: string): { name: string; version: string } | null {
  const unquoted = stripSurroundingQuotes(entryKey.trim());
  const withoutPeerSuffix = cutAtFirst(unquoted, "(").trim();
  const path = withoutPeerSuffix.startsWith("/")
    ? withoutPeerSuffix.slice(1)
    : withoutPeerSuffix;
  if (path.length === 0) return null;

  const atSeparated = parsePackageSpec(path);
  if (atSeparated !== null) return { name: atSeparated.name, version: atSeparated.version };

  // The pre-v6 shape separated name and version with a slash.
  const lastSlash = path.lastIndexOf("/");
  if (lastSlash <= 0) return null;

  const name = path.slice(0, lastSlash);
  const version = path.slice(lastSlash + 1);
  return name.length === 0 || version.length === 0 ? null : { name, version };
}

// ---------------------------------------------------------------------------
// Python: requirements.txt
// ---------------------------------------------------------------------------

/** What one requirement line resolved to, and how firmly. */
type RequirementSpecifier = {
  name: string;
  /** null when the line stated a range, a wildcard, a URL, or nothing at all. */
  pinnedVersion: string | null;
};

/**
 * Reads pinned requirements. Only `==` and `===` against a wildcard-free version
 * are resolutions; a range or a bare name is recorded with `version: null` and
 * counted as unpinned, never guessed at.
 *
 * Option lines are ignored and never acted on: `-r` and `-c` includes are not
 * followed, `-e` editable installs are not resolved, and a direct reference URL is
 * not fetched.
 * sourceRef: https://pip.pypa.io/en/stable/reference/requirements-file-format/
 */
function collectRequirementLines(content: string, accumulator: DependencyAccumulator): void {
  for (const logicalLine of joinContinuedLines(content)) {
    const stripped = stripRequirementComment(logicalLine).trim();
    if (stripped.length === 0) continue;
    if (stripped.startsWith("-")) continue;

    const requirement = parseRequirementSpecifier(stripped);
    if (requirement === null) {
      accumulator.unparsableLineCount += 1;
      continue;
    }

    addDependencyCandidate(accumulator, {
      ecosystem: "pypi",
      rawName: requirement.name,
      rawVersion: requirement.pinnedVersion,
      isDevOnly: false,
      depth: UNKNOWN_DEPTH,
    });
  }
}

function parseRequirementSpecifier(line: string): RequirementSpecifier | null {
  // An environment marker gates installation; it never changes the resolution.
  const withoutMarker = cutAtFirst(line, ";");
  // Per-requirement options such as `--hash=sha256:...` follow the specifier.
  const specifier = cutAtFirst(withoutMarker, " --").trim();
  if (specifier.length === 0) return null;

  const nameMatch = /^[A-Za-z0-9._-]+/.exec(specifier);
  const name = nameMatch?.[0];
  if (name === undefined) return null;

  let remainder = specifier.slice(name.length).trim();

  // Extras (`requests[security]`) select optional dependency groups of the same
  // distribution, so they do not change which version is resolved.
  if (remainder.startsWith("[")) {
    const closingBracket = remainder.indexOf("]");
    if (closingBracket === -1) return null;
    remainder = remainder.slice(closingBracket + 1).trim();
  }

  if (remainder.length === 0) return { name, pinnedVersion: null };

  // A direct reference (`name @ https://...`) points at an artifact. The URL is
  // never read, resolved, or fetched, and it is not a version.
  if (remainder.startsWith("@")) return { name, pinnedVersion: null };

  // PEP 508 allows the specifier set to be parenthesized (`requests (>=2.8.1)`).
  const clauses =
    remainder.startsWith("(") && remainder.endsWith(")")
      ? remainder.slice(1, -1).trim()
      : remainder;

  // Anything that is not a version specifier is not a requirement line. Without
  // this check any prose line would read as a bare requirement.
  if (!REQUIREMENT_OPERATORS.some((operator) => clauses.startsWith(operator))) return null;

  return { name, pinnedVersion: findExactPin(clauses) };
}

/** The first `==` or `===` clause with a wildcard-free version, or null. */
function findExactPin(clauses: string): string | null {
  for (const rawClause of clauses.split(",")) {
    const clause = rawClause.trim();
    const operator = REQUIREMENT_OPERATORS.find((candidate) => clause.startsWith(candidate));
    if (operator === undefined) continue;
    if (operator !== "==" && operator !== "===") continue;

    const version = clause.slice(operator.length).trim();
    // `== 2.8.*` is prefix matching, which resolves to a set, not to one version.
    if (version.length === 0 || version.includes("*")) continue;
    return version;
  }
  return null;
}

/**
 * Joins lines ending in a backslash, which pip treats as one logical line.
 * Comments are stripped after this join, in that order, per the pip docs.
 */
function joinContinuedLines(content: string): string[] {
  const logicalLines: string[] = [];
  let pending = "";

  for (const line of splitIntoLines(content)) {
    if (line.endsWith("\\")) {
      pending += line.slice(0, -1);
      continue;
    }
    logicalLines.push(pending + line);
    pending = "";
  }

  if (pending.length > 0) logicalLines.push(pending);
  return logicalLines;
}

/** Drops a full-line comment, or whitespace followed by `#` and the rest of the line. */
function stripRequirementComment(line: string): string {
  if (line.trimStart().startsWith("#")) return "";
  const inlineComment = line.search(/\s#/);
  return inlineComment === -1 ? line : line.slice(0, inlineComment);
}

// ---------------------------------------------------------------------------
// Python: poetry.lock
// ---------------------------------------------------------------------------

/**
 * Reads the `[[package]]` blocks of a poetry.lock. Collection stops at the next
 * table header, because `[package.dependencies]` holds `name = "constraint"` lines
 * that would otherwise overwrite the block's own name.
 * sourceRef: poetry.lock from python-poetry/poetry (name, version, description,
 * optional, python-versions, groups, files).
 */
function collectPoetryPackages(content: string, accumulator: DependencyAccumulator): void {
  let name: string | null = null;
  let version: string | null = null;
  let isCollecting = false;

  const flushPendingPackage = (): void => {
    if (name !== null && version !== null) {
      addDependencyCandidate(accumulator, {
        ecosystem: "pypi",
        rawName: name,
        rawVersion: version,
        isDevOnly: false,
        depth: UNKNOWN_DEPTH,
      });
    } else if (name !== null || version !== null) {
      accumulator.unparsableLineCount += 1;
    }
    name = null;
    version = null;
  };

  for (const line of splitIntoLines(content)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;

    if (trimmed.startsWith("[")) {
      flushPendingPackage();
      isCollecting = trimmed === "[[package]]";
      continue;
    }
    if (!isCollecting) continue;

    const readName = readTomlString(trimmed, "name");
    if (readName !== null) {
      name = readName;
      continue;
    }
    const readVersion = readTomlString(trimmed, "version");
    if (readVersion !== null) version = readVersion;
  }

  flushPendingPackage();
}

/** Reads `key = "value"` from a TOML line, accepting either quote style. */
function readTomlString(line: string, key: string): string | null {
  const match = new RegExp(`^${key}\\s*=\\s*("([^"]*)"|'([^']*)')\\s*$`).exec(line);
  if (match === null) return null;
  const value = match[2] ?? match[3];
  return value === undefined || value.length === 0 ? null : value;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads a property only when the parsed object owns it, so a crafted lockfile
 * cannot answer a lookup from `Object.prototype`.
 */
function readOwnProperty(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function isPrototypeKey(key: string): boolean {
  return PROTOTYPE_KEYS.includes(key);
}

/** Splits on newlines, tolerating CRLF input. */
function splitIntoLines(content: string): string[] {
  return content.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function hasLineStartingWith(content: string, prefix: string): boolean {
  return splitIntoLines(content).some((line) => line.startsWith(prefix));
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let searchFrom = 0;

  for (;;) {
    const found = haystack.indexOf(needle, searchFrom);
    if (found === -1) return count;
    count += 1;
    searchFrom = found + needle.length;
  }
}

function cutAtFirst(text: string, marker: string): string {
  const found = text.indexOf(marker);
  return found === -1 ? text : text.slice(0, found);
}

function stripSurroundingQuotes(value: string): string {
  const isDoubleQuoted = value.length >= 2 && value.startsWith('"') && value.endsWith('"');
  const isSingleQuoted = value.length >= 2 && value.startsWith("'") && value.endsWith("'");
  return isDoubleQuoted || isSingleQuoted ? value.slice(1, -1) : value;
}
