import type { TyposquatConfidence } from "@/lib/analysis/typosquat";

/**
 * The /typosquats URL contract.
 *
 * One thing on this surface belongs in the URL: how weak a pair's evidence may be and still be
 * listed. The detector labels every pair high, medium or low from which signals fired, and those
 * three tiers are not degrees of the same claim. A low pair is two names that are two edits apart
 * with no download figure to separate them, which describes a great many legitimate siblings; a
 * high pair is a strong spelling collision with a confirmed popularity gap. A reader who wants to
 * see the weak tier should be able to hand that view to someone else, and a reader who does not
 * should not have to scroll past it.
 *
 * The floor is read on the server, so the two lists and the counts beside them are decided in one
 * render and cannot disagree.
 *
 * The parameter is always written into the link, including for the default floor. The default is
 * derived from the slice (the strongest tier that actually holds a pair), so it moves when the
 * slice is re-ingested, and a link that omitted it would quietly show a different list later.
 */

/** The path this surface lives at. Used to build its own links. */
export const TYPOSQUATS_PATH = "/typosquats";

/** The weakest confidence tier the lists include. */
export const CONFIDENCE_PARAMETER = "confidence";

/**
 * The tiers, strongest first. This order is the detector's own ranking, not a new one.
 * sourceRef: CONFIDENCE_RANK in src/lib/analysis/typosquat.ts.
 */
export const CONFIDENCE_FLOORS: readonly TyposquatConfidence[] = ["high", "medium", "low"];

/** How many pairs carry each tier. Absent tiers are 0, never missing. */
export type ConfidenceCounts = Record<TyposquatConfidence, number>;

/**
 * Reads the requested floor, or null when the URL carries none this surface offers.
 *
 * Null rather than a constant default: which floor is the default depends on what the slice
 * holds, so the choice is made by `selectFloor` against the offered set and never guessed here.
 */
export function readRequestedFloor(raw: string | string[] | undefined): TyposquatConfidence | null {
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (first === undefined) return null;

  const requested = first.trim().toLowerCase();
  return CONFIDENCE_FLOORS.find((floor) => floor === requested) ?? null;
}

/**
 * The href for a state of this surface.
 *
 * Built through URLSearchParams rather than by concatenation. The floor is one of three literals
 * from this module, but a link assembled by hand is how an unencoded value reaches router.push.
 * sourceRef: node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-router.md.
 */
export function buildTyposquatHref(floor: TyposquatConfidence): string {
  const search = new URLSearchParams({ [CONFIDENCE_PARAMETER]: floor });
  return `${TYPOSQUATS_PATH}?${search.toString()}`;
}

export type FloorChoice = {
  floor: TyposquatConfidence;
  /** The tier's own word, so the chip and the label on every row read alike. */
  label: string;
  /** How many pairs this floor lists, which is the tier and everything above it. */
  pairCount: number;
};

/**
 * The floors worth offering for the pairs this slice produced.
 *
 * A floor is offered only when it changes the list. A tier that holds nothing would show the
 * same rows as the tier above it, and a chip that shows the same rows as the chip beside it is a
 * control that does nothing. On a slice where the detector reaches only one tier, this returns a
 * single choice and the caller renders no control at all rather than a group of one.
 */
export function describeFloorChoices(counts: ConfidenceCounts): FloorChoice[] {
  const choices: FloorChoice[] = [];
  let listed = 0;

  for (const floor of CONFIDENCE_FLOORS) {
    listed += counts[floor];
    if (listed === 0) continue;
    // Equal to the previous choice means this tier is empty: same rows, different word.
    if (choices[choices.length - 1]?.pairCount === listed) continue;
    choices.push({ floor, label: floor, pairCount: listed });
  }

  return choices;
}

/**
 * Which of the offered floors a request resolves to.
 *
 * An absent or unusable request opens on the strongest offered floor, which is the shortest
 * honest list: every pair it hides is one the detector itself labelled weaker. A floor that is
 * not on offer resolves the same way rather than to an empty list.
 */
export function selectFloor(
  choices: readonly FloorChoice[],
  requested: TyposquatConfidence | null,
): TyposquatConfidence {
  const exact = choices.find((choice) => choice.floor === requested);
  if (exact !== undefined) return exact.floor;
  // No choices means no pair was found at all, so no list is rendered and the floor is never
  // read. The strongest tier is returned rather than the weakest, so a caller that does render
  // something shows the shortest list rather than the longest one.
  return choices[0]?.floor ?? "high";
}
