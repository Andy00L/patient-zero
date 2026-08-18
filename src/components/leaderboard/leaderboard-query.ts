/**
 * The /maintainers URL contract.
 *
 * Two things about this surface belong in the URL rather than in client state. How many ranked
 * accounts the table shows, because a reader who wants the whole board should be able to send
 * the whole board to someone else. And which account is opened below the table, because that
 * choice is the finding: "this account reaches eight services" is the claim worth pasting into
 * an issue, and a claim that only exists in someone's browser cannot be checked.
 *
 * Both are read on the server, so the ranking, the readings and the opened account are decided
 * in one render and cannot disagree with each other.
 *
 * Every reader here refuses an unusable value instead of trusting it. `rows=9999` and
 * `rows=drop` both fall back to the default, and an account key that names no ranked row is
 * resolved against the rows by the caller, which is why nothing from the URL is ever
 * interpolated into a link: the hrefs this module builds carry keys that came out of the graph.
 * sourceRef: node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-router.md.
 */

/** The path this surface lives at. Used to build its own links. */
export const MAINTAINERS_PATH = "/maintainers";

/** How many ranked accounts the table shows. */
export const ROW_COUNT_PARAMETER = "rows";

/** Which account is opened below the table, as `ecosystem:username`. */
export const ACCOUNT_PARAMETER = "account";

/**
 * The row counts on offer.
 *
 * Ten is the default because the question is "whose account is the worst one to lose", and the
 * answer to that is at the top. A hundred is the ceiling the API route publishes for the same
 * ranking (MAX_LIMIT in src/app/api/maintainers/route.ts), so the surface and the route agree
 * on what a caller may ask for.
 */
export const ROW_COUNT_CHOICES = [10, 25, 100] as const;

export type RowCount = (typeof ROW_COUNT_CHOICES)[number];

export const DEFAULT_ROW_COUNT: RowCount = 10;

export type LeaderboardQuery = {
  rowCount: RowCount;
  /**
   * The account to open, or null to open the worst-ranked one. Null rather than a hardcoded
   * key: which account is worst is a result of the ranking, and this module never guesses it.
   */
  accountKey: string | null;
};

/** Reads the row count out of a parameter that can arrive repeated, absent, or unusable. */
export function readRowCount(raw: string | string[] | undefined): RowCount {
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (first === undefined) return DEFAULT_ROW_COUNT;

  const requested = Number(first);
  // Compared against the offered set rather than clamped: a clamp would answer `rows=11` with
  // ten rows and a URL that says eleven, and the chip would then disagree with the table.
  return ROW_COUNT_CHOICES.find((choice) => choice === requested) ?? DEFAULT_ROW_COUNT;
}

/** Reads the requested account key. An empty value is absent, not a key that matches nothing. */
export function readAccountKey(raw: string | string[] | undefined): string | null {
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (first === undefined) return null;

  const trimmed = first.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * The href for a state of this surface.
 *
 * Built through URLSearchParams rather than by concatenation, so a username with a character
 * that means something in a query string cannot break the link it appears in.
 */
export function buildLeaderboardHref(query: LeaderboardQuery): string {
  const search = new URLSearchParams({ [ROW_COUNT_PARAMETER]: String(query.rowCount) });
  // The opened account is omitted when it is the default, so the link a reader copies from an
  // untouched surface is the shortest one that reproduces what they are looking at.
  if (query.accountKey !== null) search.set(ACCOUNT_PARAMETER, query.accountKey);
  return `${MAINTAINERS_PATH}?${search.toString()}`;
}

export type RowCountChoice = {
  rowCount: RowCount;
  /** What the chip says: "Top 25", or "All 30" for a choice that covers the whole ranking. */
  label: string;
};

/**
 * The row counts worth offering for a ranking of this size.
 *
 * A chip that shows the same table as the chip beside it is a control that does nothing, so a
 * choice is offered only while it actually trims the board, plus the one choice that covers all
 * of it. A ranking of eight accounts therefore produces a single choice, and the caller renders
 * no control at all rather than a group of one.
 */
export function describeRowCountChoices(rankedRows: number): RowCountChoice[] {
  const choices: RowCountChoice[] = [];
  for (const rowCount of ROW_COUNT_CHOICES) {
    if (rowCount < rankedRows) {
      choices.push({ rowCount, label: `Top ${rowCount}` });
      continue;
    }
    // The first choice that reaches the end of the ranking is the last one worth offering, and
    // it says so with the real count rather than with a ceiling the board never touches.
    choices.push({ rowCount, label: `All ${rankedRows}` });
    return choices;
  }
  return choices;
}

/**
 * Which of the offered choices a requested count resolves to.
 *
 * A count that is not on offer falls to the widest one rather than to the default: the reader
 * asked for more rows than this board can fill, and showing them the whole board answers that.
 */
export function selectRowCount(
  choices: readonly RowCountChoice[],
  requested: RowCount,
): RowCount {
  const exact = choices.find((choice) => choice.rowCount === requested);
  if (exact !== undefined) return exact.rowCount;
  return choices[choices.length - 1]?.rowCount ?? DEFAULT_ROW_COUNT;
}
