"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { joinClassNames } from "./class-names";
import { HopRingGlyph } from "./hop-ring-glyph";
import { DataValue, Eyebrow } from "./text";

/**
 * The status rail: this app's navigation, treated as an instrument readout rather than as a
 * site header.
 *
 * It carries real slice state, which is the whole reason it is a rail and not a nav bar. A
 * reader has to be able to see, at all times and without clicking, what graph is answering
 * their questions and how completely it covers the registry. A tool that says "not exposed"
 * over a slice of 402 packages is saying something much weaker than the same words over the
 * whole registry, and the rail is where that difference stays visible.
 *
 * The active item is a tinted chip. Not an underline that fills on hover, not a dot beneath
 * the label: both are decoration standing in for a state that the chip states directly.
 */

/** The five surfaces, in reading order. The order is the demo's order. */
const SURFACES: readonly { href: string; label: string }[] = [
  { href: "/", label: "Radar" },
  { href: "/scan", label: "Scan" },
  { href: "/maintainers", label: "Maintainers" },
  { href: "/typosquats", label: "Typosquats" },
  { href: "/local", label: "Local" },
];

export type SliceReading = {
  /** Short label for the reading, for example "nodes". */
  label: string;
  /** The value, machine-generated, so it renders in the data face. */
  value: string;
};

export type StatusRailProps = {
  /**
   * What the loaded graph covers, read from the snapshot's embedded manifest by the server
   * and passed down. Rendered verbatim: the rail never computes or rounds a coverage figure,
   * because a rounded coverage number is a claim the manifest did not make.
   */
  readings: readonly SliceReading[];
  /** Which snapshot answered, for the "which source said this" line. */
  source: string;
};

export function StatusRail({ readings, source }: StatusRailProps) {
  const currentPath = usePathname();

  return (
    <header className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-edge px-6 py-3">
      <Link
        href="/"
        className="flex items-center gap-2 rounded-control"
        aria-label="Patient Zero, go to the radar"
      >
        <HopRingGlyph />
        <span className="font-display text-heading text-ink">Patient Zero</span>
      </Link>

      <nav aria-label="Surfaces" className="flex flex-wrap items-center gap-1">
        {SURFACES.map((surface) => {
          // Exact match only. A prefix match would light up Radar on every surface, since
          // every path starts with "/".
          const isActive = currentPath === surface.href;

          return (
            <Link
              key={surface.href}
              href={surface.href}
              aria-current={isActive ? "page" : undefined}
              className={joinClassNames(
                "flex h-[var(--h-control)] items-center rounded-chip px-3 text-small",
                "transition-colors duration-[var(--dur-small)] ease-out",
                isActive
                  ? "bg-tint-accent font-medium text-accent"
                  : "text-ink-muted hover:bg-tint-quiet hover:text-ink",
              )}
            >
              {surface.label}
            </Link>
          );
        })}
      </nav>

      <div className="ml-auto flex flex-wrap items-center gap-x-5 gap-y-2">
        {readings.map((reading) => (
          <div key={reading.label} className="flex items-baseline gap-2">
            <Eyebrow>{reading.label}</Eyebrow>
            <DataValue>{reading.value}</DataValue>
          </div>
        ))}
        <div className="flex items-baseline gap-2">
          <Eyebrow>source</Eyebrow>
          <DataValue muted>{source}</DataValue>
        </div>
      </div>
    </header>
  );
}
