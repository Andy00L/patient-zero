import { UNKNOWN_NUMERIC_VALUE } from "@/lib/graph/model";

/**
 * How numbers, instants, and durations are written on every surface.
 *
 * Five surfaces render the same kinds of value, and the reason this is one module rather than a
 * habit repeated five times is the sentinel. `UNKNOWN_NUMERIC_VALUE` means "the source never
 * reported this", and 0 in a timestamp column means the same thing: neither is a reading. A
 * formatter that did not know that would render an absent publish date as 1970-01-01 and an
 * absent download count as -1, and both would look like facts the registry supplied. Every
 * function here refuses instead, and returns the same word for it, so an absent value reads as
 * absent wherever it appears.
 *
 * Everything is formatted in UTC with an explicit locale. These strings are produced during a
 * server render and hydrated in a browser that may be in another timezone with another locale,
 * and a value that changes between the two is a hydration mismatch. UTC is also the honest
 * frame for this data: a resolution instant in a lockfile is a point in the incident timeline,
 * not a time of day where the reader happens to be sitting.
 */

/** The one word for an absent reading. Never "none", never "0", never a dash. */
export const UNKNOWN_READING = "unknown";

/** A number and its unit, kept apart so a caller can render them as DataValue and UnitSuffix. */
export type Measure = {
  value: string;
  unit: string;
};

const COUNT_FORMAT = new Intl.NumberFormat("en-US");

const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * True when a number came from a source rather than standing in for a missing one.
 *
 * Exported because the decision shows up outside formatting too: a panel that would place a
 * time window on an absent instant has to ask this before it renders anything at all.
 */
export function isKnownNumber(value: number): boolean {
  return Number.isFinite(value) && value !== UNKNOWN_NUMERIC_VALUE;
}

/** A count, thousands separated. The sentinel and a non-finite value read as unknown. */
export function formatCount(value: number): string {
  if (!isKnownNumber(value)) return UNKNOWN_READING;
  return COUNT_FORMAT.format(value);
}

/**
 * An instant, to the minute, in UTC: "2018-11-26 03:31 UTC".
 *
 * Zero and every negative value are absent rather than early: the graph writes 0 and the
 * sentinel for a timestamp the registry did not give, so an epoch instant here is always a
 * missing value and never a real one.
 */
export function formatInstant(epochMs: number): string {
  const parts = utcParts(epochMs);
  if (parts === null) return UNKNOWN_READING;
  return `${parts.day} ${parts.hour}:${parts.minute} UTC`;
}

/** A calendar day in UTC: "2018-11-26". For an axis tick or a column that has no room. */
export function formatDay(epochMs: number): string {
  const parts = utcParts(epochMs);
  if (parts === null) return UNKNOWN_READING;
  return parts.day;
}

/**
 * A span of time as one number and one unit, at the coarsest unit that keeps it readable.
 *
 * Returns null rather than a string, because a caller showing a headline number needs to place
 * the value and the unit in two different type steps. A negative span is null as well: it means
 * the two instants behind it disagree about their order, and a duration cannot be stated from
 * that.
 */
export function measureDuration(spanMs: number): Measure | null {
  if (!isKnownNumber(spanMs) || spanMs < 0) return null;

  if (spanMs >= MS_PER_DAY) {
    return { value: oneDecimal(spanMs / MS_PER_DAY), unit: "days" };
  }
  if (spanMs >= MS_PER_HOUR) {
    return { value: oneDecimal(spanMs / MS_PER_HOUR), unit: "hours" };
  }
  if (spanMs >= MS_PER_MINUTE) {
    return { value: String(Math.round(spanMs / MS_PER_MINUTE)), unit: "minutes" };
  }
  return { value: String(Math.round(spanMs / MS_PER_SECOND)), unit: "seconds" };
}

/**
 * How long a graph operation took, as one number and one unit.
 *
 * Separate from `measureDuration` because the two measure different things. A duration in this
 * product is a window in the incident timeline, where the coarsest readable unit is right and
 * anything under a minute rounds to seconds. A query latency is the opposite: sub-millisecond
 * for an in-process read, single-digit milliseconds for a chunked engine read, and rounding
 * either of those to "0 seconds" would delete the reading the provenance panel exists to show.
 *
 * Zero is a real reading here, unlike everywhere else in this module: a call that returned in
 * under 0.05 ms did happen and did return. Only a negative or non-finite span is refused,
 * because that means the clock disagreed with itself.
 */
export function measureLatency(spanMs: number): Measure | null {
  if (!Number.isFinite(spanMs) || spanMs < 0) return null;

  if (spanMs >= MS_PER_SECOND) return { value: oneDecimal(spanMs / MS_PER_SECOND), unit: "s" };
  // Under ten milliseconds a whole number throws away most of the reading, so the decimal
  // stays; above it the fraction is noise from the event loop rather than from the graph.
  if (spanMs < 10) return { value: oneDecimal(spanMs), unit: "ms" };
  return { value: String(Math.round(spanMs)), unit: "ms" };
}

/** The span between two instants, or null when either end is absent. */
export function measureSpan(fromMs: number, toMs: number): Measure | null {
  if (!isKnownInstant(fromMs) || !isKnownInstant(toMs)) return null;
  return measureDuration(toMs - fromMs);
}

/** An instant is present only when it is a real number after the epoch. */
export function isKnownInstant(epochMs: number): boolean {
  return isKnownNumber(epochMs) && epochMs > 0;
}

type UtcParts = {
  day: string;
  hour: string;
  minute: string;
};

function utcParts(epochMs: number): UtcParts | null {
  if (!isKnownInstant(epochMs)) return null;

  const at = new Date(epochMs);
  const year = at.getUTCFullYear();
  if (!Number.isFinite(year)) return null;

  return {
    day: `${year}-${twoDigits(at.getUTCMonth() + 1)}-${twoDigits(at.getUTCDate())}`,
    hour: twoDigits(at.getUTCHours()),
    minute: twoDigits(at.getUTCMinutes()),
  };
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * One decimal, with a trailing ".0" dropped.
 *
 * "78.6 days" carries information; "14.0 days" carries a false precision that suggests the span
 * was measured more finely than it was.
 */
function oneDecimal(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
