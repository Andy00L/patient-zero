import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { POST as localScanRoute } from "@/app/api/local-scan/route";
import { LocalScanConsole } from "@/components/local/local-scan-console";
import { FindingsTable, ScanReadoutPanel } from "@/components/local/scan-report";
import {
  LOCAL_SCAN_ENABLED_VALUE,
  LOCAL_SCAN_ENV_VARIABLE,
  LOCAL_SCAN_FAILURE_SCHEMA,
  LOCAL_SCAN_SUCCESS_SCHEMA,
  type LocalScanRefusalKind,
  SEVERITY_RANK,
} from "@/components/local/scan-contract";

/**
 * POST /api/local-scan, the one route in this project that reads the filesystem of the machine
 * it runs on. The handler is called directly with a constructed Request, so what is under test
 * is the contract a browser sees rather than Next.js routing.
 *
 * These are security assertions, not coverage. Each one defends a property that, if it broke,
 * would turn this feature into the thing it warns about:
 *
 * 1. The gate. With the environment variable unset the route answers 404 and reads nothing.
 * 2. Containment. A path outside the tree the server was started in is refused, and so is a
 *    `..` traversal and a symlink that leaves the tree, each with the distinct refusal kind
 *    the surface needs to name the reason.
 * 3. Silence. No refusal and no report contains the requested path, the project location, the
 *    home directory, or a single byte of any file that was read. The compromised fixture holds
 *    a planted secret exactly so that a leak has something to catch on.
 * 4. Abstention. A walk that could not read everything reports `unknown`, never `not_exposed`,
 *    and the word "clean" is not in this route's vocabulary. An incomplete scan that reads as
 *    clean is the one failure this feature must not have.
 * 5. Read-only. The scanned tree is byte-identical after a scan.
 * 6. The surface. The same silence, asserted on the markup a browser actually receives, and no
 *    result on screen before anybody asked for one.
 */

const BASE_URL = "http://patient-zero.test/api/local-scan";

/** The directory the server process runs in, which is the boundary the route enforces. */
const PROJECT_ROOT = resolve(import.meta.dir, "..");

const FIXTURE_ROOT = join(import.meta.dir, "fixtures", "scanner");
const CLEAN_ROOT = join(FIXTURE_ROOT, "clean");
const COMPROMISED_ROOT = join(FIXTURE_ROOT, "compromised");

/**
 * The literal planted in the compromised CLAUDE.md fixture. The scanner proves it matched by
 * reporting a line number, so this string must never appear in a serialized report.
 * sourceRef: test/fixtures/scanner/compromised/CLAUDE.md
 */
const PLANTED_SECRET = "FIXTURE-PLANTED-SECRET-c0ffee";

/**
 * `..` segments deep enough to clamp at the filesystem root from anywhere in this tree, so the
 * traversal below lands on a known directory instead of on whatever happens to be one level up.
 */
const CLAMPING_TRAVERSAL = new Array(16).fill("..");

/** Nested directory levels created to trip the walker's depth cap, which sits at 32. */
const OVER_DEPTH_LEVELS = 40;

/** Throwaway trees go under the project's gitignored scratch folder and are removed after. */
const SCRATCH_ROOT = join(PROJECT_ROOT, ".scratch");

/** One file's identity for the read-only check: name, size and modification time. */
type TreeEntry = { path: string; size: number; modifiedAtMs: number };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Runs `work` with the gate open, restoring whatever the environment held before. */
async function withGateOpen<TValue>(work: () => Promise<TValue>): Promise<TValue> {
  const previous = process.env[LOCAL_SCAN_ENV_VARIABLE];
  process.env[LOCAL_SCAN_ENV_VARIABLE] = LOCAL_SCAN_ENABLED_VALUE;
  try {
    return await work();
  } finally {
    if (previous === undefined) delete process.env[LOCAL_SCAN_ENV_VARIABLE];
    else process.env[LOCAL_SCAN_ENV_VARIABLE] = previous;
  }
}

/** Runs `work` with the gate explicitly unset, whatever the shell exported. */
async function withGateClosed<TValue>(work: () => Promise<TValue>): Promise<TValue> {
  const previous = process.env[LOCAL_SCAN_ENV_VARIABLE];
  delete process.env[LOCAL_SCAN_ENV_VARIABLE];
  try {
    return await work();
  } finally {
    if (previous !== undefined) process.env[LOCAL_SCAN_ENV_VARIABLE] = previous;
  }
}

/** Posts a scan request. `body` is sent verbatim so a malformed request can be tested too. */
async function postScan(body: unknown): Promise<Response> {
  return localScanRoute(
    new Request(BASE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/** Posts a well-formed request for one path, with consent given. */
async function postScanForPath(path: string): Promise<Response> {
  return postScan({ path, consent: true });
}

/** Parses a success body through the shared schema, so a dropped field fails here. */
async function readSuccess(response: Response, context: string) {
  const parsed = LOCAL_SCAN_SUCCESS_SCHEMA.safeParse(await response.clone().json());
  if (!parsed.success) {
    return expect.unreachable(`${context}: body does not match the scan schema (${parsed.error.message})`);
  }
  return parsed.data;
}

/** Parses a refusal body and returns the kind the surface branches on. */
async function readRefusal(response: Response, context: string): Promise<LocalScanRefusalKind> {
  const parsed = LOCAL_SCAN_FAILURE_SCHEMA.safeParse(await response.clone().json());
  if (!parsed.success) {
    return expect.unreachable(`${context}: body does not match the failure schema (${parsed.error.message})`);
  }
  const refusal = parsed.data.error.context?.refusal;
  if (refusal === undefined) {
    return expect.unreachable(`${context}: the refusal kind is missing from the failure context`);
  }
  return refusal;
}

/**
 * Asserts that a whole response body names nothing about this machine.
 *
 * The check runs on the serialized text rather than on parsed fields, so a leak that landed in
 * an unexpected place (a context value, a nested message) is caught too.
 */
async function expectNoMachineDetails(response: Response, requestedPath: string): Promise<void> {
  const text = await response.clone().text();
  // A bare separator is not a machine detail: "/" occurs in this route's own name. Anything
  // longer than one character names a location and must not come back.
  if (requestedPath.length > 1) expect(text).not.toContain(requestedPath);
  expect(text).not.toContain(PROJECT_ROOT);
  expect(text).not.toContain(homedir());
  expect(text).not.toContain(PLANTED_SECRET);
}

/** Creates a throwaway directory inside the project tree, so the scan can reach it. */
async function makeScratchTree(): Promise<string> {
  await mkdir(SCRATCH_ROOT, { recursive: true });
  return mkdtemp(join(SCRATCH_ROOT, "local-scan-"));
}

/**
 * Directory symlink creation, which needs a privilege on Windows that CI may not have. The
 * boolean lets the symlink tests skip rather than fail on a platform that cannot express one.
 */
async function tryCreateDirectorySymlink(targetPath: string, linkPath: string): Promise<boolean> {
  try {
    await symlink(targetPath, linkPath, "dir");
    return true;
  } catch {
    return false;
  }
}

/** Every file in a tree with its size and mtime, sorted, for the read-only comparison. */
async function readTreeEntries(rootPath: string): Promise<TreeEntry[]> {
  const names = await readdir(rootPath, { recursive: true });
  const entries: TreeEntry[] = [];
  for (const name of names.sort()) {
    const stats = await stat(join(rootPath, name));
    if (!stats.isFile()) continue;
    entries.push({ path: name, size: stats.size, modifiedAtMs: stats.mtimeMs });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// 1. The gate
// ---------------------------------------------------------------------------

describe("POST /api/local-scan, the environment gate", () => {
  test("answers 404 and scans nothing when the variable is unset", async () => {
    const response = await withGateClosed(() => postScanForPath(COMPROMISED_ROOT));

    expect(response.status).toBe(404);
    expect(await readRefusal(response, "closed gate")).toBe("gate_closed");
    await expectNoMachineDetails(response, COMPROMISED_ROOT);
  });

  test("answers 404 for a path it would otherwise refuse, so the gate leaks no probe", async () => {
    // A closed gate has to be indistinguishable for every input: if an outside path answered
    // "outside the root" while an inside path answered 404, the route would be a path oracle.
    const response = await withGateClosed(() => postScanForPath("/etc/passwd"));

    expect(response.status).toBe(404);
    expect(await readRefusal(response, "closed gate, outside path")).toBe("gate_closed");
  });
});

// ---------------------------------------------------------------------------
// 2. Containment
// ---------------------------------------------------------------------------

describe("POST /api/local-scan, path containment", () => {
  test("refuses a path outside the directory the server was started in", async () => {
    const response = await withGateOpen(() => postScanForPath("/etc/passwd"));

    expect(response.status).toBe(400);
    expect(await readRefusal(response, "outside root")).toBe("outside_root");
    await expectNoMachineDetails(response, "/etc/passwd");
  });

  test("collapses a .. traversal and refuses where it lands", async () => {
    // Enough `..` segments to clamp at the filesystem root, then back down into /etc. If the
    // route matched on strings instead of resolving, this would read as a path under the
    // fixtures directory and would be scanned.
    const traversal = join(COMPROMISED_ROOT, ...CLAMPING_TRAVERSAL, "etc");

    const response = await withGateOpen(() => postScanForPath(traversal));

    expect(response.status).toBe(400);
    expect(await readRefusal(response, "traversal")).toBe("outside_root");
    await expectNoMachineDetails(response, traversal);
  });

  test("accepts a .. traversal that resolves back inside the tree", async () => {
    // The complement of the test above: containment is real resolution, not a ban on the two
    // characters. A route that refused every path holding `..` would pass that test for the
    // wrong reason.
    const insideTraversal = join(COMPROMISED_ROOT, "..", "compromised");

    const response = await withGateOpen(() => postScanForPath(insideTraversal));
    const body = await readSuccess(response, "inside traversal");

    expect(response.status).toBe(200);
    expect(body.rootLabel).toBe("compromised");
  });

  test("refuses a symlink whose real path leaves the tree", async () => {
    const scratchTree = await makeScratchTree();
    try {
      const escapeLink = join(scratchTree, "escape");
      const created = await tryCreateDirectorySymlink("/etc", escapeLink);
      if (!created) return;

      const response = await withGateOpen(() => postScanForPath(escapeLink));

      expect(response.status).toBe(400);
      expect(await readRefusal(response, "symlink escape")).toBe("outside_root");
      await expectNoMachineDetails(response, escapeLink);
    } finally {
      await rm(scratchTree, { recursive: true, force: true });
    }
  });

  test("refuses the home directory, a shared temp directory and a filesystem root by name", async () => {
    const cases: readonly { path: string; expected: LocalScanRefusalKind }[] = [
      { path: homedir(), expected: "home_directory" },
      { path: tmpdir(), expected: "shared_temp" },
      { path: "/", expected: "filesystem_root" },
    ];

    for (const scenario of cases) {
      const response = await withGateOpen(() => postScanForPath(scenario.path));

      expect(response.status).toBe(400);
      expect(await readRefusal(response, scenario.path)).toBe(scenario.expected);
      await expectNoMachineDetails(response, scenario.path);
    }
  });

  test("gives each remaining refusal its own kind", async () => {
    const missingPath = join(PROJECT_ROOT, "no-such-directory-4b91f2");
    const filePath = join(CLEAN_ROOT, "package.json");

    const blank = await withGateOpen(() => postScanForPath("   "));
    expect(await readRefusal(blank, "blank path")).toBe("blank_path");

    const relative = await withGateOpen(() => postScanForPath("test/fixtures/scanner/clean"));
    expect(await readRefusal(relative, "relative path")).toBe("relative_path");

    const missing = await withGateOpen(() => postScanForPath(missingPath));
    expect(missing.status).toBe(404);
    expect(await readRefusal(missing, "missing path")).toBe("path_not_found");
    await expectNoMachineDetails(missing, missingPath);

    const file = await withGateOpen(() => postScanForPath(filePath));
    expect(await readRefusal(file, "file path")).toBe("not_a_directory");
    await expectNoMachineDetails(file, filePath);
  });

  test("refuses a request that does not carry consent", async () => {
    const withoutConsent = await withGateOpen(() => postScan({ path: COMPROMISED_ROOT }));
    expect(await readRefusal(withoutConsent, "no consent")).toBe("malformed_request");

    const deniedConsent = await withGateOpen(() =>
      postScan({ path: COMPROMISED_ROOT, consent: false }),
    );
    expect(await readRefusal(deniedConsent, "consent false")).toBe("malformed_request");
  });
});

// ---------------------------------------------------------------------------
// 3. Silence about what was read
// ---------------------------------------------------------------------------

describe("POST /api/local-scan, what crosses the boundary", () => {
  test("reports findings worst first, with no content and no absolute path", async () => {
    const response = await withGateOpen(() => postScanForPath(COMPROMISED_ROOT));
    const body = await readSuccess(response, "compromised fixture");

    expect(response.status).toBe(200);
    expect(body.verdict).toBe("exposed");
    expect(body.counts.total).toBeGreaterThan(0);
    expect(body.counts.bySeverity.high).toBeGreaterThan(0);

    const ranks = body.findings.map((finding) => SEVERITY_RANK[finding.severity]);
    expect(ranks).toEqual([...ranks].sort((first, second) => first - second));

    // The label is the directory name, never the path that reaches it.
    expect(body.rootLabel).toBe("compromised");
    for (const finding of body.findings) {
      expect(isAbsolute(finding.relativePath)).toBe(false);
    }

    // The planted secret sits on the line one indicator matched, so a report that carried the
    // matched line, a snippet, or the file itself would fail here.
    await expectNoMachineDetails(response, COMPROMISED_ROOT);
  });

  test("leaves the scanned tree byte-identical", async () => {
    const before = await readTreeEntries(COMPROMISED_ROOT);
    const response = await withGateOpen(() => postScanForPath(COMPROMISED_ROOT));
    const after = await readTreeEntries(COMPROMISED_ROOT);

    expect(response.status).toBe(200);
    expect(after).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// 4. Abstention
// ---------------------------------------------------------------------------

describe("POST /api/local-scan, abstention", () => {
  test("reports a real negative only when the walk covered everything", async () => {
    const response = await withGateOpen(() => postScanForPath(CLEAN_ROOT));
    const body = await readSuccess(response, "clean fixture");

    expect(body.counts.total).toBe(0);
    expect(body.limits).toEqual([]);
    expect(body.verdict).toBe("not_exposed");

    // Nothing in this route's vocabulary says "clean". The negative is scoped to the indicator
    // set that ran, because that is the only thing the walk actually checked.
    expect(body.rationale).not.toMatch(/\bclean\b/i);
  });

  test("abstains rather than reporting a negative when a cap truncated the walk", async () => {
    const scratchTree = await makeScratchTree();
    try {
      // Deeper than the walker's directory-depth cap, and holding no indicator file at all, so
      // the only thing separating this from the clean fixture is that the walk stopped early.
      await mkdir(join(scratchTree, ...new Array(OVER_DEPTH_LEVELS).fill("nested")), {
        recursive: true,
      });

      const response = await withGateOpen(() => postScanForPath(scratchTree));
      const body = await readSuccess(response, "over-depth tree");

      expect(body.counts.total).toBe(0);
      expect(body.limits.map((limit) => limit.id)).toContain("depth_cap");
      expect(body.verdict).toBe("unknown");
      expect(body.verdict).not.toBe("not_exposed");
    } finally {
      await rm(scratchTree, { recursive: true, force: true });
    }
  });

  test("abstains when a symlink out of the tree left a subtree unread", async () => {
    const scratchTree = await makeScratchTree();
    try {
      const created = await tryCreateDirectorySymlink("/etc", join(scratchTree, "linked"));
      if (!created) return;

      const response = await withGateOpen(() => postScanForPath(scratchTree));
      const body = await readSuccess(response, "escaping symlink inside the tree");

      expect(body.counts.total).toBe(0);
      expect(body.limits.map((limit) => limit.id)).toContain("skipped_symlinks");
      expect(body.verdict).toBe("unknown");

      // The link was counted, not followed: nothing under /etc reached the report.
      await expectNoMachineDetails(response, scratchTree);
    } finally {
      await rm(scratchTree, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 5. The rendered surface
// ---------------------------------------------------------------------------

describe("the /local surface", () => {
  test("renders no reading before anybody asked for one", () => {
    // The console's first paint, which is what a reader gets for loading the page. No effect
    // runs a scan on mount, so the only correct initial markup is a populated control and an
    // explicit statement that nothing has been read.
    const markup = renderToStaticMarkup(
      createElement(LocalScanConsole, {
        question: "Did anything leave a foothold in this directory?",
        lede: "A read-only walk of one directory on this machine.",
        defaultPath: PROJECT_ROOT,
        indicatorCount: 27,
      }),
    );

    expect(markup).toContain("Nothing has been read yet");
    // The button says what it will do, and neither control is disabled: a dead control would be
    // a lie about what the page can do. The attribute is matched with its value, because the
    // word also appears inside Tailwind's `disabled:` variant classes.
    expect(markup).toContain("Read this directory");
    expect(markup).not.toContain('disabled=""');
    // The field opens on the project directory. This is the one place a path belongs on screen:
    // it is the reader's own input, in their own browser, in the control they can edit.
    expect(markup).toContain(PROJECT_ROOT);
    // No result of any kind: no findings table, and nothing that could be read as a verdict.
    expect(markup).not.toContain("<table");
    expect(markup).not.toContain("Not exposed");
  });

  test("renders a real report without leaking what was read", async () => {
    // The whole path end to end: the route scans the compromised fixture, the schema validates
    // the answer, and the components render it. Anything the route kept out of the response
    // cannot appear here, and this asserts that nothing put it back.
    const response = await withGateOpen(() => postScanForPath(COMPROMISED_ROOT));
    const report = await readSuccess(response, "compromised fixture, rendered");

    const markup =
      renderToStaticMarkup(createElement(ScanReadoutPanel, { report })) +
      renderToStaticMarkup(createElement(FindingsTable, { findings: report.findings }));

    // The rows are really there, so the assertions below are about a populated table.
    const firstFinding = report.findings[0];
    if (firstFinding === undefined) {
      return expect.unreachable("the compromised fixture produced no findings to render");
    }
    expect(markup).toContain(firstFinding.relativePath);
    expect(markup).toContain(firstFinding.title);

    // The matched line's content, the machine's layout and the reader's home directory: none of
    // the three reaches the markup, and the planted secret is the canary for the first.
    expect(markup).not.toContain(PLANTED_SECRET);
    expect(markup).not.toContain(PROJECT_ROOT);
    expect(markup).not.toContain(homedir());
  });
});
