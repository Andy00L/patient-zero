import type { SVGProps } from "react";

import { joinClassNames } from "./class-names";

/**
 * The house icon set. Ten glyphs, all drawn on one 16px grid with a single 1.5px stroke,
 * no fills, and round caps, so they carry the same optical weight as Technor at
 * --text-small next to them.
 *
 * Hand-drawn rather than pulled from a library for one reason: the app needs exactly these
 * ten, and a library's house style would be the only thing on the page that did not come
 * out of this design system.
 *
 * Every glyph is aria-hidden by default, because none of them is the sole carrier of a
 * meaning anywhere in this app: each one sits beside real text. A caller that needs a
 * standalone icon control passes an accessible name on the control, not on the glyph.
 */

/** The grid every path below was drawn on, in px. Also the default render size. */
const ICON_GRID_PX = 16;

/** Stroke width in grid units, chosen to match Technor 400 at 13px beside it. */
const ICON_STROKE_WIDTH = 1.5;

export type IconName =
  | "hop"
  | "clock"
  | "package"
  | "maintainer"
  | "advisory"
  | "confirmed"
  | "unknown"
  | "search"
  | "upload"
  | "expand";

/**
 * Path geometry per glyph, as one or more `d` strings drawn on the 16px grid.
 * Kept as data rather than as ten components so the set cannot drift in weight or size.
 */
const ICON_PATHS: Record<IconName, readonly string[]> = {
  // A single dependency hop, the arrow that reads left to right along a path.
  hop: ["M2.5 8h10", "M9 4.5 12.5 8 9 11.5"],
  // Known time and valid time, the two clocks the bitemporal query compares.
  clock: ["M8 2.25a5.75 5.75 0 1 0 0 11.5 5.75 5.75 0 0 0 0-11.5Z", "M8 4.75V8l2.5 1.75"],
  // A package. The cube's visible top face is what separates it from a plain box.
  package: ["M8 1.75 14 5v6L8 14.25 2 11V5Z", "M2 5l6 3 6-3", "M8 8v6.25"],
  // A maintainer, the human single point of failure the leaderboard ranks.
  maintainer: ["M8 3.25a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z", "M3.25 13.75c0-2.35 2.13-4.25 4.75-4.25s4.75 1.9 4.75 4.25"],
  // An advisory. The triangle is the only glyph with a flat base, so it reads at 16px.
  advisory: ["M8 2.25 14.5 13.5h-13Z", "M8 6.5v3", "M8 11.75h.01"],
  // A confirmed reading. Never used to mean "safe": see the verdict pill.
  confirmed: ["M3 8.5 6.5 12 13 4.5"],
  // The abstention mark. Paired with the hatched ring wherever a verdict is unknown.
  unknown: [
    "M8 2.25a5.75 5.75 0 1 0 0 11.5 5.75 5.75 0 0 0 0-11.5Z",
    "M6.4 6.4a1.75 1.75 0 1 1 1.6 2.35v.75",
    "M8 11.5h.01",
  ],
  search: ["M7 2.75a4.25 4.25 0 1 0 0 8.5 4.25 4.25 0 0 0 0-8.5Z", "M10.25 10.25 14 14"],
  // Lockfile upload on the scan surface.
  upload: ["M8 12.75V3.25", "M4.75 6.5 8 3.25l3.25 3.25", "M2.75 13.75h10.5"],
  expand: ["M4 6.5 8 10.5l4-4"],
};

export type IconProps = Omit<SVGProps<SVGSVGElement>, "children" | "viewBox" | "name"> & {
  name: IconName;
  /** Rendered size in px on both axes. Defaults to the 16px grid the paths were drawn on. */
  size?: number;
};

/** One glyph from the house set. Inherits currentColor from whatever it sits beside. */
export function Icon({ name, size = ICON_GRID_PX, className, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${ICON_GRID_PX} ${ICON_GRID_PX}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={joinClassNames("shrink-0", className)}
      {...rest}
    >
      {ICON_PATHS[name].map((pathData) => (
        <path key={pathData} d={pathData} />
      ))}
    </svg>
  );
}
