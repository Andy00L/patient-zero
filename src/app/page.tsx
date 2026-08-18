import { QueryProvenance } from "@/components/app/query-provenance";
import { Surface, SurfaceHead } from "@/components/app/surface";
import { type IncidentChoice, IncidentPicker } from "@/components/radar/incident-picker";
import { RadarConsole } from "@/components/radar/radar-console";
import { EmptyState } from "@/components/ui/state";
import { buildReplayTimeline } from "@/lib/analysis/replay";
import { requestGraph } from "@/lib/graph/request-graph";
import { withStatementLog } from "@/lib/graph/statements";
import { type IncidentPack, loadAllIncidentPacks } from "@/lib/incidents/pack";

/**
 * The radar: the surface the demo opens on.
 *
 * Everything a reader sees here is decided on the server, on this request. The incident comes
 * from the URL, the replay is built by walking the graph once per compromised version, and the
 * whole decided timeline is handed to the client so the scrubber can move through sixty instants
 * without another request. The one piece of client state on the page is which instant is showing.
 *
 * The answer arrives wrapped in a statement log, and the provenance panel at the bottom prints
 * what the graph actually did to produce it. That panel is not decoration for a hackathon judge:
 * this tool's product is a claim about who was exposed, and a claim like that is worth exactly as
 * much as the reader's ability to see the query behind it.
 */

/** The search parameter that names the incident. Shared with the picker, which writes it. */
const INCIDENT_PARAMETER = "incident";

/**
 * Splits a pack slug into the artifact it is about and the year it happened.
 *
 * Pack slugs are written as `<subject>-<year>`, so the split is a read of an existing convention
 * rather than a new one. The subject keeps its hyphens because they are part of the package name:
 * "event-stream" is what the package is called, and "event stream" is not.
 */
const SLUG_YEAR_PATTERN = /^(.+)-(\d{4})$/;

function describeChoice(pack: IncidentPack): IncidentChoice {
  const match = SLUG_YEAR_PATTERN.exec(pack.slug);
  // A slug with no year still gets a chip, labelled with the whole slug. Dropping the incident
  // because its name does not match a pattern would hide data the repo ships.
  if (match === null) return { slug: pack.slug, label: pack.slug, year: null };
  return { slug: pack.slug, label: match[1], year: match[2] };
}

/**
 * What was compromised, in the few words a panel title has room for.
 *
 * Names the first artifact and counts the rest, rather than summarising all of them: the worm
 * pack condemns 84 artifacts, and a title that lists them is not a title. The pack's own title
 * carries the full description and is stated in the surface head above.
 */
function describeSubject(pack: IncidentPack): string {
  const labels = pack.compromisedVersions.map((entry) => `${entry.name}@${entry.version}`);
  // The pack schema requires at least one compromised version, so an empty list would be a
  // parser defect rather than a pack a curator wrote. The title is still a true label for it.
  if (labels.length === 0) return pack.title;
  if (labels.length === 1) return labels[0];
  return `${labels[0]} and ${labels.length - 1} more`;
}

/** Reads the requested slug out of a parameter that can arrive repeated. */
function readRequestedSlug(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function RadarPage({ searchParams }: PageProps<"/">) {
  const packs = await loadAllIncidentPacks();
  if (!packs.ok) {
    return (
      <Surface>
        <EmptyState title="No incident packs could be read">
          The replay is built from the curated packs in data/incidents, and none of them could be
          loaded, so there is no incident to replay. This is a gap in the repository rather than a
          finding about any package. The loader reported: {packs.failure.message}
        </EmptyState>
      </Surface>
    );
  }

  const requestedSlug = readRequestedSlug((await searchParams)[INCIDENT_PARAMETER]);
  // An unrecognised slug falls back to the first pack rather than to an error page: the picker
  // renders the pack that is actually on screen as the selected one, so the surface stays
  // self-consistent and a mistyped link still shows a real incident.
  const pack = packs.value.find((candidate) => candidate.slug === requestedSlug) ?? packs.value[0];

  const graph = await requestGraph();
  if (!graph.ok) {
    return (
      <Surface>
        <SurfaceHead
          question="Who was exposed, and when could anyone have known?"
          lede="The graph could not be read, so nothing below can be stated about any package."
          controls={
            <IncidentPicker
              choices={packs.value.map(describeChoice)}
              selectedSlug={pack.slug}
              parameterName={INCIDENT_PARAMETER}
            />
          }
        />
        <EmptyState title="The graph could not be read">
          Every answer on this surface is a traversal of the ingested slice, and the slice could
          not be opened. An empty result is not the same claim as an estate with no exposure, so
          nothing is shown rather than a clean picture. The loader reported: {graph.failure.message}
        </EmptyState>
      </Surface>
    );
  }

  const replay = await withStatementLog(() =>
    buildReplayTimeline({ gateway: graph.value.gateway, coverage: graph.value.coverage, pack }),
  );

  return (
    <Surface>
      <SurfaceHead
        question="Who was exposed, and when could anyone have known?"
        lede={`${pack.title}. The routes are traversed once against the graph and each frame states which of them had resolved by that instant, so a service appears when its lockfile pinned the compromised version rather than when the advisory named it.`}
        controls={
          <IncidentPicker
            choices={packs.value.map(describeChoice)}
            selectedSlug={pack.slug}
            parameterName={INCIDENT_PARAMETER}
          />
        }
      />

      {replay.value.ok ? (
        // Keyed on the slug so switching incident remounts the console: a frame index means
        // nothing across two timelines of different lengths, and a remount is a clearer reset
        // than an effect that watches a prop and writes state behind the render.
        <RadarConsole
          key={replay.value.value.packSlug}
          timeline={replay.value.value}
          subjectLabel={describeSubject(pack)}
        />
      ) : (
        <EmptyState title={`The replay of ${pack.title} could not be built`}>
          The graph was readable but this incident could not be replayed against it, so no instant
          is stated rather than a partial one. The replay engine reported:{" "}
          {replay.value.failure.message}
        </EmptyState>
      )}

      <QueryProvenance record={replay.record} />
    </Surface>
  );
}
