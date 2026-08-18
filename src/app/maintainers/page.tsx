import { QueryProvenance } from "@/components/app/query-provenance";
import { Surface, SurfaceHead } from "@/components/app/surface";
import { AccountReach } from "@/components/leaderboard/account-reach";
import {
  ACCOUNT_PARAMETER,
  describeRowCountChoices,
  readAccountKey,
  readRowCount,
  ROW_COUNT_PARAMETER,
  selectRowCount,
} from "@/components/leaderboard/leaderboard-query";
import { describeLeaderboardRows, selectRow } from "@/components/leaderboard/leaderboard-rows";
import { LeaderboardTable } from "@/components/leaderboard/leaderboard-table";
import { RowCountPicker } from "@/components/leaderboard/row-count-picker";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import { AbstainNotice, EmptyState } from "@/components/ui/state";
import { DataValue, FieldLabel, UnitSuffix } from "@/components/ui/text";
import { type AnswerLimit, describeLimit } from "@/lib/analysis/abstention";
import {
  type MaintainerLeaderboard,
  rankMaintainerSurfaces,
} from "@/lib/analysis/maintainer-surface";
import { formatCount } from "@/lib/format";
import { type GraphGateway, isGraphEmpty, readStringProperty } from "@/lib/graph/gateway";
import { SELECTOR_PROPERTY } from "@/lib/graph/model";
import { requestGraph } from "@/lib/graph/request-graph";
import type { SliceCoverage } from "@/lib/graph/slice-manifest";
import { withStatementLog } from "@/lib/graph/statements";
import { type Failure, type Result, succeed } from "@/lib/result";

/**
 * The maintainer surface: which publish account is the worst one to lose.
 *
 * This is the surface that makes the tool a radar instead of a post-mortem. Every other surface
 * answers a question about something that already happened; this one ranks the accounts that
 * have not been compromised yet, by how much of the estate a single stolen npm token would
 * reach. The ranking is worst first, and the number it ranks on is decomposed into the terms it
 * was built from, because a leaderboard whose number cannot be taken apart is a claim rather
 * than evidence.
 *
 * Every figure on the surface comes from `rankMaintainerSurfaces`. Nothing is scored, summed, or
 * re-sorted here: this file enumerates the accounts to rank, hands them to the library, and
 * renders what comes back. The two decisions the view does make are stated where they are made,
 * and both are about refusing to print a number the coverage does not support.
 *
 * The account keys are enumerated exactly the way the JSON route does it, count first, so a
 * shortfall between what exists and what was examined is reported with both real numbers rather
 * than guessed at. sourceRef: src/app/api/maintainers/route.ts.
 */

const QUESTION = "If one publish account fell tomorrow, whose would reach the furthest?";

const LEDE =
  "Every account in the slice is ranked by the services one compromised publish token would reach, then by the download volume behind it. The reach is measured from the slice's own publish, dependency and lockfile edges; the two-hop worm figures in the opened account are a stated model rather than a measurement.";

/**
 * Ceiling on accounts enumerated in one render.
 *
 * The same ceiling the JSON route publishes, for the same reason: the ranking pass is batched,
 * so this bounds a graph nobody has ingested yet rather than trimming the answer.
 * sourceRef: MAX_MAINTAINERS_SCANNED in src/app/api/maintainers/route.ts.
 */
const MAX_MAINTAINERS_SCANNED = 5_000;

/**
 * What answering this surface produced.
 *
 * Three outcomes rather than one, because "no account could be ranked" has two different causes
 * and neither of them is an error: a graph that holds nothing, and an ingest that carried no
 * publish rights. Telling them apart is the difference between "run an ingest" and "this ingest
 * has a gap", and a reader can act on exactly one of those.
 */
type LeaderboardOutcome =
  | { kind: "no_accounts"; graphIsEmpty: boolean }
  | { kind: "no_readable_key"; maintainersInGraph: number }
  | {
      kind: "ranked";
      leaderboard: MaintainerLeaderboard;
      rationale: string;
      limits: readonly AnswerLimit[];
      verdictIsUnknown: boolean;
      maintainersInGraph: number;
      maintainersExamined: number;
    };

/**
 * Enumerates the publish accounts and ranks them.
 *
 * Returns a Failure only when the graph itself could not be read. Every other shortfall is an
 * outcome the surface renders, which is what keeps an unreadable slice from looking like a clean
 * one.
 */
async function answerLeaderboard(
  gateway: GraphGateway,
  coverage: SliceCoverage,
): Promise<Result<LeaderboardOutcome, Failure>> {
  const total = await gateway.countNodes("Maintainer");
  if (!total.ok) return total;

  if (total.value === 0) {
    const empty = await isGraphEmpty(gateway);
    if (!empty.ok) return empty;
    return succeed({ kind: "no_accounts", graphIsEmpty: empty.value });
  }

  const nodeIds = await gateway.listNodeIds({
    label: "Maintainer",
    limit: Math.min(total.value, MAX_MAINTAINERS_SCANNED),
  });
  if (!nodeIds.ok) return nodeIds;

  const nodes = await gateway.readNodes({ nodeIds: nodeIds.value, label: "Maintainer" });
  if (!nodes.ok) return nodes;

  const maintainerKeys: string[] = [];
  for (const node of nodes.value) {
    const key = readStringProperty(node.properties, SELECTOR_PROPERTY);
    if (key !== null) maintainerKeys.push(key);
  }

  if (maintainerKeys.length === 0) {
    return succeed({ kind: "no_readable_key", maintainersInGraph: total.value });
  }

  const ranked = await rankMaintainerSurfaces({ gateway, coverage, maintainerKeys });
  if (!ranked.ok) return ranked;

  // The enumeration shortfall is the surface's own limit, kept apart from the ranking's so
  // `limits` stays exactly what the library reported.
  const limits: AnswerLimit[] =
    maintainerKeys.length < total.value
      ? [
          ...ranked.value.limits,
          { kind: "scan_capped", examined: maintainerKeys.length, total: total.value },
        ]
      : [...ranked.value.limits];

  return succeed({
    kind: "ranked",
    leaderboard: ranked.value.evidence,
    rationale: ranked.value.rationale,
    limits,
    verdictIsUnknown: ranked.value.verdict === "unknown",
    maintainersInGraph: total.value,
    maintainersExamined: maintainerKeys.length,
  });
}

export default async function MaintainersPage({ searchParams }: PageProps<"/maintainers">) {
  const params = await searchParams;
  const requestedRowCount = readRowCount(params[ROW_COUNT_PARAMETER]);
  const requestedAccountKey = readAccountKey(params[ACCOUNT_PARAMETER]);

  const graph = await requestGraph();
  if (!graph.ok) {
    return (
      <Surface>
        <SurfaceHead
          question={QUESTION}
          lede="The graph could not be read, so no account can be ranked and none is shown."
        />
        <EmptyState title="The graph could not be read">
          The ranking is a traversal of the ingested slice, and the slice could not be opened. An
          empty leaderboard is not the same claim as an estate with no single point of failure, so
          nothing is ranked rather than nothing being at risk. The loader reported:{" "}
          {graph.failure.message}
        </EmptyState>
      </Surface>
    );
  }

  const answered = await withStatementLog(() =>
    answerLeaderboard(graph.value.gateway, graph.value.coverage),
  );

  if (!answered.value.ok) {
    return (
      <Surface>
        <SurfaceHead question={QUESTION} lede={LEDE} />
        <EmptyState title="The accounts could not be ranked">
          The graph was readable but the ranking pass did not finish, so no account is placed
          rather than a partial board being presented as the worst cases. The ranking reported:{" "}
          {answered.value.failure.message}
        </EmptyState>
        <QueryProvenance record={answered.record} />
      </Surface>
    );
  }

  const outcome = answered.value.value;

  if (outcome.kind === "no_accounts") {
    return (
      <Surface>
        <SurfaceHead question={QUESTION} lede={LEDE} />
        <AbstainNotice
          rationale={
            outcome.graphIsEmpty
              ? "The graph is empty, so no publish account can be ranked yet. Run an ingest first."
              : "The slice holds no publish accounts, so nothing can be ranked. The ingest that produced it carried no MAINTAINS edges, which is a gap in the data rather than an estate with no single point of failure."
          }
          // No limit kind describes an ingest that carried no publish rights, and the
          // rationale above states it in full, so nothing is invented to fill the list.
          limits={outcome.graphIsEmpty ? [describeLimit({ kind: "empty_graph" })] : []}
        />
        <QueryProvenance record={answered.record} />
      </Surface>
    );
  }

  if (outcome.kind === "no_readable_key") {
    return (
      <Surface>
        <SurfaceHead question={QUESTION} lede={LEDE} />
        <AbstainNotice
          rationale={`The slice reports ${formatCount(outcome.maintainersInGraph)} publish accounts and none of them carries a readable key, so none of them can be ranked.`}
          limits={[
            describeLimit({ kind: "scan_capped", examined: 0, total: outcome.maintainersInGraph }),
          ]}
        />
        <QueryProvenance record={answered.record} />
      </Surface>
    );
  }

  const leaderboard = outcome.leaderboard;
  const rows = describeLeaderboardRows({
    rows: leaderboard.rows,
    coverage: graph.value.coverage,
  });

  const choices = describeRowCountChoices(rows.length);
  const rowCount = selectRowCount(choices, requestedRowCount);
  const shownRows = rows.slice(0, rowCount);
  // Selected from the whole ranking rather than from the visible slice, so a shared link to
  // account number forty still opens account number forty when the table is showing ten rows.
  // The panel's own header prints its rank, which is what tells a reader it is off the table.
  const openRow = selectRow(rows, requestedAccountKey);
  const limits = outcome.limits.map(describeLimit);

  return (
    <Surface>
      <SurfaceHead
        question={QUESTION}
        lede={LEDE}
        controls={
          // One chip is not a choice, so a board that fits in the smallest offered count
          // renders no control at all rather than a group of one.
          choices.length > 1 ? (
            <RowCountPicker
              choices={choices}
              selected={rowCount}
              accountKey={openRow === null ? null : openRow.surface.subject.maintainerKey}
            />
          ) : undefined
        }
      />

      <Panel>
        <PanelHeader
          eyebrow="ranking"
          title="Publish accounts by reach"
          aside={
            <span className="flex items-baseline gap-1">
              <DataValue>{formatCount(shownRows.length)}</DataValue>
              <UnitSuffix>of {formatCount(rows.length)} ranked</UnitSuffix>
            </span>
          }
        />

        {/* The qualification sits above the table, not below it. A reader who has already read
            the numbers has already formed the belief the caveat was supposed to qualify. */}
        <PanelBody className="flex flex-col gap-3">
          {outcome.verdictIsUnknown ? (
            <AbstainNotice rationale={outcome.rationale} limits={limits} />
          ) : (
            <>
              <p className="max-w-prose text-small text-ink">{outcome.rationale}</p>
              {limits.length === 0 ? null : (
                <div className="flex flex-col gap-1">
                  <FieldLabel>What this ranking does not cover</FieldLabel>
                  <ul className="flex list-none flex-col gap-1">
                    {limits.map((limit) => (
                      <li key={limit} className="max-w-prose text-small text-ink-muted">
                        {limit}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </PanelBody>

        {openRow === null ? (
          <EmptyState title="No account holds a rank in this slice">
            Publish accounts were enumerated and none of them holds a package the slice ingested,
            so there is nothing to rank. That is a statement about this ingest and not about the
            registry.
          </EmptyState>
        ) : (
          <LeaderboardTable
            rows={shownRows}
            openAccountKey={openRow.surface.subject.maintainerKey}
            rowCount={rowCount}
          />
        )}

        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 border-t border-edge px-4 py-3">
          <span className="flex items-baseline gap-1">
            <DataValue muted>{formatCount(outcome.maintainersExamined)}</DataValue>
            <UnitSuffix>
              of {formatCount(outcome.maintainersInGraph)} accounts examined
            </UnitSuffix>
          </span>
          <span className="flex items-baseline gap-1">
            <DataValue muted>{formatCount(leaderboard.servicesConsidered)}</DataValue>
            <UnitSuffix>services examined for reach</UnitSuffix>
          </span>
          {leaderboard.unrankedMaintainerKeys.length > 0 ? (
            <span className="flex items-baseline gap-1">
              <DataValue muted>
                {formatCount(leaderboard.unrankedMaintainerKeys.length)}
              </DataValue>
              <UnitSuffix>accounts hold no ingested package, so they hold no rank</UnitSuffix>
            </span>
          ) : null}
        </div>
      </Panel>

      {openRow === null ? null : (
        <AccountReach
          row={openRow}
          rankedRows={rows.length}
          servicesConsidered={leaderboard.servicesConsidered}
        />
      )}

      <QueryProvenance record={answered.record} />
    </Surface>
  );
}
