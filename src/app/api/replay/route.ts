/**
 * GET /api/replay
 *
 * One incident, replayed over its own window: what was exposed at a given instant, and whether
 * anything public said so yet.
 *
 * Query contract:
 *   incident   required  pack slug, kebab-case (event-stream-2018)
 *   at         optional  epoch milliseconds. With it the response carries the single frame
 *                        covering that instant. Without it, every frame comes back at once.
 *   frameCount optional  2 to 2000, how finely the window is sampled. Default is the replay
 *                        module's own default.
 *
 * Why the whole timeline is available in one request: each frame is a decided answer over the
 * graph, and a scrubber that fetched them one at a time would rebuild the entire timeline per
 * frame. The frame instants always travel with the response, so a client can snap a slider to
 * real ticks without holding every frame's evidence.
 *
 * The slug reaches a file path, so it is validated twice: once here against the same kebab-case
 * pattern the pack loader enforces, and again inside the loader. Nothing else from the query
 * touches the filesystem.
 */

import { z } from "zod";

import { digitsInRange, epochMs, jsonFailure, jsonOk, parseQuery, runRoute } from "@/lib/api/http";
import { type ReplayTimeline, buildReplayTimeline } from "@/lib/analysis/replay";
import { frameAt } from "@/lib/analysis/replay-frames";
import { loadGraph } from "@/lib/graph/load-graph";
import { loadIncidentPack } from "@/lib/incidents/pack";
import { type Failure } from "@/lib/result";

const ROUTE_NAME = "GET /api/replay";

/**
 * Kebab-case, mirroring the pack loader's own rule. Enforced here so a slug carrying a path
 * separator is rejected before any file is opened, and so a typo answers 400 rather than 404.
 */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Longest slug worth accepting. The committed packs are well under this. */
const MAX_SLUG_LENGTH = 80;

/** Mirrors the replay module's own frame bounds. It rejects anything outside them as well. */
const MIN_FRAME_COUNT = 2;
const MAX_FRAME_COUNT = 2_000;

const QUERY_SCHEMA = z.object({
  incident: z
    .string()
    .min(1)
    .max(MAX_SLUG_LENGTH)
    .regex(SLUG_PATTERN, "must be a kebab-case incident slug"),
  at: epochMs().optional(),
  frameCount: digitsInRange(MIN_FRAME_COUNT, MAX_FRAME_COUNT).optional(),
});

export async function GET(request: Request): Promise<Response> {
  return runRoute(ROUTE_NAME, async () => {
    const query = parseQuery(request, QUERY_SCHEMA, ROUTE_NAME);
    if (!query.ok) return jsonFailure(query.failure);

    const pack = await loadIncidentPack(query.value.incident);
    if (!pack.ok) return jsonFailure(rewritePackFailure(pack.failure, query.value.incident));

    const loaded = await loadGraph();
    if (!loaded.ok) return jsonFailure(loaded.failure);

    const built = await buildReplayTimeline({
      gateway: loaded.value.gateway,
      coverage: loaded.value.coverage,
      pack: pack.value,
      options:
        query.value.frameCount === undefined ? undefined : { frameCount: query.value.frameCount },
    });
    if (!built.ok) return jsonFailure(built.failure);

    const timeline = built.value;
    const payload = {
      query: {
        incident: query.value.incident,
        atMs: query.value.at ?? null,
        frameCount: query.value.frameCount ?? null,
      },
      source: loaded.value.source,
      timeline: describeTimeline(timeline),
    };

    if (query.value.at === undefined) {
      return jsonOk({ ...payload, frame: null, frameSelection: null, frames: timeline.frames });
    }

    const selection = selectFrame(timeline, query.value.at);
    const frame = frameAt(timeline, selection.index);
    if (!frame.ok) return jsonFailure(frame.failure);

    return jsonOk({
      ...payload,
      frame: frame.value,
      frameSelection: {
        requestedAtMs: query.value.at,
        frameIndex: selection.index,
        frameAtMs: frame.value.atMs,
        // Set when the instant asked about falls outside the pack's own window, so a client can
        // say "before this incident starts" instead of presenting the first frame as the answer.
        clamped: selection.clamped,
      },
      frames: null,
    });
  });
}

/** The scrubber's own metadata: bounds, the two boundary instants, and where the ticks are. */
function describeTimeline(timeline: ReplayTimeline) {
  return {
    packSlug: timeline.packSlug,
    packTitle: timeline.packTitle,
    ecosystem: timeline.ecosystem,
    payloadLiveAtMs: timeline.payloadLiveAtMs,
    disclosedAtMs: timeline.disclosedAtMs,
    blindSpot: timeline.blindSpot,
    windowStartMs: timeline.windowStartMs,
    windowEndMs: timeline.windowEndMs,
    frameCount: timeline.frames.length,
    frameInstants: timeline.frames.map((frame) => frame.atMs),
  };
}

type FrameSelection = {
  index: number;
  clamped: "before_window" | "after_window" | null;
};

/**
 * The frame that describes the world at `atMs`.
 *
 * The frame at or before the instant is the answer, because a frame states what was true from
 * its own instant until the next one. An instant outside the window is clamped to the nearest
 * end and flagged rather than rejected: "what did this look like before it started" is a
 * question a scrubber asks by dragging, not a malformed request.
 */
function selectFrame(timeline: ReplayTimeline, atMs: number): FrameSelection {
  const lastIndex = timeline.frames.length - 1;
  if (atMs < timeline.windowStartMs) return { index: 0, clamped: "before_window" };
  if (atMs > timeline.windowEndMs) return { index: lastIndex, clamped: "after_window" };

  let index = 0;
  for (const [candidate, frame] of timeline.frames.entries()) {
    if (frame.atMs > atMs) break;
    index = candidate;
  }
  return { index, clamped: null };
}

/**
 * Keeps a 404 for an incident nobody has, and turns a broken committed pack into a 500.
 *
 * The slug was already validated against the loader's own pattern, so an `invalid_input` from
 * the loader can only mean the file on disk is wrong, which is not the client's fault.
 *
 * Neither message quotes the loader's own text. A missing file produces an ENOENT naming the
 * absolute path it tried, and the client asked about a slug, not about a filesystem.
 */
function rewritePackFailure(failure: Failure, slug: string): Failure {
  if (failure.reason === "not_found") {
    return {
      reason: "not_found",
      message: `[${ROUTE_NAME}] no incident pack named "${slug}" is installed. GET /api/incidents lists the ones that are.`,
    };
  }
  return {
    reason: "internal",
    message: `[${ROUTE_NAME}] the installed incident pack "${slug}" is unusable (${failure.reason})`,
  };
}
