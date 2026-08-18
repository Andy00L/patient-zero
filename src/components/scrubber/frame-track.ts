import { describeLimit } from "@/lib/analysis/abstention";
import type { ReplayFrame, ReplayTimeline } from "@/lib/analysis/replay";
import { formatCount, formatInstant, isKnownInstant } from "@/lib/format";

/**
 * The scrubber's arithmetic, kept out of the component.
 *
 * Everything here is pure: a frame list in, bars, indices, offsets and sentences out. The
 * split is not tidiness. A time scrubber is wrong in ways a screenshot cannot show (a click
 * that lands one bar off, a playhead half a slot from the frame it claims to mark, a step
 * that wraps at the end of the timeline instead of stopping), and those are the parts worth
 * asserting on. test/scrubber.test.ts tests this file; the component only renders it.
 *
 * Nothing here re-decides anything the replay engine decided. Counts, verdicts, limits and
 * labels are read off `ReplayFrame` as they were produced by src/lib/analysis/replay.ts.
 */

/**
 * The gap between two frame bars, in px.
 *
 * A one-off geometry rather than a token: it is the hairline that separates one scrubber
 * position from the next, and it exists at this size because the sheet's smallest spacing
 * step (4px) would eat a third of a bar's width on a sixty-frame timeline. It lives here
 * rather than in the component because the playhead offset below has to account for it, and
 * two copies of the number would drift.
 */
export const BAR_GAP_PX = 2;

/**
 * Smallest height a bar draws at, as a fraction of the track's inner height.
 *
 * A frame with no exposure still has to mark its own tick: the track is a time axis before it
 * is a chart, and a zero-height bar would make the first half of every incident read as a gap
 * in the timeline rather than as a quiet stretch of it.
 */
const MIN_BAR_HEIGHT_RATIO = 0.08;

/** One frame as the track draws it. */
export type FrameBar = {
  /** Position in `ReplayTimeline.frames`, so a click on a bar can name its frame. */
  index: number;
  atMs: number;
  /** Services the frame reports as exposed, taken from its own verdict counts. */
  exposedCount: number;
  /** 0 to 1 of the track's inner height. Never 0, see MIN_BAR_HEIGHT_RATIO. */
  heightRatio: number;
  /** Drives the tint: amber when the frame found exposure, the quiet tint when it did not. */
  hasExposure: boolean;
};

/**
 * Turns the frames into bars, scaled against the loudest frame in this timeline.
 *
 * Scaled locally rather than against an absolute service count, because the shape a reader
 * needs to see is when exposure arrived and how steeply it climbed, and a timeline whose worst
 * frame reaches four services would otherwise draw four invisible bars. The cumulative
 * exposure the replay produces means the bars rise and then plateau, which is the outbreak.
 */
export function buildFrameBars(frames: readonly ReplayFrame[]): FrameBar[] {
  const loudestCount = frames.reduce(
    (highest, frame) => Math.max(highest, frame.answer.evidence.counts.exposed),
    0,
  );

  return frames.map((frame) => {
    const exposedCount = frame.answer.evidence.counts.exposed;
    const scaled = loudestCount > 0 ? exposedCount / loudestCount : 0;

    return {
      index: frame.index,
      atMs: frame.atMs,
      exposedCount,
      heightRatio: Math.max(scaled, MIN_BAR_HEIGHT_RATIO),
      hasExposure: exposedCount > 0,
    };
  });
}

/**
 * Forces any incoming index into a position this timeline actually has.
 *
 * The parent owns the selected index, so a stale one arrives whenever a reader switches
 * incident while sitting deep in a longer timeline. Clamping shows the end of the new replay,
 * which is a defensible frame to be looking at; rendering `undefined` as a frame is not. A
 * fractional index is rounded, because `aria-valuenow` has to be one of the positions the
 * slider advertises.
 */
export function clampFrameIndex(index: number, frameCount: number): number {
  if (frameCount <= 0) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(Math.round(index), 0), frameCount - 1);
}

/**
 * Steps the selection, stopping at both ends.
 *
 * No wrap-around: a replay is a story with a start and an end, and an arrow key that jumps
 * from the last frame back to the first would tell a reader the outbreak reset.
 */
export function stepFrameIndex(index: number, step: number, frameCount: number): number {
  return clampFrameIndex(clampFrameIndex(index, frameCount) + step, frameCount);
}

/**
 * The frame under a pointer, from that pointer's position across the track.
 *
 * Bars are equal-width slots, so the bar a reader clicked is the nearest frame by
 * construction: slot `i` owns the width from `i / count` to `(i + 1) / count`. Ratios outside
 * the track come from a drag that left it, which is an ordinary gesture and clamps rather
 * than failing.
 */
export function selectFrameIndexAtRatio(ratio: number, frameCount: number): number {
  if (frameCount <= 0) return 0;
  if (!Number.isFinite(ratio)) return 0;
  return clampFrameIndex(Math.floor(ratio * frameCount), frameCount);
}

/**
 * Where the playhead sits, as a CSS length for `left`.
 *
 * Expressed as a calc rather than a percentage because the bars are separated by
 * `BAR_GAP_PX`, so the slot centres are not at `(index + 0.5) / count` of the track: the gaps
 * push every slot after the first to the right. Getting this wrong by a gap or two is the
 * classic scrubber defect where the playhead drifts away from the bar it claims to mark, and
 * the drift is largest exactly where a demo audience is looking, in the middle of the track.
 */
export function computePlayheadOffset(index: number, frameCount: number): string {
  if (frameCount <= 0) return "0px";
  const boundedIndex = clampFrameIndex(index, frameCount);
  const gapsTotalPx = (frameCount - 1) * BAR_GAP_PX;
  const slotCentre = boundedIndex + 0.5;
  return `calc((100% - ${gapsTotalPx}px) / ${frameCount} * ${slotCentre} + ${boundedIndex * BAR_GAP_PX}px)`;
}

/**
 * Where the hairline between two frames sits, as a CSS length for `left`.
 *
 * The centre of the gap that separates slot `index - 1` from slot `index`, which is where a
 * boundary on this axis belongs: a mark that means "everything left of here" has to fall
 * between two frames rather than on one, or a reader reasonably counts the frame under it as
 * being on both sides. Index 0 returns the track's leading edge, and the sign is written out
 * because `calc(... + -1px)` is not valid CSS.
 */
export function computeFrameBoundaryOffset(index: number, frameCount: number): string {
  if (frameCount <= 0) return "0px";
  const boundedIndex = clampFrameIndex(index, frameCount);
  const gapsTotalPx = (frameCount - 1) * BAR_GAP_PX;
  const shiftPx = (boundedIndex - 0.5) * BAR_GAP_PX;
  const sign = shiftPx < 0 ? "-" : "+";
  return `calc((100% - ${gapsTotalPx}px) / ${frameCount} * ${boundedIndex} ${sign} ${Math.abs(shiftPx)}px)`;
}

/**
 * The first frame the advisory was public for, or null when the axis has no disclosure to mark.
 *
 * This is the flip the product exists to show: left of it, services were exposed and no
 * advisory existed to look the version up in. Read off the frame's own `advisoryPublic` flag
 * rather than re-compared against `disclosedAtMs`, so the mark and the frame's verdict can
 * never disagree about which side of disclosure a frame is on.
 *
 * Null in three cases, all of which mean there is no rule to draw rather than a rule at zero:
 * the disclosure instant is absent, so nothing is known about when the advisory went public; no
 * frame in the window is public, so the whole replay sits inside the blind spot; or the first
 * frame is already public, so disclosure happened at or before the window opened and a rule on
 * the track's leading edge would separate nothing from everything.
 * sourceRef: src/lib/analysis/replay.ts (advisoryPublic)
 */
export function findDisclosureIndex(timeline: ReplayTimeline): number | null {
  if (!isKnownInstant(timeline.disclosedAtMs)) return null;

  const index = timeline.frames.findIndex((frame) => frame.answer.evidence.advisoryPublic);
  if (index <= 0) return null;

  return index;
}

/**
 * True when a frame's label is only its own instant written out as ISO.
 *
 * replay.ts labels a tick with the curator's prose when the pack narrates that instant, and
 * falls back to `new Date(atMs).toISOString()` for every other tick. Printing that fallback
 * next to the formatted instant would show one reading twice in two formats, so the label is
 * suppressed when it parses back to the frame's own instant. Parsing rather than pattern
 * matching, because prose never parses to an exact epoch and this cannot throw on a
 * timestamp outside the Date range. sourceRef: src/lib/analysis/replay.ts (labelInstant)
 */
export function isInstantOnlyLabel(frame: ReplayFrame): boolean {
  return Date.parse(frame.label) === frame.atMs;
}

/**
 * What the slider announces at this position: the instant, the exposure it found, and the
 * curator's line when there is one.
 *
 * The index is deliberately absent. "Frame 34 of 67" is a fact about the control; a reader
 * using a screen reader needs the same fact a sighted reader gets off the readout, which is
 * when this was and how much of the estate was already exposed by then.
 */
export function describeFrameForSlider(frame: ReplayFrame): string {
  const exposedCount = frame.answer.evidence.counts.exposed;
  const serviceWord = exposedCount === 1 ? "service" : "services";
  const readings = [
    formatInstant(frame.atMs),
    `${formatCount(exposedCount)} ${serviceWord} exposed`,
  ];
  if (!isInstantOnlyLabel(frame)) readings.push(frame.label);
  return readings.join(", ");
}

/**
 * The limits behind the answer on screen, as sentences.
 *
 * Every limit the replay hit travels into every frame, so this is the selected frame's own
 * list rather than a union over the timeline. Deduped by rendered sentence: two compromised
 * versions of one package produce the same partial-coverage limit twice, and a reader would
 * read that as two separate problems.
 */
export function describeFrameLimits(frame: ReplayFrame): string[] {
  const sentences: string[] = [];
  for (const limit of frame.answer.limits) {
    const sentence = describeLimit(limit);
    if (!sentences.includes(sentence)) sentences.push(sentence);
  }
  return sentences;
}

/**
 * The reason a replay with no frames states, built from the timeline's own bounds.
 *
 * `ReplayTimeline.frames` is documented as never empty, so reaching this is a defect rather
 * than a data limit. It still gets a sentence with real bounds in it: a blank strip where a
 * track should be tells a reader nothing, and an absent bound reads as unknown through
 * formatInstant instead of as 1970.
 */
export function describeMissingFrames(timeline: ReplayTimeline): string {
  return (
    `${timeline.packTitle} produced no frames between ${formatInstant(timeline.windowStartMs)} ` +
    `and ${formatInstant(timeline.windowEndMs)}, so there is nothing to state at any instant ` +
    `in its window.`
  );
}
