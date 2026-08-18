import { joinClassNames } from "./class-names";

/**
 * The hop-ring glyph: the signature element's geometry at identity scale.
 *
 * docs/UI_DESIGN_SYSTEM.md section 7 gives the propagation trace one placement rule. It owns
 * the primary viewport region of the radar surface and appears nowhere else. Every other
 * surface carries this instead: the concentric hop rings alone, no paths. Same geometry at a
 * different scale, which is one signature reused rather than two signatures competing.
 *
 * Patient zero is the filled centre. Each ring is one hop out, and ring opacity falls with
 * hop distance, matching how the full trace encodes depth.
 */

/** The grid the rings were drawn on, in px. Also the default render size. */
const GLYPH_GRID_PX = 20;

/** Ring radii in grid units, and the opacity each carries. Three hops is enough to read. */
const HOP_RINGS: readonly { radius: number; opacity: number }[] = [
  { radius: 4, opacity: 0.85 },
  { radius: 6.75, opacity: 0.5 },
  { radius: 9.25, opacity: 0.28 },
];

export type HopRingGlyphProps = {
  size?: number;
  className?: string;
};

export function HopRingGlyph({ size = GLYPH_GRID_PX, className }: HopRingGlyphProps) {
  const center = GLYPH_GRID_PX / 2;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${GLYPH_GRID_PX} ${GLYPH_GRID_PX}`}
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={joinClassNames("shrink-0", className)}
    >
      {HOP_RINGS.map((ring) => (
        <circle
          key={ring.radius}
          cx={center}
          cy={center}
          r={ring.radius}
          stroke="var(--color-accent)"
          strokeWidth={1}
          opacity={ring.opacity}
        />
      ))}
      {/* Patient zero. Filled, so the origin reads as a node and not as a fourth ring. */}
      <circle cx={center} cy={center} r={1.75} fill="var(--color-accent)" />
    </svg>
  );
}
