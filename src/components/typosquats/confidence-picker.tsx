"use client";

import { useRouter } from "next/navigation";
import { useOptimistic, useTransition } from "react";

import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented";
import { FieldLabel } from "@/components/ui/text";
import type { TyposquatConfidence } from "@/lib/analysis/typosquat";
import { formatCount } from "@/lib/format";

import { buildTyposquatHref, type FloorChoice, readRequestedFloor } from "./typosquat-query";

/**
 * How weak a pair's evidence may be and still be listed.
 *
 * The floor lives in the URL for the reason the incident does on the radar: the pairs and their
 * counts are decided on the server, and a reader who opened the weak tier can hand that view to
 * someone else as a link. The chip moves the moment it is pressed and React puts it back by itself
 * if the navigation fails, so the control can never show a floor the lists are not honouring.
 * sourceRef: src/components/radar/incident-picker.tsx.
 *
 * This is the one control in the app that carries a visible label. Elsewhere the chips name their
 * own axis: "10 / 25 / 100" beside a ranking can only be a row count. Here they read "high /
 * medium / low", which does not say whose confidence it is, and worse, does not say whether
 * pressing "medium" shows the medium tier or everything down to it. Both are answered by the label
 * and the counts on the chips, and neither is answered by the words alone.
 */

export type ConfidencePickerProps = {
  /** The floors worth offering for this slice, from `describeFloorChoices`. */
  choices: readonly FloorChoice[];
  selected: TyposquatConfidence;
};

const GROUP_LABEL = "Include pairs down to";

export function ConfidencePicker({ choices, selected }: ConfidencePickerProps) {
  const router = useRouter();
  const [isNavigating, startNavigation] = useTransition();
  const [shownFloor, showFloor] = useOptimistic<string>(selected);

  const options: SegmentedOption<string>[] = choices.map((choice) => ({
    value: choice.floor,
    label: choice.label,
    // The count is what the reader is actually choosing between: "low" is a word, "68 pairs" is
    // the length of the list it opens.
    detail: `${formatCount(choice.pairCount)} pairs`,
  }));

  function select(next: string): void {
    const nextFloor = readRequestedFloor(next);
    if (nextFloor === null || nextFloor === selected) return;

    startNavigation(() => {
      showFloor(nextFloor);
      router.push(buildTyposquatHref(nextFloor), { scroll: false });
    });
  }

  return (
    <span className="flex flex-wrap items-center gap-2" aria-busy={isNavigating}>
      {/* The same string is the radiogroup's accessible name below, so the visual copy is hidden
          from assistive tech rather than announced twice. Pointing the group at this element with
          aria-labelledby would be the other way round, and it would mean changing the shared
          SegmentedControl for one caller. */}
      <span aria-hidden>
        <FieldLabel>{GROUP_LABEL}</FieldLabel>
      </span>
      <SegmentedControl
        label={GROUP_LABEL}
        options={options}
        value={shownFloor}
        onChange={select}
      />
    </span>
  );
}
