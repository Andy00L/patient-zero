import Link from "next/link";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@/components/ui/table";
import { DataValue, UnitSuffix } from "@/components/ui/text";
import { formatCount } from "@/lib/format";

import { buildLeaderboardHref, type RowCount } from "./leaderboard-query";
import type { LeaderboardRow } from "./leaderboard-rows";

/**
 * The ranking, as the parts it was ranked on.
 *
 * Every column here is either an identity or a term of the comparison the library made, in the
 * order it made it: services reached first, then weekly download volume, then the key for a
 * stable tie. sourceRef: compareSurfaces in src/lib/analysis/maintainer-surface.ts. There is
 * deliberately no combined score column, because a single number would have to be invented in
 * this file, and a ranking whose number cannot be traced to the thing it ranks is a claim rather
 * than evidence.
 *
 * The packages column is not a term of the comparison. It is the lever: it says how much an
 * attacker gets to publish with one stolen token, and two accounts with the same reach are not
 * the same problem when one of them publishes forty packages and the other one publishes one.
 *
 * A row opens the account below the table through its own link rather than through client state,
 * so the opened account is in the URL, the middle-click works, and this table stays on the
 * server with no bundle of its own. The open row carries no link: it already points here.
 *
 * Only hop-1 measurements appear in these columns. The modelled hop-2 numbers live in the panel
 * below, next to the assumption they rest on, because a modelled figure in a column of measured
 * ones is read as a measurement.
 */

export type LeaderboardTableProps = {
  /** The rows to show, already trimmed to the requested count by the caller. */
  rows: readonly LeaderboardRow[];
  /** The account opened below the table, so its row can be marked. */
  openAccountKey: string;
  /** The current row count, carried into every row link so opening an account keeps it. */
  rowCount: RowCount;
};

export function LeaderboardTable({ rows, openAccountKey, rowCount }: LeaderboardTableProps) {
  return (
    <Table caption="Publish accounts ranked by the services one compromised account would reach, worst first.">
      <TableHead>
        <TableHeaderCell isNumeric>#</TableHeaderCell>
        <TableHeaderCell>account</TableHeaderCell>
        <TableHeaderCell isNumeric>publishes</TableHeaderCell>
        <TableHeaderCell isNumeric>weekly downloads</TableHeaderCell>
        <TableHeaderCell isNumeric>services reached</TableHeaderCell>
        <TableHeaderCell>basis</TableHeaderCell>
      </TableHead>
      <TableBody>
        {rows.map((row) => {
          const subject = row.surface.subject;
          const isOpen = subject.maintainerKey === openAccountKey;

          return (
            <TableRow key={subject.maintainerKey} isActive={isOpen}>
              <TableCell isNumeric>
                <DataValue muted>{row.rank}</DataValue>
              </TableCell>

              <TableCell>
                {isOpen ? (
                  <AccountName username={subject.username} ecosystem={subject.ecosystem} />
                ) : (
                  <Link
                    href={buildLeaderboardHref({ rowCount, accountKey: subject.maintainerKey })}
                    scroll={false}
                    className="inline-flex"
                  >
                    <AccountName username={subject.username} ecosystem={subject.ecosystem} />
                  </Link>
                )}
              </TableCell>

              <TableCell isNumeric>
                <DataValue>{formatCount(row.surface.direct.packages.length)}</DataValue>
              </TableCell>

              <TableCell isNumeric>
                <span className="inline-flex items-baseline gap-1">
                  <DataValue muted={!row.isDownloadSumKnown}>{row.downloadReading}</DataValue>
                  {/* A sum over some of the account's packages is still a sum, and saying so in
                      the cell keeps it from being read as a total. */}
                  {row.isDownloadSumPartial ? <UnitSuffix>partial</UnitSuffix> : null}
                </span>
              </TableCell>

              <TableCell isNumeric>
                <DataValue muted={!row.isServiceReachKnown}>{row.serviceReading}</DataValue>
              </TableCell>

              <TableCell>
                {/* The reading, not a chip. A tinted pill on every row of a hundred-row table
                    turns a per-row fact into wallpaper. */}
                <span className="text-small text-ink-faint">{row.basisReading}</span>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** The account, in the data face, with its registry as the qualifier rather than as a chip. */
function AccountName({ username, ecosystem }: { username: string; ecosystem: string }) {
  return (
    <span className="inline-flex items-baseline gap-2">
      <DataValue>{username}</DataValue>
      <UnitSuffix>{ecosystem}</UnitSuffix>
    </span>
  );
}
