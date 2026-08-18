import { describe, expect, test } from "bun:test";

import {
  type ConfusablePair,
  countMirroredPairs,
  countPairsByConfidence,
  describeReasons,
  foldConfusablePairs,
  keepAtFloor,
  type SideFacts,
  sideId,
  splitByLockfilePin,
} from "@/components/typosquats/confusable-pairs";
import {
  buildTyposquatHref,
  describeFloorChoices,
  readRequestedFloor,
  selectFloor,
} from "@/components/typosquats/typosquat-query";
import type {
  TyposquatConfidence,
  TyposquatFinding,
  TyposquatSignal,
} from "@/lib/analysis/typosquat";
import { UNKNOWN_WEEKLY_DOWNLOADS } from "@/lib/analysis/typosquat";

/**
 * The /typosquats view model.
 *
 * Three behaviours here are load bearing enough that a regression in them would make the surface
 * lie rather than look wrong: folding a collision reported from both ends into one pair while
 * recording that it was mirrored, splitting the pairs on the lockfile pin rather than on the
 * declared dependency, and resolving a confidence floor the URL asked for against the floors the
 * slice can actually offer. Everything else in those modules is a rearrangement of the detector's
 * own output and is covered by test/typosquat.test.ts.
 */

const EDIT_DISTANCE: TyposquatSignal = {
  kind: "edit_distance",
  distance: 1,
  plainDistance: 1,
  includesTransposition: false,
  suspectForm: "lodahs",
  targetForm: "lodash",
};

function makeFinding({
  suspect,
  target,
  confidence = "medium",
  targetWeeklyDownloads = 50_000_000,
}: {
  suspect: string;
  target: string;
  confidence?: TyposquatConfidence;
  targetWeeklyDownloads?: number;
}): TyposquatFinding {
  return {
    suspect: { ecosystem: "npm", name: suspect, providedName: suspect },
    target: {
      ecosystem: "npm",
      name: target,
      providedName: target,
      weeklyDownloads: targetWeeklyDownloads,
    },
    signals: [EDIT_DISTANCE],
    confidence,
    editDistance: 1,
  };
}

function makeFacts(entries: readonly [string, Partial<SideFacts>][]): Map<string, SideFacts> {
  const facts = new Map<string, SideFacts>();
  for (const [name, overrides] of entries) {
    facts.set(sideId("npm", name), {
      weeklyDownloads: UNKNOWN_WEEKLY_DOWNLOADS,
      nodeKey: `npm:${name}`,
      dependentVersionCount: 0,
      serviceNames: [],
      isProbed: true,
      ...overrides,
    });
  }
  return facts;
}

describe("foldConfusablePairs", () => {
  test("a collision reported from both ends becomes one pair marked mirrored", () => {
    const pairs = foldConfusablePairs({
      findings: [
        makeFinding({ suspect: "lodahs", target: "lodash" }),
        makeFinding({ suspect: "lodash", target: "lodahs" }),
      ],
      facts: makeFacts([
        ["lodahs", {}],
        ["lodash", {}],
      ]),
    });

    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.isMirrored).toBe(true);
    // The first finding is the one kept, so the incoming ranking decides which name is written
    // as the suspect and the fold never reverses it.
    expect(pairs[0]?.suspect.name).toBe("lodahs");
    expect(pairs[0]?.target.name).toBe("lodash");
    expect(countMirroredPairs(pairs)).toBe(1);
  });

  test("a collision reported once is not marked mirrored", () => {
    const pairs = foldConfusablePairs({
      findings: [makeFinding({ suspect: "lodahs", target: "lodash" })],
      facts: makeFacts([
        ["lodahs", {}],
        ["lodash", {}],
      ]),
    });

    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.isMirrored).toBe(false);
    expect(countMirroredPairs(pairs)).toBe(0);
  });

  test("the detector's order survives the fold", () => {
    const pairs = foldConfusablePairs({
      findings: [
        makeFinding({ suspect: "reqeusts", target: "requests", confidence: "high" }),
        makeFinding({ suspect: "lodahs", target: "lodash", confidence: "medium" }),
        makeFinding({ suspect: "requests", target: "reqeusts", confidence: "high" }),
        makeFinding({ suspect: "expres", target: "express", confidence: "low" }),
      ],
      facts: makeFacts([
        ["reqeusts", {}],
        ["requests", {}],
        ["lodahs", {}],
        ["lodash", {}],
        ["expres", {}],
        ["express", {}],
      ]),
    });

    expect(pairs.map((pair) => pair.confidence)).toEqual(["high", "medium", "low"]);
  });

  test("a name the facts map does not hold reads as unprobed rather than as clean", () => {
    const pairs = foldConfusablePairs({
      findings: [makeFinding({ suspect: "lodahs", target: "lodash" })],
      facts: makeFacts([["lodash", { dependentVersionCount: 4 }]]),
    });

    // Zero dependents and "nobody could ask" are different facts, and only the second one is
    // allowed to be rendered as unknown.
    expect(pairs[0]?.suspect.isProbed).toBe(false);
    expect(pairs[0]?.target.isProbed).toBe(true);
    expect(pairs[0]?.target.dependentVersionCount).toBe(4);
  });

  test("a pin on either name puts the pair in the pinned list", () => {
    const facts = makeFacts([
      ["lodahs", { serviceNames: ["checkout-api"] }],
      ["lodash", {}],
      ["expres", { dependentVersionCount: 9 }],
      ["express", { dependentVersionCount: 40 }],
    ]);

    const pairs = foldConfusablePairs({
      findings: [
        makeFinding({ suspect: "lodahs", target: "lodash" }),
        makeFinding({ suspect: "expres", target: "express" }),
      ],
      facts,
    });

    const split = splitByLockfilePin(pairs);
    expect(split.pinned.map((pair) => pair.suspect.name)).toEqual(["lodahs"]);
    // A declared dependency, however many of them, is not a pin and does not promote a pair.
    expect(split.unpinned.map((pair) => pair.suspect.name)).toEqual(["expres"]);
  });
});

describe("describeReasons", () => {
  test("a popularity gap is rendered through the shared count formatter", () => {
    const reasons = describeReasons([
      {
        kind: "popularity_gap",
        ratio: 25.4,
        suspectWeeklyDownloads: 2_000_000,
        targetWeeklyDownloads: 50_000_000,
      },
    ]);

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toBe(
      "the imitated package has 25 times the weekly downloads (50,000,000 against 2,000,000)",
    );
  });

  test("every other signal keeps the library's own sentence", () => {
    expect(describeReasons([EDIT_DISTANCE])[0]).toBe(
      '"lodahs" is 1 character edit away from "lodash"',
    );
  });
});

describe("keepAtFloor", () => {
  const pairs: ConfusablePair[] = (["high", "medium", "low"] as const).map((confidence) => ({
    pairId: confidence,
    ecosystem: "npm",
    suspect: {
      name: `${confidence}-suspect`,
      weeklyDownloads: UNKNOWN_WEEKLY_DOWNLOADS,
      nodeKey: null,
      dependentVersionCount: 0,
      serviceNames: [],
      isProbed: false,
    },
    target: {
      name: `${confidence}-target`,
      weeklyDownloads: UNKNOWN_WEEKLY_DOWNLOADS,
      nodeKey: null,
      dependentVersionCount: 0,
      serviceNames: [],
      isProbed: false,
    },
    confidence,
    reasons: ["a reason"],
    isMirrored: false,
    isPinnedHere: false,
  }));

  test("a floor keeps its own tier and every stronger one", () => {
    expect(keepAtFloor(pairs, "high").map((pair) => pair.confidence)).toEqual(["high"]);
    expect(keepAtFloor(pairs, "medium").map((pair) => pair.confidence)).toEqual(["high", "medium"]);
    expect(keepAtFloor(pairs, "low")).toHaveLength(3);
  });

  test("counting by tier reports a measured zero rather than a missing key", () => {
    expect(countPairsByConfidence(keepAtFloor(pairs, "medium"))).toEqual({
      high: 1,
      medium: 1,
      low: 0,
    });
  });
});

describe("the confidence floor in the URL", () => {
  test("only the three tiers are read, and an array takes its first entry", () => {
    expect(readRequestedFloor("low")).toBe("low");
    expect(readRequestedFloor(" MEDIUM ")).toBe("medium");
    expect(readRequestedFloor(["high", "low"])).toBe("high");
    expect(readRequestedFloor("none")).toBeNull();
    expect(readRequestedFloor(undefined)).toBeNull();
  });

  test("the href is encoded rather than concatenated", () => {
    expect(buildTyposquatHref("medium")).toBe("/typosquats?confidence=medium");
  });

  test("a floor is offered only when it changes the list", () => {
    // The medium tier is empty here, so a medium chip would show the same rows as the high one.
    expect(describeFloorChoices({ high: 2, medium: 0, low: 5 })).toEqual([
      { floor: "high", label: "high", pairCount: 2 },
      { floor: "low", label: "low", pairCount: 7 },
    ]);
  });

  test("the count on a chip is cumulative, since a floor lists its tier and every stronger one", () => {
    expect(describeFloorChoices({ high: 1, medium: 2, low: 4 }).map((c) => c.pairCount)).toEqual([
      1, 3, 7,
    ]);
  });

  test("a slice with nothing above the weakest tier offers one floor, so no control is rendered", () => {
    expect(describeFloorChoices({ high: 0, medium: 0, low: 6 })).toEqual([
      { floor: "low", label: "low", pairCount: 6 },
    ]);
  });

  test("an absent or unoffered request opens on the strongest offered floor", () => {
    const choices = describeFloorChoices({ high: 0, medium: 3, low: 9 });
    expect(selectFloor(choices, null)).toBe("medium");
    // Asked for a tier this slice does not reach: the shortest honest list, not an empty one.
    expect(selectFloor(choices, "high")).toBe("medium");
    expect(selectFloor(choices, "low")).toBe("low");
  });
});
