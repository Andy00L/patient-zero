import { describe, expect, test } from "bun:test";

import {
  type ComparablePackage,
  type TyposquatFinding,
  type TyposquatSignal,
  UNMEASURED_EDIT_DISTANCE,
  areSamePackage,
  describeTyposquatSignal,
  findTyposquats,
  flattenPackageName,
  measureEditDistanceWithin,
  measureLevenshteinWithin,
  scanForTyposquats,
  toEcosystemIdentity,
  toTyposquatEdgeFacts,
} from "@/lib/analysis/typosquat";
import type { Failure, Result } from "@/lib/result";

/**
 * Weekly download figures below are order of magnitude placeholders, not measurements.
 * The detector only ever compares them as a ratio, so what matters is that a real target
 * sits far above a fresh squat and that a legitimate sibling sits close to its neighbour.
 */
const NPM_POPULAR: readonly ComparablePackage[] = [
  { ecosystem: "npm", name: "cross-env", weeklyDownloads: 8_000_000 },
  { ecosystem: "npm", name: "babel-cli", weeklyDownloads: 1_000_000 },
  { ecosystem: "npm", name: "mongoose", weeklyDownloads: 2_000_000 },
  { ecosystem: "npm", name: "mongodb", weeklyDownloads: 1_500_000 },
  { ecosystem: "npm", name: "axios", weeklyDownloads: 40_000_000 },
  { ecosystem: "npm", name: "d3", weeklyDownloads: 4_000_000 },
  { ecosystem: "npm", name: "moment", weeklyDownloads: 20_000_000 },
  { ecosystem: "npm", name: "node-fetch", weeklyDownloads: 30_000_000 },
  { ecosystem: "npm", name: "lodash", weeklyDownloads: 50_000_000 },
  { ecosystem: "npm", name: "express", weeklyDownloads: 30_000_000 },
  { ecosystem: "npm", name: "electron-notify", weeklyDownloads: 20_000 },
  { ecosystem: "npm", name: "@types/node", weeklyDownloads: 90_000_000 },
];

/** No weekly downloads on purpose: the PyPI JSON API does not publish any. */
const PYPI_POPULAR: readonly ComparablePackage[] = [
  { ecosystem: "pypi", name: "jellyfish" },
  { ecosystem: "pypi", name: "python-dateutil" },
  { ecosystem: "pypi", name: "colorama" },
  { ecosystem: "pypi", name: "requests" },
  { ecosystem: "pypi", name: "urllib3" },
];

function readFailureOrUnreachable<TValue>(result: Result<TValue>): Failure {
  if (result.ok) return expect.unreachable("expected a Failure, received a value");
  return result.failure;
}

function readValueOrUnreachable<TValue>(result: Result<TValue>): TValue {
  if (!result.ok) return expect.unreachable(`expected a value, received ${result.failure.message}`);
  return result.value;
}

function readOnlyFindingOrUnreachable(result: Result<TyposquatFinding[]>): TyposquatFinding {
  const findings = readValueOrUnreachable(result);
  expect(findings.map((finding) => finding.target.name)).toHaveLength(1);
  const only = findings[0];
  if (only === undefined) return expect.unreachable("expected exactly one finding");
  return only;
}

function readSignalOrUnreachable<TKind extends TyposquatSignal["kind"]>(
  finding: TyposquatFinding,
  kind: TKind,
): Extract<TyposquatSignal, { kind: TKind }> {
  const matching = finding.signals.filter(
    (signal): signal is Extract<TyposquatSignal, { kind: TKind }> => signal.kind === kind,
  );
  const first = matching[0];
  if (first === undefined) {
    return expect.unreachable(
      `expected a ${kind} signal, saw ${finding.signals.map((signal) => signal.kind).join(", ")}`,
    );
  }
  return first;
}

describe("bounded Damerau-Levenshtein", () => {
  test("scores a transposition as one edit where plain Levenshtein scores two", () => {
    expect(measureEditDistanceWithin("axois", "axios", 1)).toBe(1);
    expect(measureLevenshteinWithin("axois", "axios", 2)).toBe(2);
    expect(measureLevenshteinWithin("axois", "axios", 1)).toBeNull();
  });

  test("returns null instead of a distance once the bound is exceeded", () => {
    expect(measureEditDistanceWithin("mongose", "mongoose", 1)).toBe(1);
    expect(measureEditDistanceWithin("chalk", "check", 2)).toBe(2);
    expect(measureEditDistanceWithin("chalk", "check", 1)).toBeNull();
  });

  test("rejects a pair on the length difference alone, before any table work", () => {
    // The length difference is a lower bound on the distance, which is what keeps a scan of
    // 10,000 popular names cheap.
    expect(measureEditDistanceWithin("react", "react-native-web", 2)).toBeNull();
    expect(measureEditDistanceWithin("", "ab", 2)).toBe(2);
    expect(measureEditDistanceWithin("lodash", "lodash", 0)).toBe(0);
  });
});

describe("registry identity", () => {
  test("PEP 503 makes two PyPI spellings one project, npm keeps them apart", () => {
    expect(toEcosystemIdentity("pypi", "Zope.Interface")).toBe("zope-interface");
    expect(areSamePackage("pypi", "Zope.Interface", "zope-interface")).toBe(true);
    expect(areSamePackage("npm", "Zope.Interface", "zope-interface")).toBe(false);
    expect(flattenPackageName("@types/Node_Fetch")).toBe("typesnodefetch");
  });
});

describe("documented npm campaigns", () => {
  test("crossenv against cross-env, from the packages npm removed in August 2017", () => {
    const finding = readOnlyFindingOrUnreachable(
      findTyposquats({ ecosystem: "npm", name: "crossenv", weeklyDownloads: 100 }, NPM_POPULAR),
    );

    expect(finding.target.name).toBe("cross-env");
    expect(finding.confidence).toBe("high");
    expect(finding.editDistance).toBe(1);
    // Hardest to explain away first: the two names are the same letters in the same order.
    expect(finding.signals[0]?.kind).toBe("separator_or_case");

    const separator = readSignalOrUnreachable(finding, "separator_or_case");
    expect(separator.flattenedForm).toBe("crossenv");
    expect(separator.separatorsDiffer).toBe(true);
    expect(separator.caseDiffers).toBe(false);

    expect(readSignalOrUnreachable(finding, "edit_distance").distance).toBe(1);
    expect(readSignalOrUnreachable(finding, "popularity_gap").ratio).toBe(80_000);
  });

  test("babelcli against babel-cli, same 2017 campaign", () => {
    const finding = readOnlyFindingOrUnreachable(
      findTyposquats({ ecosystem: "npm", name: "babelcli", weeklyDownloads: 50 }, NPM_POPULAR),
    );

    expect(finding.target.name).toBe("babel-cli");
    expect(finding.confidence).toBe("high");
    expect(readSignalOrUnreachable(finding, "separator_or_case").flattenedForm).toBe("babelcli");
  });

  test("mongose against mongoose ranks above the two-edit neighbour it also matches", () => {
    const scan = readValueOrUnreachable(
      scanForTyposquats({ ecosystem: "npm", name: "mongose", weeklyDownloads: 10 }, NPM_POPULAR, {
        maxFindings: 1,
      }),
    );

    // Two popular names sit within the default ceiling: mongoose at one edit, mongodb at two.
    expect(scan.matchedCount).toBe(2);
    expect(scan.findings).toHaveLength(1);
    const best = scan.findings[0];
    if (best === undefined) return expect.unreachable("expected the capped scan to keep one finding");
    expect(best.target.name).toBe("mongoose");
    expect(best.confidence).toBe("high");
    expect(readSignalOrUnreachable(best, "edit_distance").distance).toBe(1);
  });

  test("d3.js against d3, the suffix token campaign, is padding rather than a distance match", () => {
    const finding = readOnlyFindingOrUnreachable(
      findTyposquats({ ecosystem: "npm", name: "d3.js", weeklyDownloads: 500 }, NPM_POPULAR),
    );

    expect(finding.target.name).toBe("d3");
    // Three characters apart, so the distance detector never sees it: padding is the signal.
    expect(finding.editDistance).toBe(UNMEASURED_EDIT_DISTANCE);
    const padding = readSignalOrUnreachable(finding, "padding");
    expect(padding.position).toBe("suffix");
    expect(padding.token).toBe("js");
    expect(padding.isKnownPaddingToken).toBe(true);
    expect(padding.strippedForm).toBe("d3");
    // A filler token is weak evidence on its own, so a confirmed gap lands it at medium.
    expect(finding.confidence).toBe("medium");
  });

  test("axois against axios reports the transposition in the evidence it renders", () => {
    const finding = readOnlyFindingOrUnreachable(
      findTyposquats({ ecosystem: "npm", name: "axois", weeklyDownloads: 20 }, NPM_POPULAR),
    );

    expect(finding.target.name).toBe("axios");
    expect(finding.confidence).toBe("high");
    const distance = readSignalOrUnreachable(finding, "edit_distance");
    expect(distance.distance).toBe(1);
    expect(distance.plainDistance).toBe(2);
    expect(distance.includesTransposition).toBe(true);
    expect(describeTyposquatSignal(distance)).toContain("transposition");
  });

  test("rnoment against moment collapses under the rn to m confusable", () => {
    const finding = readOnlyFindingOrUnreachable(
      findTyposquats({ ecosystem: "npm", name: "rnoment", weeklyDownloads: 50 }, NPM_POPULAR),
    );

    expect(finding.target.name).toBe("moment");
    expect(finding.confidence).toBe("high");
    const homoglyph = readSignalOrUnreachable(finding, "homoglyph");
    expect(homoglyph.canonicalForm).toBe("moment");
    expect(homoglyph.suspectSubstitutions).toEqual([{ written: "rn", canonical: "m", occurrences: 1 }]);
    expect(homoglyph.targetSubstitutions).toEqual([]);
  });

  test("NodeFetch against node-fetch is caught by case and separators, not by distance", () => {
    const finding = readOnlyFindingOrUnreachable(
      findTyposquats({ ecosystem: "npm", name: "NodeFetch", weeklyDownloads: 200 }, NPM_POPULAR),
    );

    expect(finding.target.name).toBe("node-fetch");
    expect(finding.confidence).toBe("high");
    // Three edits apart once case counts, which npm does count.
    expect(finding.editDistance).toBe(UNMEASURED_EDIT_DISTANCE);
    const separator = readSignalOrUnreachable(finding, "separator_or_case");
    expect(separator.caseDiffers).toBe(true);
    expect(separator.separatorsDiffer).toBe(true);
  });

  test("an unexpected scope over a popular name is scope confusion", () => {
    const finding = readOnlyFindingOrUnreachable(
      findTyposquats({ ecosystem: "npm", name: "@evil/lodash", weeklyDownloads: 40 }, NPM_POPULAR),
    );

    expect(finding.target.name).toBe("lodash");
    expect(finding.confidence).toBe("high");
    const scope = readSignalOrUnreachable(finding, "scope_confusion");
    expect(scope.variety).toBe("scope_added");
    expect(scope.suspectScope).toBe("evil");
    expect(scope.targetScope).toBeNull();
    expect(scope.sharedName).toBe("lodash");
  });

  test("a scope folded into the name is scope confusion in the other direction", () => {
    const finding = readOnlyFindingOrUnreachable(
      findTyposquats({ ecosystem: "npm", name: "types-node", weeklyDownloads: 30 }, NPM_POPULAR),
    );

    expect(finding.target.name).toBe("@types/node");
    expect(readSignalOrUnreachable(finding, "scope_confusion").variety).toBe("scope_flattened");
    expect(finding.confidence).toBe("high");
  });

  test("an inserted middle segment is padding, not a distance match", () => {
    // electron-native-notify was a real malicious npm package (2019, aimed at the Komodo
    // Agama wallet). Pairing it with electron-notify is this module's generalization, not a
    // documented squat pair: the campaign relied on a plausible name rather than a typo.
    const finding = readOnlyFindingOrUnreachable(
      findTyposquats(
        { ecosystem: "npm", name: "electron-native-notify", weeklyDownloads: 100 },
        NPM_POPULAR,
      ),
    );

    expect(finding.target.name).toBe("electron-notify");
    const padding = readSignalOrUnreachable(finding, "padding");
    expect(padding.position).toBe("infix");
    expect(padding.token).toBe("native");
    expect(padding.isKnownPaddingToken).toBe(false);
    expect(finding.confidence).toBe("medium");
  });
});

describe("documented PyPI campaigns", () => {
  test("jeIlyfish against jellyfish, removed from PyPI in December 2019", () => {
    const finding = readOnlyFindingOrUnreachable(
      findTyposquats({ ecosystem: "pypi", name: "jeIlyfish" }, PYPI_POPULAR),
    );

    expect(finding.suspect.name).toBe("jeilyfish");
    expect(finding.target.name).toBe("jellyfish");
    const homoglyph = readSignalOrUnreachable(finding, "homoglyph");
    expect(homoglyph.canonicalForm).toBe("jellyflsh");
    expect(homoglyph.suspectSubstitutions).toEqual([{ written: "i", canonical: "l", occurrences: 2 }]);
    expect(readSignalOrUnreachable(finding, "edit_distance").distance).toBe(1);
    // PyPI publishes no download counts, so the gap cannot be confirmed and a strong
    // spelling signal stops at medium instead of high.
    expect(finding.signals.some((signal) => signal.kind === "popularity_gap")).toBe(false);
    expect(finding.confidence).toBe("medium");
  });

  test("the same PyPI pair reaches high once the caller supplies download counts", () => {
    const finding = readOnlyFindingOrUnreachable(
      findTyposquats({ ecosystem: "pypi", name: "jeIlyfish", weeklyDownloads: 12 }, [
        { ecosystem: "pypi", name: "jellyfish", weeklyDownloads: 900_000 },
      ]),
    );

    expect(finding.confidence).toBe("high");
    expect(readSignalOrUnreachable(finding, "popularity_gap").targetWeeklyDownloads).toBe(900_000);
  });

  test("python3-dateutil against python-dateutil, removed alongside jeIlyfish", () => {
    const finding = readOnlyFindingOrUnreachable(
      findTyposquats({ ecosystem: "pypi", name: "python3-dateutil" }, PYPI_POPULAR),
    );

    expect(finding.target.name).toBe("python-dateutil");
    expect(readSignalOrUnreachable(finding, "edit_distance").distance).toBe(1);
    const padding = readSignalOrUnreachable(finding, "padding");
    expect(padding.token).toBe("3");
    expect(padding.strippedForm).toBe("python-dateutil");
    expect(finding.confidence).toBe("medium");
  });

  test("colourama against colorama, the 2018 PyPI clipboard hijacker", () => {
    const finding = readOnlyFindingOrUnreachable(
      findTyposquats({ ecosystem: "pypi", name: "colourama" }, PYPI_POPULAR),
    );

    expect(finding.target.name).toBe("colorama");
    expect(readSignalOrUnreachable(finding, "edit_distance").distance).toBe(1);
  });
});

describe("false positives that must never appear", () => {
  test("a package is never reported as a squat of itself", () => {
    const findings = readValueOrUnreachable(
      findTyposquats({ ecosystem: "npm", name: "express", weeklyDownloads: 30_000_000 }, NPM_POPULAR),
    );
    expect(findings).toEqual([]);
  });

  test("two PyPI spellings of one project cannot squat each other", () => {
    const findings = readValueOrUnreachable(
      findTyposquats({ ecosystem: "pypi", name: "Zope.Interface" }, [
        { ecosystem: "pypi", name: "zope-interface" },
      ]),
    );
    expect(findings).toEqual([]);
  });

  test("the same two spellings on npm are two packages and are reported", () => {
    const finding = readOnlyFindingOrUnreachable(
      findTyposquats({ ecosystem: "npm", name: "Zope.Interface", weeklyDownloads: 10 }, [
        { ecosystem: "npm", name: "zope-interface", weeklyDownloads: 5_000_000 },
      ]),
    );
    expect(finding.confidence).toBe("high");
    const separator = readSignalOrUnreachable(finding, "separator_or_case");
    expect(separator.caseDiffers).toBe(true);
    expect(separator.separatorsDiffer).toBe(true);
  });

  test("a DefinitelyTyped package is not a squat of the package it types", () => {
    // Asserted with the popularity gate wide open, so the empty result can only come from
    // the conventional scope rule and not from the ratio.
    const findings = readValueOrUnreachable(
      findTyposquats(
        { ecosystem: "npm", name: "@types/express", weeklyDownloads: 30_000_000 },
        NPM_POPULAR,
        { minPopularityRatio: 1 },
      ),
    );
    expect(findings).toEqual([]);
  });

  test("a name from the other registry is never a squat, a port is not an imitation", () => {
    const scan = readValueOrUnreachable(
      scanForTyposquats({ ecosystem: "npm", name: "requests", weeklyDownloads: 100 }, PYPI_POPULAR),
    );
    expect(scan.findings).toEqual([]);
    expect(scan.comparedCount).toBe(0);
    expect(scan.otherEcosystemCount).toBe(PYPI_POPULAR.length);
  });

  test("finding nothing is a success, not a failure", () => {
    const findings = readValueOrUnreachable(
      findTyposquats({ ecosystem: "npm", name: "hydra-patient-zero", weeklyDownloads: 1 }, []),
    );
    expect(findings).toEqual([]);
  });
});

describe("popularity gap", () => {
  const REACT_DOM: readonly ComparablePackage[] = [
    { ecosystem: "npm", name: "react-dom", weeklyDownloads: 25_000_000 },
  ];

  test("a sibling with comparable popularity is rejected", () => {
    const findings = readValueOrUnreachable(
      findTyposquats(
        { ecosystem: "npm", name: "react-router-dom", weeklyDownloads: 11_000_000 },
        REACT_DOM,
      ),
    );
    expect(findings).toEqual([]);
  });

  test("the same pair matches on spelling, so only the ratio rejected it", () => {
    const finding = readOnlyFindingOrUnreachable(
      findTyposquats(
        { ecosystem: "npm", name: "react-router-dom", weeklyDownloads: 11_000_000 },
        REACT_DOM,
        { minPopularityRatio: 1 },
      ),
    );

    expect(readSignalOrUnreachable(finding, "padding").token).toBe("router");
    // Weak spelling evidence plus a confirmed but small gap: medium, never high.
    expect(finding.confidence).toBe("medium");
    expect(readSignalOrUnreachable(finding, "popularity_gap").ratio).toBeCloseTo(2.27, 2);
  });

  test("an unknown download count abstains instead of rejecting", () => {
    const finding = readOnlyFindingOrUnreachable(
      findTyposquats({ ecosystem: "npm", name: "crossenv" }, [
        { ecosystem: "npm", name: "cross-env" },
      ]),
    );
    expect(finding.signals.some((signal) => signal.kind === "popularity_gap")).toBe(false);
    expect(finding.confidence).toBe("medium");
  });
});

describe("invalid input", () => {
  test("an empty name fails", () => {
    const failure = readFailureOrUnreachable(
      findTyposquats({ ecosystem: "npm", name: "   " }, NPM_POPULAR),
    );
    expect(failure.reason).toBe("invalid_input");
    expect(failure.message).toContain("empty package name");
  });

  test("a name past the npm 214 character cap fails", () => {
    const failure = readFailureOrUnreachable(
      findTyposquats({ ecosystem: "npm", name: "a".repeat(215) }, NPM_POPULAR),
    );
    expect(failure.reason).toBe("invalid_input");
    expect(failure.message).toContain("215");
  });

  test("options outside their documented range fail rather than being clamped", () => {
    const distance = readFailureOrUnreachable(
      findTyposquats({ ecosystem: "npm", name: "crossenv" }, NPM_POPULAR, { maxEditDistance: 5 }),
    );
    expect(distance.reason).toBe("invalid_input");
    expect(distance.message).toContain("maxEditDistance");

    const ratio = readFailureOrUnreachable(
      findTyposquats({ ecosystem: "npm", name: "crossenv" }, NPM_POPULAR, { minPopularityRatio: 0.5 }),
    );
    expect(ratio.message).toContain("minPopularityRatio");

    const findings = readFailureOrUnreachable(
      findTyposquats({ ecosystem: "npm", name: "crossenv" }, NPM_POPULAR, { maxFindings: 0 }),
    );
    expect(findings.message).toContain("maxFindings");
  });
});

describe("scan bookkeeping", () => {
  test("stopping early is reported as a scan_capped limit, never dropped in silence", () => {
    const scan = readValueOrUnreachable(
      scanForTyposquats({ ecosystem: "npm", name: "crossenv", weeklyDownloads: 100 }, NPM_POPULAR, {
        maxComparedNames: 1,
      }),
    );

    expect(scan.comparedCount).toBe(1);
    const limit = scan.limits[0];
    if (limit?.kind !== "scan_capped") {
      return expect.unreachable(`expected a scan_capped limit, saw ${JSON.stringify(scan.limits)}`);
    }
    expect(limit.examined).toBe(1);
    expect(limit.total).toBe(NPM_POPULAR.length);
  });

  test("a completed scan carries no limits, and unusable names are counted", () => {
    const scan = readValueOrUnreachable(
      scanForTyposquats({ ecosystem: "npm", name: "crossenv", weeklyDownloads: 100 }, [
        ...NPM_POPULAR,
        { ecosystem: "npm", name: "  ", weeklyDownloads: 1 },
        { ecosystem: "npm", name: "b".repeat(215), weeklyDownloads: 1 },
        ...PYPI_POPULAR,
      ]),
    );

    expect(scan.limits).toEqual([]);
    expect(scan.comparedCount).toBe(NPM_POPULAR.length);
    expect(scan.unusableTargetCount).toBe(2);
    expect(scan.otherEcosystemCount).toBe(PYPI_POPULAR.length);
    expect(scan.matchedCount).toBe(1);
  });
});

describe("graph composition", () => {
  test("a finding becomes the fact shape the ingest layer stages", () => {
    const finding = readOnlyFindingOrUnreachable(
      findTyposquats({ ecosystem: "npm", name: "crossenv", weeklyDownloads: 100 }, NPM_POPULAR),
    );

    expect(toTyposquatEdgeFacts(finding, "6.0.6")).toEqual({
      suspect: { ecosystem: "npm", name: "crossenv", version: "6.0.6" },
      target: { ecosystem: "npm", name: "cross-env" },
      editDistance: 1,
    });
  });

  test("a pair matched on scoping carries an unmeasured distance onto the edge", () => {
    const finding = readOnlyFindingOrUnreachable(
      findTyposquats({ ecosystem: "npm", name: "@evil/lodash", weeklyDownloads: 40 }, NPM_POPULAR),
    );

    expect(toTyposquatEdgeFacts(finding, "1.0.0").editDistance).toBe(UNMEASURED_EDIT_DISTANCE);
  });
});
