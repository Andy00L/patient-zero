import type { ReactNode } from "react";

import { joinClassNames } from "./class-names";

/**
 * The three label treatments, and the data value.
 *
 * docs/UI_DESIGN_SYSTEM.md section 3 fixes three label treatments rather than one, each
 * with a placement rule, because a single treatment repeated everywhere flattens the
 * hierarchy. The rule is enforced here by giving each treatment its own component with its
 * own placement documented: no block may use two of them.
 *
 * The three faces are a rule, not a preference. Technor carries identity and structure, so it
 * appears at display, title, and heading sizes and in the eyebrow treatment, and nowhere
 * else. The neutral carries everything a reader reads as sentences. Tabular carries only
 * machine-generated content: a package key, a semver string, an ISO timestamp, a count in a
 * column. `DataValue` and `UnitSuffix` are the only components in this folder that reach for
 * the data face, so a screen cannot quietly spread a monospace across prose.
 */

type LabelProps = {
  children: ReactNode;
  className?: string;
};

/**
 * Treatment 1: a region's identity, in the display face at 11px tracked caps.
 *
 * Placement rule: it names a region. The status rail's readings, a panel's own identity
 * beside its title, a table's column heads. It is never stacked directly above a heading as a
 * kicker, which is the one placement that turns a label into decoration.
 */
export function Eyebrow({ children, className }: LabelProps) {
  return (
    <span
      className={joinClassNames("font-display text-eyebrow uppercase text-ink-faint", className)}
    >
      {children}
    </span>
  );
}

/**
 * Treatment 2: the name of a value or of a control.
 *
 * Placement rule: inline to the left of its value in a definition row, or directly above the
 * form control it labels. Both are correct and they are the same treatment because they do the
 * same job. What is forbidden is stacking it above a large heading, where a small label over
 * big type reads as a kicker rather than as a label.
 */
export function FieldLabel({ children, className }: LabelProps) {
  return (
    <span className={joinClassNames("text-small text-ink-muted", className)}>{children}</span>
  );
}

/**
 * Treatment 3: a number's unit or qualifier ("hops", "of 4", "ms").
 *
 * Placement rule: immediately after the number it qualifies. Never on its own line.
 *
 * `--text-unit` is its own step rather than the eyebrow's, even though both are 11px: the
 * eyebrow's tracking and weight exist to make a caps region label read, and a unit sitting
 * against a number wants neither.
 */
export function UnitSuffix({ children, className }: LabelProps) {
  return (
    <span className={joinClassNames("font-data text-unit text-ink-faint", className)}>
      {children}
    </span>
  );
}

export type DataValueProps = LabelProps & {
  /** `lg` is the 34px step, for the one headline number on a surface. */
  scale?: "default" | "lg";
  /** Dims the value to muted ink for a reading that resolved but carries no weight. */
  muted?: boolean;
};

/**
 * A machine-generated value: a package key, a version, a timestamp, a count.
 * The only component here that uses the data face, and the reason a mono is in the system
 * at all. `tabular-nums` comes from the type step, so columns align without each cell
 * asking for it.
 */
export function DataValue({
  children,
  className,
  scale = "default",
  muted = false,
}: DataValueProps) {
  return (
    <span
      className={joinClassNames(
        "font-data",
        scale === "lg" ? "text-data-lg" : "text-data",
        muted ? "text-ink-muted" : "text-ink",
        className,
      )}
    >
      {children}
    </span>
  );
}

export type DefinitionRowProps = {
  label: ReactNode;
  children: ReactNode;
  className?: string;
};

/**
 * One label-and-value pair, at the fixed 12px gap from the sheet's dense profile.
 * Uses `FieldLabel` so the inline placement rule cannot be broken by a caller.
 */
export function DefinitionRow({ label, children, className }: DefinitionRowProps) {
  return (
    <div className={joinClassNames("flex items-baseline justify-between gap-3", className)}>
      <FieldLabel>{label}</FieldLabel>
      {children}
    </div>
  );
}
