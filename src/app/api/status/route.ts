/**
 * GET /api/status
 *
 * The status rail: which graph answered, how much is in it, and what the slice claims to
 * cover. No query parameters.
 *
 * This route never fails hard. A degraded status is still a status, so a graph that could not
 * be loaded comes back as 200 with `available: false` and the reason, not as a 503 the UI has
 * to special-case before it can render anything at all.
 *
 * Counts are `number | null`, and null means the count could not be read. Reporting a failed
 * count as 0 would be the exact mistake the whole abstention model exists to prevent: an empty
 * graph and an unreadable one are different facts.
 */

import { jsonOk, redactForClient, runRoute } from "@/lib/api/http";
import { loadGraph } from "@/lib/graph/load-graph";
import { NODE_LABELS, type NodeLabel } from "@/lib/graph/model";

const ROUTE_NAME = "GET /api/status";

export async function GET(): Promise<Response> {
  return runRoute(ROUTE_NAME, async () => {
    const loaded = await loadGraph();
    if (!loaded.ok) {
      return jsonOk({
        available: false,
        degraded: true,
        source: null,
        graph: null,
        slice: null,
        unavailable: {
          reason: loaded.failure.reason,
          message: redactForClient(loaded.failure.message),
        },
      });
    }

    const { gateway, coverage, manifest, source } = loaded.value;

    // All five counts in one pass. Each is its own read on a live graph, so they go out
    // together rather than one after another.
    const counted = await Promise.all(
      Object.values(NODE_LABELS).map(async (label) => ({
        label,
        count: await gateway.countNodes(label),
      })),
    );

    const nodeCounts: Record<NodeLabel, number | null> = {
      Package: null,
      Version: null,
      Maintainer: null,
      Service: null,
      Advisory: null,
    };
    const unreadableLabels: NodeLabel[] = [];
    for (const { label, count } of counted) {
      if (count.ok) nodeCounts[label] = count.value;
      else unreadableLabels.push(label);
    }

    // Emptiness is the Version count, which was just read: a second countNodes call would ask
    // the same question twice. Null when that count failed, because "unreadable" is not "empty".
    const versionCount = nodeCounts.Version;
    const isEmpty = versionCount === null ? null : versionCount === 0;

    return jsonOk({
      available: true,
      degraded: unreadableLabels.length > 0 || source.degradedReason !== null,
      source: {
        kind: source.kind,
        detail: source.detail,
        generatedAtMs: source.generatedAtMs,
        degradedReason: source.degradedReason,
      },
      graph: {
        isEmpty,
        nodeCounts,
        unreadableLabels,
      },
      slice: {
        version: manifest.version,
        // When the ingest that produced this coverage claim ran.
        generatedAtMs: manifest.generatedAtMs,
        ecosystems: manifest.ecosystems,
        counts: manifest.counts,
        closedPackageCount: manifest.closedPackageKeys.length,
        partialPackageCount: manifest.partialPackageKeys.length,
        closedServiceCount: manifest.closedServiceKeys.length,
        // True when the manifest itself claims no versions were ingested.
        claimsEmpty: coverage.isEmpty,
        notes: manifest.notes,
      },
      unavailable: null,
    });
  });
}
