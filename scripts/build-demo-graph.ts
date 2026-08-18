/**
 * Builds the one graph the demo answers from, by merging the incident seed snapshot with the
 * registry ingest snapshot.
 *
 * Usage:
 *   bun run graph:demo                                          the two default inputs
 *   bun run graph:demo -- --out data/graph/other.json            another destination
 *   bun run graph:demo -- --input a.json --input b.json          other inputs, in order
 *
 * WHY. Neither input can run the product on its own. `data/graph/snapshot.json` carries the
 * Service nodes and their RESOLVED lockfile edges, so it can answer "who pinned this while
 * the payload was live" and nothing about dependencies. `data/graph/slice-snapshot.json`
 * carries DEPENDS_ON, RESOLVES_TO and MAINTAINS, so it can answer blast radius and maintainer
 * surface and nothing about services. This script writes the union, unified on natural keys
 * so the package both files describe is one node that holds both halves of its edges.
 *
 * Input order matters. The first input wins every property conflict, and each conflict is
 * printed below with both values, because a graph that quietly picked one side would hide a
 * disagreement between two sources.
 *
 * Errors are values everywhere below. Only `runBuildDemoGraph` decides an exit code, and only
 * the last two lines of this file exit the process.
 */

import { mergeGraphSnapshots, type MergeReport } from "@/lib/graph/merge-snapshots";
import {
  buildGraphSnapshot,
  DEFAULT_GRAPH_SNAPSHOT_PATH,
  type GraphSnapshot,
  loadGraphSnapshot,
  writeGraphSnapshot,
} from "@/lib/graph/snapshot";
import { type Failure, type Result, succeed, fail } from "@/lib/result";

/** The merge ran and the snapshot was written with no disagreement between the inputs. */
const EXIT_MERGED = 0;

/** Nothing was written: bad arguments, an unreadable input, or a failed write. */
const EXIT_NOT_MERGED = 1;

/**
 * The snapshot was written, but the inputs disagreed about at least one property. Non-zero so
 * a run that silently kept one source's value over another's is visible in a terminal and in
 * CI, rather than only in the lines that scrolled past.
 */
const EXIT_MERGED_WITH_CONFLICTS = 2;

/** Which writer produced the merged snapshot, recorded in the file. Log safe: never a path. */
const SNAPSHOT_SOURCE = "build-demo-graph";

/** Where the merged demo graph lands by default. */
const DEFAULT_OUTPUT_PATH = "data/graph/demo-snapshot.json";

/**
 * The two halves of the demo, in the order they are merged. The incident seed comes first
 * because it is the curated file: its timestamps are sourced by hand in the incident packs,
 * so it is the side that should win a disagreement with the registry ingest.
 * sourceRef: scripts/seed-incidents.ts, scripts/ingest-slice.ts.
 */
const DEFAULT_INPUT_PATHS: readonly string[] = [
  DEFAULT_GRAPH_SNAPSHOT_PATH,
  "data/graph/slice-snapshot.json",
];

/** How many conflicts are printed in full before the rest are counted only. */
const MAX_PRINTED_CONFLICTS = 20;

const USAGE_LINE = "usage: bun run graph:demo [-- --out <path>] [-- --input <path> --input <path>]";

type BuildArguments = {
  outputPath: string;
  /** At least two paths, merged left to right. */
  inputPaths: readonly string[];
};

type LoadedInput = {
  path: string;
  snapshot: GraphSnapshot;
};

async function runBuildDemoGraph(argumentValues: readonly string[]): Promise<number> {
  const parsed = parseArguments(argumentValues);
  if (!parsed.ok) {
    reportFailure("arguments", parsed.failure);
    return EXIT_NOT_MERGED;
  }

  const loaded = await loadInputs(parsed.value.inputPaths);
  if (!loaded.ok) {
    reportFailure("input", loaded.failure);
    return EXIT_NOT_MERGED;
  }

  const merged = mergeLoadedInputs(loaded.value);
  if (!merged.ok) {
    reportFailure("merge", merged.failure);
    return EXIT_NOT_MERGED;
  }

  const saved = await writeGraphSnapshot(merged.value.snapshot, parsed.value.outputPath);
  if (!saved.ok) {
    reportFailure("write", saved.failure);
    return EXIT_NOT_MERGED;
  }

  printMergedSummary(merged.value.snapshot, saved.value.path, saved.value.byteSize);

  if (merged.value.conflictCount > 0) {
    console.error(
      `[runBuildDemoGraph] wrote ${saved.value.path} with ${merged.value.conflictCount} property ` +
        `conflict(s): the first input's value was kept in each case, listed above. Check them before ` +
        `the demo runs on this graph.`,
    );
    return EXIT_MERGED_WITH_CONFLICTS;
  }

  console.log(`[runBuildDemoGraph] wrote ${saved.value.path} with no property conflicts`);
  return EXIT_MERGED;
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArguments(argumentValues: readonly string[]): Result<BuildArguments, Failure> {
  let outputPath: string | null = null;
  const inputPaths: string[] = [];

  for (let index = 0; index < argumentValues.length; index += 1) {
    const argument = argumentValues[index];

    if (argument === "--out" || argument === "--input") {
      const value = argumentValues[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return fail("invalid_input", `[parseArguments] ${argument} needs a value. ${USAGE_LINE}`);
      }
      if (argument === "--out") outputPath = value;
      else inputPaths.push(value);

      index += 1;
      continue;
    }

    return fail("invalid_input", `[parseArguments] unknown argument "${argument}". ${USAGE_LINE}`);
  }

  // Stated inputs replace the defaults rather than adding to them, so a run that names its
  // inputs cannot silently also fold in a file the operator did not mention.
  const resolvedInputs = inputPaths.length > 0 ? inputPaths : [...DEFAULT_INPUT_PATHS];

  if (resolvedInputs.length < 2) {
    return fail(
      "invalid_input",
      `[parseArguments] a merge needs at least two inputs and ${resolvedInputs.length} was given. ` +
        `${USAGE_LINE}`,
    );
  }

  return succeed({ outputPath: outputPath ?? DEFAULT_OUTPUT_PATH, inputPaths: resolvedInputs });
}

// ---------------------------------------------------------------------------
// Loading and merging
// ---------------------------------------------------------------------------

/**
 * Loads every input through the shared loader, so a corrupt file is refused by the same
 * validation the app applies at startup rather than by a second reader written here.
 *
 * The loader hands back a graph and its manifest, and the merge works on parsed snapshots, so
 * each one is projected back through the shared serialiser. That projection is not a
 * conversion layer: it is the same function the producers use to write the file, so a
 * property the loader kept cannot be lost on the way into the merge.
 */
async function loadInputs(paths: readonly string[]): Promise<Result<LoadedInput[], Failure>> {
  const loadedInputs: LoadedInput[] = [];

  for (const path of paths) {
    const loaded = await loadGraphSnapshot(path);
    if (!loaded.ok) return loaded;

    console.log(
      `[loadInputs] ${path}: source=${loaded.value.source} ${loaded.value.graph.nodeCount} nodes ` +
        `${loaded.value.graph.edgeCount} edges`,
    );

    loadedInputs.push({
      path,
      snapshot: buildGraphSnapshot({
        graph: loaded.value.graph,
        manifest: loaded.value.manifest,
        generatedAtMs: loaded.value.generatedAtMs,
        source: loaded.value.source,
      }),
    });
  }

  return succeed(loadedInputs);
}

type MergeOutcome = {
  snapshot: GraphSnapshot;
  conflictCount: number;
};

/**
 * Folds the inputs left to right, printing one report per step.
 *
 * Left to right rather than pairwise-and-combine so the first input keeps its node ids and
 * wins every conflict, whatever the number of inputs.
 */
function mergeLoadedInputs(loadedInputs: readonly LoadedInput[]): Result<MergeOutcome, Failure> {
  const first = loadedInputs[0];
  if (first === undefined) {
    return fail("invalid_input", `[mergeLoadedInputs] no input was loaded. ${USAGE_LINE}`);
  }

  // One clock for the whole run, so every merged manifest and the file itself agree.
  const generatedAtMs = Date.now();
  let mergedSnapshot = first.snapshot;
  let mergedPath = first.path;
  let conflictCount = 0;

  for (const input of loadedInputs.slice(1)) {
    const merged = mergeGraphSnapshots({
      first: mergedSnapshot,
      second: input.snapshot,
      generatedAtMs,
      source: SNAPSHOT_SOURCE,
    });
    if (!merged.ok) return merged;

    printMergeReport(mergedPath, input.path, merged.value.report);

    mergedSnapshot = merged.value.snapshot;
    mergedPath = `${mergedPath} + ${input.path}`;
    conflictCount += merged.value.report.conflicts.length;
  }

  return succeed({ snapshot: mergedSnapshot, conflictCount });
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printMergeReport(firstPath: string, secondPath: string, report: MergeReport): void {
  const rows: readonly [string, string][] = [
    ["first input", `${firstPath}: ${report.firstNodeCount} nodes, ${report.firstEdgeCount} edges`],
    [
      "second input",
      `${secondPath}: ${report.secondNodeCount} nodes, ${report.secondEdgeCount} edges`,
    ],
    ["merged", `${report.mergedNodeCount} nodes, ${report.mergedEdgeCount} edges`],
    ["nodes unified by key", String(report.unifiedNodes)],
    ["nodes added", String(report.addedNodes)],
    ["edges added", String(report.addedEdges)],
    ["edges already present", String(report.skippedDuplicateEdges)],
    ["properties filled in", String(report.filledProperties)],
    ["nodes with no key", String(report.unkeyedNodes)],
    ["property conflicts", String(report.conflicts.length)],
  ];

  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  console.log("[printMergeReport] merge report");
  for (const [label, value] of rows) {
    console.log(`[printMergeReport]   ${label.padEnd(labelWidth)}  ${value}`);
  }

  for (const conflict of report.conflicts.slice(0, MAX_PRINTED_CONFLICTS)) {
    console.log(
      `[printMergeReport]   conflict ${conflict.label} "${conflict.key}" ${conflict.property}: ` +
        `kept ${String(conflict.keptValue)}, dropped ${String(conflict.discardedValue)}`,
    );
  }
  if (report.conflicts.length > MAX_PRINTED_CONFLICTS) {
    console.log(
      `[printMergeReport]   ${report.conflicts.length - MAX_PRINTED_CONFLICTS} further conflict(s) ` +
        `not printed`,
    );
  }
}

/** What the written graph holds, by label and by relationship type. */
function printMergedSummary(snapshot: GraphSnapshot, path: string, byteSize: number): void {
  const nodeCountByLabel = new Map<string, number>();
  for (const node of snapshot.nodes) {
    nodeCountByLabel.set(node.label, (nodeCountByLabel.get(node.label) ?? 0) + 1);
  }

  const edgeCountByRelType = new Map<string, number>();
  for (const edge of snapshot.edges) {
    edgeCountByRelType.set(edge.relType, (edgeCountByRelType.get(edge.relType) ?? 0) + 1);
  }

  const counts = snapshot.manifest.counts;
  const rows: readonly [string, string][] = [
    ["destination", `${path} (${byteSize} bytes)`],
    ["nodes by label", describeCounts(nodeCountByLabel)],
    ["edges by type", describeCounts(edgeCountByRelType)],
    ["resolution edges", String(counts.resolutionEdges)],
    ["closed packages", String(snapshot.manifest.closedPackageKeys.length)],
    ["partial packages", String(snapshot.manifest.partialPackageKeys.length)],
    ["closed services", String(snapshot.manifest.closedServiceKeys.length)],
  ];

  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  console.log("[printMergedSummary] demo graph summary");
  for (const [label, value] of rows) {
    console.log(`[printMergedSummary]   ${label.padEnd(labelWidth)}  ${value}`);
  }

  console.log(
    `[printMergedSummary] ${snapshot.manifest.notes.length} disclosure(s) travel with this graph`,
  );
}

function describeCounts(countByName: ReadonlyMap<string, number>): string {
  return [...countByName.entries()]
    .sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
    .map(([name, count]) => `${name} ${count}`)
    .join(", ");
}

/** Prints a Failure in full, then the next thing to try. Same shape as seed-incidents. */
function reportFailure(stage: string, failure: Failure): void {
  console.error(`[reportFailure] FAILED at ${stage}, reason=${failure.reason}`);
  console.error(`[reportFailure] ${failure.message}`);
  const remedy = describeRemedy(failure);
  if (remedy !== null) console.error(`[reportFailure] next step: ${remedy}`);
}

function describeRemedy(failure: Failure): string | null {
  switch (failure.reason) {
    case "invalid_input":
      return `fix the argument or the offending row named above. ${USAGE_LINE}`;
    case "not_found":
      return "build the inputs first: `bun run seed` writes the incident half, `bun run ingest` the registry half";
    default:
      return null;
  }
}

const exitCode = await runBuildDemoGraph(process.argv.slice(2));
process.exit(exitCode);
