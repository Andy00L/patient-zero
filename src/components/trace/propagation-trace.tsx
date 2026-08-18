"use client";

import { useId, type KeyboardEvent } from "react";

import {
  placeTrace,
  type TraceBranch,
  type TraceLabelPlacement,
  type TraceLayout,
  type TracePlacedNode,
  type TracePlacedPath,
  type TracePlacedRing,
  type TracePoint,
} from "./trace-geometry";
import { joinClassNames } from "@/components/ui/class-names";
import { DataValue, UnitSuffix } from "@/components/ui/text";
import { isAbsenceLimit, type AbstainingAnswer } from "@/lib/analysis/abstention";

/**
 * The propagation trace: the real dependency routes out of patient zero, in concentric hop
 * rings. docs/UI_DESIGN_SYSTEM.md section 7 gives this component the primary viewport region
 * of the radar surface, and every other surface carries `HopRingGlyph` instead, so there is
 * one signature at two scales rather than two signatures competing.
 *
 * Three rules this component does not get to bend:
 *
 *  1. It renders the answer, it never re-decides it. `answer.verdict` sets the centre mark's
 *     form, so an `unknown` with an empty branch list draws a hatched origin and says no
 *     route was found in this slice, rather than the clean picture of an estate nobody
 *     checked. That is the abstention rule (src/lib/analysis/abstention.ts) at the one place
 *     where breaking it would be most convincing and most wrong.
 *  2. Every ring, node, and label is in the DOM at full opacity on the first frame. The only
 *     motion is the 14 second sweep, which carries no information and is absent under
 *     `prefers-reduced-motion: reduce`.
 *  3. The layout is a pure function of the answer (./trace-geometry). No effect, no state, no
 *     measurement, so a frame change is one render with nothing to settle.
 *
 * `answer.limits` is deliberately not printed here: the console beside the trace already
 * carries the deduped list and the AbstainNotice, and the same sentence twice on one screen
 * reads as noise rather than as emphasis.
 */

export type PropagationTraceProps = {
  /**
   * The decided answer for one instant. Only `verdict`, `limits`, and
   * `evidence.exposedServices` are read.
   */
  answer: AbstainingAnswer<{ exposedServices: readonly TraceBranch[] }>;
  /** The compromised artifact at the centre, as `name@version`, written by the caller. */
  subjectLabel: string;
  /**
   * The service whose exact chain is highlighted, or null for none. Optional: a caller that
   * only wants the picture can leave it out.
   */
  selectedServiceKey?: string | null;
  /**
   * Selection handler. Absent means read-only: no node is focusable, nothing responds to a
   * click, and the trace is safe to render from a server component.
   */
  onSelectService?: (serviceKey: string | null) => void;
  className?: string;
};

/** Re-exported so a caller can type its branches without reaching into the geometry module. */
export type { TraceBranch } from "./trace-geometry";

/** How far the unselected structure recedes while one chain is highlighted. */
const RECEDE_OPACITY = 0.3;

/**
 * Depth encoding for ring lines and quiet edges: opacity at hop 1, and the decay per hop out.
 * The ladder lands on 0.85, 0.53, 0.33, which is the identity glyph's 0.85, 0.5, 0.28 within
 * a hair, so the mark and the full trace fade depth at the same rate.
 * sourceRef: src/components/ui/hop-ring-glyph.tsx
 */
const DEPTH_OPACITY_AT_HOP_ONE = 0.85;
const DEPTH_OPACITY_DECAY = 0.62;

/** Floor, so a ring eight hops out is still a line rather than a rumour. */
const DEPTH_OPACITY_FLOOR = 0.12;

const RING_STROKE_WIDTH = 1;
const EDGE_STROKE_WIDTH = 1;
const SELECTED_STROKE_WIDTH = 1.75;

/** Patient zero's filled core, inside its tinted disc. */
const ORIGIN_CORE_RADIUS = 6.5;

/** Invisible padding around a selectable mark, so a 11 unit square is a real click target. */
const HIT_PADDING = 8;

/** Dash for a route pinned while no advisory existed. Form, not hue, carries the finding. */
const UNKNOWN_WINDOW_DASH = "5 3";

/** The sweep's arc, in radians. Wide enough to read as a beam, narrow enough to be a beam. */
const SWEEP_SPAN_RADIANS = 0.7;

/** The sweep is decoration, so it sits under the ink it crosses. */
const SWEEP_OPACITY = 0.16;
const SWEEP_STROKE_WIDTH = 2;

/** Hatch tile, in user units: a 45 degree line every 3, mirroring the `.hatch` recipe. */
const HATCH_TILE = 3;

export function PropagationTrace({
  answer,
  subjectLabel,
  selectedServiceKey = null,
  onSelectService,
  className,
}: PropagationTraceProps) {
  // useId keeps two traces on one page from sharing a pattern definition. The colons React
  // puts in the value are legal in an id and inside url(#...), but they are dropped anyway so
  // the value is also usable as a CSS selector by anyone debugging the rendered markup.
  const scope = useId().replace(/:/g, "");
  const titleId = `${scope}-title`;
  const hatchSignalId = `${scope}-hatch-signal`;
  const hatchQuietId = `${scope}-hatch-quiet`;

  const branches = answer.evidence.exposedServices;
  // A found route proves patient zero is a node in this slice. With no route and an absence
  // limit, the slice may never have held it, and the origin has to say so. Both facts come
  // from the decided answer: the trace does not get to reach a verdict of its own.
  const subjectIsInGraph = branches.length > 0 || !answer.limits.some(isAbsenceLimit);
  const layout = placeTrace({ subjectLabel, subjectIsInGraph, branches });

  const isInteractive = onSelectService !== undefined;
  const selectedPath =
    layout.paths.find((path) => path.serviceKey === selectedServiceKey) ?? null;
  const selectedStepKeys = new Set(selectedPath?.steps.map((step) => step.key) ?? []);
  const blindSpotBranchCount = layout.paths.filter(
    (path) => path.isWithinUnknownWindow,
  ).length;

  return (
    <figure className={joinClassNames("flex flex-col gap-3", className)}>
      <svg
        viewBox={layout.viewBox}
        // Fixed viewBox, fluid width: the drawing scales with its panel and its height never
        // depends on how many nodes are on a ring, so a replay frame cannot reflow the page.
        className="block h-auto w-full"
        // A read-only trace is one image with one description. An interactive one has to keep
        // its service marks reachable, so its children stay exposed.
        role={isInteractive ? "group" : "img"}
        aria-labelledby={titleId}
        focusable="false"
      >
        <title id={titleId}>{describeLayout(layout, answer.verdict, blindSpotBranchCount)}</title>

        <defs>
          <HatchPattern id={hatchSignalId} stroke="var(--color-accent)" />
          <HatchPattern id={hatchQuietId} stroke="var(--color-ink-muted)" />
        </defs>

        <RingScale rings={layout.rings} center={layout.center} />
        <Sweep center={layout.center} rings={layout.rings} />

        <g
          opacity={selectedPath === null ? 1 : RECEDE_OPACITY}
          className="transition-opacity duration-[var(--dur-std)] ease-[var(--ease-out)]"
        >
          {layout.paths
            .filter((path) => path.serviceKey !== selectedPath?.serviceKey)
            .map((path) => (
              <QuietBranch key={path.serviceKey} path={path} />
            ))}
        </g>

        {selectedPath === null ? null : <SelectedChain path={selectedPath} />}

        {layout.nodes.map((node) => (
          <TraceNode
            key={node.id}
            node={node}
            hatchId={hatchSignalId}
            isSelected={node.key === selectedPath?.serviceKey}
            isOnSelectedChain={selectedStepKeys.has(node.key)}
            hasSelection={selectedPath !== null}
            // The selected chain draws its own step labels in a louder ink, so the node layer
            // stands back rather than printing the same key twice at the same coordinate.
            suppressLabel={selectedStepKeys.has(node.key)}
            onSelectService={onSelectService}
          />
        ))}

        <Origin layout={layout} verdict={answer.verdict} hatchId={hatchQuietId} />
      </svg>

      <figcaption className="flex flex-col gap-1">
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="flex items-baseline gap-1">
            <DataValue muted={layout.paths.length === 0}>{layout.paths.length}</DataValue>
            <UnitSuffix>{layout.paths.length === 1 ? "route" : "routes"} drawn</UnitSuffix>
          </span>
          <span className="flex items-baseline gap-1">
            <DataValue muted={layout.deepestHopReached === 0}>
              {layout.deepestHopReached}
            </DataValue>
            <UnitSuffix>{layout.deepestHopReached === 1 ? "hop" : "hops"} deep</UnitSuffix>
          </span>
          {layout.omittedNodeCount === 0 ? null : (
            <span className="flex items-baseline gap-1">
              <DataValue>{layout.omittedNodeCount}</DataValue>
              <UnitSuffix>nodes past the ring cap</UnitSuffix>
            </span>
          )}
        </span>
        {/* Two lines are reserved whatever the state, so stepping through a replay never
            changes the panel's height. */}
        <p className="line-clamp-2 min-h-[2.9em] text-small text-ink-muted">
          {describeState({
            layout,
            verdict: answer.verdict,
            subjectIsInGraph,
            blindSpotBranchCount,
            isInteractive,
          })}
        </p>
      </figcaption>
    </figure>
  );
}

/* -- Layers. --------------------------------------------------------------------------- */

/**
 * The hop rings and their numbers.
 *
 * A ring that carries exposure takes the amber structural ink, and a ring the walk reached
 * with nothing on it stays a hairline in `--color-edge`: the scale is drawn either way, so
 * the drawing never implies a hop it did not observe.
 */
function RingScale({
  rings,
  center,
}: {
  rings: readonly TracePlacedRing[];
  center: TracePoint;
}) {
  return (
    <g>
      {rings.map((ring) => (
        <circle
          key={ring.hopDistance}
          cx={center.x}
          cy={center.y}
          r={ring.radius}
          fill="none"
          stroke={ring.carriesExposure ? "var(--color-accent-deep)" : "var(--color-edge)"}
          strokeWidth={RING_STROKE_WIDTH}
          opacity={ring.carriesExposure ? depthOpacity(ring.hopDistance) : 1}
        />
      ))}
      {rings.map((ring) => (
        <text
          key={ring.hopDistance}
          x={ring.labelPoint.x}
          y={ring.labelPoint.y}
          textAnchor="middle"
          dominantBaseline="central"
          className="font-data text-unit"
          fill="var(--color-ink-faint)"
        >
          {describeRing(ring)}
        </text>
      ))}
    </g>
  );
}

/**
 * The sweep. Decoration, and the only moving thing in this component.
 *
 * One arc at 14 seconds per revolution, from `--dur-sweep`. It carries no information, so it
 * is `aria-hidden`, it never gates a node's visibility, and `motion-reduce:animate-none`
 * removes it outright rather than leaving it to the global 0.01ms collapse, which would turn
 * an infinite rotation into a flicker.
 */
function Sweep({
  center,
  rings,
}: {
  center: TracePoint;
  rings: readonly TracePlacedRing[];
}) {
  const outerRadius = rings.at(-1)?.radius;
  if (outerRadius === undefined) return null;

  return (
    <g
      aria-hidden="true"
      className="animate-spin [animation-duration:var(--dur-sweep)] motion-reduce:animate-none"
      style={{ transformOrigin: `${center.x}px ${center.y}px` }}
    >
      <path
        d={buildSweepArc(center, outerRadius)}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth={SWEEP_STROKE_WIDTH}
        strokeLinecap="round"
        opacity={SWEEP_OPACITY}
      />
    </g>
  );
}

/**
 * One unselected route, drawn segment by segment so opacity can fall with hop distance.
 *
 * A single polyline could not do that, and depth is the reading the sheet asks the edges to
 * carry: the near blast is the loudest line on the screen.
 */
function QuietBranch({ path }: { path: TracePlacedPath }) {
  return (
    <g>
      {path.edges.map((edge) => (
        <line
          key={edge.id}
          x1={edge.from.x}
          y1={edge.from.y}
          x2={edge.to.x}
          y2={edge.to.y}
          stroke="var(--color-accent-deep)"
          strokeWidth={EDGE_STROKE_WIDTH}
          strokeDasharray={path.isWithinUnknownWindow ? UNKNOWN_WINDOW_DASH : undefined}
          opacity={depthOpacity(edge.toHopDistance)}
        />
      ))}
    </g>
  );
}

/**
 * The selected chain: one polyline at full strength, plus the key of every step on it.
 *
 * This is the feature. A reader who clicks a service gets the exact `ExposureStep` chain back
 * to patient zero with every intermediate package named, which is the difference between a
 * picture of a blast radius and an answer to "how does this reach me".
 */
function SelectedChain({ path }: { path: TracePlacedPath }) {
  return (
    <g>
      <polyline
        points={path.steps.map((step) => `${step.point.x},${step.point.y}`).join(" ")}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth={SELECTED_STROKE_WIDTH}
        strokeDasharray={path.isWithinUnknownWindow ? UNKNOWN_WINDOW_DASH : undefined}
        strokeLinejoin="round"
      />
      {path.steps.map((step) =>
        step.labelPlacement === null ? null : (
          <Label key={step.key} placement={step.labelPlacement} fill="var(--color-ink)">
            {step.label}
          </Label>
        ),
      )}
    </g>
  );
}

/**
 * One node on a ring: a square for a service, a circle for a version.
 *
 * Kind is form, not hue, and not geometry: a service sits on the ring for its own hop count
 * like everything else, because each ring is labelled with that number and moving a two hop
 * service out to a four hop ring would misstate the one figure this product exists to report.
 *
 * A service that pinned the compromised version while no advisory existed is hatched, the
 * same form `VerdictMark` uses for unknown, so the blind spot survives greyscale. Versions
 * are never hatched: one version can sit on a blind route and a sighted one at the same time,
 * and hatching it would claim more than the evidence says.
 */
function TraceNode({
  node,
  hatchId,
  isSelected,
  isOnSelectedChain,
  hasSelection,
  suppressLabel,
  onSelectService,
}: {
  node: TracePlacedNode;
  hatchId: string;
  isSelected: boolean;
  isOnSelectedChain: boolean;
  hasSelection: boolean;
  suppressLabel: boolean;
  onSelectService?: (serviceKey: string | null) => void;
}) {
  const description = describeNode(node);
  const isLit = isSelected || isOnSelectedChain;
  const mark =
    node.kind === "service" ? (
      <rect
        x={node.point.x - node.markRadius}
        y={node.point.y - node.markRadius}
        width={node.markRadius * 2}
        height={node.markRadius * 2}
        // 3 user units is `--radius-tick` at this box's scale, which renders near 1:1.
        rx={3}
        fill={
          node.isWithinUnknownWindow
            ? `url(#${hatchId})`
            : isLit
              ? "var(--color-accent)"
              : "var(--color-tint-accent)"
        }
        stroke="var(--color-accent)"
        strokeWidth={isLit ? SELECTED_STROKE_WIDTH : EDGE_STROKE_WIDTH}
      />
    ) : (
      <circle
        cx={node.point.x}
        cy={node.point.y}
        r={node.markRadius}
        fill={isLit ? "var(--color-accent)" : "var(--color-tint-accent)"}
        stroke={isLit ? "var(--color-accent)" : "var(--color-accent-deep)"}
        strokeWidth={EDGE_STROKE_WIDTH}
      />
    );

  const label =
    suppressLabel || node.labelPlacement === null ? null : (
      <Label
        placement={node.labelPlacement}
        fill={isLit ? "var(--color-ink)" : "var(--color-ink-muted)"}
      >
        {node.label}
      </Label>
    );

  // A node stays at full strength while another chain is selected only if it is on that
  // chain. Everything else recedes, which is what makes one route readable among forty.
  const body = (
    <g
      opacity={hasSelection && !isLit ? RECEDE_OPACITY : 1}
      className="transition-opacity duration-[var(--dur-std)] ease-[var(--ease-out)]"
    >
      {mark}
      {label}
    </g>
  );

  // Selection is a service-level idea, so only services are selectable, and only when the
  // caller passed a handler. Without one the trace has nothing focusable at all.
  if (node.kind !== "service" || onSelectService === undefined) {
    return (
      <g>
        <title>{description}</title>
        {body}
      </g>
    );
  }

  const toggle = () => onSelectService(isSelected ? null : node.key);

  const handleKeyDown = (event: KeyboardEvent<SVGGElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      // Space scrolls the page otherwise, which loses the node the reader just aimed at.
      event.preventDefault();
      toggle();
      return;
    }
    if (event.key === "Escape" && isSelected) onSelectService(null);
  };

  return (
    <g
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
      aria-label={description}
      onClick={toggle}
      onKeyDown={handleKeyDown}
      className="cursor-pointer"
    >
      <title>{description}</title>
      {/* A transparent disc, so the pointer target is a finger's width rather than a mark's. */}
      <circle
        cx={node.point.x}
        cy={node.point.y}
        r={node.markRadius + HIT_PADDING}
        fill="transparent"
      />
      {body}
    </g>
  );
}

/**
 * Patient zero, and the verdict it was answered with.
 *
 * The form is `VerdictMark`'s vocabulary at trace scale: a filled core for exposed, a hatched
 * disc for unknown, a hollow ring for not exposed. That is what keeps the empty cases honest.
 * An unknown answer with no route draws a hatched centre inside empty rings, which reads as
 * "nothing was found and nothing was proved", not as a clean estate.
 * sourceRef: src/components/ui/verdict.tsx
 */
function Origin({
  layout,
  verdict,
  hatchId,
}: {
  layout: TraceLayout;
  verdict: AbstainingAnswer<unknown>["verdict"];
  hatchId: string;
}) {
  const { origin, center } = layout;

  return (
    <g>
      <title>{describeOrigin(origin.label, verdict, origin.isInGraph)}</title>
      <circle
        cx={center.x}
        cy={center.y}
        r={origin.markRadius}
        fill={
          verdict === "exposed"
            ? "var(--color-tint-accent)"
            : verdict === "unknown"
              ? `url(#${hatchId})`
              : "none"
        }
        stroke={
          verdict === "exposed"
            ? "var(--color-accent)"
            : verdict === "unknown"
              ? "var(--color-edge-strong)"
              : "var(--color-ink-faint)"
        }
        strokeWidth={RING_STROKE_WIDTH}
      />
      {verdict === "exposed" ? (
        <circle
          cx={center.x}
          cy={center.y}
          r={ORIGIN_CORE_RADIUS}
          fill="var(--color-accent)"
        />
      ) : null}
      {/* The subject's name never recedes: a chain selected somewhere on a ring is a chain
          into this artifact, so this is the one label that stays at full strength. */}
      <Label placement={origin.labelPlacement} fill="var(--color-ink)" sizeClassName="text-data">
        {origin.label}
      </Label>
    </g>
  );
}

/**
 * One placed label. The full text rides along in a `<title>` whenever the placement had to
 * cut it, so a truncated key is never a lost key.
 */
function Label({
  placement,
  fill,
  sizeClassName = "text-unit",
  children,
}: {
  placement: TraceLabelPlacement;
  fill: string;
  sizeClassName?: string;
  children: string;
}) {
  return (
    <text
      x={placement.point.x}
      y={placement.point.y}
      textAnchor={placement.anchor}
      // Centred on the mark's own y rather than hung from a guessed baseline offset.
      dominantBaseline="central"
      className={joinClassNames("font-data", sizeClassName)}
      fill={fill}
    >
      {placement.isTruncated ? <title>{children}</title> : null}
      {placement.text}
    </text>
  );
}

/** The `.hatch` recipe as an SVG pattern, since a CSS background never paints an SVG shape. */
function HatchPattern({ id, stroke }: { id: string; stroke: string }) {
  return (
    <pattern
      id={id}
      width={HATCH_TILE}
      height={HATCH_TILE}
      patternUnits="userSpaceOnUse"
      patternTransform="rotate(45)"
    >
      <line x1={0} y1={0} x2={0} y2={HATCH_TILE} stroke={stroke} strokeWidth={1} />
    </pattern>
  );
}

/* -- Wording and small maths. ---------------------------------------------------------- */

function depthOpacity(hopDistance: number): number {
  const stepsOut = Math.max(hopDistance - 1, 0);
  const faded = DEPTH_OPACITY_AT_HOP_ONE * Math.pow(DEPTH_OPACITY_DECAY, stepsOut);
  return Math.round(Math.max(faded, DEPTH_OPACITY_FLOOR) * 1000) / 1000;
}

function buildSweepArc(center: TracePoint, radius: number): string {
  const start = -Math.PI / 2;
  const end = start + SWEEP_SPAN_RADIANS;
  const startX = center.x + Math.cos(start) * radius;
  const startY = center.y + Math.sin(start) * radius;
  const endX = center.x + Math.cos(end) * radius;
  const endY = center.y + Math.sin(end) * radius;
  return `M ${startX} ${startY} A ${radius} ${radius} 0 0 1 ${endX} ${endY}`;
}

/**
 * A ring's own line. It states its hop number, and takes over the reading when the ring is
 * too dense for per-node text or the cap dropped some of its nodes, so a suppressed label is
 * an honest count rather than a silent gap.
 */
function describeRing(ring: TracePlacedRing): string {
  const hops = `hop ${ring.hopDistance}`;
  if (ring.omittedCount > 0) {
    return `${hops}, ${ring.nodeCount} of ${ring.nodeCount + ring.omittedCount} drawn`;
  }
  if (ring.nodeCount > 0 && !ring.hasNodeLabels) {
    return `${hops}, ${ring.nodeCount} ${ring.nodeCount === 1 ? "node" : "nodes"}`;
  }
  return hops;
}

function describeNode(node: TracePlacedNode): string {
  const hops = `${node.hopDistance} ${node.hopDistance === 1 ? "hop" : "hops"} from patient zero`;
  if (node.kind === "service") {
    const blind = node.isWithinUnknownWindow
      ? ", pinned before the advisory was public"
      : "";
    return `${node.label}, service, ${hops}${blind}`;
  }
  const behind = `${node.servicesBehind} exposed ${node.servicesBehind === 1 ? "service routes" : "services route"} through it`;
  return `${node.label}, package, ${hops}, ${behind}`;
}

function describeOrigin(
  label: string,
  verdict: AbstainingAnswer<unknown>["verdict"],
  isInGraph: boolean,
): string {
  if (!isInGraph) return `${label}, patient zero, outside the ingested slice`;
  if (verdict === "exposed") return `${label}, patient zero`;
  if (verdict === "unknown") return `${label}, patient zero, exposure undecided`;
  return `${label}, patient zero, no route found`;
}

/** The whole drawing in one sentence, for a reader who gets the image and not the marks. */
function describeLayout(
  layout: TraceLayout,
  verdict: AbstainingAnswer<unknown>["verdict"],
  blindSpotBranchCount: number,
): string {
  const subject = `Propagation trace for ${layout.origin.label}`;
  if (layout.paths.length === 0) {
    return `${subject}: no route found in this slice, verdict ${verdict.replace("_", " ")}.`;
  }
  const routes = `${layout.paths.length} ${layout.paths.length === 1 ? "route" : "routes"}`;
  const depth = `${layout.deepestHopReached} ${layout.deepestHopReached === 1 ? "hop" : "hops"} deep`;
  const blind =
    blindSpotBranchCount > 0
      ? `, ${blindSpotBranchCount} pinned before the advisory was public`
      : "";
  return `${subject}: ${routes}, ${depth}${blind}.`;
}

/**
 * The line under the drawing. Never empty, in any state.
 *
 * The zero route cases come first, because they are the common ones on the committed snapshot
 * and they are the ones a picture can lie about. Ordinary states fall through to the legend
 * the drawing needs read: what the dashes mean, or what a ring is.
 */
function describeState({
  layout,
  verdict,
  subjectIsInGraph,
  blindSpotBranchCount,
  isInteractive,
}: {
  layout: TraceLayout;
  verdict: AbstainingAnswer<unknown>["verdict"];
  subjectIsInGraph: boolean;
  blindSpotBranchCount: number;
  isInteractive: boolean;
}): string {
  if (!subjectIsInGraph) {
    return `${layout.origin.label} is not a node in this slice, so there is nothing to trace from it. The rings are scale, not a result.`;
  }
  if (layout.paths.length === 0) {
    return verdict === "not_exposed"
      ? "No route reaches this artifact, and the walk finished inside every budget, so this is a real negative."
      : "No route was found in this slice at this instant, which is not the same as no route existing.";
  }
  if (blindSpotBranchCount > 0) {
    return `A dashed route was pinned while no advisory existed: ${blindSpotBranchCount} of ${layout.paths.length} here. Each ring is one hop from patient zero.`;
  }
  return isInteractive
    ? "Each ring is one hop from patient zero. Select a service to trace its exact chain back."
    : "Each ring is one hop from patient zero, and every drawn line is a resolved dependency edge.";
}
