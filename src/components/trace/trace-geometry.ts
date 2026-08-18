import type { ExposurePath, ExposureStep } from "@/lib/analysis/blast-radius";

/**
 * The propagation trace's geometry: exposure branches in, placed points out.
 *
 * Framework free and deterministic on purpose. The same branches always yield the same
 * layout, so a server render and its hydration agree, a screenshot is reproducible, and the
 * placement problem can be tested without a DOM (test/trace-geometry.test.ts). Nothing here
 * reads a clock or a random source.
 *
 * One placement rule, applied without exception: a node sits on the ring for its own hop
 * distance from patient zero, and patient zero is the origin. Services therefore land on the
 * outermost ring that any exposure reached, which is where they always are in practice since
 * a service is the end of its own chain. What is deliberately NOT done is pinning every
 * service to the outer ring regardless of its hop count: each ring is labelled with a hop
 * number, so a service two hops out drawn on the fourth ring would be a false reading of the
 * one number this product exists to state.
 *
 * Nodes are derived from the branch step chains rather than from a second list, so the
 * drawing cannot contain a mark no path passes through, or a path that passes through a mark
 * that was never drawn.
 *
 * The ring proportions are shared with the identity glyph rather than invented here, so the
 * small mark and the full-size trace are the same geometry at two scales.
 * sourceRef: src/components/ui/hop-ring-glyph.tsx
 */

/* -- What the trace draws from. --------------------------------------------------------- */

/**
 * One route into the blast radius.
 *
 * Structural on purpose: `ReplayExposure` (src/lib/analysis/replay.ts) already has every
 * field under these exact names, so a caller holding a replay frame passes its exposures
 * straight through, and a caller holding a `ServiceExposure` maps `shortestPath` to `path`.
 * Declaring the shape here rather than importing one producer's type is what keeps the trace
 * usable on both surfaces.
 */
export type TraceBranch = {
  serviceKey: string;
  serviceName: string;
  /** Hops from the service down to the compromised version. 1 is a direct dependency. */
  hopCount: number;
  isDirectDependency: boolean;
  /** Service first, compromised version last. `steps.length === hopCount + 1`. */
  path: ExposurePath;
  /** The pin landed before the advisory existed: exposed and unknowable at that instant. */
  withinUnknownWindow: boolean;
};

/** What the layout needs. The component decides the two subject facts and passes them in. */
export type TraceGeometryInput = {
  /** The compromised artifact at the centre, already written as `name@version`. */
  subjectLabel: string;
  /** False when the subject is outside the ingested slice: there is nothing to trace from. */
  subjectIsInGraph: boolean;
  branches: readonly TraceBranch[];
};

/* -- The frame. Every figure below is an SVG user unit. --------------------------------- */

/**
 * viewBox width and height in user units.
 *
 * Sized close to the width the trace actually gets (about 660 CSS px in a panel at 60% of
 * `--w-surface`) rather than to a round 1000, because text inside a viewBox scales with the
 * viewport: an 11 unit label in a 960 unit box rendered at 660 px reads as 7.6 px, which is
 * not a label any more. At this box the same label lands within a unit of its token size.
 */
const VIEW_WIDTH = 660;
const VIEW_HEIGHT = 440;

/** The origin. Patient zero sits here, and every ring is concentric with it. */
const CENTER: TracePoint = { x: VIEW_WIDTH / 2, y: VIEW_HEIGHT / 2 };

/**
 * Radius of the outermost ring.
 *
 * The binding constraint is horizontal label room, not vertical: labels run outward
 * horizontally, so the widest one has to fit in `VIEW_WIDTH / 2 - OUTER_RADIUS - LABEL_GAP`,
 * which is 152 units, or 23 characters of the data face at 6.6 units per character. The
 * remainder is also the margin that keeps the outer ring inside its panel rather than
 * bleeding into the surface corner.
 */
const OUTER_RADIUS = 168;

/**
 * How ring radius grows with hop distance.
 *
 * Chosen so three rings reproduce the identity glyph's proportions (4, 6.75 and 9.25 on its
 * 10 unit half grid, which normalise to 0.432, 0.730 and 1.000 of the outer radius). It also
 * gives the near blast the most room, which is the correct ranking: hop 1 is the finding a
 * reader acts on. sourceRef: src/components/ui/hop-ring-glyph.tsx
 */
const RING_CURVE_EXPONENT = 0.77;

/**
 * Rings drawn when the evidence reaches less far than this.
 *
 * Three, the count the identity glyph carries, so the zero exposure state is the glyph at
 * full size rather than one lonely circle or an empty box. A ring with no node on it is
 * scale, and the component draws it in `--color-edge` while a ring that carries exposure
 * takes `--color-accent-deep`, so the drawing never implies a walk that did not happen.
 */
const MIN_RING_COUNT = 3;

/** Patient zero's mark radius. Large enough to read as the subject rather than as a node. */
const ORIGIN_MARK_RADIUS = 13;

/** A version node's mark radius before the count of services behind it widens it. */
const VERSION_MARK_RADIUS_MIN = 4.5;

/** Ceiling on that widening, so one heavily depended-on version cannot swallow its ring. */
const VERSION_MARK_RADIUS_MAX = 9;

/** Units of radius per service routed through a version. The sheet's node radius encoding. */
const VERSION_MARK_RADIUS_PER_SERVICE = 0.9;

/** Half the side of a service's square mark. Square against round is the kind encoding. */
const SERVICE_MARK_HALF_SIDE = 5.5;

/**
 * Nodes drawn on one ring. Beyond this the ring states its total and drops the rest, because
 * 40 marks at the outer radius already sit only 26 units apart and a 41st is a smear.
 */
const MAX_NODES_PER_RING = 40;

/** Gap between a mark and the start of its label. */
const LABEL_GAP = 10;

/**
 * Minimum baseline separation between two labels on the same side of the vertical axis, in
 * units: one 11 unit line of the data face plus 3 units of air.
 */
const LABEL_MIN_VERTICAL_GAP = 14;

/**
 * Characters a label keeps before it is cut. 22 characters of the data face is 145 units at
 * 6.6 units per character, which clears the 152 units available beside the outer ring.
 */
const LABEL_MAX_CHARS = 22;

/** U+2026, written as an escape so this file stays ASCII. */
const LABEL_ELLIPSIS = "\u2026";

/** Ring number sits just above its ring line, in the gap no node occupies. */
const RING_LABEL_OFFSET = 8;

/** Patient zero's own label sits below its mark. */
const ORIGIN_LABEL_OFFSET = 26;

/** Screen coordinates put -90 degrees at the top, which is where a dial starts. */
const START_ANGLE_RADIANS = -Math.PI / 2;

/**
 * Half a slot of rotation, so the first node on a ring lands off the vertical axis. Two nodes
 * straddling the exact top would put their labels at the same baseline on opposite sides,
 * which reads as one broken line rather than as two labels. Capped so a ring holding two
 * nodes does not rotate a quarter turn.
 */
const MAX_HALF_SLOT_RADIANS = 0.35;

/**
 * Rotation added per ring, in radians, so rings do not line their nodes up into spokes. About
 * 24 degrees, and not a rational fraction of a turn, so no small ring count re-aligns.
 */
const RING_ANGLE_OFFSET_RADIANS = 0.42;

/* -- Placed output. -------------------------------------------------------------------- */

export type TracePoint = { x: number; y: number };

export type TraceLabelAnchor = "start" | "middle" | "end";

export type TraceLabelPlacement = {
  point: TracePoint;
  anchor: TraceLabelAnchor;
  /** Already cut to the label budget. The untruncated text belongs in a `<title>`. */
  text: string;
  /** True when `text` was cut, so a caller knows the full key has to stay reachable. */
  isTruncated: boolean;
};

export type TraceNodeKind = ExposureStep["nodeKind"];

export type TracePlacedNode = {
  /** Unique within a layout and stable across calls, so it is safe as a React key. */
  id: string;
  kind: TraceNodeKind;
  /** Natural key: `ecosystem:name:version` for a version, the bare name for a service. */
  key: string;
  /** What a person reads: `name@version`, or the service name. */
  label: string;
  hopDistance: number;
  point: TracePoint;
  /** Measured from the positive x axis in screen coordinates, so y grows downward. */
  angleRadians: number;
  markRadius: number;
  /** Exposed services routed through this node. A service node counts itself. */
  servicesBehind: number;
  /**
   * True when a route through this node was pinned while no advisory existed. On a service
   * that is its own `withinUnknownWindow`; on a version it means at least one of the services
   * behind it was blind at the moment it resolved.
   */
  isWithinUnknownWindow: boolean;
  /** null when the ring is too dense for per-node text and carries the reading instead. */
  labelPlacement: TraceLabelPlacement | null;
};

export type TraceOrigin = {
  point: TracePoint;
  markRadius: number;
  label: string;
  /** False when the subject is outside the slice: the mark states unknown, not clean. */
  isInGraph: boolean;
  labelPlacement: TraceLabelPlacement;
};

export type TracePlacedRing = {
  hopDistance: number;
  radius: number;
  /** Nodes drawn on this ring. */
  nodeCount: number;
  /** Nodes at this hop distance that did not fit `MAX_NODES_PER_RING`. */
  omittedCount: number;
  /** True when at least one exposed node sits here, which is what colours the ring line. */
  carriesExposure: boolean;
  /** False when the ring is too dense for per-node text. */
  hasNodeLabels: boolean;
  labelPoint: TracePoint;
};

/** One segment of a branch, walking from the service inward to patient zero. */
export type TracePlacedEdge = {
  id: string;
  from: TracePoint;
  to: TracePoint;
  /** Hop distance of the node this segment arrives at. 0 is patient zero. */
  toHopDistance: number;
};

export type TracePlacedPathStep = {
  /** The step's natural key, straight from the evidence and safe as a React key. */
  key: string;
  label: string;
  nodeKind: TraceNodeKind;
  hopDistance: number;
  point: TracePoint;
  /** Lockfile resolution instant, present only on a step reached over RESOLVED. */
  resolvedAtMs: number | null;
  /** null on the patient zero step, whose label is the origin's own. */
  labelPlacement: TraceLabelPlacement | null;
};

export type TracePlacedPath = {
  serviceKey: string;
  serviceName: string;
  hopCount: number;
  isDirectDependency: boolean;
  /** Drawn as a dashed chain, because a blind-spot route is not the same finding. */
  isWithinUnknownWindow: boolean;
  /** Service first, patient zero last: the order `ExposurePath.steps` already uses. */
  steps: readonly TracePlacedPathStep[];
  edges: readonly TracePlacedEdge[];
};

export type TraceLayout = {
  /** Ready for the `viewBox` attribute, so the trace scales without measuring anything. */
  viewBox: string;
  width: number;
  height: number;
  center: TracePoint;
  origin: TraceOrigin;
  rings: readonly TracePlacedRing[];
  nodes: readonly TracePlacedNode[];
  /** One per branch whose service got a placed node, in the input's order. */
  paths: readonly TracePlacedPath[];
  /** Nodes dropped by the per-ring cap, summed over every ring. */
  omittedNodeCount: number;
  /** Deepest hop distance the branches actually reached. 0 when nothing was exposed. */
  deepestHopReached: number;
};

/* -- Placement. ------------------------------------------------------------------------ */

/**
 * Places every ring, node, and branch for one answer.
 *
 * Pure: the same input always produces the same output, down to the rounded coordinate.
 */
export function placeTrace(input: TraceGeometryInput): TraceLayout {
  const candidates = collectCandidates(input.branches);
  const deepestHopReached = findDeepestHop(candidates);
  const ringCount = Math.max(deepestHopReached, MIN_RING_COUNT);

  const rings: TracePlacedRing[] = [];
  const nodes: TracePlacedNode[] = [];
  let omittedNodeCount = 0;

  for (let hopDistance = 1; hopDistance <= ringCount; hopDistance += 1) {
    const radius = computeRingRadius(hopDistance, ringCount);
    const onThisRing = candidates.filter((candidate) => candidate.hopDistance === hopDistance);
    const drawn = onThisRing.slice(0, MAX_NODES_PER_RING);
    const omittedCount = onThisRing.length - drawn.length;
    omittedNodeCount += omittedCount;

    const placed = placeNodesOnRing(drawn, hopDistance, radius);
    nodes.push(...placed);

    rings.push({
      hopDistance,
      radius,
      nodeCount: placed.length,
      omittedCount,
      carriesExposure: placed.length > 0,
      hasNodeLabels: placed.some((node) => node.labelPlacement !== null),
      labelPoint: { x: CENTER.x, y: roundUnit(CENTER.y - radius - RING_LABEL_OFFSET) },
    });
  }

  const nodeByKey = new Map(nodes.map((node) => [node.key, node]));

  const paths: TracePlacedPath[] = [];
  for (const branch of input.branches) {
    const serviceNode = nodeByKey.get(branch.serviceKey);
    // A service the per-ring cap dropped has no mark to select, so it gets no chain either:
    // a polyline running to a node that is not drawn would be a line to nowhere.
    if (serviceNode === undefined) continue;
    paths.push(placeBranch(branch, serviceNode, nodeByKey, ringCount));
  }

  return {
    viewBox: `0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`,
    width: VIEW_WIDTH,
    height: VIEW_HEIGHT,
    center: CENTER,
    origin: placeOrigin(input.subjectLabel, input.subjectIsInGraph),
    rings,
    nodes,
    paths,
    omittedNodeCount,
    deepestHopReached,
  };
}

/** Ring radius for one hop distance. Monotonic in `hopDistance` by construction. */
export function computeRingRadius(hopDistance: number, ringCount: number): number {
  const safeRingCount = Math.max(ringCount, 1);
  const clampedHop = Math.min(Math.max(hopDistance, 1), safeRingCount);
  return roundUnit(OUTER_RADIUS * Math.pow(clampedHop / safeRingCount, RING_CURVE_EXPONENT));
}

/** Patient zero, drawn whether or not it is a node: an absent subject is still the subject. */
function placeOrigin(subjectLabel: string, isInGraph: boolean): TraceOrigin {
  const truncated = truncateLabel(subjectLabel);

  return {
    point: CENTER,
    markRadius: ORIGIN_MARK_RADIUS,
    label: subjectLabel,
    isInGraph,
    labelPlacement: {
      point: { x: CENTER.x, y: CENTER.y + ORIGIN_LABEL_OFFSET },
      anchor: "middle",
      text: truncated.text,
      isTruncated: truncated.isTruncated,
    },
  };
}

/** A node waiting for an angle: everything except where on its ring it lands. */
type TraceNodeCandidate = {
  kind: TraceNodeKind;
  key: string;
  label: string;
  hopDistance: number;
  servicesBehind: number;
  isWithinUnknownWindow: boolean;
};

/**
 * Derives every node from the branch step chains.
 *
 * A step's distance from patient zero is its distance from the end of its own chain, and that
 * is the same number on every branch that names it: each branch carries a shortest path, and
 * every suffix of a shortest path is itself shortest. So a key seen twice is seen at one
 * distance, and the minimum is only a tiebreak against malformed input rather than a choice
 * between two honest answers.
 *
 * Sorted by label so a ring reads alphabetically and its order does not depend on the order
 * the branches happened to arrive in.
 */
function collectCandidates(branches: readonly TraceBranch[]): TraceNodeCandidate[] {
  const byKey = new Map<string, TraceNodeCandidate>();

  for (const branch of branches) {
    for (let index = 0; index < branch.path.steps.length; index += 1) {
      const step = branch.path.steps[index];
      if (step === undefined) continue;

      // `steps.length` is always `hopCount + 1` with the compromised version last.
      // sourceRef: src/lib/analysis/blast-radius.ts (ExposurePath)
      const hopDistance = branch.path.hopCount - index;
      // Distance 0 is patient zero itself, which is the origin mark and never a ring node. A
      // malformed negative distance is dropped rather than drawn on top of the origin.
      if (hopDistance < 1) continue;

      const existing = byKey.get(step.key);
      if (existing === undefined) {
        byKey.set(step.key, {
          kind: step.nodeKind,
          key: step.key,
          label: step.displayName,
          hopDistance,
          servicesBehind: 1,
          isWithinUnknownWindow: branch.withinUnknownWindow,
        });
        continue;
      }

      existing.hopDistance = Math.min(existing.hopDistance, hopDistance);
      existing.servicesBehind += 1;
      existing.isWithinUnknownWindow =
        existing.isWithinUnknownWindow || branch.withinUnknownWindow;
    }
  }

  return [...byKey.values()].sort(compareCandidates);
}

function compareCandidates(left: TraceNodeCandidate, right: TraceNodeCandidate): number {
  if (left.label !== right.label) return left.label < right.label ? -1 : 1;
  if (left.key !== right.key) return left.key < right.key ? -1 : 1;
  return 0;
}

/**
 * Spreads a ring's nodes evenly and decides whether the ring can carry per-node text.
 *
 * Even spacing is the only distribution that guarantees the minimum angular separation for a
 * given count, and it keeps the drawing readable as the replay grows a ring from 0 to 40
 * nodes without any node moving for a reason other than the count changing.
 */
function placeNodesOnRing(
  candidates: readonly TraceNodeCandidate[],
  hopDistance: number,
  radius: number,
): TracePlacedNode[] {
  if (candidates.length === 0) return [];

  const slotRadians = (Math.PI * 2) / candidates.length;
  const halfSlot = Math.min(slotRadians / 2, MAX_HALF_SLOT_RADIANS);
  const startAngle =
    START_ANGLE_RADIANS + halfSlot + RING_ANGLE_OFFSET_RADIANS * (hopDistance - 1);

  const angles = candidates.map((_candidate, index) => startAngle + index * slotRadians);
  const points = angles.map((angle) => pointOnCircle(angle, radius));
  const markRadii = candidates.map(computeMarkRadius);
  const labels = candidates.map((candidate, index) =>
    placeRadialLabel(
      candidate.label,
      points[index] ?? CENTER,
      angles[index] ?? startAngle,
      markRadii[index] ?? VERSION_MARK_RADIUS_MIN,
    ),
  );
  const ringCanLabel = canRingCarryNodeLabels(labels);

  return candidates.map((candidate, index) => ({
    id: `${candidate.kind}:${candidate.key}`,
    kind: candidate.kind,
    key: candidate.key,
    label: candidate.label,
    hopDistance,
    point: points[index] ?? CENTER,
    angleRadians: normaliseAngle(angles[index] ?? startAngle),
    markRadius: markRadii[index] ?? VERSION_MARK_RADIUS_MIN,
    servicesBehind: candidate.servicesBehind,
    isWithinUnknownWindow: candidate.isWithinUnknownWindow,
    labelPlacement: ringCanLabel ? (labels[index] ?? null) : null,
  }));
}

/**
 * Mark size.
 *
 * A service is a fixed square: services are the unit of impact, and one of them being read by
 * more traffic is not something this evidence knows. A version grows with the count of
 * services routed through it, which is the sheet's encoding for depth without a legend.
 * sourceRef: docs/UI_DESIGN_SYSTEM.md section 7
 */
function computeMarkRadius(candidate: TraceNodeCandidate): number {
  if (candidate.kind === "service") return SERVICE_MARK_HALF_SIDE;
  return roundUnit(
    Math.min(
      VERSION_MARK_RADIUS_MIN + candidate.servicesBehind * VERSION_MARK_RADIUS_PER_SERVICE,
      VERSION_MARK_RADIUS_MAX,
    ),
  );
}

/**
 * Places one label outward from its node, on the side the node already faces.
 *
 * Horizontal rather than rotated to the radius: a package key set at an angle is a dial
 * decoration, and this one has to be read.
 */
function placeRadialLabel(
  text: string,
  point: TracePoint,
  angleRadians: number,
  markRadius: number,
): TraceLabelPlacement {
  const facesRight = Math.cos(angleRadians) >= 0;
  const offset = markRadius + LABEL_GAP;
  const truncated = truncateLabel(text);

  return {
    // The y is the mark's own centre: the caller sets `dominant-baseline: central`, so the
    // label is centred against the mark rather than hanging from a guessed baseline offset.
    point: { x: roundUnit(point.x + (facesRight ? offset : -offset)), y: point.y },
    anchor: facesRight ? "start" : "end",
    text: truncated.text,
    isTruncated: truncated.isTruncated,
  };
}

/**
 * Whether a ring can carry per-node text.
 *
 * Labels run horizontally away from the centre, so two of them collide only when they sit on
 * the same side of the vertical axis with baselines closer than one line. Evenly spaced nodes
 * near the top and the bottom of a ring are exactly where that happens: at 20 nodes on the
 * outer ring the pair either side of the top is 11 units apart, under the line height. A ring
 * that fails loses its per-node text and states its count on the ring instead, because a
 * label that collides is worse than a label that is absent.
 */
function canRingCarryNodeLabels(placements: readonly TraceLabelPlacement[]): boolean {
  const rightBaselines = placements
    .filter((placement) => placement.anchor === "start")
    .map((placement) => placement.point.y);
  const leftBaselines = placements
    .filter((placement) => placement.anchor === "end")
    .map((placement) => placement.point.y);

  return hasClearBaselines(rightBaselines) && hasClearBaselines(leftBaselines);
}

function hasClearBaselines(baselines: readonly number[]): boolean {
  const sorted = [...baselines].sort((left, right) => left - right);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous === undefined || current === undefined) continue;
    if (current - previous < LABEL_MIN_VERTICAL_GAP) return false;
  }
  return true;
}

/**
 * Places the exact step chain of one branch, service first and patient zero last.
 *
 * A step that has its own mark on a ring is drawn at that mark, which is what makes the line
 * an explanation rather than an illustration: it visibly passes through the packages it
 * names. A step whose mark the ring cap dropped falls back to its hop ring at the service's
 * own angle, so the chain still runs inward instead of vanishing.
 */
function placeBranch(
  branch: TraceBranch,
  serviceNode: TracePlacedNode,
  nodeByKey: ReadonlyMap<string, TracePlacedNode>,
  ringCount: number,
): TracePlacedPath {
  const steps = placeBranchSteps(branch.path, serviceNode, nodeByKey, ringCount);
  const edges: TracePlacedEdge[] = [];

  for (let index = 1; index < steps.length; index += 1) {
    const from = steps[index - 1];
    const to = steps[index];
    if (from === undefined || to === undefined) continue;
    edges.push({
      id: `${branch.serviceKey}>${to.key}`,
      from: from.point,
      to: to.point,
      toHopDistance: to.hopDistance,
    });
  }

  return {
    serviceKey: branch.serviceKey,
    serviceName: branch.serviceName,
    hopCount: branch.path.hopCount,
    isDirectDependency: branch.isDirectDependency,
    isWithinUnknownWindow: branch.withinUnknownWindow,
    steps,
    edges,
  };
}

function placeBranchSteps(
  path: ExposurePath,
  serviceNode: TracePlacedNode,
  nodeByKey: ReadonlyMap<string, TracePlacedNode>,
  ringCount: number,
): TracePlacedPathStep[] {
  const placed: TracePlacedPathStep[] = [];

  for (let index = 0; index < path.steps.length; index += 1) {
    const step = path.steps[index];
    if (step === undefined) continue;

    const hopDistance = Math.max(path.hopCount - index, 0);
    const point = placeStepPoint(step, hopDistance, serviceNode, nodeByKey, ringCount);

    placed.push({
      key: step.key,
      label: step.displayName,
      nodeKind: step.nodeKind,
      hopDistance,
      point,
      resolvedAtMs: step.resolvedAtMs,
      labelPlacement:
        hopDistance === 0
          ? null
          : placeRadialLabel(
              step.displayName,
              point,
              Math.atan2(point.y - CENTER.y, point.x - CENTER.x),
              nodeByKey.get(step.key)?.markRadius ?? VERSION_MARK_RADIUS_MIN,
            ),
    });
  }

  return placed;
}

function placeStepPoint(
  step: ExposureStep,
  hopDistance: number,
  serviceNode: TracePlacedNode,
  nodeByKey: ReadonlyMap<string, TracePlacedNode>,
  ringCount: number,
): TracePoint {
  if (hopDistance === 0) return CENTER;

  const placedNode = nodeByKey.get(step.key);
  if (placedNode !== undefined) return placedNode.point;

  return pointOnCircle(serviceNode.angleRadians, computeRingRadius(hopDistance, ringCount));
}

/* -- Small pure helpers. --------------------------------------------------------------- */

function findDeepestHop(candidates: readonly TraceNodeCandidate[]): number {
  let deepest = 0;
  for (const candidate of candidates) {
    if (candidate.hopDistance > deepest) deepest = candidate.hopDistance;
  }
  return deepest;
}

function pointOnCircle(angleRadians: number, radius: number): TracePoint {
  return {
    x: roundUnit(CENTER.x + Math.cos(angleRadians) * radius),
    y: roundUnit(CENTER.y + Math.sin(angleRadians) * radius),
  };
}

/** Wraps an angle into [-PI, PI), so two calls that mean the same direction compare equal. */
function normaliseAngle(angleRadians: number): number {
  const turn = Math.PI * 2;
  const wrapped = ((((angleRadians + Math.PI) % turn) + turn) % turn) - Math.PI;
  return roundAngle(wrapped);
}

function truncateLabel(text: string): { text: string; isTruncated: boolean } {
  if (text.length <= LABEL_MAX_CHARS) return { text, isTruncated: false };
  return {
    text: `${text.slice(0, LABEL_MAX_CHARS - 1)}${LABEL_ELLIPSIS}`,
    isTruncated: true,
  };
}

/**
 * Coordinates are rounded to two decimals.
 *
 * Not cosmetic: the same layout is computed on the server and again in the browser, and a
 * float printed to seventeen digits in one and sixteen in the other is a hydration mismatch.
 */
function roundUnit(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Angles keep more precision than coordinates: they are compared, not printed. */
function roundAngle(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
