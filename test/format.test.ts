import { describe, expect, test } from "bun:test";

import {
  UNKNOWN_READING,
  formatCount,
  formatDay,
  formatInstant,
  isKnownInstant,
  measureDuration,
  measureLatency,
  measureSpan,
} from "@/lib/format";
import { UNKNOWN_NUMERIC_VALUE } from "@/lib/graph/model";

/**
 * These tests exist for one rule: an absent value must never render as a reading.
 *
 * The graph writes -1 and 0 for facts a registry never supplied, so the failure mode this file
 * guards against is a formatter that turns an absent publish date into 1970-01-01 or an absent
 * download count into -1. Both would look like data the registry gave us, which is the one thing
 * this product must not do.
 */

/** 2018-11-26 03:31 UTC, inside the real event-stream window. */
const INCIDENT_INSTANT_MS = Date.UTC(2018, 10, 26, 3, 31, 12);

describe("absent values", () => {
  test("the sentinel and the epoch are absent, not readings", () => {
    expect(formatCount(UNKNOWN_NUMERIC_VALUE)).toBe(UNKNOWN_READING);
    expect(formatInstant(UNKNOWN_NUMERIC_VALUE)).toBe(UNKNOWN_READING);
    expect(formatInstant(0)).toBe(UNKNOWN_READING);
    expect(formatDay(0)).toBe(UNKNOWN_READING);
    expect(isKnownInstant(0)).toBe(false);
    expect(measureSpan(0, INCIDENT_INSTANT_MS)).toBeNull();
  });

  test("zero is a real count, because a package can have no dependents", () => {
    expect(formatCount(0)).toBe("0");
  });
});

describe("readings", () => {
  test("counts are thousands separated", () => {
    expect(formatCount(1347)).toBe("1,347");
  });

  test("an instant is written in UTC to the minute", () => {
    expect(formatInstant(INCIDENT_INSTANT_MS)).toBe("2018-11-26 03:31 UTC");
    expect(formatDay(INCIDENT_INSTANT_MS)).toBe("2018-11-26");
  });

  test("a span takes the coarsest unit that stays readable", () => {
    expect(measureDuration(6_791_040_000)).toEqual({ value: "78.6", unit: "days" });
    expect(measureDuration(14 * 24 * 60 * 60 * 1000)).toEqual({ value: "14", unit: "days" });
    expect(measureDuration(90 * 60 * 1000)).toEqual({ value: "1.5", unit: "hours" });
    expect(measureDuration(9 * 60 * 1000)).toEqual({ value: "9", unit: "minutes" });
    expect(measureDuration(2_400)).toEqual({ value: "2", unit: "seconds" });
  });

  test("a span whose ends disagree about their order states nothing", () => {
    expect(measureSpan(INCIDENT_INSTANT_MS, INCIDENT_INSTANT_MS - 1000)).toBeNull();
  });

  /**
   * A query latency is the one reading in this module where zero is real and where rounding to
   * the coarsest unit would delete the measurement. An in-process read returns in well under a
   * millisecond, and "0 seconds" is not what happened.
   */
  test("a query latency keeps the sub-millisecond reading it was given", () => {
    expect(measureLatency(0)).toEqual({ value: "0", unit: "ms" });
    expect(measureLatency(0.42)).toEqual({ value: "0.4", unit: "ms" });
    expect(measureLatency(9.94)).toEqual({ value: "9.9", unit: "ms" });
    expect(measureLatency(42.4)).toEqual({ value: "42", unit: "ms" });
    expect(measureLatency(1_480)).toEqual({ value: "1.5", unit: "s" });
    expect(measureLatency(-1)).toBeNull();
  });
});
