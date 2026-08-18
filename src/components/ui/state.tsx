import type { ReactNode } from "react";

import { joinClassNames } from "./class-names";
import { Icon } from "./icon";
import { VerdictMark } from "./verdict";

/**
 * Loading, empty, and abstaining states.
 *
 * `EmptyState` and `AbstainNotice` are two components rather than one with a tone prop, and
 * that separation is the point. "The tool looked and found nothing" and "the tool could not
 * finish looking" are different facts, and collapsing them into one component is exactly how
 * an abstention gets rendered as an all-clear. A caller has to pick, so a caller has to
 * know which one it holds.
 */

export type SkeletonProps = {
  /**
   * What is loading, for assistive tech. Required, because a bare grey block announces
   * nothing and a screen reader gets silence where a sighted reader gets a hint.
   */
  label: string;
  /** How many placeholder rows to draw. Match the real row count where it is known. */
  rows?: number;
  className?: string;
};

/**
 * The loading placeholder. Static on purpose.
 *
 * A shimmer or pulse would be the only thing on the page animating longer than the sheet's
 * 320ms ceiling apart from the radar sweep, and two competing ambient motions fight each
 * other (section 6). The recessed tray ground already reads as "not content yet", and
 * `aria-busy` carries the state to assistive tech, so the animation would be decoration.
 */
export function Skeleton({ label, rows = 3, className }: SkeletonProps) {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className={joinClassNames("flex flex-col gap-2 p-4", className)}
    >
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_unused, rowIndex) => (
        <div
          key={rowIndex}
          className="h-[var(--h-row)] rounded-chip bg-tint-quiet"
          // The last row is short, so the block reads as interrupted content rather than as
          // a deliberate set of equal bars.
          style={{ width: rowIndex === rows - 1 ? "62%" : "100%" }}
        />
      ))}
    </div>
  );
}

export type EmptyStateProps = {
  /** What was looked for and not found. One sentence, specific. */
  title: string;
  /**
   * Why nothing being here is a complete answer rather than a missing one. This is the field
   * that stops an empty table from reading as a failure.
   */
  children: ReactNode;
  /** An action that would give the reader something to look at. */
  action?: ReactNode;
  className?: string;
};

/**
 * Nothing to show, and that is the true and complete answer. The tool ran, its coverage was
 * good, and the result is genuinely empty.
 *
 * Never use this for an unfinished or truncated read. That is `AbstainNotice`.
 */
export function EmptyState({ title, children, action, className }: EmptyStateProps) {
  return (
    <div
      className={joinClassNames(
        "flex flex-col items-start gap-3 px-4 py-8",
        className,
      )}
    >
      <div className="flex items-center gap-2 text-ink-muted">
        <Icon name="search" />
        <p className="text-body text-ink">{title}</p>
      </div>
      <p className="max-w-prose text-small text-ink-muted">{children}</p>
      {action}
    </div>
  );
}

export type AbstainNoticeProps = {
  /**
   * Why the tool will not answer. One sentence, in the tool's own voice.
   * `describeVerdict` and the rationale from `decideVerdict` are the natural sources.
   */
  rationale: string;
  /**
   * The specific limits that produced the abstention, already rendered to sentences by
   * `describeLimit` from `src/lib/analysis/abstention.ts`. An abstention with no stated limit
   * is a shrug, so an empty list is rendered as such rather than hidden.
   */
  limits: readonly string[];
  className?: string;
};

/**
 * The tool could not determine an answer, and says so.
 *
 * This is the component that carries the product's central promise: an empty result is never
 * presented as safety. It is louder than `EmptyState` on purpose, because the sheet ranks
 * `unknown` as more present than `not_exposed` (section 4): the worst failure this tool can
 * have is a false negative, so the state that could hide one is the state that gets weight.
 */
export function AbstainNotice({ rationale, limits, className }: AbstainNoticeProps) {
  return (
    <div
      className={joinClassNames(
        "flex flex-col gap-3 rounded-panel bg-tint-quiet px-4 py-4",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <VerdictMark verdict="unknown" />
        <p className="text-body text-ink">No answer, and no assumption of safety</p>
      </div>

      <p className="max-w-prose text-small text-ink-muted">{rationale}</p>

      {limits.length > 0 ? (
        // A rule down the leading edge instead of a mark per line. The verdict is stated once,
        // on the headline; repeating the unknown glyph beside every limit would make the list
        // read as four separate verdicts rather than as the reasons behind one.
        <ul className="flex flex-col gap-2 border-l border-edge-strong pl-3">
          {limits.map((limitDescription) => (
            <li key={limitDescription} className="text-small text-ink-muted">
              {limitDescription}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-small text-ink-faint">
          The reason was not recorded, which is itself a defect worth reporting.
        </p>
      )}
    </div>
  );
}
