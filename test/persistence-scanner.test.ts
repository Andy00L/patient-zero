import { describe, expect, test } from "bun:test";
import { mkdir, rmdir, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  type ScanFinding,
  type ScanReport,
  resolvePackageNameFromRelativePath,
  scanForPersistence,
} from "@/lib/scanner/persistence";

/**
 * The scanner is a trust boundary: it reads paths on the user's machine and must
 * never report what it read. These tests therefore assert two different things about
 * every hit. That the indicator fired, and that the report does not contain the bytes
 * that made it fire.
 *
 * Fixtures are a real tree rather than synthesized strings, because the walk itself
 * (directory skipping, symlink containment, node_modules package resolution) is what
 * is under test and none of it can be exercised without a filesystem.
 */
const FIXTURE_ROOT = join(import.meta.dir, "fixtures", "scanner");
const CLEAN_ROOT = join(FIXTURE_ROOT, "clean");
const COMPROMISED_ROOT = join(FIXTURE_ROOT, "compromised");

/**
 * The literal planted in the compromised CLAUDE.md fixture. The scanner proves it
 * matched by reporting a line number, so this string must never appear in a
 * serialized report.
 * sourceRef: test/fixtures/scanner/compromised/CLAUDE.md
 */
const PLANTED_SECRET = "FIXTURE-PLANTED-SECRET-c0ffee";

/** Line holding "runOn" in the compromised tasks.json. Unit: 1-indexed line number. */
const TASKS_JSON_RUN_ON_LINE = 9;

/** Line holding the credential-read directive in the compromised CLAUDE.md. Unit: 1-indexed line number. */
const CLAUDE_MD_DIRECTIVE_LINE = 5;

function findFinding(
  report: ScanReport,
  indicatorId: string,
  relativePath: string,
): ScanFinding | undefined {
  return report.findings.find(
    (finding) => finding.indicatorId === indicatorId && finding.relativePath === relativePath,
  );
}

describe("scanForPersistence guards", () => {
  test("refuses to run without consent, before touching the filesystem", async () => {
    // A root that does not exist: a "not_found" here would prove the scan reached the
    // filesystem before it checked consent.
    const missingRoot = join(FIXTURE_ROOT, "no-such-fixture-directory");

    const result = await scanForPersistence({ rootPath: missingRoot, consentGiven: false });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe("invalid_input");
    expect(result.failure.message).toContain("opt-in");
  });

  test("refuses an empty, blank or relative root path", async () => {
    for (const rootPath of ["", "   ", "test/fixtures/scanner/clean", "./clean"]) {
      const result = await scanForPersistence({ rootPath, consentGiven: true });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.reason).toBe("invalid_input");
    }
  });
});

describe("scanForPersistence over a clean tree", () => {
  test("reports nothing and does not truncate", async () => {
    const result = await scanForPersistence({ rootPath: CLEAN_ROOT, consentGiven: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const report = result.value;

    expect(report.findings).toEqual([]);
    expect(report.truncated.reason).toBeNull();
    expect(report.unreadablePathCount).toBe(0);
    expect(report.skippedOutsideRootCount).toBe(0);
    // A zero-file walk would make "no findings" meaningless, so the count is part of
    // the assertion: the tree really was visited.
    expect(report.filesVisited).toBeGreaterThan(0);
    expect(report.bytesRead).toBeGreaterThan(0);
    expect(report.rootRelativeLabel).toBe("clean");
  });

  test("an ordinary CLAUDE.md is not a finding, while a planted one is", async () => {
    const cleanResult = await scanForPersistence({ rootPath: CLEAN_ROOT, consentGiven: true });
    const plantedResult = await scanForPersistence({ rootPath: COMPROMISED_ROOT, consentGiven: true });

    expect(cleanResult.ok).toBe(true);
    expect(plantedResult.ok).toBe(true);
    if (!cleanResult.ok || !plantedResult.ok) return;

    const cleanInstructionFindings = cleanResult.value.findings.filter(
      (finding) => finding.relativePath === "CLAUDE.md",
    );
    expect(cleanInstructionFindings).toEqual([]);

    // The same indicator has to fire on the planted file, otherwise the clean result
    // above would only prove the indicator never works.
    expect(
      findFinding(plantedResult.value, "agent-instruction-credential-read-directive", "CLAUDE.md"),
    ).toBeDefined();
  });
});

describe("scanForPersistence over a compromised tree", () => {
  test("finds a folderOpen task with the right indicator and line number", async () => {
    const result = await scanForPersistence({ rootPath: COMPROMISED_ROOT, consentGiven: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const finding = findFinding(result.value, "vscode-task-run-on-folder-open", ".vscode/tasks.json");
    expect(finding).toBeDefined();
    if (finding === undefined) return;

    expect(finding.lineNumber).toBe(TASKS_JSON_RUN_ON_LINE);
    expect(finding.severity).toBe("high");
    expect(finding.packageName).toBeNull();
  });

  test("finds install hooks in node_modules and resolves the owning package", async () => {
    const result = await scanForPersistence({ rootPath: COMPROMISED_ROOT, consentGiven: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const unscoped = findFinding(
      result.value,
      "install-hook-pipes-download-to-shell",
      "node_modules/evil-pkg/package.json",
    );
    expect(unscoped).toBeDefined();
    expect(unscoped?.packageName).toBe("evil-pkg");

    const scoped = findFinding(
      result.value,
      "install-hook-runs-known-worm-loader",
      "node_modules/@evil/loader/package.json",
    );
    expect(scoped).toBeDefined();
    expect(scoped?.packageName).toBe("@evil/loader");

    // The path-only artifact indicator needs no read, so it carries no line number.
    const artifact = findFinding(result.value, "worm-payload-artifact-present", "setup_bun.js");
    expect(artifact).toBeDefined();
    expect(artifact?.lineNumber).toBeNull();
  });

  test("proves a match by line number and never carries the matched content", async () => {
    const result = await scanForPersistence({ rootPath: COMPROMISED_ROOT, consentGiven: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const directive = findFinding(
      result.value,
      "agent-instruction-credential-read-directive",
      "CLAUDE.md",
    );
    expect(directive?.lineNumber).toBe(CLAUDE_MD_DIRECTIVE_LINE);

    const serialized = JSON.stringify(result.value);
    expect(serialized).not.toContain(PLANTED_SECRET);
    expect(serialized).not.toContain("~/.npmrc");
    expect(serialized).not.toContain("npm-cache.com");
    expect(serialized).not.toContain("toJSON(secrets)");
    // No absolute path either: only the root's own directory name is safe to show.
    expect(serialized).not.toContain(COMPROMISED_ROOT);
    expect(result.value.rootRelativeLabel).toBe("compromised");
  });
});

describe("scanForPersistence containment", () => {
  test("counts a symlink that leaves the root instead of following it", async () => {
    const probeRoot = join(FIXTURE_ROOT, "symlink-probe");
    const linkPath = join(probeRoot, "escape");

    await mkdir(probeRoot, { recursive: true });

    // The link points at the compromised fixture tree, so following it would produce
    // findings. Zero findings is therefore evidence of containment, not of an empty
    // walk.
    if (!(await tryCreateDirectorySymlink(COMPROMISED_ROOT, linkPath))) {
      // Windows without developer mode, and some sandboxes, refuse symlink creation.
      // Reported rather than silently passed: this test asserts nothing there.
      console.log(
        "[scanForPersistenceContainment] symlink creation not permitted, containment assertion skipped",
      );
      await removeSymlinkProbe(probeRoot, linkPath);
      return;
    }

    try {
      const result = await scanForPersistence({ rootPath: probeRoot, consentGiven: true });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.skippedOutsideRootCount).toBe(1);
      expect(result.value.findings).toEqual([]);
      expect(result.value.filesVisited).toBe(0);
      expect(result.value.bytesRead).toBe(0);
      expect(result.value.unreadablePathCount).toBe(0);
    } finally {
      await removeSymlinkProbe(probeRoot, linkPath);
    }
  });
});

describe("resolvePackageNameFromRelativePath", () => {
  test("maps installed paths to package names across scopes, nesting and the pnpm store", () => {
    expect(resolvePackageNameFromRelativePath("node_modules/left-pad/package.json")).toBe("left-pad");
    expect(resolvePackageNameFromRelativePath("node_modules/@scope/ui/dist/index.js")).toBe("@scope/ui");

    // The last node_modules marker wins, so a nested dependency resolves to itself
    // rather than to the package that hoisted it.
    expect(resolvePackageNameFromRelativePath("node_modules/a/node_modules/@scope/b/index.js")).toBe(
      "@scope/b",
    );
    expect(
      resolvePackageNameFromRelativePath(
        "node_modules/.pnpm/left-pad@1.3.0/node_modules/left-pad/package.json",
      ),
    ).toBe("left-pad");

    // Reserved dot-prefixed entries are not packages.
    expect(resolvePackageNameFromRelativePath("node_modules/.bin/tsc")).toBeNull();
    // Incomplete and non-installed paths have no owning package.
    expect(resolvePackageNameFromRelativePath("node_modules")).toBeNull();
    expect(resolvePackageNameFromRelativePath("node_modules/@scope")).toBeNull();
    expect(resolvePackageNameFromRelativePath("src/lib/index.ts")).toBeNull();
    expect(resolvePackageNameFromRelativePath("")).toBeNull();
  });
});

/** True when the link was created. Symlink creation is a platform privilege, not a given. */
async function tryCreateDirectorySymlink(targetPath: string, linkPath: string): Promise<boolean> {
  try {
    await symlink(targetPath, linkPath, "dir");
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes the probe by unlinking the link itself and then removing the now-empty
 * directory. Deliberately not a recursive delete: the probe contains a link into the
 * fixture tree, and a recursive remove is not a risk worth taking to clean up a test.
 */
async function removeSymlinkProbe(probeRoot: string, linkPath: string): Promise<void> {
  await unlink(linkPath).catch(() => undefined);
  await rmdir(probeRoot).catch(() => undefined);
}
