"use client";

import { useRouter } from "next/navigation";
import { useOptimistic, useTransition } from "react";

import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented";

/**
 * Which incident the radar is replaying.
 *
 * The choice lives in the URL rather than in client state, for three reasons that all matter
 * to this product. The answer is computed on the server from the graph, so a client-held
 * selection would mean fetching an answer the server could have rendered. A URL that names the
 * incident can be pasted into a submission, an issue, or a video description and it will show
 * the same thing. And the browser's back button then does what a reader expects, which a
 * segmented control holding its own state cannot offer.
 *
 * The chip moves the moment it is pressed, through `useOptimistic`, while the server recomputes
 * the answer behind it. That is a real reading of what is happening rather than a decorative
 * one: React reverts the chip by itself if the navigation fails, so the control can never end up
 * showing an incident the page is not displaying.
 */

export type IncidentChoice = {
  slug: string;
  /** The package or campaign the pack is about, taken from the slug so it stays short. */
  label: string;
  /**
   * The year, as the chip's secondary reading, or null for a slug that does not carry one.
   * Null renders a chip with no secondary line rather than an empty one, because a blank
   * reading beside three filled ones reads as a value that failed to load.
   */
  year: string | null;
};

export type IncidentPickerProps = {
  choices: readonly IncidentChoice[];
  selectedSlug: string;
  /** The search parameter the surface reads the selection from. */
  parameterName: string;
};

export function IncidentPicker({ choices, selectedSlug, parameterName }: IncidentPickerProps) {
  const router = useRouter();
  const [isNavigating, startNavigation] = useTransition();
  const [shownSlug, showSlug] = useOptimistic(selectedSlug);

  const options: SegmentedOption<string>[] = choices.map((choice) => ({
    value: choice.slug,
    label: choice.label,
    detail: choice.year ?? undefined,
  }));

  function select(nextSlug: string): void {
    if (nextSlug === selectedSlug) return;

    startNavigation(() => {
      showSlug(nextSlug);
      // Built through URLSearchParams rather than by string concatenation: a slug is our own
      // data, but a URL assembled by hand is how an unencoded value reaches router.push.
      // sourceRef: node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-router.md
      const query = new URLSearchParams({ [parameterName]: nextSlug });
      router.push(`/?${query.toString()}`, { scroll: false });
    });
  }

  return (
    <span aria-busy={isNavigating}>
      <SegmentedControl
        label="Incident to replay"
        options={options}
        value={shownSlug}
        onChange={select}
      />
    </span>
  );
}
