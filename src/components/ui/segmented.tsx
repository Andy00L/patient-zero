"use client";

import { joinClassNames } from "./class-names";
import { UnitSuffix } from "./text";

/**
 * The segmented control: the incident picker on the radar surface.
 *
 * A segmented control rather than a select, for two reasons. There are four incidents and
 * they are the point of the demo, so hiding them behind a closed menu costs a click and the
 * reader's sense of what is available. And it removes the need for a whole menu primitive
 * (popover, portal, keyboard trap) that nothing else in this app would use.
 *
 * Controlled, so the parent owns which incident is selected and this component owns nothing.
 */

export type SegmentedOption<TValue extends string> = {
  value: TValue;
  label: string;
  /** A secondary reading on the same chip, for example the exposure window. */
  detail?: string;
  disabled?: boolean;
};

export type SegmentedControlProps<TValue extends string> = {
  /** Names the group for assistive tech, since the chips carry no visible group label. */
  label: string;
  options: readonly SegmentedOption<TValue>[];
  value: TValue;
  onChange: (next: TValue) => void;
  className?: string;
};

export function SegmentedControl<TValue extends string>({
  label,
  options,
  value,
  onChange,
  className,
}: SegmentedControlProps<TValue>) {
  return (
    // A radiogroup rather than a tablist: these select a subject, they do not switch panels,
    // and arrow-key semantics are what a reader expects from a set of mutually exclusive
    // choices.
    <div
      role="radiogroup"
      aria-label={label}
      // The recessed track hugs its options rather than filling its container: a tray that
      // runs to the full width of a panel with its chips bunched at the left reads as an
      // unfinished row, and the empty half of the track states nothing.
      className={joinClassNames("tray inline-flex w-fit flex-wrap gap-1 p-1", className)}
    >
      {options.map((option) => {
        const isSelected = option.value === value;

        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={isSelected}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            className={joinClassNames(
              "flex h-[var(--h-control)] items-center gap-2 rounded-chip px-3 text-small",
              "transition-[color,background-color,transform] duration-[var(--dur-small)] ease-out",
              "active:scale-[0.98] active:duration-[var(--dur-micro)]",
              "disabled:cursor-not-allowed disabled:text-ink-faint disabled:active:scale-100",
              isSelected
                ? "bg-tint-accent font-medium text-accent"
                : "text-ink-muted hover:bg-tint-quiet hover:text-ink",
            )}
          >
            {option.label}
            {/* The detail is a reading about the option, so it takes the sheet's unit
                treatment rather than a second prose size on the same chip. */}
            {option.detail ? <UnitSuffix>{option.detail}</UnitSuffix> : null}
          </button>
        );
      })}
    </div>
  );
}
