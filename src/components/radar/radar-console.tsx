"use client";

import { useState } from "react";

import {
  clampFrameIndex,
  describeFrameLimits,
  describeMissingFrames,
  isInstantOnlyLabel,
} from "@/components/scrubber/frame-track";
import { TimeScrubber } from "@/components/scrubber/time-scrubber";
import { PropagationTrace } from "@/components/trace/propagation-trace";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import { AbstainNotice, EmptyState } from "@/components/ui/state";
import { DataValue, DefinitionRow, FieldLabel, UnitSuffix } from "@/components/ui/text";
import { VerdictPill } from "@/components/ui/verdict";
import type { ReplayExposure, ReplayTimeline } from "@/lib/analysis/replay";
import { frameAt } from "@/lib/analysis/replay-frames";
import { formatCount, formatInstant, isKnownInstant, measureDuration } from "@/lib/format";

/**
 * The radar: one instant of a replay, and the control that moves between instants.
 *
 * This is the only stateful piece of the surface, and the state is a single number: which frame
 * the reader is looking at. Everything else was decided on the server. `ReplayTimeline` arrives
 * fully computed, so moving the scrubber costs no request, no loading state and no chance of the
 * picture disagreeing with the readout beside it. That is the reason the replay engine returns a
 * serialisable timeline instead of an endpoint the scrubber would poll: a scrub that stutters
 * once per frame is not a replay, it is a form.
 *
 * The payload that buys it is real. The worm pack carries sixty frames, each holding one row per
 * exposed service with its full path, and those rows repeat heavily from frame to frame because
 * exposure is cumulative. It compresses accordingly in transit, and the alternative costs a
 * round trip per frame on the one interaction the demo is built around.
 *
 * The frame index is deliberately not in the URL. The incident is, because that names what is on
 * screen and is worth sharing; a frame index is a scroll position, and putting it in the URL
 * would push a history entry for every notch of a drag.
 */

/**
 * What the selected service is, stated for the instant on screen.
 *
 * The selection deliberately survives a frame change, and this sentence is the reason it can.
 * A reader selects a service on the completed answer, scrubs backward, and the highlighted chain
 * disappears at the instant that service had not yet resolved the compromised version. Without a
 * line saying so, that looks like the trace losing the selection; with it, the disappearance is
 * the finding, and the instant it re-appears is the pin.
 *
 * The frame's own exposures decide whether there is a chain to draw. The completed set, which is
 * the last frame because exposure accumulates, is only consulted to name the pin instant of a
 * service that has not entered yet.
 */
function describeSelection({
  selectedServiceKey,
  frameExposures,
  completeExposures,
}: {
  selectedServiceKey: string | null;
  frameExposures: readonly ReplayExposure[];
  completeExposures: readonly ReplayExposure[];
}): string {
  if (selectedServiceKey === null) {
    return "Select a service in the trace to read its chain back to patient zero.";
  }

  const atThisInstant = frameExposures.find((entry) => entry.serviceKey === selectedServiceKey);
  if (atThisInstant !== undefined) {
    const hopWord = atThisInstant.hopCount === 1 ? "hop" : "hops";
    const pin = isKnownInstant(atThisInstant.resolvedAtMs)
      ? `at ${formatInstant(atThisInstant.resolvedAtMs)}`
      : "at an instant the lockfile did not record";
    // Named only when true. Every exposed service is inside the window at some instant of a
    // replay, so stating the negative case would put the phrase on every row and mean nothing.
    const blind = atThisInstant.withinUnknownWindow ? ", before any advisory existed" : "";
    return `${atThisInstant.serviceName} pinned ${atThisInstant.versionKey} ${pin}, ${atThisInstant.hopCount} ${hopWord} from patient zero${blind}.`;
  }

  const laterInTheReplay = completeExposures.find(
    (entry) => entry.serviceKey === selectedServiceKey,
  );
  if (laterInTheReplay === undefined) {
    // Unreachable while the selection comes from a node this timeline drew, and stated rather
    // than asserted: a blank line here would read as the readout failing.
    return `${selectedServiceKey} is selected and this replay holds no route for it.`;
  }

  const pin = isKnownInstant(laterInTheReplay.resolvedAtMs)
    ? `It pins ${laterInTheReplay.versionKey} at ${formatInstant(laterInTheReplay.resolvedAtMs)}, later in this replay.`
    : `It pins ${laterInTheReplay.versionKey} at an instant the lockfile did not record.`;
  return `${laterInTheReplay.serviceName} is selected and has no route at this instant. ${pin}`;
}

export type RadarConsoleProps = {
  /**
   * The replay, decided on the server. The caller must key this component on
   * `timeline.packSlug` so switching incident remounts it: the frame index means nothing across
   * two different timelines, and remounting is a clearer reset than an effect that watches a
   * prop and writes state behind the render.
   */
  timeline: ReplayTimeline;
  /**
   * What was compromised, as a person reads it: `name@version`, or that plus a count when the
   * pack condemns several artifacts. Written by the caller from the pack, so the client bundle
   * never has to carry the pack schema to render its own title.
   */
  subjectLabel: string;
};

export function RadarConsole({ timeline, subjectLabel }: RadarConsoleProps) {
  // Opens on the last frame, which is the completed answer. Opening on the first frame would
  // show an empty trace and a zero count on arrival, and a reader cannot tell a replay that has
  // not started from a tool that found nothing.
  const [requestedIndex, setRequestedIndex] = useState(timeline.frames.length - 1);
  // Not reset when the frame changes. Keeping it is what makes scrubbing informative: the chain
  // winks out at the instant the service had not yet resolved, and describeSelection says so.
  const [selectedServiceKey, setSelectedServiceKey] = useState<string | null>(null);

  const frameCount = timeline.frames.length;
  const index = clampFrameIndex(requestedIndex, frameCount);
  const frame = frameAt(timeline, index);

  if (!frame.ok) {
    // Documented as unreachable: `frames` is never empty. Rendered rather than asserted,
    // because a thrown error here would take down the whole surface over a missing frame.
    return (
      <EmptyState title="This replay has no frames to show">
        {describeMissingFrames(timeline)}
      </EmptyState>
    );
  }

  const answer = frame.value.answer;
  const counts = answer.evidence.counts;
  const knownServiceCount = counts.exposed + counts.not_exposed + counts.unknown;
  const blindSpotCount = answer.evidence.unknownWindowServiceKeys.length;
  const limits = describeFrameLimits(frame.value);
  const blindSpot = timeline.blindSpot === null ? null : measureDuration(timeline.blindSpot.durationMs);
  // Exposure accumulates across frames, so the last frame holds every route this replay found.
  // Read only to name the pin instant of a service selected before it enters.
  const finalFrame = frameAt(timeline, frameCount - 1);
  const completeExposures = finalFrame.ok ? finalFrame.value.answer.evidence.exposedServices : [];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
        <Panel>
          <PanelHeader
            eyebrow="propagation"
            title={<span className="font-data">{subjectLabel}</span>}
            aside={
              blindSpot === null ? (
                // Null is "the advisory did not follow the payload", not a zero-length window,
                // and the reader is told which one this is.
                <FieldLabel>no blind spot</FieldLabel>
              ) : (
                <>
                  <DataValue>{blindSpot.value}</DataValue>
                  <UnitSuffix>{blindSpot.unit} unknown</UnitSuffix>
                </>
              )
            }
          />
          <PanelBody>
            <PropagationTrace
              answer={answer}
              subjectLabel={subjectLabel}
              selectedServiceKey={selectedServiceKey}
              onSelectService={setSelectedServiceKey}
            />
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader
            eyebrow="readout"
            title={<span className="font-data">{formatInstant(frame.value.atMs)}</span>}
            aside={<VerdictPill verdict={answer.verdict} rationale={answer.rationale} />}
          />
          <PanelBody className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <div className="flex items-baseline gap-2">
                <DataValue scale="lg">{formatCount(counts.exposed)}</DataValue>
                <UnitSuffix>of {formatCount(knownServiceCount)} services exposed</UnitSuffix>
              </div>
              {/* Two lines are reserved in every state, so selecting a service in the trace
                  never moves the rows below it. The trace panel reserves its caption the same
                  way, and the two panels sit side by side. */}
              <p className="line-clamp-2 min-h-[2.9em] text-small text-ink-muted">
                {describeSelection({
                  selectedServiceKey,
                  frameExposures: answer.evidence.exposedServices,
                  completeExposures,
                })}
              </p>
            </div>

            <dl className="flex flex-col">
              <DefinitionRow label="Advisory">
                {answer.evidence.advisoryPublic ? "public at this instant" : "not published yet"}
              </DefinitionRow>
              <DefinitionRow label="Pinned before disclosure">
                <span className="flex items-baseline gap-1">
                  <DataValue muted={blindSpotCount === 0}>{formatCount(blindSpotCount)}</DataValue>
                  <UnitSuffix>{blindSpotCount === 1 ? "service" : "services"}</UnitSuffix>
                </span>
              </DefinitionRow>
              <DefinitionRow label="Undecided">
                <span className="flex items-baseline gap-1">
                  <DataValue muted={counts.unknown === 0}>{formatCount(counts.unknown)}</DataValue>
                  <UnitSuffix>{counts.unknown === 1 ? "service" : "services"}</UnitSuffix>
                </span>
              </DefinitionRow>
              <DefinitionRow label="Not exposed">
                <span className="flex items-baseline gap-1">
                  <DataValue muted={counts.not_exposed === 0}>
                    {formatCount(counts.not_exposed)}
                  </DataValue>
                  <UnitSuffix>{counts.not_exposed === 1 ? "service" : "services"}</UnitSuffix>
                </span>
              </DefinitionRow>
            </dl>

            {isInstantOnlyLabel(frame.value) ? null : (
              // The curator's line for this tick, shown only when the pack narrates this
              // instant. The fallback label is the instant as ISO, which the header already
              // prints in a readable form.
              <p className="text-small text-ink">{frame.value.label}</p>
            )}

            {answer.verdict === "unknown" ? (
              <AbstainNotice rationale={answer.rationale} limits={limits} />
            ) : (
              <div className="flex flex-col gap-1">
                <FieldLabel>Why this answer is not the whole picture</FieldLabel>
                {limits.length === 0 ? (
                  <p className="text-small text-ink-muted">
                    Nothing limited this frame: the traversal finished inside every budget and
                    every service in the slice was reachable.
                  </p>
                ) : (
                  <ul className="flex list-none flex-col gap-1">
                    {limits.map((limit) => (
                      <li key={limit} className="text-small text-ink-muted">
                        {limit}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </PanelBody>
        </Panel>
      </div>

      <TimeScrubber timeline={timeline} index={index} onIndexChange={setRequestedIndex} />
    </div>
  );
}
