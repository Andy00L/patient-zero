import type { ReactNode } from "react";

import { joinClassNames } from "./class-names";
import { Eyebrow } from "./text";

/**
 * The three materials, and nothing else. docs/UI_DESIGN_SYSTEM.md section 6 fixes exactly
 * three: field (the page ground, painted once in globals.css), raised, and recessed. There
 * is no glass and no fourth material.
 *
 * The `.panel`, `.panel-shell`, and `.tray` recipes live in globals.css rather than here,
 * because the hairline is the first layer of the shadow stack instead of a separate border,
 * and a multi-layer box-shadow reads badly as a utility chain.
 */

type SurfaceProps = {
  /**
   * Optional, because an empty surface is a real state rather than a mistake: a panel that
   * is still loading, and a material swatch on the system surface, both hold nothing.
   */
  children?: ReactNode;
  className?: string;
};

/** The outer console shell, 14px radius. One per surface, holding panels inside it. */
export function Shell({ children, className }: SurfaceProps) {
  return <section className={joinClassNames("panel-shell", className)}>{children}</section>;
}

/** A raised panel, 10px radius. The default container for a block of readings. */
export function Panel({ children, className }: SurfaceProps) {
  return <div className={joinClassNames("panel", className)}>{children}</div>;
}

/**
 * A recessed tray. Scrubber tracks, lockfile wells, and code interiors: anything the reader
 * should perceive as cut into the surface rather than sitting on it.
 */
export function Tray({ children, className }: SurfaceProps) {
  return <div className={joinClassNames("tray", className)}>{children}</div>;
}

export type PanelHeaderProps = {
  /** The region's identity. Rendered as the eyebrow treatment, its one legal placement. */
  eyebrow?: ReactNode;
  title: ReactNode;
  /** A reading or control that belongs to this panel, right-aligned on the same line. */
  aside?: ReactNode;
  className?: string;
};

/**
 * A panel's header. Sits above the panel body on the 16px panel padding.
 *
 * The eyebrow is optional and, when present, is the panel's own identity rather than a
 * kicker over a heading: an eyebrow plus a big heading stacked together is a rejected
 * layout, so the two never share a vertical stack here. The eyebrow renders inline with the
 * title's baseline group only when a caller passes one for a top-level region.
 */
export function PanelHeader({ eyebrow, title, aside, className }: PanelHeaderProps) {
  return (
    <header
      className={joinClassNames(
        "flex items-baseline justify-between gap-4 border-b border-edge px-4 py-3",
        className,
      )}
    >
      <div className="flex items-baseline gap-3">
        <h2 className="text-heading text-ink">{title}</h2>
        {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
      </div>
      {aside ? <div className="flex shrink-0 items-baseline gap-3">{aside}</div> : null}
    </header>
  );
}

/** A panel's body at the sheet's 16px panel padding. */
export function PanelBody({ children, className }: SurfaceProps) {
  return <div className={joinClassNames("p-4", className)}>{children}</div>;
}
