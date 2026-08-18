import { describe, expect, test } from "bun:test";

import {
  buildLeaderboardHref,
  describeRowCountChoices,
  readAccountKey,
  readRowCount,
  selectRowCount,
} from "@/components/leaderboard/leaderboard-query";
import {
  describeLeaderboardRows,
  describeRowCoverage,
  selectRow,
} from "@/components/leaderboard/leaderboard-rows";
import type { MaintainerSurface } from "@/lib/analysis/maintainer-surface";
import { UNKNOWN_READING } from "@/lib/format";
import { SliceCoverage, type SliceManifest } from "@/lib/graph/slice-manifest";

/**
 * The /maintainers view model.
 *
 * What is asserted here is the set of decisions that decide whether the leaderboard is evidence
 * or a claim: which of a row's numbers may be printed as a number at all, and how a URL that
 * asks for a state the board cannot show is resolved. The ranking itself belongs to
 * test/maintainer-surface.test.ts and is not re-tested here.
 */

function makeManifest(overrides: Partial<SliceManifest>): SliceManifest {
  return {
    version: 1,
    generatedAtMs: 1_700_000_000_000,
    ecosystems: ["npm"],
    closedPackageKeys: [],
    partialPackageKeys: [],
    closedServiceKeys: [],
    counts: {
      packages: 2,
      versions: 4,
      maintainers: 2,
      services: 1,
      advisories: 0,
      resolutionEdges: 3,
    },
    notes: [],
    ...overrides,
  };
}

function makeSurface({
  username,
  packageKeys = ["npm:left-pad"],
  weeklyDownloads = 1_000,
  packagesWithoutDownloadCount = 0,
  reachedServiceCount = 1,
}: {
  username: string;
  packageKeys?: readonly string[];
  weeklyDownloads?: number;
  packagesWithoutDownloadCount?: number;
  reachedServiceCount?: number;
}): MaintainerSurface {
  return {
    subject: {
      maintainerKey: `npm:${username}`,
      ecosystem: "npm",
      username,
      nodeId: 1,
    },
    direct: {
      packages: packageKeys.map((packageKey) => ({
        packageKey,
        ecosystem: "npm",
        name: packageKey.slice("npm:".length),
        weeklyDownloads: 1_000,
        versionCount: 2,
      })),
      versionCount: 2,
      dependentVersionCount: 3,
      dependentPackageCount: 2,
      reachedServices: Array.from({ length: reachedServiceCount }, (_unused, index) => ({
        serviceKey: `service-${index}`,
        serviceName: `service-${index}`,
        hopCount: 1,
      })),
      reachableWeeklyDownloads: weeklyDownloads,
      packagesWithoutDownloadCount,
    },
    modelled: {
      isModelled: true,
      candidateVersionCount: 0,
      candidatePackageCount: 0,
      candidateVersionsWithInstallScript: 0,
      candidatePackagesWithInstallScript: 0,
      assumption: "stated worst case",
    },
  };
}

describe("describeRowCoverage", () => {
  const surface = makeSurface({ username: "alice", packageKeys: ["npm:a", "npm:b"] });

  test("every package closed makes the row's numbers measured", () => {
    const coverage = new SliceCoverage(makeManifest({ closedPackageKeys: ["npm:a", "npm:b"] }));
    expect(describeRowCoverage(coverage, surface)).toBe("closed");
  });

  test("one package short of closed makes the whole row a lower bound", () => {
    const coverage = new SliceCoverage(
      makeManifest({ closedPackageKeys: ["npm:a"], partialPackageKeys: ["npm:b"] }),
    );
    expect(describeRowCoverage(coverage, surface)).toBe("partial");
  });

  test("an account with no ingested package is partial, not absent", () => {
    // Their packages were not ingested, which is not the same as having none, and "absent"
    // would let the row print "no claim" where the honest reading is a lower bound.
    const coverage = new SliceCoverage(makeManifest({}));
    expect(describeRowCoverage(coverage, makeSurface({ username: "bob", packageKeys: [] }))).toBe(
      "partial",
    );
  });
});

describe("describeLeaderboardRows", () => {
  test("no service found under partial coverage reads unknown, never zero", () => {
    const rows = describeLeaderboardRows({
      rows: [makeSurface({ username: "alice", reachedServiceCount: 0 })],
      coverage: new SliceCoverage(makeManifest({ partialPackageKeys: ["npm:left-pad"] })),
    });

    // The exact false negative this surface exists to avoid: a printed 0 in a reach column
    // under coverage that cannot support it.
    expect(rows[0]?.serviceReading).toBe(UNKNOWN_READING);
    expect(rows[0]?.isServiceReachKnown).toBe(false);
    expect(rows[0]?.basisReading).toBe("lower bound");
  });

  test("no service found under closed coverage reads zero, because zero is the finding", () => {
    const rows = describeLeaderboardRows({
      rows: [makeSurface({ username: "alice", reachedServiceCount: 0 })],
      coverage: new SliceCoverage(makeManifest({ closedPackageKeys: ["npm:left-pad"] })),
    });

    expect(rows[0]?.serviceReading).toBe("0");
    expect(rows[0]?.isServiceReachKnown).toBe(true);
    expect(rows[0]?.basisReading).toBe("measured");
  });

  test("a sum over packages that all reported nothing has no sum to print", () => {
    const rows = describeLeaderboardRows({
      rows: [
        makeSurface({
          username: "alice",
          packageKeys: ["npm:a", "npm:b"],
          weeklyDownloads: 0,
          packagesWithoutDownloadCount: 2,
        }),
      ],
      coverage: new SliceCoverage(makeManifest({ closedPackageKeys: ["npm:a", "npm:b"] })),
    });

    expect(rows[0]?.downloadReading).toBe(UNKNOWN_READING);
    expect(rows[0]?.isDownloadSumKnown).toBe(false);
    expect(rows[0]?.isDownloadSumPartial).toBe(false);
  });

  test("a sum over some reporting packages is printed and flagged partial", () => {
    const rows = describeLeaderboardRows({
      rows: [
        makeSurface({
          username: "alice",
          packageKeys: ["npm:a", "npm:b"],
          weeklyDownloads: 4_200,
          packagesWithoutDownloadCount: 1,
        }),
      ],
      coverage: new SliceCoverage(makeManifest({ closedPackageKeys: ["npm:a", "npm:b"] })),
    });

    expect(rows[0]?.downloadReading).toBe("4,200");
    expect(rows[0]?.isDownloadSumKnown).toBe(true);
    expect(rows[0]?.isDownloadSumPartial).toBe(true);
  });

  test("the library's order becomes the rank, and nothing re-sorts it", () => {
    const rows = describeLeaderboardRows({
      rows: [
        makeSurface({ username: "alice", reachedServiceCount: 1 }),
        makeSurface({ username: "bob", reachedServiceCount: 9 }),
      ],
      coverage: new SliceCoverage(makeManifest({ closedPackageKeys: ["npm:left-pad"] })),
    });

    expect(rows.map((row) => [row.rank, row.surface.subject.username])).toEqual([
      [1, "alice"],
      [2, "bob"],
    ]);
  });
});

describe("selectRow", () => {
  const rows = describeLeaderboardRows({
    rows: [makeSurface({ username: "alice" }), makeSurface({ username: "bob" })],
    coverage: new SliceCoverage(makeManifest({ closedPackageKeys: ["npm:left-pad"] })),
  });

  test("no request opens the worst-ranked account", () => {
    expect(selectRow(rows, null)?.surface.subject.username).toBe("alice");
  });

  test("a key that names a ranked row opens that row", () => {
    expect(selectRow(rows, "npm:bob")?.surface.subject.username).toBe("bob");
  });

  test("a stale or mistyped key falls back rather than failing", () => {
    expect(selectRow(rows, "npm:nobody")?.surface.subject.username).toBe("alice");
  });

  test("an empty ranking opens nothing", () => {
    expect(selectRow([], "npm:alice")).toBeNull();
  });
});

describe("the row count in the URL", () => {
  test("only an offered count is honoured, and a repeated parameter takes its first entry", () => {
    expect(readRowCount("25")).toBe(25);
    expect(readRowCount(["100", "10"])).toBe(100);
    // Compared against the offered set rather than clamped: a clamp would answer rows=11 with
    // ten rows and a URL that says eleven.
    expect(readRowCount("11")).toBe(10);
    expect(readRowCount("drop")).toBe(10);
    expect(readRowCount(undefined)).toBe(10);
  });

  test("an empty account parameter is absent, not a key that matches nothing", () => {
    expect(readAccountKey("  ")).toBeNull();
    expect(readAccountKey(undefined)).toBeNull();
    expect(readAccountKey(" npm:alice ")).toBe("npm:alice");
  });

  test("a key is encoded into the href rather than concatenated into it", () => {
    expect(buildLeaderboardHref({ rowCount: 25, accountKey: "npm:@scope/name" })).toBe(
      "/maintainers?rows=25&account=npm%3A%40scope%2Fname",
    );
  });

  test("the default account is omitted, so an untouched surface has the shortest link", () => {
    expect(buildLeaderboardHref({ rowCount: 10, accountKey: null })).toBe("/maintainers?rows=10");
  });

  test("a choice is offered only while it trims the board", () => {
    expect(describeRowCountChoices(30)).toEqual([
      { rowCount: 10, label: "Top 10" },
      { rowCount: 25, label: "Top 25" },
      { rowCount: 100, label: "All 30" },
    ]);
    // Eight accounts: one choice, so the caller renders no control at all.
    expect(describeRowCountChoices(8)).toEqual([{ rowCount: 10, label: "All 8" }]);
  });

  test("a count the board cannot fill resolves to the widest offered choice", () => {
    const choices = describeRowCountChoices(12);
    expect(selectRowCount(choices, 100)).toBe(25);
    expect(selectRowCount(choices, 10)).toBe(10);
    expect(selectRowCount([], 25)).toBe(10);
  });
});
