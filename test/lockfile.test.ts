import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Failure, Result } from "@/lib/result";
import {
  MAX_LOCKFILE_CHARACTERS,
  MAX_LOCKFILE_DEPENDENCIES,
  UNKNOWN_DEPTH,
  type LockfileFormat,
  type ParsedDependency,
  type ParsedLockfile,
  detectLockfileFormat,
  parseLockfile,
  validatePackageName,
} from "@/lib/scanner/lockfile";

/**
 * Fixtures are real-shaped files rather than synthesized strings: the parser has to
 * survive what the package managers actually write, not what is convenient to assert.
 */
const FIXTURE_DIRECTORY = join(import.meta.dir, "fixtures", "lockfiles");

function readFixture(fileName: string): string {
  return readFileSync(join(FIXTURE_DIRECTORY, fileName), "utf8");
}

/** Deduplication makes emission order an implementation detail; the set is not. */
function sortDependenciesByName(dependencies: readonly ParsedDependency[]): ParsedDependency[] {
  return [...dependencies].sort((left, right) => left.name.localeCompare(right.name));
}

function parseFixtureOrUnreachable(fileName: string): ParsedLockfile {
  const parsed = parseLockfile(readFixture(fileName));
  if (parsed.ok) return parsed.value;
  return expect.unreachable(`fixture ${fileName} did not parse: ${parsed.failure.message}`);
}

function detectFormatOrUnreachable(content: string, filenameHint?: string): LockfileFormat {
  const detected = detectLockfileFormat(content, filenameHint);
  if (detected.ok) return detected.value;
  return expect.unreachable(`detection failed: ${detected.failure.message}`);
}

function readFailureOrUnreachable<TValue>(result: Result<TValue>): Failure {
  if (result.ok) return expect.unreachable("expected a Failure, received a value");
  return result.failure;
}

function buildNpmDependency(
  name: string,
  version: string,
  isDevOnly: boolean,
  depth: number,
): ParsedDependency {
  return { ecosystem: "npm", name, version, isDevOnly, depth };
}

/** Neither Python format states a dev flag or a nesting depth. */
function buildPypiDependency(name: string, version: string | null): ParsedDependency {
  return { ecosystem: "pypi", name, version, isDevOnly: false, depth: UNKNOWN_DEPTH };
}

describe("detectLockfileFormat", () => {
  test("identifies every supported format from its content alone", () => {
    const expectations: readonly { fileName: string; format: LockfileFormat }[] = [
      { fileName: "package-lock-v3.json", format: "npm-lock-v2" },
      { fileName: "package-lock-v1.json", format: "npm-lock-v1" },
      { fileName: "yarn-classic.lock", format: "yarn-classic" },
      { fileName: "yarn-berry.lock", format: "yarn-berry" },
      { fileName: "pnpm-lock.yaml", format: "pnpm" },
      { fileName: "requirements.txt", format: "requirements-txt" },
      { fileName: "poetry.lock", format: "poetry-lock" },
    ];

    for (const expectation of expectations) {
      expect(detectFormatOrUnreachable(readFixture(expectation.fileName))).toBe(expectation.format);
    }
  });

  test("content beats a misleading filename, and the hint only breaks a tie", () => {
    expect(detectFormatOrUnreachable(readFixture("poetry.lock"), "yarn.lock")).toBe("poetry-lock");

    // An include-only requirements file carries no structural marker of its own, so
    // here the filename is the only evidence available.
    expect(detectFormatOrUnreachable("-r base.txt\n", "some/dir/requirements.txt")).toBe(
      "requirements-txt",
    );
  });

  test("rejects content that is not a lockfile", () => {
    expect(readFailureOrUnreachable(detectLockfileFormat("Hello world.\nThis is a readme.")).reason).toBe(
      "unsupported",
    );
    expect(readFailureOrUnreachable(detectLockfileFormat("   \n\t  ")).reason).toBe("invalid_input");
  });
});

describe("parseLockfile: npm package-lock.json", () => {
  test("reads lockfileVersion 3 packages, nesting depth, and the dev flag", () => {
    const parsed = parseFixtureOrUnreachable("package-lock-v3.json");

    expect(parsed.format).toBe("npm-lock-v2");
    expect(parsed.ecosystem).toBe("npm");
    expect(sortDependenciesByName(parsed.dependencies)).toEqual([
      buildNpmDependency("@babel/core", "7.24.0", false, 0),
      buildNpmDependency("aaa", "1.0.0", true, 0),
      // Deduplicated across two paths: pinned at depth 0 in production and at depth 1
      // under a dev parent, so the shallowest depth and the production flag survive.
      buildNpmDependency("chalk", "5.3.1", false, 0),
      buildNpmDependency("left-pad", "1.3.0", false, 0),
      // "node_modules/left-pad/node_modules/nested-only" is "nested-only" at depth 1,
      // never "left-pad/node_modules/nested-only".
      buildNpmDependency("nested-only", "2.0.0", false, 1),
      // Deduplicated in the other order: seen first as a dev nested copy, then as a
      // production top-level one. isDevOnly must end up false either way.
      buildNpmDependency("shared-util", "3.1.0", false, 0),
      buildNpmDependency("typescript", "5.4.5", true, 0),
    ]);
    expect(parsed.skipped).toEqual({
      unpinnedCount: 0,
      unparsableLineCount: 0,
      truncatedCount: 0,
    });
  });

  test('does not emit the "" root key or a workspace member as a dependency', () => {
    const names = parseFixtureOrUnreachable("package-lock-v3.json").dependencies.map(
      (dependency) => dependency.name,
    );

    // The fixture root is "fixture-app", with a "packages/web" workspace linked from
    // "node_modules/web". The user's own code is not part of their blast radius.
    expect(names).not.toContain("fixture-app");
    expect(names).not.toContain("web");
    expect(names.every((name) => name.length > 0)).toBe(true);
  });

  test("reads the lockfileVersion 1 recursive tree with the right depths", () => {
    const parsed = parseFixtureOrUnreachable("package-lock-v1.json");

    expect(parsed.format).toBe("npm-lock-v1");
    expect(sortDependenciesByName(parsed.dependencies)).toEqual([
      buildNpmDependency("ansi-styles", "3.2.1", false, 1),
      buildNpmDependency("chalk", "2.4.2", false, 0),
      buildNpmDependency("color-convert", "1.9.3", false, 2),
      buildNpmDependency("escape-string-regexp", "1.0.5", false, 0),
      buildNpmDependency("fsevents", "2.3.2", true, 0),
      buildNpmDependency("mocha", "9.2.2", true, 0),
    ]);
    // "unresolved-peer" carries no version. It is counted, never silently dropped.
    expect(parsed.skipped.unparsableLineCount).toBe(1);
  });
});

describe("parseLockfile: yarn", () => {
  test("reads the classic v1 text format, including merged descriptors", () => {
    const parsed = parseFixtureOrUnreachable("yarn-classic.lock");

    expect(parsed.format).toBe("yarn-classic");
    expect(sortDependenciesByName(parsed.dependencies)).toEqual([
      buildNpmDependency("@babel/core", "7.24.0", false, UNKNOWN_DEPTH),
      buildNpmDependency("ansi-regex", "2.1.1", false, UNKNOWN_DEPTH),
      // Header "chalk@^5.3.0, chalk@^5.3.1:" is one entry at one resolved version.
      buildNpmDependency("chalk", "5.3.1", false, UNKNOWN_DEPTH),
      buildNpmDependency("left-pad", "1.3.0", false, UNKNOWN_DEPTH),
    ]);
    expect(parsed.skipped.unparsableLineCount).toBe(0);
  });

  test("reads Berry resolutions and skips the project's own workspace", () => {
    const parsed = parseFixtureOrUnreachable("yarn-berry.lock");

    expect(parsed.format).toBe("yarn-berry");
    expect(sortDependenciesByName(parsed.dependencies)).toEqual([
      buildNpmDependency("@babel/core", "7.24.0", false, UNKNOWN_DEPTH),
      buildNpmDependency("chalk", "5.3.1", false, UNKNOWN_DEPTH),
      // A patch: resolution still names the underlying package and version.
      buildNpmDependency("fsevents", "2.3.2", false, UNKNOWN_DEPTH),
    ]);
    // "fixture-app@workspace:." is the user's own code, not a dependency.
    expect(parsed.dependencies.map((dependency) => dependency.name)).not.toContain("fixture-app");
  });
});

describe("parseLockfile: pnpm", () => {
  test("reads packages and snapshots as one set and drops peer suffixes", () => {
    const parsed = parseFixtureOrUnreachable("pnpm-lock.yaml");

    expect(parsed.format).toBe("pnpm");
    expect(sortDependenciesByName(parsed.dependencies)).toEqual([
      buildNpmDependency("@babel/core", "7.24.0", false, UNKNOWN_DEPTH),
      buildNpmDependency("chalk", "5.3.1", false, UNKNOWN_DEPTH),
      buildNpmDependency("react", "18.2.0", false, UNKNOWN_DEPTH),
      // "react-dom@18.2.0(react@18.2.0)" under snapshots is the same identity as
      // "react-dom@18.2.0" under packages, so the peer suffix must not split it.
      buildNpmDependency("react-dom", "18.2.0", false, UNKNOWN_DEPTH),
      buildNpmDependency("typescript", "5.4.5", false, UNKNOWN_DEPTH),
    ]);
    expect(parsed.skipped).toEqual({
      unpinnedCount: 0,
      unparsableLineCount: 0,
      truncatedCount: 0,
    });
  });

  test("reads the pre-v9 slash-prefixed dependency paths", () => {
    const legacyLockfile = [
      "lockfileVersion: '6.0'",
      "",
      "packages:",
      "",
      "  /chalk@5.3.1:",
      "    resolution: {integrity: sha512-fixture==}",
      "",
      "  /@babel/core@7.24.0:",
      "    resolution: {integrity: sha512-fixture==}",
      "",
    ].join("\n");

    const parsed = parseLockfile(legacyLockfile);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(sortDependenciesByName(parsed.value.dependencies)).toEqual([
      buildNpmDependency("@babel/core", "7.24.0", false, UNKNOWN_DEPTH),
      buildNpmDependency("chalk", "5.3.1", false, UNKNOWN_DEPTH),
    ]);
  });
});

describe("parseLockfile: python", () => {
  test("pins only ==, records ranges as unpinned, and never follows an include", () => {
    const parsed = parseFixtureOrUnreachable("requirements.txt");

    expect(parsed.format).toBe("requirements-txt");
    expect(parsed.ecosystem).toBe("pypi");
    expect(sortDependenciesByName(parsed.dependencies)).toEqual([
      // "certifi==2024.2.2 --hash=sha256:..." pins a version; the hash is not one.
      buildPypiDependency("certifi", "2024.2.2"),
      buildPypiDependency("click", null),
      buildPypiDependency("django", null),
      // "Flask == 3.0.2  # an inline comment after whitespace".
      buildPypiDependency("flask", "3.0.2"),
      // A trailing "; python_version < ..." marker does not change the pin.
      buildPypiDependency("importlib-metadata", "7.0.1"),
      buildPypiDependency("pyyaml", null),
      // "requests==2.31.0" and "requests[security]==2.31.0" are one dependency.
      buildPypiDependency("requests", "2.31.0"),
      // "six==1.16.*" is prefix matching, which names a set, not one version.
      buildPypiDependency("six", null),
      // Continued across a backslash line break.
      buildPypiDependency("sqlalchemy", "2.0.29"),
      // ">=", "~=" and "!=" all resolve later, so they are unpinned, not versions.
      buildPypiDependency("urllib3", null),
      buildPypiDependency("zope-interface", "6.2"),
    ]);

    // urllib3, click, django, pyyaml and six state no exact version.
    expect(parsed.skipped).toEqual({
      unpinnedCount: 5,
      unparsableLineCount: 0,
      truncatedCount: 0,
    });

    // The -r, --requirement, -c and -e lines name other files. Nothing was read or
    // resolved, so none of their targets can appear in the output.
    const names = parsed.dependencies.map((dependency) => dependency.name);
    expect(names).not.toContain("base-requirements");
    expect(names).not.toContain("extra-requirements");
    expect(names).not.toContain("constraints");
    expect(names).not.toContain("local-package");
    // The first word of the inline comment, had the comment been treated as content.
    expect(names).not.toContain("an");
  });

  test("reads poetry.lock package blocks without leaking sub-table keys", () => {
    const parsed = parseFixtureOrUnreachable("poetry.lock");

    expect(parsed.format).toBe("poetry-lock");
    expect(sortDependenciesByName(parsed.dependencies)).toEqual([
      buildPypiDependency("certifi", "2024.2.2"),
      buildPypiDependency("pytest", "8.1.1"),
      buildPypiDependency("requests", "2.31.0"),
      // PEP 503 normalization: "zope.interface" and "zope-interface" are one project.
      buildPypiDependency("zope-interface", "6.2"),
    ]);

    // [package.dependencies] holds `iniconfig = "*"` and `urllib3 = ">=1.21.1,<3"`.
    // Neither is a locked package block, so neither may be reported as one.
    const names = parsed.dependencies.map((dependency) => dependency.name);
    expect(names).not.toContain("iniconfig");
    expect(names).not.toContain("urllib3");
  });
});

describe("parseLockfile: trust boundary", () => {
  test("rejects oversized input without putting any of it in the failure", () => {
    const marker = "SUPER-SECRET-TOKEN-VALUE";
    const oversized = marker + "x".repeat(MAX_LOCKFILE_CHARACTERS);

    const failure = readFailureOrUnreachable(parseLockfile(oversized));

    expect(failure.reason).toBe("invalid_input");
    expect(failure.message).not.toContain(marker);
    expect(failure.message).not.toContain("xxxxxxxxxx");
    // The cap is safe to state and is what makes the failure actionable.
    expect(failure.message).toContain(String(MAX_LOCKFILE_CHARACTERS));
  });

  test("reports malformed JSON as a failure carrying no file content", () => {
    // V8 embeds a slice of the input in its JSON.parse message, so the guarantee
    // under test is that the slice never reaches the Failure. Failures reach logs.
    const failure = readFailureOrUnreachable(parseLockfile(readFixture("malformed.json")));

    expect(failure.reason).toBe("invalid_input");
    expect(failure.message).not.toContain("super-secret-internal-package");
    expect(failure.message).not.toContain("oops");
    expect(failure.message).toContain("not valid JSON");
  });

  test("a crafted __proto__ key pollutes nothing and is counted, not silently dropped", () => {
    const parsed = parseFixtureOrUnreachable("package-lock-crafted-proto.json");

    expect(sortDependenciesByName(parsed.dependencies)).toEqual([
      buildNpmDependency("chalk", "5.3.1", false, 0),
      buildNpmDependency("evil", "1.0.0", false, 0),
    ]);
    // Two prototype-named top-level keys plus two prototype-named packages.
    expect(parsed.skipped.unparsableLineCount).toBe(4);

    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(
      parsed.dependencies.every(
        (dependency) => Object.getPrototypeOf(dependency) === Object.prototype,
      ),
    ).toBe(true);

    const untouchedObject: Record<string, unknown> = {};
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
    expect(untouchedObject["polluted"]).toBeUndefined();
    expect(untouchedObject["isDevOnly"]).toBeUndefined();
  });

  test("caps the dependency count and reports how many were dropped", () => {
    const entries: string[] = ['"": {"name": "flood", "version": "1.0.0"}'];
    const excess = 25;
    for (let index = 0; index < MAX_LOCKFILE_DEPENDENCIES + excess; index += 1) {
      entries.push(`"node_modules/pkg-${index}": {"version": "1.0.0"}`);
    }
    const flooded = `{"lockfileVersion": 3, "packages": {${entries.join(",")}}}`;

    const parsed = parseLockfile(flooded);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.value.dependencies.length).toBe(MAX_LOCKFILE_DEPENDENCIES);
    expect(parsed.value.skipped.truncatedCount).toBe(excess);
  });
});

describe("validatePackageName", () => {
  test("accepts real npm names, including scoped and legacy mixed case", () => {
    for (const candidate of ["chalk", "@babel/core", "@types/node", "left-pad"]) {
      const validated = validatePackageName("npm", candidate);
      expect(validated.ok).toBe(true);
      if (validated.ok) expect(validated.value).toBe(candidate);
    }

    // Uppercase is invalid for a new npm package but still resolves for existing
    // ones, and JSONStream appears in live lockfiles. Rejecting it would drop a real
    // dependency, and understating exposure is the one error this project must avoid.
    const legacy = validatePackageName("npm", "JSONStream");
    expect(legacy.ok).toBe(true);
    if (legacy.ok) expect(legacy.value).toBe("JSONStream");
  });

  test("rejects npm names that could not exist upstream", () => {
    const rejected: readonly string[] = [
      "",
      "has space",
      "_leading-underscore",
      ".leading-dot",
      "@scope/_bad",
      "with)paren",
      "with~tilde",
      "node_modules",
      "__proto__",
      "constructor",
      "a".repeat(215),
    ];

    for (const candidate of rejected) {
      expect(readFailureOrUnreachable(validatePackageName("npm", candidate)).reason).toBe(
        "invalid_input",
      );
    }
  });

  test("normalizes PyPI names per PEP 503 and rejects invalid ones", () => {
    const normalizations: readonly { input: string; expected: string }[] = [
      { input: "Friendly-Bard", expected: "friendly-bard" },
      { input: "friendly.bard", expected: "friendly-bard" },
      { input: "friendly_bard", expected: "friendly-bard" },
      { input: "FrIeNdLy-._.-bArD", expected: "friendly-bard" },
      { input: "zope.interface", expected: "zope-interface" },
    ];

    for (const normalization of normalizations) {
      const validated = validatePackageName("pypi", normalization.input);
      expect(validated.ok).toBe(true);
      if (validated.ok) expect(validated.value).toBe(normalization.expected);
    }

    // PEP 508 requires the first and last character to be a letter or a digit.
    for (const candidate of ["-leading", "trailing-", ".dotted.", "@babel/core", "has space"]) {
      expect(validatePackageName("pypi", candidate).ok).toBe(false);
    }
  });
});
