import { describe, expect, test } from "bun:test";

import {
  BAR_GAP_PX,
  buildFrameBars,
  clampFrameIndex,
  computeFrameBoundaryOffset,
  computePlayheadOffset,
  describeFrameForSlider,
  describeFrameLimits,
  describeMissingFrames,
  findDisclosureIndex,
  isInstantOnlyLabel,
  selectFrameIndexAtRatio,
  stepFrameIndex,
} from "@/components/scrubber/frame-track";
import type { AnswerLimit } from "@/lib/analysis/abstention";
import type { ReplayFrame, ReplayTimeline } from "@/lib/analysis/replay";

/**
 * One rule: the scrubber names the frame the reader pointed at, and never invents a reading.
 *
 * Everything asserted below is a defect a screenshot cannot show. A click that lands one bar
 * off, a playhead half a slot from the frame it claims to mark, an arrow key that wraps from
 * the end of an outbreak back to its start, a zero-exposure frame that draws nothing and turns
 * the quiet half of a timeline into a gap, and an absent instant printed as 1970 all render as
 * a perfectly plausible track, and so does a disclosure rule drawn at the window start when
 * nothing is known about when the advisory went public. The component is not tested here: it
 * renders these numbers.
 */

/** A real instant from the incident window, so the formatted readings below are recognisable. */
const FIRST_FRAME_MS = Date.UTC(2018, 10, 26, 3, 31);
const HOUR_MS = 60 * 60 * 1_000;

/** The absent-timestamp sentinel as the graph writes it into a frame. */
const ABSENT_INSTANT_MS = 0;

type FrameOptions = {
  index: number;
  exposedCount: number;
  atMs?: number;
  label?: string;
  limits?: AnswerLimit[];
  /** The replay engine's own flag for "the advisory existed at this instant". */
  advisoryPublic?: boolean;
};

/**
 * A frame in the shape replay.ts produces, with only the fields the track reads set to
 * anything interesting. Typed as ReplayFrame so a change to the replay module breaks this file
 * rather than letting the track assert against a shape that no longer exists.
 */
function buildFrame({
  index,
  exposedCount,
  atMs,
  label,
  limits,
  advisoryPublic,
}: FrameOptions): ReplayFrame {
  const frameAtMs = atMs ?? FIRST_FRAME_MS + index * HOUR_MS;

  return {
    index,
    atMs: frameAtMs,
    label: label ?? new Date(frameAtMs).toISOString(),
    answer: {
      verdict: exposedCount > 0 ? "exposed" : "unknown",
      rationale: "Test rationale.",
      limits: limits ?? [],
      evidence: {
        atMs: frameAtMs,
        exposedServices: [],
        counts: { exposed: exposedCount, not_exposed: 0, unknown: 0 },
        advisoryPublic: advisoryPublic ?? false,
        unknownWindowServiceKeys: [],
      },
    },
  };
}

/** A timeline with the incident's bounds fixed and its frames supplied per test. */
function buildTimeline(
  frames: readonly ReplayFrame[],
  overrides?: Partial<ReplayTimeline>,
): ReplayTimeline {
  return {
    packSlug: "event-stream",
    packTitle: "event-stream flatmap-stream",
    ecosystem: "npm",
    payloadLiveAtMs: FIRST_FRAME_MS,
    disclosedAtMs: FIRST_FRAME_MS + 8 * 24 * HOUR_MS,
    blindSpot: null,
    windowStartMs: FIRST_FRAME_MS,
    windowEndMs: FIRST_FRAME_MS + 12 * 24 * HOUR_MS,
    frames: [...frames],
    ...overrides,
  };
}

/** Two frames inside the blind spot, then disclosure, then two frames after it. */
const FRAMES_ACROSS_DISCLOSURE: readonly ReplayFrame[] = [
  buildFrame({ index: 0, exposedCount: 1 }),
  buildFrame({ index: 1, exposedCount: 3 }),
  buildFrame({ index: 2, exposedCount: 4, advisoryPublic: true }),
  buildFrame({ index: 3, exposedCount: 4, advisoryPublic: true }),
];

describe("buildFrameBars", () => {
  test("scales against the loudest frame and keeps each frame's own count", () => {
    const bars = buildFrameBars([
      buildFrame({ index: 0, exposedCount: 0 }),
      buildFrame({ index: 1, exposedCount: 2 }),
      buildFrame({ index: 2, exposedCount: 4 }),
    ]);

    expect(bars.map((bar) => bar.index)).toEqual([0, 1, 2]);
    expect(bars.map((bar) => bar.exposedCount)).toEqual([0, 2, 4]);
    expect(bars.map((bar) => bar.hasExposure)).toEqual([false, true, true]);
    expect(bars[2].heightRatio).toBe(1);
    expect(bars[1].heightRatio).toBe(0.5);
  });

  test("a frame with no exposure still marks its tick", () => {
    const bars = buildFrameBars([
      buildFrame({ index: 0, exposedCount: 0 }),
      buildFrame({ index: 1, exposedCount: 9 }),
    ]);

    // Above zero, so the quiet half of an incident reads as a quiet stretch of the axis and
    // not as a hole in it, and still well below the frame that found exposure.
    expect(bars[0].heightRatio).toBeGreaterThan(0);
    expect(bars[0].heightRatio).toBeLessThan(bars[1].heightRatio);
  });

  test("a timeline that never found exposure draws a flat floor, not a blank strip", () => {
    const bars = buildFrameBars([
      buildFrame({ index: 0, exposedCount: 0 }),
      buildFrame({ index: 1, exposedCount: 0 }),
      buildFrame({ index: 2, exposedCount: 0 }),
    ]);

    expect(bars.every((bar) => bar.heightRatio === bars[0].heightRatio)).toBe(true);
    expect(bars[0].heightRatio).toBeGreaterThan(0);
    expect(bars.some((bar) => bar.hasExposure)).toBe(false);
  });

  test("no frames produces no bars rather than a broken scale", () => {
    expect(buildFrameBars([])).toEqual([]);
  });
});

describe("clampFrameIndex", () => {
  test("holds an index inside a timeline that has fewer frames than the last one", () => {
    expect(clampFrameIndex(7, 4)).toBe(3);
    expect(clampFrameIndex(-2, 4)).toBe(0);
  });

  test("rounds to a position the slider actually advertises", () => {
    expect(clampFrameIndex(2.6, 10)).toBe(3);
  });

  test("a non-number lands on the first frame instead of rendering nothing", () => {
    expect(clampFrameIndex(Number.NaN, 10)).toBe(0);
    expect(clampFrameIndex(5, 0)).toBe(0);
  });
});

describe("stepFrameIndex", () => {
  test("steps one frame at a time", () => {
    expect(stepFrameIndex(1, 1, 4)).toBe(2);
    expect(stepFrameIndex(2, -1, 4)).toBe(1);
  });

  test("stops at both ends rather than wrapping the story around", () => {
    expect(stepFrameIndex(3, 1, 4)).toBe(3);
    expect(stepFrameIndex(0, -1, 4)).toBe(0);
    expect(stepFrameIndex(0, 400, 4)).toBe(3);
  });
});

describe("selectFrameIndexAtRatio", () => {
  test("each frame owns its own slot across the track", () => {
    expect(selectFrameIndexAtRatio(0, 4)).toBe(0);
    expect(selectFrameIndexAtRatio(0.24, 4)).toBe(0);
    expect(selectFrameIndexAtRatio(0.25, 4)).toBe(1);
    expect(selectFrameIndexAtRatio(0.99, 4)).toBe(3);
  });

  test("a drag that leaves the track clamps instead of failing", () => {
    expect(selectFrameIndexAtRatio(1, 4)).toBe(3);
    expect(selectFrameIndexAtRatio(1.8, 4)).toBe(3);
    expect(selectFrameIndexAtRatio(-0.4, 4)).toBe(0);
    expect(selectFrameIndexAtRatio(Number.NaN, 4)).toBe(0);
  });
});

describe("computePlayheadOffset", () => {
  test("accounts for the gaps between bars, so the playhead sits on its own bar", () => {
    // Four bars, three gaps: slot 2 starts after two gaps and its centre is 2.5 slots in.
    expect(computePlayheadOffset(2, 4)).toBe("calc((100% - 6px) / 4 * 2.5 + 4px)");
    expect(BAR_GAP_PX).toBe(2);
  });

  test("advances with the index and centres a single frame", () => {
    expect(computePlayheadOffset(0, 4)).toBe("calc((100% - 6px) / 4 * 0.5 + 0px)");
    expect(computePlayheadOffset(1, 4)).toBe("calc((100% - 6px) / 4 * 1.5 + 2px)");
    expect(computePlayheadOffset(0, 1)).toBe("calc((100% - 0px) / 1 * 0.5 + 0px)");
  });

  test("an empty track has no position to point at", () => {
    expect(computePlayheadOffset(3, 0)).toBe("0px");
  });
});

describe("computeFrameBoundaryOffset", () => {
  test("falls between two frames rather than on one", () => {
    // Four bars, three gaps: the boundary before slot 2 is the centre of the gap that separates
    // slot 1 from slot 2, which is one half gap left of slot 2's own leading edge.
    expect(computeFrameBoundaryOffset(2, 4)).toBe("calc((100% - 6px) / 4 * 2 + 3px)");
    expect(computeFrameBoundaryOffset(1, 4)).toBe("calc((100% - 6px) / 4 * 1 + 1px)");
  });

  test("never lands on the position the playhead would take for the same frame", () => {
    expect(computeFrameBoundaryOffset(2, 4)).not.toBe(computePlayheadOffset(2, 4));
  });

  test("writes a negative shift as valid CSS rather than as a plus and a minus", () => {
    expect(computeFrameBoundaryOffset(0, 4)).toBe("calc((100% - 6px) / 4 * 0 - 1px)");
  });

  test("an empty track has no boundary to point at", () => {
    expect(computeFrameBoundaryOffset(2, 0)).toBe("0px");
  });
});

describe("findDisclosureIndex", () => {
  test("marks the first frame the advisory was public for", () => {
    expect(findDisclosureIndex(buildTimeline(FRAMES_ACROSS_DISCLOSURE))).toBe(2);
  });

  test("no marker when nothing is known about when the advisory went public", () => {
    // The engine writes the absent sentinel and leaves every frame private, but a timeline
    // assembled another way must still not put a rule at the window start.
    expect(
      findDisclosureIndex(
        buildTimeline(FRAMES_ACROSS_DISCLOSURE, { disclosedAtMs: ABSENT_INSTANT_MS }),
      ),
    ).toBeNull();
  });

  test("no marker when the whole window sits inside the blind spot", () => {
    const blindWindow = [
      buildFrame({ index: 0, exposedCount: 1 }),
      buildFrame({ index: 1, exposedCount: 2 }),
    ];
    expect(findDisclosureIndex(buildTimeline(blindWindow))).toBeNull();
  });

  test("no marker when the window opens after disclosure", () => {
    // A rule on the track's leading edge would claim to separate nothing from everything.
    const alreadyPublic = [
      buildFrame({ index: 0, exposedCount: 4, advisoryPublic: true }),
      buildFrame({ index: 1, exposedCount: 4, advisoryPublic: true }),
    ];
    expect(findDisclosureIndex(buildTimeline(alreadyPublic))).toBeNull();
  });

  test("no frames, no marker", () => {
    expect(findDisclosureIndex(buildTimeline([]))).toBeNull();
  });
});

describe("describeFrameForSlider", () => {
  test("announces the instant and the exposure, not the frame number", () => {
    const announcement = describeFrameForSlider(buildFrame({ index: 12, exposedCount: 1 }));

    expect(announcement).toBe("2018-11-26 15:31 UTC, 1 service exposed");
    expect(announcement).not.toContain("12");
  });

  test("counts read as counts: plural, and thousands separated", () => {
    expect(describeFrameForSlider(buildFrame({ index: 0, exposedCount: 0 }))).toContain(
      "0 services exposed",
    );
    expect(describeFrameForSlider(buildFrame({ index: 0, exposedCount: 1_200 }))).toContain(
      "1,200 services exposed",
    );
  });

  test("the curator's line is announced, the ISO fallback is not", () => {
    const narrated = buildFrame({
      index: 3,
      exposedCount: 2,
      label: "Payload live on the registry",
    });
    expect(describeFrameForSlider(narrated)).toContain("Payload live on the registry");

    // The fallback label is the frame's own instant in another format, which would announce
    // the same reading twice.
    const unnarrated = buildFrame({ index: 3, exposedCount: 2 });
    expect(describeFrameForSlider(unnarrated)).toBe("2018-11-26 06:31 UTC, 2 services exposed");
  });

  test("an absent instant is announced as unknown, never as 1970", () => {
    const announcement = describeFrameForSlider(
      buildFrame({ index: 0, exposedCount: 0, atMs: ABSENT_INSTANT_MS }),
    );

    expect(announcement).toStartWith("unknown");
    expect(announcement).not.toContain("1970");
  });
});

describe("isInstantOnlyLabel", () => {
  test("separates the ISO fallback from a narrated tick", () => {
    expect(isInstantOnlyLabel(buildFrame({ index: 1, exposedCount: 0 }))).toBe(true);
    expect(
      isInstantOnlyLabel(buildFrame({ index: 1, exposedCount: 0, label: "Advisory published" })),
    ).toBe(false);
  });
});

describe("describeFrameLimits", () => {
  test("one sentence per distinct limit, so a repeat does not read as a second problem", () => {
    const repeated: AnswerLimit[] = [
      { kind: "package_partial", subjectKey: "npm:flatmap-stream" },
      { kind: "package_partial", subjectKey: "npm:flatmap-stream" },
    ];
    expect(describeFrameLimits(buildFrame({ index: 0, exposedCount: 1, limits: repeated }))).toHaveLength(1);
  });

  test("distinct limits are all kept", () => {
    const mixed: AnswerLimit[] = [
      { kind: "package_partial", subjectKey: "npm:flatmap-stream" },
      { kind: "hop_limit", maxHops: 4 },
    ];
    expect(describeFrameLimits(buildFrame({ index: 0, exposedCount: 1, limits: mixed }))).toHaveLength(2);
  });

  test("a frame with nothing held back says nothing", () => {
    expect(describeFrameLimits(buildFrame({ index: 0, exposedCount: 1 }))).toEqual([]);
  });
});

describe("describeMissingFrames", () => {
  test("states the incident and the window instead of leaving a blank track", () => {
    const reason = describeMissingFrames(buildTimeline([]));

    expect(reason).toContain("event-stream flatmap-stream");
    expect(reason).toContain("2018-11-26 03:31 UTC");
    expect(reason).toContain("2018-12-08 03:31 UTC");
  });

  test("an absent bound reads as unknown", () => {
    const reason = describeMissingFrames(buildTimeline([], { windowEndMs: ABSENT_INSTANT_MS }));

    expect(reason).toContain("unknown");
    expect(reason).not.toContain("1970");
  });
});
