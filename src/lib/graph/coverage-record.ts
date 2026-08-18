import { type GraphGateway, readGraphCounts } from "@/lib/graph/gateway";
import {
  DEFAULT_SLICE_MANIFEST_PATH,
  SLICE_MANIFEST_VERSION,
  type SliceManifest,
  buildEmptySliceManifest,
  loadSliceManifest,
  mergeSliceCoverage,
  saveSliceManifest,
} from "@/lib/graph/slice-manifest";
import type { Failure } from "@/lib/result";

/**
 * Writing the coverage record for a graph that more than one run wrote into.
 *
 * A snapshot needs none of this: the manifest travels inside the file it describes, so the two
 * cannot be separated. A live engine is the opposite. Two scripts push into it, the registry
 * ingest and the incident seed, and each one knows only its own half: the ingest observes no
 * service at all, and the seed observes no closure over the registry. Whichever ran last used to
 * overwrite the record with its half, so the file described a graph that did not exist, and
 * `/api/status` published a service count of zero beside thirty real services.
 *
 * Two rules make the record describe the engine instead:
 *
 *   1. The counts are read back from the graph, not summed. Neither script can compute the
 *      union, because the two halves overlap on every package a pack names and the ingest also
 *      harvested. sourceRef: src/lib/graph/gateway.ts readGraphCounts.
 *   2. The coverage claims are merged by the weaker-wins rule rather than replaced, so a claim
 *      one run makes and the other never heard of survives, and a subject both describe keeps
 *      the weaker claim. sourceRef: src/lib/graph/slice-manifest.ts mergeSliceCoverage.
 *
 * The loader reads the counts live as well, so a record that goes stale between a write and a
 * page load cannot misreport a size. What only this file can keep true is the coverage half,
 * which is what decides whether an empty traversal is allowed to read as `not_exposed`.
 * sourceRef: src/lib/graph/load-graph.ts openHydra.
 */

/** What became of the record. `failure` is non-null exactly when the graph has no record. */
export type CoverageRecord = {
  /** One line for a run summary, naming the file when there is one. */
  location: string;
  failure: Failure | null;
};

/**
 * Reads a live graph back and writes the record of what it now holds.
 *
 * Called with the transport still open, between the flush and the close, because the counts are
 * a question for the engine and the engine is about to be unreachable.
 *
 * Never fails the run that called it. The nodes and edges are already in the graph, and
 * reporting the write as failed would send a reader looking for something that did happen. The
 * caller reports `failure` through its own exit code instead.
 */
export async function recordLiveGraphCoverage(
  gateway: GraphGateway,
  written: SliceManifest,
  path: string = DEFAULT_SLICE_MANIFEST_PATH,
): Promise<CoverageRecord> {
  const observed = await readGraphCounts(gateway);
  if (!observed.ok) {
    return {
      location: `not written, the graph could not be counted back: ${observed.failure.message}`,
      failure: observed.failure,
    };
  }

  const recorded = await loadSliceManifest(path);
  // A missing file is the ordinary first-run case, so the merge falls back to a record that
  // claims nothing. Any other read failure is refused: a file that exists but cannot be parsed
  // still holds the other run's claims, and overwriting it would delete them.
  if (!recorded.ok && recorded.failure.reason !== "not_found") {
    return {
      location: `not written, ${path} could not be read: ${recorded.failure.message}`,
      failure: recorded.failure,
    };
  }
  const previous = recorded.ok ? recorded.value : buildEmptySliceManifest(written.generatedAtMs);

  const merged: SliceManifest = {
    version: SLICE_MANIFEST_VERSION,
    generatedAtMs: written.generatedAtMs,
    ...mergeSliceCoverage(previous, written),
    counts: observed.value,
    notes: mergeNotes(previous, written),
  };

  const saved = await saveSliceManifest(merged, path);
  if (!saved.ok) return { location: `not written, ${saved.failure.message}`, failure: saved.failure };

  return { location: `${recorded.ok ? "merged into" : "written to"} ${path}`, failure: null };
}

/**
 * The disclosures of both runs, this run's last, plus the one this file has to add itself.
 *
 * Kept rather than replaced for the same reason the claims are: a note is a disclosure about
 * data that is still in the graph, and a run that dropped the other run's notes would leave the
 * record quieter than the graph deserves. The empty-graph placeholder is the one exception,
 * because the graph it describes has since been written to.
 */
function mergeNotes(previous: SliceManifest, written: SliceManifest): string[] {
  const placeholder = buildEmptySliceManifest(previous.generatedAtMs).notes;
  const kept = previous.notes.filter(
    (note) => !written.notes.includes(note) && !placeholder.includes(note),
  );

  return [
    ...kept,
    ...written.notes,
    "Counts in this record were read back from the graph, so they describe every run that has " +
      "written to it rather than the run that wrote this file.",
  ];
}
