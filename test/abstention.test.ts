import { describe, expect, test } from "bun:test";

import {
  type AnswerLimit,
  budgetLimitFromContext,
  decideVerdict,
  describeLimit,
  detectHopLimit,
  detectPathLimit,
  isAbsenceLimit,
  isTruncatingLimit,
  weakestCoverage,
} from "@/lib/analysis/abstention";
import type { GraphPath, GraphPathEdge, GraphPathNode } from "@/lib/graph/gateway";
import { packageKey } from "@/lib/graph/model";

import { buildSliceCoverage } from "./fixtures/graph";

/**
 * The abstention model is the one module where a wrong answer is worse than no answer:
 * a not_exposed verdict tells someone their service is clean. So these tests are a
 * decision table, and the assertion that matters most is negative, that no combination
 * of inputs other than "closed coverage, nothing found, nothing truncated" can produce
 * not_exposed.
 */

const SUBJECT_KEY = packageKey("npm", "flatmap-stream");
const OTHER_KEY = packageKey("npm", "event-stream");

/** A limit sample paired with how the module is expected to classify it. */
type LimitCase = {
  [TKind in AnswerLimit["kind"]]: {
    sample: Extract<AnswerLimit, { kind: TKind }>;
    truncating: boolean;
    /** Substring the description must interpolate, so a renamed field is caught. */
    describes: string;
  };
}[AnswerLimit["kind"]];

const LIMIT_CASES: LimitCase[] = [
  { sample: { kind: "empty_graph" }, truncating: false, describes: "empty" },
  {
    sample: { kind: "package_absent", subjectKey: SUBJECT_KEY },
    truncating: false,
    describes: SUBJECT_KEY,
  },
  {
    sample: { kind: "package_partial", subjectKey: SUBJECT_KEY },
    truncating: true,
    describes: SUBJECT_KEY,
  },
  { sample: { kind: "hop_limit", maxHops: 4 }, truncating: true, describes: "4" },
  { sample: { kind: "path_limit", pathCount: 20 }, truncating: true, describes: "20" },
  {
    sample: { kind: "budget_rejected", operation: "max_query_scan_edges" },
    truncating: true,
    describes: "max_query_scan_edges",
  },
  {
    sample: { kind: "scan_capped", examined: 500, total: 5000 },
    truncating: true,
    describes: "5000",
  },
  {
    sample: { kind: "undecidable_versions", count: 3 },
    truncating: true,
    describes: "3",
  },
  {
    sample: {
      kind: "service_history_partial",
      serviceKey: "service:checkout-api",
      harvestedRevisions: 12,
    },
    truncating: true,
    describes: "12",
  },
  {
    sample: { kind: "timestamp_missing", field: "advisory published_at_ms" },
    truncating: true,
    describes: "advisory published_at_ms",
  },
];

/**
 * Exhaustiveness guard. A new AnswerLimit kind cannot compile without a key here, and
 * the coverage test below then fails until LIMIT_CASES gains the matching case. That
 * chain is deliberate: an unclassified kind would default to "not truncating" in
 * isAbsenceLimit and quietly re-enable not_exposed for a truncated traversal.
 */
const EXPECTED_KINDS: Record<AnswerLimit["kind"], true> = {
  empty_graph: true,
  package_absent: true,
  package_partial: true,
  hop_limit: true,
  path_limit: true,
  budget_rejected: true,
  scan_capped: true,
  undecidable_versions: true,
  service_history_partial: true,
  timestamp_missing: true,
};

/** A path shaped like a real one: hopCount edges and hopCount + 1 nodes. */
function pathWithHopCount(hopCount: number): GraphPath {
  const nodes: GraphPathNode[] = [
    { id: 1, labels: ["Version"], properties: { key: SUBJECT_KEY } },
  ];
  const relationships: GraphPathEdge[] = [];
  for (let hop = 1; hop <= hopCount; hop += 1) {
    nodes.push({
      id: hop + 1,
      labels: ["Version"],
      properties: { key: `npm:dependent-${hop}:1.0.0` },
    });
    relationships.push({
      id: hop,
      relType: "DEPENDED_ON_BY",
      sourceNodeId: hop,
      targetNodeId: hop + 1,
      properties: {},
    });
  }
  return { nodes, relationships, hopCount };
}

function limitKinds(limits: readonly AnswerLimit[]): string[] {
  return limits.map((limit) => limit.kind);
}

describe("decideVerdict branch order", () => {
  test("an empty graph outranks found evidence", () => {
    const decided = decideVerdict({
      foundEvidence: true,
      subjectCoverage: "closed",
      subjectKey: SUBJECT_KEY,
      limits: [],
      graphIsEmpty: true,
    });

    expect(decided.verdict).toBe("unknown");
    expect(limitKinds(decided.limits)).toEqual(["empty_graph"]);
  });

  test("empty_graph is prepended ahead of the limits the caller already had", () => {
    const decided = decideVerdict({
      foundEvidence: false,
      subjectCoverage: "absent",
      subjectKey: SUBJECT_KEY,
      limits: [{ kind: "hop_limit", maxHops: 8 }],
      graphIsEmpty: true,
    });

    // The first limit is the one the UI leads with, so ordering is behaviour. An empty
    // graph also swallows the absent-subject branch: there is nothing to be absent from.
    expect(limitKinds(decided.limits)).toEqual(["empty_graph", "hop_limit"]);
  });

  test("an absent subject is unknown and names the subject", () => {
    const decided = decideVerdict({
      foundEvidence: false,
      subjectCoverage: "absent",
      subjectKey: SUBJECT_KEY,
      limits: [],
      graphIsEmpty: false,
    });

    expect(decided.verdict).toBe("unknown");
    expect(decided.limits).toEqual([{ kind: "package_absent", subjectKey: SUBJECT_KEY }]);
    expect(decided.rationale).toContain(SUBJECT_KEY);
  });

  test("an absent subject outranks found evidence", () => {
    const decided = decideVerdict({
      foundEvidence: true,
      subjectCoverage: "absent",
      subjectKey: SUBJECT_KEY,
      limits: [],
      graphIsEmpty: false,
    });

    // Abstaining on a found path is the conservative direction, so this pins the branch
    // order the code implements. The doc comment above decideVerdict describes the
    // opposite order ("then found evidence, then absence"); the code is the contract.
    expect(decided.verdict).toBe("unknown");
    expect(limitKinds(decided.limits)).toEqual(["package_absent"]);
  });

  test("partial coverage adds package_partial exactly once", () => {
    const decided = decideVerdict({
      foundEvidence: false,
      subjectCoverage: "partial",
      subjectKey: SUBJECT_KEY,
      limits: [],
      graphIsEmpty: false,
    });

    expect(limitKinds(decided.limits)).toEqual(["package_partial"]);
    expect(decided.verdict).toBe("unknown");
  });

  test("partial coverage does not duplicate a package_partial the caller supplied", () => {
    const decided = decideVerdict({
      foundEvidence: false,
      subjectCoverage: "partial",
      subjectKey: SUBJECT_KEY,
      // The caller's limit names a different subject, which is the case a naive
      // "already has one" check gets wrong by keying on the subject instead of the kind.
      limits: [{ kind: "package_partial", subjectKey: OTHER_KEY }],
      graphIsEmpty: false,
    });

    expect(limitKinds(decided.limits)).toEqual(["package_partial"]);
    expect(decided.limits).toEqual([{ kind: "package_partial", subjectKey: OTHER_KEY }]);
  });

  test("found evidence under complete coverage reports a finished traversal", () => {
    const decided = decideVerdict({
      foundEvidence: true,
      subjectCoverage: "closed",
      subjectKey: SUBJECT_KEY,
      limits: [],
      graphIsEmpty: false,
    });

    expect(decided.verdict).toBe("exposed");
    expect(decided.rationale).toContain("ran to completion");
    expect(decided.limits).toEqual([]);
  });

  test("found evidence under partial coverage reports a floor, not a total", () => {
    const decided = decideVerdict({
      foundEvidence: true,
      subjectCoverage: "partial",
      subjectKey: SUBJECT_KEY,
      limits: [],
      graphIsEmpty: false,
    });

    expect(decided.verdict).toBe("exposed");
    // Partial coverage counts as truncation, so the rationale has to stop claiming the
    // reach is complete. Same verdict, different sentence.
    expect(decided.rationale).toContain("at least this large");
    expect(decided.rationale).not.toContain("ran to completion");
  });

  test("found evidence under a truncating limit reports a floor, not a total", () => {
    const decided = decideVerdict({
      foundEvidence: true,
      subjectCoverage: "closed",
      subjectKey: SUBJECT_KEY,
      limits: [{ kind: "hop_limit", maxHops: 3 }],
      graphIsEmpty: false,
    });

    expect(decided.verdict).toBe("exposed");
    expect(decided.rationale).toContain("at least this large");
  });

  test("closed coverage, nothing found and nothing truncated is the only not_exposed", () => {
    const decided = decideVerdict({
      foundEvidence: false,
      subjectCoverage: "closed",
      subjectKey: SUBJECT_KEY,
      limits: [],
      graphIsEmpty: false,
    });

    expect(decided.verdict).toBe("not_exposed");
    expect(decided.limits).toEqual([]);
    expect(decided.rationale).toContain(SUBJECT_KEY);
  });
});

describe("a truncated empty result never becomes a negative", () => {
  for (const limitCase of LIMIT_CASES) {
    if (!limitCase.truncating) continue;

    test(`${limitCase.sample.kind} forces unknown`, () => {
      const decided = decideVerdict({
        foundEvidence: false,
        subjectCoverage: "closed",
        subjectKey: SUBJECT_KEY,
        limits: [limitCase.sample],
        graphIsEmpty: false,
      });

      expect(decided.verdict).toBe("unknown");
      // The user is told which limit stopped the search, so the rationale carries the
      // description rather than a generic "could not determine".
      expect(decided.rationale).toContain(describeLimit(limitCase.sample));
    });
  }

  test("several truncating limits are all named in the rationale", () => {
    const hopLimit: AnswerLimit = { kind: "hop_limit", maxHops: 6 };
    const scanLimit: AnswerLimit = { kind: "scan_capped", examined: 100, total: 900 };

    const decided = decideVerdict({
      foundEvidence: false,
      subjectCoverage: "closed",
      subjectKey: SUBJECT_KEY,
      limits: [hopLimit, scanLimit],
      graphIsEmpty: false,
    });

    expect(decided.verdict).toBe("unknown");
    expect(decided.rationale).toContain(describeLimit(hopLimit));
    expect(decided.rationale).toContain(describeLimit(scanLimit));
  });
});

describe("limit classification", () => {
  test("every AnswerLimit kind has a case in this file", () => {
    const covered: string[] = LIMIT_CASES.map((limitCase) => limitCase.sample.kind);
    expect(covered.sort()).toEqual(Object.keys(EXPECTED_KINDS).sort());
  });

  for (const limitCase of LIMIT_CASES) {
    test(`${limitCase.sample.kind} is classified as truncating ${limitCase.truncating}`, () => {
      expect(isTruncatingLimit(limitCase.sample)).toBe(limitCase.truncating);
      // Every kind is exactly one of the two. A kind that were neither would pass
      // through decideVerdict without blocking not_exposed.
      expect(isAbsenceLimit(limitCase.sample)).toBe(!limitCase.truncating);
    });

    test(`${limitCase.sample.kind} describes itself with its payload`, () => {
      const described = describeLimit(limitCase.sample);
      expect(described.length).toBeGreaterThan(0);
      expect(described).toContain(limitCase.describes);
      expect(described).not.toContain("undefined");
    });
  }
});

describe("detectHopLimit", () => {
  test("stays silent when every path finished below the ceiling", () => {
    expect(detectHopLimit([pathWithHopCount(1), pathWithHopCount(2)], 4)).toBeNull();
  });

  test("stays silent on an empty result", () => {
    // Every traversal carries a maximum, so reporting the ceiling unconditionally would
    // make not_exposed unreachable.
    expect(detectHopLimit([], 4)).toBeNull();
  });

  test("reports the ceiling when a path is sitting on it", () => {
    expect(detectHopLimit([pathWithHopCount(1), pathWithHopCount(4)], 4)).toEqual({
      kind: "hop_limit",
      maxHops: 4,
    });
  });
});

describe("detectPathLimit", () => {
  test("stays silent when fewer paths came back than were asked for", () => {
    expect(detectPathLimit([pathWithHopCount(1), pathWithHopCount(2)], 3)).toBeNull();
  });

  test("reports the cap when the result is exactly full", () => {
    expect(detectPathLimit([pathWithHopCount(1), pathWithHopCount(2)], 2)).toEqual({
      kind: "path_limit",
      pathCount: 2,
    });
  });
});

describe("budgetLimitFromContext", () => {
  test("keeps the engine's operation name when the transport supplied one", () => {
    expect(budgetLimitFromContext({ budget: "max_query_scan_edges" })).toEqual({
      kind: "budget_rejected",
      operation: "max_query_scan_edges",
    });
  });

  test("falls back to a placeholder instead of throwing on a missing or wrong-typed budget", () => {
    // A budget rejection is already an error path; a throw here would replace a usable
    // limit with a crash in the caller's error handler.
    const fallback: AnswerLimit = { kind: "budget_rejected", operation: "unnamed_budget" };
    expect(budgetLimitFromContext(undefined)).toEqual(fallback);
    expect(budgetLimitFromContext({})).toEqual(fallback);
    expect(budgetLimitFromContext({ budget: 429 })).toEqual(fallback);
    expect(budgetLimitFromContext({ budget: true })).toEqual(fallback);
  });
});

describe("weakestCoverage", () => {
  const coverage = buildSliceCoverage({
    closedPackageKeys: [packageKey("npm", "left-pad"), packageKey("npm", "chalk")],
    partialPackageKeys: [packageKey("npm", "event-stream")],
  });

  test("all closed stays closed", () => {
    expect(
      weakestCoverage(coverage, [packageKey("npm", "left-pad"), packageKey("npm", "chalk")]),
    ).toBe("closed");
  });

  test("one partial drags the answer to partial", () => {
    expect(
      weakestCoverage(coverage, [packageKey("npm", "left-pad"), packageKey("npm", "event-stream")]),
    ).toBe("partial");
  });

  test("an unlisted package drags the answer to absent whatever its position", () => {
    const unlisted = packageKey("npm", "flatmap-stream");
    expect(weakestCoverage(coverage, [unlisted, packageKey("npm", "event-stream")])).toBe("absent");
    expect(weakestCoverage(coverage, [packageKey("npm", "event-stream"), unlisted])).toBe("absent");
  });

  test("an empty key list is closed, because there is nothing uncovered", () => {
    expect(weakestCoverage(coverage, [])).toBe("closed");
  });
});
