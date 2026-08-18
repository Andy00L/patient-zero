import { Tray } from "@/components/ui/panel";
import { DataValue, FieldLabel, UnitSuffix } from "@/components/ui/text";
import { formatCount, UNKNOWN_READING } from "@/lib/format";

import type { ConfusablePair, PairSide } from "./confusable-pairs";

/**
 * The list of confusable name pairs.
 *
 * Every decision in this file exists to keep two things from reading alike.
 *
 * A pair is not a claim about who copied whom. The detector settles that with the popularity gap
 * and with nothing else, so a pair it reported from both ends reads "confusable with" and a pair
 * it reported once reads "imitating". One word, on every row, carrying the difference between a
 * measurement and a symmetry the tool could not break. The caller states what the word means once
 * per region rather than repeating the explanation on 68 rows.
 *
 * A reading is not a reading about a pair. Downloads, declaring manifests and pinning lockfiles
 * are measured per name, and a number that floated free of its name would be worse than no number:
 * "something here installs one of these two" is the exact confusion the surface exists to prevent.
 * So both names sit in one grid, one row each, with their readings in aligned columns. The two rows
 * are directly comparable because that comparison is the finding.
 *
 * Nothing is unknown by omission. A name the traversal could not select prints unknown; a name it
 * selected and found nothing for prints 0. Those are different facts and a blank cell would be
 * neither. sourceRef: docs/UI_DESIGN_SYSTEM.md section 3.
 *
 * The row is a stack rather than a table row, for the reason the provenance list gives: the reason
 * sentence has no fixed height and the sheet's 36px row is a promise wrapped prose cannot keep.
 * sourceRef: src/components/app/query-provenance.tsx.
 */

/** Pin names listed in full before the row starts counting instead of naming. */
const PINS_NAMED = 3;

export type PairListProps = {
  /** Already filtered and split by the caller. Rendered in the order given. */
  pairs: readonly ConfusablePair[];
  /**
   * Names this list for assistive tech. Two lists sit on the surface and they differ by exactly
   * one fact, so an unlabelled pair of them is unnavigable.
   */
  label: string;
};

export function PairList({ pairs, label }: PairListProps) {
  return (
    <Tray>
      <ul aria-label={label} className="flex list-none flex-col">
        {pairs.map((pair) => (
          <PairRow key={pair.pairId} pair={pair} />
        ))}
      </ul>
    </Tray>
  );
}

/**
 * One collision.
 *
 * The hairline is on the row rather than between rows, so the last one drops it and the tray's
 * inset edge is the only line at the bottom.
 */
function PairRow({ pair }: { pair: ConfusablePair }) {
  const reasons = writeReasons(pair.reasons);

  return (
    <li className="flex flex-col gap-2 border-b border-edge px-3 py-3 last:border-b-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-2">
          <DataValue>{pair.suspect.name}</DataValue>
          {/* The one word that says whether the order of these two names means anything. */}
          <FieldLabel>{pair.isMirrored ? "confusable with" : "imitating"}</FieldLabel>
          <DataValue>{pair.target.name}</DataValue>
        </div>

        <div className="flex shrink-0 items-baseline gap-3">
          {/* Both names in a pair belong to the same registry, so the marker is the pair's and
              appears once. It is not decoration: `requests` and `lodash` are the same kind of
              string on screen and only the registry tells a reader which install command
              reaches them. */}
          <FieldLabel>{pair.ecosystem}</FieldLabel>
          <FieldLabel>{pair.confidence} confidence</FieldLabel>
        </div>
      </div>

      {reasons === null ? null : <p className="max-w-prose text-small text-ink-muted">{reasons}</p>}

      {/* One grid, both names, so the columns line up across the two rows and the readings can be
          compared. The reading columns are fixed so that alignment survives a long name. */}
      <div className="grid gap-x-4 gap-y-1 [grid-template-columns:minmax(0,1fr)] md:[grid-template-columns:minmax(0,1fr)_11rem_10rem_minmax(0,14rem)]">
        <SideReadings side={pair.suspect} />
        <SideReadings side={pair.target} />
      </div>
    </li>
  );
}

/**
 * What the slice knows about one name of the pair.
 *
 * Four cells of the row's shared grid rather than a container of its own, which is what keeps the
 * two names' readings in the same columns.
 */
function SideReadings({ side }: { side: PairSide }) {
  const pins = describePins(side);

  return (
    <>
      <DataValue muted className="truncate">
        {side.name}
      </DataValue>

      <span className="flex items-baseline gap-1">
        <DataValue muted>{formatCount(side.weeklyDownloads)}</DataValue>
        <UnitSuffix>weekly downloads</UnitSuffix>
      </span>

      <span className="flex items-baseline gap-1">
        <DataValue muted>{describeCount(side, side.dependentVersionCount)}</DataValue>
        <UnitSuffix>{side.dependentVersionCount === 1 ? "manifest" : "manifests"}</UnitSuffix>
      </span>

      {/* A pin is the fact that separates the two lists on this surface, so the named services
          take full ink while every other reading on the row stays muted. */}
      {pins === null ? (
        <UnitSuffix>{side.isProbed ? "no lockfile here pins it" : "pins unknown"}</UnitSuffix>
      ) : (
        <span className="flex min-w-0 items-baseline gap-1">
          <DataValue className="truncate">{pins}</DataValue>
          <UnitSuffix>pins it</UnitSuffix>
        </span>
      )}
    </>
  );
}

/**
 * A measured count, or unknown when the name could not be measured at all.
 *
 * The distinction is the whole abstention discipline in one cell: 0 means the traversal ran and
 * found nothing, and unknown means it never selected this name. Printing 0 for the second is how
 * a tool tells someone nothing depends on a package it never looked at.
 */
function describeCount(side: PairSide, count: number): string {
  return side.isProbed ? formatCount(count) : UNKNOWN_READING;
}

/**
 * The services that pinned this name, or null when none did.
 *
 * Named rather than counted, because a service name is actionable and a count is not. Past three
 * the row counts the rest instead of running the width of the panel.
 */
function describePins(side: PairSide): string | null {
  if (side.serviceNames.length === 0) return null;

  const named = side.serviceNames.slice(0, PINS_NAMED);
  const remaining = side.serviceNames.length - named.length;
  if (remaining === 0) return named.join(", ");
  return `${named.join(", ")} and ${formatCount(remaining)} more`;
}

/**
 * The signals that fired, as one sentence.
 *
 * The clauses are the detector's own, unedited: this surface reports what flagged a pair, it does
 * not re-argue it. They arrive lowercase and unpunctuated, so the lead-in is what makes them a
 * sentence, rather than capitalising a clause that often starts with a quoted package name.
 */
function writeReasons(reasons: readonly string[]): string | null {
  if (reasons.length === 0) return null;
  return `Flagged because ${reasons.join("; ")}.`;
}
