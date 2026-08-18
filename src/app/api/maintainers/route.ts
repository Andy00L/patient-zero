/**
 * GET /api/maintainers
 *
 * The single-point-of-failure leaderboard: which publish accounts reach the most, ranked.
 *
 * Query contract:
 *   limit   optional  1 to 100 rows, default 10. Pagination over an already ranked list.
 *
 * The ranking module takes the maintainer keys to rank, so this route enumerates them from the
 * graph first. It counts the Maintainer nodes before listing them, which makes the enumeration
 * exact: when fewer accounts are examined than exist, the shortfall is reported as a
 * `scan_capped` limit with both real numbers instead of a guess.
 *
 * Hop-2 numbers are modelled, not measured, and the assumption behind them travels with every
 * row. It is repeated at the top level so a client rendering a header has it even when the
 * leaderboard came back with no rows at all.
 */

import { z } from "zod";

import { digitsInRange, jsonFailure, jsonOk, parseQuery, runRoute } from "@/lib/api/http";
import { type AnswerLimit, buildUnknownAnswer } from "@/lib/analysis/abstention";
import {
  HOP_TWO_ASSUMPTION,
  type MaintainerLeaderboard,
  rankMaintainerSurfaces,
} from "@/lib/analysis/maintainer-surface";
import { isGraphEmpty, readStringProperty } from "@/lib/graph/gateway";
import { loadGraph } from "@/lib/graph/load-graph";
import { SELECTOR_PROPERTY } from "@/lib/graph/model";

const ROUTE_NAME = "GET /api/maintainers";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

/**
 * Ceiling on accounts enumerated in one request. The committed slice holds a hundred or so, and
 * the ranking pass is batched, so this exists to bound a graph nobody has ingested yet rather
 * than to trim the answer.
 */
const MAX_MAINTAINERS_SCANNED = 5_000;

const QUERY_SCHEMA = z.object({
  limit: digitsInRange(1, MAX_LIMIT).optional(),
});

const EMPTY_LEADERBOARD: MaintainerLeaderboard = {
  rows: [],
  maintainersRequested: 0,
  unrankedMaintainerKeys: [],
  servicesConsidered: 0,
  isSliceLowerBound: true,
};

export async function GET(request: Request): Promise<Response> {
  return runRoute(ROUTE_NAME, async () => {
    const query = parseQuery(request, QUERY_SCHEMA, ROUTE_NAME);
    if (!query.ok) return jsonFailure(query.failure);

    const limit = query.value.limit ?? DEFAULT_LIMIT;

    const loaded = await loadGraph();
    if (!loaded.ok) return jsonFailure(loaded.failure);

    const { gateway, coverage, source } = loaded.value;

    const total = await gateway.countNodes("Maintainer");
    if (!total.ok) return jsonFailure(total.failure);

    if (total.value === 0) {
      const empty = await isGraphEmpty(gateway);
      if (!empty.ok) return jsonFailure(empty.failure);

      // No account can be ranked, and that is an answer, not an empty leaderboard. The two
      // reasons are worth telling apart: nothing ingested at all, or an ingest that carried no
      // MAINTAINS edges.
      const limits: AnswerLimit[] = empty.value ? [{ kind: "empty_graph" }] : [];
      const rationale = empty.value
        ? "The graph is empty, so no publish account can be ranked yet. Run an ingest first."
        : "The slice holds no maintainer accounts, so no publish account can be ranked. The ingest that produced it carried no MAINTAINS edges.";

      return jsonOk({
        query: { limit },
        source,
        answer: buildUnknownAnswer(rationale, EMPTY_LEADERBOARD, limits),
        pagination: { limit, returnedRows: 0, rankedRows: 0 },
        enumeration: { maintainersInGraph: 0, maintainersExamined: 0, capped: false },
        routeLimits: [],
        assumption: HOP_TWO_ASSUMPTION,
      });
    }

    const nodeIds = await gateway.listNodeIds({
      label: "Maintainer",
      limit: Math.min(total.value, MAX_MAINTAINERS_SCANNED),
    });
    if (!nodeIds.ok) return jsonFailure(nodeIds.failure);

    const nodes = await gateway.readNodes({ nodeIds: nodeIds.value, label: "Maintainer" });
    if (!nodes.ok) return jsonFailure(nodes.failure);

    const maintainerKeys: string[] = [];
    for (const node of nodes.value) {
      const key = readStringProperty(node.properties, SELECTOR_PROPERTY);
      if (key !== null) maintainerKeys.push(key);
    }

    if (maintainerKeys.length === 0) {
      return jsonOk({
        query: { limit },
        source,
        answer: buildUnknownAnswer(
          `The slice reports ${total.value} maintainer accounts but none of them carries a readable key, so nothing can be ranked.`,
          EMPTY_LEADERBOARD,
          [{ kind: "scan_capped", examined: 0, total: total.value }],
        ),
        pagination: { limit, returnedRows: 0, rankedRows: 0 },
        enumeration: {
          maintainersInGraph: total.value,
          maintainersExamined: 0,
          capped: true,
        },
        routeLimits: [],
        assumption: HOP_TWO_ASSUMPTION,
      });
    }

    const ranked = await rankMaintainerSurfaces({ gateway, coverage, maintainerKeys });
    if (!ranked.ok) return jsonFailure(ranked.failure);

    const answer = ranked.value;
    const rows = answer.evidence.rows.slice(0, limit);

    // The limit this route introduced, kept separate so `answer.limits` stays exactly what the
    // ranking module produced. It only appears when the enumeration really did fall short.
    const routeLimits: AnswerLimit[] =
      maintainerKeys.length < total.value
        ? [{ kind: "scan_capped", examined: maintainerKeys.length, total: total.value }]
        : [];

    return jsonOk({
      query: { limit },
      source,
      answer: { ...answer, evidence: { ...answer.evidence, rows } },
      // Trimming to `limit` is pagination over a ranked list, not a truncated search, so it is
      // reported here rather than as a limit on the answer.
      pagination: { limit, returnedRows: rows.length, rankedRows: answer.evidence.rows.length },
      enumeration: {
        maintainersInGraph: total.value,
        maintainersExamined: maintainerKeys.length,
        capped: maintainerKeys.length < total.value,
      },
      routeLimits,
      assumption: HOP_TWO_ASSUMPTION,
    });
  });
}
