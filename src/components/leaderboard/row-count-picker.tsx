"use client";

import { useRouter } from "next/navigation";
import { useOptimistic, useTransition } from "react";

import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented";

import {
  buildLeaderboardHref,
  readRowCount,
  type RowCount,
  type RowCountChoice,
} from "./leaderboard-query";

/**
 * How much of the ranking the table shows.
 *
 * The count lives in the URL for the same reason the incident does on the radar: the ranking is
 * computed on the server, so a client-held count would mean holding rows the server had already
 * decided not to render, and a reader who scrolled to the bottom of the whole board can hand
 * that board to someone else as a link.
 * sourceRef: src/components/radar/incident-picker.tsx.
 *
 * The chip moves the moment it is pressed and React puts it back by itself if the navigation
 * fails, so the control can never show a count the table is not honouring.
 */

export type RowCountPickerProps = {
  /** The counts worth offering for this ranking, from `describeRowCountChoices`. */
  choices: readonly RowCountChoice[];
  selected: RowCount;
  /** The opened account, carried through the navigation so changing the count keeps it. */
  accountKey: string | null;
};

export function RowCountPicker({ choices, selected, accountKey }: RowCountPickerProps) {
  const router = useRouter();
  const [isNavigating, startNavigation] = useTransition();
  const [shownCount, showCount] = useOptimistic(String(selected));

  const options: SegmentedOption<string>[] = choices.map((choice) => ({
    value: String(choice.rowCount),
    label: choice.label,
  }));

  function select(next: string): void {
    const nextCount = readRowCount(next);
    if (nextCount === selected) return;

    startNavigation(() => {
      showCount(String(nextCount));
      router.push(buildLeaderboardHref({ rowCount: nextCount, accountKey }), { scroll: false });
    });
  }

  return (
    <span aria-busy={isNavigating}>
      <SegmentedControl
        label="Ranked accounts shown"
        options={options}
        value={shownCount}
        onChange={select}
      />
    </span>
  );
}
