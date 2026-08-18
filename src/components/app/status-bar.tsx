import { type SliceReading, StatusRail } from "@/components/ui/status-rail";
import { formatCount } from "@/lib/format";
import type { GraphSource } from "@/lib/graph/load-graph";
import { requestGraph } from "@/lib/graph/request-graph";
import type { SliceManifest } from "@/lib/graph/slice-manifest";

/**
 * The status rail, with the loaded slice behind it.
 *
 * The rail is this app's one permanent claim about how much it knows, so the numbers in it come
 * from the manifest the answering graph carries and from nowhere else. Nothing here computes a
 * coverage figure: "5 of 402" is two fields of the manifest printed side by side, because a
 * derived percentage would be a claim the ingest never made.
 *
 * A failed load renders the rail rather than nothing. The navigation still has to work when no
 * graph answered, and a rail reading "unavailable" is itself the most useful thing on the screen
 * at that moment.
 */
export async function StatusBar() {
  const loaded = await requestGraph();

  if (!loaded.ok) {
    return (
      <StatusRail
        readings={[{ label: "slice", value: "unavailable" }]}
        source="no graph loaded"
      />
    );
  }

  return (
    <StatusRail
      readings={readSliceReadings(loaded.value.manifest)}
      source={describeSource(loaded.value.source)}
    />
  );
}

/**
 * Three readings: how much is in the graph, and how much of it was ingested to closure.
 *
 * The closure reading is the one that qualifies every verdict this tool gives. A package with a
 * partial closure can hide a dependent, so "not exposed" over a partial slice is a weaker
 * statement than the same words over a closed one, and the rail is where that stays visible
 * without a click.
 */
function readSliceReadings(manifest: SliceManifest): SliceReading[] {
  const packageCount = manifest.counts.packages;
  const closedCount = manifest.closedPackageKeys.length;

  return [
    { label: "packages", value: formatCount(packageCount) },
    { label: "versions", value: formatCount(manifest.counts.versions) },
    { label: "closed", value: `${formatCount(closedCount)} of ${formatCount(packageCount)}` },
  ];
}

/**
 * Which source answered, in the shortest form that still identifies it.
 *
 * `source.detail` is already redacted by the loader and holds no host and no token, but it is a
 * whole sentence with a path in it, and the rail has one line. The file name is the part a
 * reader can act on, and a degraded load says so in the same breath: a snapshot that answered
 * because HydraDB did not is a different situation from a snapshot that was the only thing
 * configured.
 */
function describeSource(source: GraphSource): string {
  const base = source.kind === "hydradb" ? "hydradb" : readFileName(source.detail);
  return source.degradedReason === null ? base : `${base}, degraded`;
}

function readFileName(detail: string): string {
  const [path] = detail.split(" ");
  if (path === undefined || path.length === 0) return "snapshot";
  const segments = path.split("/");
  return segments[segments.length - 1] ?? "snapshot";
}
