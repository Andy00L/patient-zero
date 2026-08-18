import type { ReplayFrame, ReplayTimeline } from "@/lib/analysis/replay";
import { type Failure, type Result, fail, succeed } from "@/lib/result";

/**
 * The frame accessors, split out so a browser can hold them.
 *
 * This is one function in its own file, and the reason is a bundling boundary rather than a
 * preference. `replay.ts` builds a timeline, so it imports the incident pack loader, which
 * imports `node:fs/promises` at module scope. A client component that imports any runtime value
 * from `replay.ts` therefore drags the filesystem into the browser chunk, and Turbopack answers
 * that with a 500 on the page and a panic log naming `node:fs/promises` rather than naming the
 * import that asked for it. The radar console is a client component and needs exactly this one
 * function, so this file is what it imports.
 *
 * Types are safe to take from `replay.ts` directly: `import type` is erased before bundling and
 * pulls no module in. Only value imports build the graph that has to be client-safe.
 *
 * Nothing that touches a gateway, a snapshot, a manifest or a pack belongs here. If this file
 * ever needs one of them, the caller wanted the server.
 */

/**
 * Bounds-checked frame lookup for the UI.
 *
 * A scrubber is driven by a pointer, a keyboard and a URL parameter, so an out-of-range
 * index is an ordinary input rather than a bug. It comes back as a Failure the caller can
 * render, never as an exception and never as `undefined` pretending to be a frame.
 */
export function frameAt(timeline: ReplayTimeline, index: number): Result<ReplayFrame, Failure> {
  if (!Number.isInteger(index)) {
    return fail("invalid_input", `[frameAt] frame index ${index} is not an integer`);
  }
  const frame = timeline.frames[index];
  if (frame === undefined) {
    return fail(
      "invalid_input",
      `[frameAt] frame ${index} is outside 0 to ${timeline.frames.length - 1}`,
      { context: { packSlug: timeline.packSlug, frameCount: timeline.frames.length } },
    );
  }
  return succeed(frame);
}
