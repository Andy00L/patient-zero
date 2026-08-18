"use client";

import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { joinClassNames } from "@/components/ui/class-names";
import { Tray } from "@/components/ui/panel";
import { AbstainNotice } from "@/components/ui/state";
import { FieldLabel } from "@/components/ui/text";
import type { ReplayFrame, ReplayTimeline } from "@/lib/analysis/replay";
import { formatInstant } from "@/lib/format";

import {
  BAR_GAP_PX,
  buildFrameBars,
  clampFrameIndex,
  computeFrameBoundaryOffset,
  computePlayheadOffset,
  describeFrameForSlider,
  describeMissingFrames,
  findDisclosureIndex,
  selectFrameIndexAtRatio,
  stepFrameIndex,
} from "./frame-track";

/**
 * The time scrubber: one replay window, one frame per scrubber position.
 *
 * The whole timeline arrives as a prop and every position is already decided inside it, so
 * scrubbing costs no network round trip and no recomputation. The component reads frames; it
 * never re-decides a verdict.
 *
 * The selected index lives in the parent (src/components/radar/radar-console.tsx), which
 * renders the readout, the verdict and the limits for whatever frame this control names. This
 * file owns the track, the playhead, the slider semantics and the single transport control.
 *
 * Geometry, index arithmetic and the sentences are in ./frame-track.ts and tested in
 * test/scrubber.test.ts. What is left here is the DOM, the two browser systems React does not
 * own (a timer and a media query), and their cleanup.
 */

/**
 * How long one frame holds during playback, in ms.
 *
 * This is playback speed, not a UI reaction, so it deliberately does not come from the
 * --dur-* ladder in globals.css: that ladder measures how fast the interface answers a
 * gesture and its ceiling is 320ms, while this measures how fast a story is told. At 240ms a
 * frame the default 60-frame window replays in about 14 seconds, which is slow enough to read
 * the instant as it moves and short enough that a person watching a demo does not look away.
 * sourceRef: src/lib/analysis/replay.ts (DEFAULT_FRAME_COUNT = 60)
 */
const PLAYBACK_FRAME_INTERVAL_MS = 240;

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Subscribes to the reduced-motion preference instead of sampling it once.
 *
 * Read at module load, the preference would be captured before hydration and never updated,
 * so a reader who turns motion off mid-session would keep the animated playhead until a
 * reload. useSyncExternalStore keeps the query as the source of truth and removes the
 * listener on unmount.
 */
function subscribeToReducedMotion(onStoreChange: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", onStoreChange);
  return () => {
    query.removeEventListener("change", onStoreChange);
  };
}

function readReducedMotion(): boolean {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/**
 * The server has no preference to read. False renders the animated playhead in the HTML, and
 * the first client snapshot corrects it before any frame advances.
 */
function readReducedMotionOnServer(): boolean {
  return false;
}

export type TimeScrubberProps = {
  timeline: ReplayTimeline;
  /** The frame the surface is showing. May arrive stale after an incident change; clamped here. */
  index: number;
  onIndexChange: (index: number) => void;
  className?: string;
};

export function TimeScrubber({ timeline, index, onIndexChange, className }: TimeScrubberProps) {
  const frames = timeline.frames;
  const frameCount = frames.length;
  const lastIndex = frameCount - 1;
  const selectedIndex = clampFrameIndex(index, frameCount);

  // Annotated rather than inferred: `frames` is documented as never empty, so the index always
  // resolves in practice, but a control that renders `undefined` as a frame is a worse failure
  // than one that states why it has nothing to show. The empty branch below is that statement.
  const selectedFrame: ReplayFrame | undefined = frames[selectedIndex];

  const [isPlaybackRequested, setIsPlaybackRequested] = useState(false);
  const prefersReducedMotion = useSyncExternalStore(
    subscribeToReducedMotion,
    readReducedMotion,
    readReducedMotionOnServer,
  );
  const barsRef = useRef<HTMLDivElement | null>(null);
  const bars = useMemo(() => buildFrameBars(frames), [frames]);

  // A one-frame timeline has nothing to play through, so the transport control reports itself
  // unavailable rather than sitting there doing nothing when pressed.
  const canPlay = lastIndex > 0;
  const isAtEnd = selectedIndex >= lastIndex;

  // Playing is derived, not stored. The end of a replay stops it: looping back to the first
  // frame would show exposure vanishing and then arriving again, which is a different claim
  // than the data makes. Deriving it rather than clearing the flag from inside the effect means
  // there is one source for "is the timer armed", "does the button read Pause", and "has the
  // story finished", so those three cannot disagree for a render.
  const isPlaying = isPlaybackRequested && !isAtEnd;

  // Playback drives a browser timer, the one system here React does not own. The timer is
  // re-armed per frame because the index lives in the parent: each tick is scheduled from the
  // frame currently on screen, so a manual seek shifts the schedule instead of racing a stale
  // interval. Cleanup clears it on unmount, on every frame change, and when isPlaying goes
  // false.
  useEffect(() => {
    if (!isPlaying) return;

    const timer = window.setTimeout(() => {
      onIndexChange(stepFrameIndex(selectedIndex, 1, frameCount));
    }, PLAYBACK_FRAME_INTERVAL_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [isPlaying, selectedIndex, frameCount, onIndexChange]);

  // Every manual seek stops playback: a reader who grabs the track has taken the story over,
  // and a timer still running would pull the frame out from under them. The parent receives an
  // index already inside this timeline, so it never has to clamp again.
  const seekTo = useCallback(
    (nextIndex: number) => {
      setIsPlaybackRequested(false);
      onIndexChange(clampFrameIndex(nextIndex, frameCount));
    },
    [frameCount, onIndexChange],
  );

  const seekToClientX = useCallback(
    (clientX: number) => {
      const barsElement = barsRef.current;
      if (barsElement === null) return;

      const bounds = barsElement.getBoundingClientRect();
      if (bounds.width <= 0) return;

      seekTo(selectFrameIndexAtRatio((clientX - bounds.left) / bounds.width, frameCount));
    },
    [frameCount, seekTo],
  );

  function togglePlayback() {
    if (!canPlay) return;

    if (isPlaying) {
      setIsPlaybackRequested(false);
      return;
    }

    // Pressing play on the last frame restarts the replay rather than doing nothing, which is
    // what the "Replay" label promises there.
    if (isAtEnd) onIndexChange(0);
    setIsPlaybackRequested(true);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    // Secondary and middle mouse buttons belong to the browser, not to the scrubber.
    if (event.pointerType === "mouse" && event.button !== 0) return;

    // Captured on the track itself, so a drag that wanders off it keeps scrubbing and releases
    // on its own. The alternative, window listeners added on pointerdown, is the usual place a
    // scrubber leaks one.
    event.currentTarget.setPointerCapture(event.pointerId);
    seekToClientX(event.clientX);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    // Only a captured pointer is a drag. Without this gate the frame would follow the cursor
    // across a track nobody is holding.
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    seekToClientX(event.clientX);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === " ") {
      // Space would scroll the page, and on a control that is the transport key it must not.
      event.preventDefault();
      togglePlayback();
      return;
    }

    switch (event.key) {
      case "ArrowLeft":
      case "ArrowDown":
        seekTo(stepFrameIndex(selectedIndex, -1, frameCount));
        break;
      case "ArrowRight":
      case "ArrowUp":
        seekTo(stepFrameIndex(selectedIndex, 1, frameCount));
        break;
      case "Home":
        seekTo(0);
        break;
      case "End":
        seekTo(lastIndex);
        break;
      default:
        return;
    }

    event.preventDefault();
  }

  const playbackLabel = isPlaying ? "Pause" : isAtEnd ? "Replay" : "Play";

  if (selectedFrame === undefined) {
    return (
      <div className={joinClassNames("flex flex-col gap-3", className)}>
        <div className="flex items-center justify-between gap-4">
          <FieldLabel>Replay position</FieldLabel>
          <Button disabled onClick={togglePlayback}>
            <PlaybackGlyph isPlaying={false} />
            Play
          </Button>
        </div>

        {/* The track still renders. A blank strip where a time axis belongs reads as a
            rendering fault; a track holding one sentence reads as an answer. */}
        <Tray className="flex h-12 items-center px-3">
          <p className="text-small text-ink-faint">No frames in this replay window</p>
        </Tray>

        <AbstainNotice rationale={describeMissingFrames(timeline)} limits={[]} />
      </div>
    );
  }

  // Null when there is no disclosure to mark: an absent instant, a window that ends before the
  // advisory, or one that opens after it. See findDisclosureIndex.
  const disclosureIndex = findDisclosureIndex(timeline);

  return (
    <div className={joinClassNames("flex flex-col gap-3", className)}>
      <div className="flex items-center justify-between gap-4">
        {/* The label and the transport, and no reading between them. The console prints the
            instant and the exposed count directly above this track, larger and in the data
            face, and the same string twice forty pixels apart is not a second reading. The
            slider's aria-valuetext still carries both, because that announcement is the only
            reading a person on a screen reader gets off this axis. */}
        <FieldLabel>Replay position</FieldLabel>

        <Button onClick={togglePlayback} disabled={!canPlay}>
          <PlaybackGlyph isPlaying={isPlaying} />
          {playbackLabel}
        </Button>
      </div>

      <Tray className="p-1">
        <div
          ref={barsRef}
          role="slider"
          tabIndex={0}
          aria-label={`Replay position across ${timeline.packTitle}`}
          aria-valuemin={0}
          aria-valuemax={lastIndex}
          aria-valuenow={selectedIndex}
          // The instant, not the index. "Frame 34" is a fact about the control; the reading a
          // person needs is when this was and how much was exposed by then.
          aria-valuetext={describeFrameForSlider(selectedFrame)}
          onKeyDown={handleKeyDown}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          className="relative flex h-10 touch-none select-none items-end"
          // The gap is set from the same constant the playhead offset is computed with, so the
          // two cannot drift apart and leave the playhead beside the bar it claims to mark.
          style={{ columnGap: `${BAR_GAP_PX}px` }}
        >
          {bars.map((bar) => (
            <div
              key={bar.index}
              aria-hidden="true"
              className={joinClassNames(
                "min-w-px flex-1 rounded-tick",
                bar.index === selectedIndex
                  ? "bg-accent"
                  : bar.hasExposure
                    ? "bg-accent-deep"
                    : "bg-tint-quiet",
              )}
              style={{ height: `${(bar.heightRatio * 100).toFixed(2)}%` }}
            />
          ))}

          {disclosureIndex === null ? null : (
            /* Disclosure (T2), the flip this product exists to show. A rule on the axis rather
               than a bar: it is 2px of the gap between two frames, it is the deeper amber the
               bars already use for exposure rather than a colour of its own, it has square ends
               where every bar and the playhead are rounded, and it runs the full height of the
               tray so it cuts past the bars instead of standing among them. Everything to its
               left is exposure nobody could have looked up. */
            <div
              aria-hidden="true"
              title={`Advisory public from ${formatInstant(timeline.disclosedAtMs)}`}
              className="pointer-events-none absolute -inset-y-1 w-0.5 -translate-x-1/2 bg-accent-deep"
              style={{ left: computeFrameBoundaryOffset(disclosureIndex, frameCount) }}
            />
          )}

          <div
            aria-hidden="true"
            className={joinClassNames(
              "pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-tick bg-accent",
              // Playback itself keeps working under reduced motion, because the frames are the
              // content. What stops is the playhead sliding between two positions, which is
              // decoration on top of a value that has already changed.
              !prefersReducedMotion &&
                "transition-[left] duration-[var(--dur-micro)] ease-[var(--ease-out)]",
            )}
            style={{ left: computePlayheadOffset(selectedIndex, frameCount) }}
          />
        </div>
      </Tray>

      {disclosureIndex === null ? null : (
        <p className="text-small text-ink-faint">
          The rule marks the advisory going public, {formatInstant(timeline.disclosedAtMs)}. Frames
          to its left are exposure nobody could have looked up.
        </p>
      )}
    </div>
  );
}

type PlaybackGlyphProps = {
  isPlaying: boolean;
};

/**
 * The transport glyph, on the house 16px grid.
 *
 * Drawn here rather than added to src/components/ui/icon.tsx because that set is shared
 * vocabulary and this is the only surface with a transport control. Same viewBox, same 1.5px
 * stroke and round joins as the set, so it sits in Button's icon slot without shifting the
 * label. It moves into icon.tsx as `play` and `pause` the day a second surface needs it.
 */
function PlaybackGlyph({ isPlaying }: PlaybackGlyphProps) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      {isPlaying ? (
        <>
          <path d="M6.25 4.5v7" />
          <path d="M9.75 4.5v7" />
        </>
      ) : (
        <path d="M6 4.25 12 8 6 11.75Z" />
      )}
    </svg>
  );
}
