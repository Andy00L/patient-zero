import type { ReactNode } from "react";

import { joinClassNames } from "./class-names";
import { Icon } from "./icon";
import { DataValue, UnitSuffix } from "./text";
import type { Verdict } from "@/lib/analysis/abstention";

/**
 * The verdict pill: the most load-bearing visual decision in this product.
 *
 * `src/lib/analysis/abstention.ts` returns three verdicts, and rendering `unknown` as if it
 * were `not_exposed` would tell someone their service is clean when the tool never looked.
 * So all three sit on the same amber axis and differ by VALUE and FORM rather than by hue
 * (docs/UI_DESIGN_SYSTEM.md section 4). The mark shape carries the meaning a second time,
 * which is what makes the three states survive greyscale, colour blindness, and a projector
 * with the saturation crushed.
 *
 * Emphasis is deliberately ranked: `exposed` is loudest, `unknown` is more present than
 * `not_exposed`, and a clean reading is the quietest thing on the screen. That is the
 * correct ranking for a tool whose worst failure is a false negative.
 */

/**
 * Human-facing wording per verdict. Kept here rather than taken from `describeVerdict`
 * because that helper writes a sentence for a log line, and a pill needs two words.
 * sourceRef: src/lib/analysis/abstention.ts (the Verdict union these keys mirror)
 */
const VERDICT_WORDING: Record<Verdict, string> = {
  exposed: "Exposed",
  unknown: "Unknown",
  not_exposed: "Not exposed",
};

/** Ground and ink per verdict. Every pair is measured in the sheet's contrast ledger. */
const VERDICT_CLASSES: Record<Verdict, string> = {
  exposed: "bg-tint-accent text-accent",
  unknown: "bg-tint-quiet text-ink-muted",
  not_exposed: "bg-transparent text-ink-faint",
};

export type VerdictPillProps = {
  verdict: Verdict;
  /**
   * Appends the reason the tool reached this verdict, which is the whole point of the
   * abstention model: an `unknown` with no stated limit is indistinguishable from a shrug.
   */
  rationale?: string;
  className?: string;
};

export function VerdictPill({ verdict, rationale, className }: VerdictPillProps) {
  return (
    <span
      className={joinClassNames(
        "inline-flex items-center gap-2 rounded-chip px-2 py-1 text-small font-medium",
        VERDICT_CLASSES[verdict],
        className,
      )}
      title={rationale}
    >
      <VerdictMark verdict={verdict} />
      {VERDICT_WORDING[verdict]}
    </span>
  );
}

/**
 * The 7px mark. Three distinct forms, so the encoding is redundant with the colour:
 * a solid dot for exposed, a hatched ring for unknown, a hollow ring for not_exposed.
 *
 * The hatch is a repeating gradient in currentColor from the `.hatch` recipe in globals.css,
 * so it tracks whatever ink the pill is using instead of hardcoding a second value.
 */
export function VerdictMark({ verdict, className }: { verdict: Verdict; className?: string }) {
  const shared = "size-[7px] shrink-0 rounded-full";

  if (verdict === "exposed") {
    return (
      <span aria-hidden="true" className={joinClassNames(shared, "bg-current", className)} />
    );
  }

  if (verdict === "unknown") {
    return (
      <span
        aria-hidden="true"
        className={joinClassNames(
          shared,
          "hatch border border-current opacity-90",
          className,
        )}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className={joinClassNames(shared, "border border-current", className)}
    />
  );
}

export type AdvisoryChipProps = {
  children: ReactNode;
  className?: string;
};

/**
 * Advisory severity, a separate axis that never borrows the verdict marks.
 *
 * The label is `--color-ink` at 14.03:1 on the critical tint, and the critical hue is
 * carried by the 2px left rule at 4.34:1 instead of by the text. That split exists because
 * `--color-critical` text on `--color-tint-critical` measures 4.34:1, under the 4.5:1 body
 * floor, so the component was changed rather than the palette (sheet section 9).
 */
export function AdvisoryChip({ children, className }: AdvisoryChipProps) {
  return (
    <span
      className={joinClassNames(
        "inline-flex items-center gap-2 rounded-chip bg-tint-critical py-1 pl-2 pr-2 text-small text-ink",
        "border-l-2 border-critical",
        className,
      )}
    >
      <Icon name="advisory" size={13} className="text-critical" />
      {children}
    </span>
  );
}

export type HopBadgeProps = {
  /** Hop distance from patient zero. 0 is patient zero itself. */
  hops: number;
  className?: string;
};

/**
 * A hop distance. The number is machine-generated so it takes the data face, and the unit
 * rides along as the sheet's third label treatment rather than as more prose.
 */
export function HopBadge({ hops, className }: HopBadgeProps) {
  return (
    <span
      className={joinClassNames(
        "inline-flex items-baseline gap-1 rounded-chip bg-tint-quiet px-2 py-1",
        className,
      )}
    >
      <DataValue>{hops}</DataValue>
      <UnitSuffix>{hops === 1 ? "hop" : "hops"}</UnitSuffix>
    </span>
  );
}
