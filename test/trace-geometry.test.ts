import { describe, expect, test } from "bun:test";

import {
  computeRingRadius,
  placeTrace,
  type TraceBranch,
} from "@/components/trace/trace-geometry";
import type { ExposureStep } from "@/lib/analysis/blast-radius";
import { REL_TYPES } from "@/lib/graph/model";

/**
 * The trace's geometry is the one part of the signature visual that can be wrong without
 * looking wrong: a ring that shrinks with distance, two labels stacked on the same baseline,
 * or a chain that stops short of patient zero all render happily. So the invariants a reader
 * relies on are asserted here rather than eyeballed in a browser.
 *
 * These are properties, not snapshots. A snapshot of 40 placed points would fail on every
 * cosmetic change and prove nothing about collisions.
 */

const SUBJECT_LABEL = "event-stream@3.3.6";
const SUBJECT_KEY = "npm:event-stream:3.3.6";

/** Mirrors LABEL_MIN_VERTICAL_GAP in src/components/trace/trace-geometry.ts. */
const LABEL_LINE_UNITS = 14;

/** Mirrors MAX_NODES_PER_RING. Also the count the brief asks a ring to survive. */
const RING_CAP = 40;

/** Mirrors MIN_RING_COUNT, which is the identity glyph's ring count. */
const MIN_RINGS = 3;

function versionStep(name: string, version: string): ExposureStep {
  return {
    nodeKind: "version",
    key: `npm:${name}:${version}`,
    displayName: `${name}@${version}`,
    version,
    viaRelType: REL_TYPES.resolvesTo,
    resolvedAtMs: null,
  };
}

function serviceStep(serviceName: string): ExposureStep {
  return {
    nodeKind: "service",
    key: serviceName,
    displayName: serviceName,
    version: null,
    viaRelType: REL_TYPES.resolved,
    resolvedAtMs: 1_542_000_000_000,
  };
}

/**
 * One branch, service first and patient zero last, exactly as `ExposurePath` is documented.
 * `middle` holds the intermediate versions, closest to the service first.
 */
function buildBranch(
  serviceName: string,
  middle: readonly (readonly [string, string])[] = [],
  withinUnknownWindow = false,
): TraceBranch {
  const steps: ExposureStep[] = [
    serviceStep(serviceName),
    ...middle.map(([name, version]) => versionStep(name, version)),
    versionStep("event-stream", "3.3.6"),
  ];
  const hopCount = steps.length - 1;

  return {
    serviceKey: serviceName,
    serviceName,
    hopCount,
    isDirectDependency: hopCount === 1,
    path: { steps, hopCount },
    withinUnknownWindow,
  };
}

function layoutOf(branches: readonly TraceBranch[], subjectIsInGraph = true) {
  return placeTrace({ subjectLabel: SUBJECT_LABEL, subjectIsInGraph, branches });
}

function directBranches(count: number): TraceBranch[] {
  // Padded names, so alphabetical order and arrival order agree and a failure is readable.
  return Array.from({ length: count }, (_unused, index) =>
    buildBranch(`checkout-${String(index).padStart(2, "0")}`),
  );
}

describe("ring radius", () => {
  test("grows with hop distance for every ring count", () => {
    for (let ringCount = 1; ringCount <= 8; ringCount += 1) {
      for (let hop = 2; hop <= ringCount; hop += 1) {
        expect(computeRingRadius(hop, ringCount)).toBeGreaterThan(
          computeRingRadius(hop - 1, ringCount),
        );
      }
    }
  });

  test("puts the outermost ring at the same radius whatever the depth", () => {
    // The frame is fixed, so one hop ring fills it exactly as eight do. Otherwise a shallow
    // answer would render as a small dial floating in a large panel.
    expect(computeRingRadius(1, 1)).toBe(computeRingRadius(8, 8));
  });

  test("orders a layout's rings outward from patient zero", () => {
    const layout = layoutOf([buildBranch("checkout", [["flatmap-stream", "0.1.1"]])]);
    const radii = layout.rings.map((ring) => ring.radius);

    expect(layout.rings.map((ring) => ring.hopDistance)).toEqual([1, 2, 3]);
    expect(radii).toEqual([...radii].sort((left, right) => left - right));
  });
});

describe("determinism", () => {
  test("places the same input identically on every call", () => {
    const branches = [
      buildBranch("checkout", [["flatmap-stream", "0.1.1"]]),
      buildBranch("billing"),
    ];

    expect(layoutOf(branches)).toEqual(layoutOf(branches));
  });

  test("does not depend on the order the branches arrived in", () => {
    const first = buildBranch("checkout", [["flatmap-stream", "0.1.1"]]);
    const second = buildBranch("billing");

    // Nodes are sorted by label, so a reordered evidence list draws the same picture. The
    // `paths` list follows the caller's order on purpose, so only the nodes are compared.
    expect(layoutOf([first, second]).nodes).toEqual(layoutOf([second, first]).nodes);
  });
});

describe("ring density", () => {
  test("keeps forty nodes on one ring clear of each other", () => {
    const layout = layoutOf(directBranches(RING_CAP));
    const ring = layout.rings[0];
    const nodes = layout.nodes;

    expect(ring?.nodeCount).toBe(RING_CAP);
    expect(layout.omittedNodeCount).toBe(0);

    // The placement angle, not one recomputed from the drawn point: coordinates are rounded
    // to two decimals for hydration stability, which moves a measured angle by ~1e-4.
    const angles = [...nodes.map((node) => node.angleRadians)].sort((left, right) => left - right);
    const minimumSeparation = (Math.PI * 2) / RING_CAP;
    const gaps = angles.map((angle, index) =>
      index === 0
        ? angle + Math.PI * 2 - (angles.at(-1) ?? angle)
        : angle - (angles[index - 1] ?? angle),
    );
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(minimumSeparation - 1e-5);
    }

    // Angular separation alone does not prove the marks miss each other, so the closest pair
    // is measured against the two marks that would touch.
    for (let index = 1; index < nodes.length; index += 1) {
      const previous = nodes[index - 1];
      const current = nodes[index];
      if (previous === undefined || current === undefined) continue;
      const distance = Math.hypot(
        current.point.x - previous.point.x,
        current.point.y - previous.point.y,
      );
      expect(distance).toBeGreaterThan(previous.markRadius + current.markRadius);
    }

    // A colliding label is worse than an absent one, so this ring states its count instead.
    expect(ring?.hasNodeLabels).toBe(false);
    expect(nodes.every((node) => node.labelPlacement === null)).toBe(true);
  });

  test("drops nodes past the ring cap and says how many", () => {
    const layout = layoutOf(directBranches(RING_CAP + 5));

    expect(layout.rings[0]?.nodeCount).toBe(RING_CAP);
    expect(layout.rings[0]?.omittedCount).toBe(5);
    expect(layout.omittedNodeCount).toBe(5);
    // A dropped node has no mark, so it gets no chain either: no line to nowhere.
    expect(layout.paths).toHaveLength(RING_CAP);
  });

  test("labels a sparse ring without stacking two labels on one line", () => {
    const layout = layoutOf(directBranches(6));
    const placements = layout.nodes.flatMap((node) =>
      node.labelPlacement === null ? [] : [node.labelPlacement],
    );

    expect(placements).toHaveLength(6);

    for (const anchor of ["start", "end"] as const) {
      const baselines = placements
        .filter((placement) => placement.anchor === anchor)
        .map((placement) => placement.point.y)
        .sort((left, right) => left - right);
      for (let index = 1; index < baselines.length; index += 1) {
        const gap = (baselines[index] ?? 0) - (baselines[index - 1] ?? 0);
        expect(gap).toBeGreaterThanOrEqual(LABEL_LINE_UNITS);
      }
    }
  });

  test("cuts a label that cannot fit and flags the cut", () => {
    const layout = layoutOf([buildBranch("payments-reconciliation-worker-eu-west")]);
    const placement = layout.nodes[0]?.labelPlacement;

    expect(placement?.isTruncated).toBe(true);
    expect(placement?.text.endsWith("\u2026")).toBe(true);
    expect(placement?.text.length).toBeLessThan("payments-reconciliation-worker-eu-west".length);
  });
});

describe("chains", () => {
  test("visits every step in order and ends at patient zero", () => {
    const branch = buildBranch("checkout", [
      ["ps-tree", "1.1.0"],
      ["flatmap-stream", "0.1.1"],
    ]);
    const layout = layoutOf([branch]);
    const placed = layout.paths[0];

    expect(placed?.steps.map((step) => step.key)).toEqual(
      branch.path.steps.map((step) => step.key),
    );
    expect(placed?.steps.map((step) => step.hopDistance)).toEqual([3, 2, 1, 0]);
    expect(placed?.steps.at(-1)?.point).toEqual(layout.center);
    expect(placed?.steps.at(-1)?.key).toBe(SUBJECT_KEY);
    // One segment per hop, and the last one arrives at patient zero.
    expect(placed?.edges).toHaveLength(branch.hopCount);
    expect(placed?.edges.at(-1)?.to).toEqual(layout.center);
    // Patient zero is the origin mark, never a node on a ring.
    expect(layout.nodes.some((node) => node.key === SUBJECT_KEY)).toBe(false);
  });

  test("keeps a chain's own labels a line apart", () => {
    // A chain runs inward at one angle, so its steps land on the same side with baselines a
    // few units apart. Every key on the selected chain has to stay legible, so they are moved
    // rather than dropped, and this is the assertion that says they actually were.
    const layout = layoutOf([
      buildBranch("checkout", [
        ["ps-tree", "1.1.0"],
        ["flatmap-stream", "0.1.1"],
      ]),
    ]);
    const placements = (layout.paths[0]?.steps ?? []).flatMap((step) =>
      step.labelPlacement === null ? [] : [step.labelPlacement],
    );

    expect(placements).toHaveLength(3);

    for (const anchor of ["start", "end"] as const) {
      const baselines = placements
        .filter((placement) => placement.anchor === anchor)
        .map((placement) => placement.point.y)
        .sort((left, right) => left - right);
      for (let index = 1; index < baselines.length; index += 1) {
        const gap = (baselines[index] ?? 0) - (baselines[index - 1] ?? 0);
        expect(gap).toBeGreaterThanOrEqual(LABEL_LINE_UNITS);
      }
    }
  });

  test("draws a shared package once and widens it for every service behind it", () => {
    const shared: readonly [string, string] = ["flatmap-stream", "0.1.1"];
    const layout = layoutOf([
      buildBranch("checkout", [shared]),
      buildBranch("billing", [shared]),
      buildBranch("search"),
    ]);
    const sharedNodes = layout.nodes.filter((node) => node.key === "npm:flatmap-stream:0.1.1");
    const soleService = layout.nodes.find((node) => node.key === "search");

    expect(sharedNodes).toHaveLength(1);
    expect(sharedNodes[0]?.servicesBehind).toBe(2);
    expect(sharedNodes[0]?.hopDistance).toBe(1);
    expect(sharedNodes[0]?.markRadius).toBeGreaterThan(
      layout.nodes.find((node) => node.key === "npm:ps-tree:1.1.0")?.markRadius ?? 0,
    );
    // A direct dependency sits on ring 1 with the shared package, and two hop services on 2.
    expect(soleService?.hopDistance).toBe(1);
  });

  test("carries the blind spot flag from the branch to its chain", () => {
    const layout = layoutOf([buildBranch("checkout", [], true), buildBranch("billing")]);

    expect(layout.paths.find((path) => path.serviceKey === "checkout")?.isWithinUnknownWindow).toBe(
      true,
    );
    expect(layout.paths.find((path) => path.serviceKey === "billing")?.isWithinUnknownWindow).toBe(
      false,
    );
  });
});

describe("empty states", () => {
  test("still draws patient zero and the full dial when nothing is exposed", () => {
    const layout = layoutOf([]);

    expect(layout.origin.point).toEqual(layout.center);
    expect(layout.origin.label).toBe(SUBJECT_LABEL);
    expect(layout.origin.labelPlacement.anchor).toBe("middle");
    // Never an empty box: the glyph's three rings render as scale.
    expect(layout.rings).toHaveLength(MIN_RINGS);
    expect(layout.rings.every((ring) => ring.carriesExposure)).toBe(false);
    expect(layout.nodes).toHaveLength(0);
    expect(layout.paths).toHaveLength(0);
    expect(layout.deepestHopReached).toBe(0);
  });

  test("marks a subject that is not in the slice", () => {
    const layout = layoutOf([], false);

    expect(layout.origin.isInGraph).toBe(false);
    expect(layout.rings).toHaveLength(MIN_RINGS);
  });
});
