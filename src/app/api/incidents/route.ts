/**
 * GET /api/incidents
 *
 * The incident packs the demo can replay, with the bounds a time scrubber needs. No query
 * parameters: there are four packs and the whole list is a few kilobytes once the per-service
 * lockfile rows are left out.
 *
 * Every pack goes through the loader in src/lib/incidents/pack.ts, so a hand-edited file with a
 * timeline entry outside its own window is rejected here rather than rendered as a scrubber
 * that scrolls past its own data.
 *
 * Three time facts travel with each pack and they are not the same thing:
 *   - `window` is what the pack declares it covers, which is what the scrubber spans.
 *   - `timelineBounds` is the first and last narrated event, which is where the ticks are.
 *   - `blindSpot` is the interval where the payload was installable and no advisory existed
 *     yet, which is the number the whole product is about. It is null when the advisory
 *     preceded the artifact, and null means "no blind spot", not "zero milliseconds".
 */

import { jsonFailure, jsonOk, runRoute } from "@/lib/api/http";
import { packageKey, versionKey } from "@/lib/graph/model";
import {
  type IncidentPack,
  computeExposureWindow,
  loadAllIncidentPacks,
} from "@/lib/incidents/pack";
import { type Failure } from "@/lib/result";

const ROUTE_NAME = "GET /api/incidents";

export async function GET(): Promise<Response> {
  return runRoute(ROUTE_NAME, async () => {
    const packs = await loadAllIncidentPacks();
    if (!packs.ok) return jsonFailure(rewriteServerSideFailure(packs.failure));

    return jsonOk({
      count: packs.value.length,
      incidents: packs.value.map(summarisePack),
    });
  });
}

/**
 * A pack as the UI needs it.
 *
 * The resolution rows inside each service are left out on purpose: they are the same facts the
 * graph holds as RESOLVED edges, and the routes that answer exposure questions read them from
 * there. Sending them twice would triple the size of this response for no new information.
 */
function summarisePack(pack: IncidentPack) {
  const instants = pack.timeline.map((entry) => entry.atMs);

  return {
    slug: pack.slug,
    title: pack.title,
    ecosystem: pack.ecosystem,
    dataOrigin: pack.dataOrigin,
    summary: pack.summary,
    window: { startMs: pack.windowStartMs, endMs: pack.windowEndMs },
    timelineBounds: {
      firstEventMs: Math.min(...instants),
      lastEventMs: Math.max(...instants),
    },
    blindSpot: computeExposureWindow(pack),
    counts: {
      compromisedVersions: pack.compromisedVersions.length,
      advisories: pack.advisories.length,
      services: pack.services.length,
      timelineEntries: pack.timeline.length,
      sources: pack.sources.length,
    },
    // Keys are built here so the client can call /api/blast-radius with what it was handed
    // rather than assembling a natural key of its own and getting the separator wrong.
    compromisedVersions: pack.compromisedVersions.map((entry) => ({
      ecosystem: entry.ecosystem,
      name: entry.name,
      version: entry.version,
      packageKey: packageKey(entry.ecosystem, entry.name),
      versionKey: versionKey(entry.ecosystem, entry.name, entry.version),
      publishedAtMs: entry.publishedAtMs,
      hasInstallScript: entry.hasInstallScript,
      note: entry.note,
    })),
    advisories: pack.advisories.map((advisory) => ({
      advisoryId: advisory.advisoryId,
      publishedAtMs: advisory.publishedAtMs,
      modifiedAtMs: advisory.modifiedAtMs,
      summary: advisory.summary,
      affectedPackageCount: advisory.affects.length,
    })),
    services: pack.services.map((service) => ({
      key: service.key,
      name: service.name,
      description: service.description,
      resolutionCount: service.resolved.length,
    })),
    timeline: pack.timeline,
    sources: pack.sources,
  };
}

/**
 * Turns a bad committed file into a server problem.
 *
 * The pack loader reports an invalid pack as `invalid_input`, which is correct for the caller
 * that handed it the file, but this request carried no input at all. Passing that reason
 * through would answer 400 and blame the browser for a file in the repository. A missing
 * directory is the same story: the deployment has no packs installed, which is a 503.
 *
 * The loader's own message is dropped rather than quoted. It names the directory it read, and a
 * client asking which incidents exist has no use for a path on the server.
 */
function rewriteServerSideFailure(failure: Failure): Failure {
  if (failure.reason === "not_found") {
    return {
      reason: "graph_unavailable",
      message: `[${ROUTE_NAME}] no incident packs are installed, so there is nothing to replay`,
    };
  }
  return {
    reason: "internal",
    message: `[${ROUTE_NAME}] an installed incident pack is unusable (${failure.reason})`,
  };
}
