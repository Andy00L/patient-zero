import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  INCIDENT_PACK_DIRECTORY,
  type IncidentPack,
  computeExposureWindow,
  loadAllIncidentPacks,
  loadIncidentPack,
  parseIncidentPack,
} from "@/lib/incidents/pack";
import type { Failure, Result } from "@/lib/result";

/**
 * The packs are curated by hand from advisory and registry records, so these tests guard
 * the two failure modes that would survive review: a timestamp that drifts outside the
 * replay window, and a version string that is not a version. Both produce a confident
 * wrong answer downstream rather than a crash.
 */
const PACK_DIRECTORY = join(import.meta.dir, "..", INCIDENT_PACK_DIRECTORY);

/** One hour in milliseconds. Used to state exposure windows in readable units. */
const HOUR_MS = 60 * 60 * 1000;
/** One week in milliseconds. */
const WEEK_MS = 7 * 24 * HOUR_MS;

function readValueOrUnreachable<TValue>(result: Result<TValue, Failure>, context: string): TValue {
  if (result.ok) return result.value;
  return expect.unreachable(`${context}: ${result.failure.message}`);
}

function readFailureOrUnreachable<TValue>(result: Result<TValue, Failure>, context: string): Failure {
  if (!result.ok) return result.failure;
  return expect.unreachable(`${context}: expected a failure`);
}

async function listPackSlugs(): Promise<string[]> {
  const entries = await readdir(PACK_DIRECTORY);
  return entries.filter((entry) => entry.endsWith(".json")).map((entry) => entry.slice(0, -".json".length));
}

async function loadPackOrUnreachable(slug: string): Promise<IncidentPack> {
  return readValueOrUnreachable(await loadIncidentPack(slug, PACK_DIRECTORY), `load ${slug}`);
}

describe("the curated pack directory", () => {
  test("every pack file on disk parses and self-identifies", async () => {
    const slugs = await listPackSlugs();
    expect(slugs.length).toBeGreaterThan(0);

    for (const slug of slugs) {
      const pack = await loadPackOrUnreachable(slug);
      expect(pack.slug).toBe(slug);
      expect(pack.sources.length).toBeGreaterThan(0);
      expect(pack.windowStartMs).toBeLessThan(pack.windowEndMs);
    }
  });

  test("loadAllIncidentPacks returns every file, ordered by slug", async () => {
    const slugs = await listPackSlugs();
    const packs = readValueOrUnreachable(await loadAllIncidentPacks(PACK_DIRECTORY), "load all");

    expect(packs.map((pack) => pack.slug)).toEqual([...slugs].sort((left, right) => left.localeCompare(right)));
  });

  test("every pack splits its services across the exposure window", async () => {
    // With every service inside the window the bitemporal query has nothing to
    // discriminate, and the demo proves nothing.
    for (const slug of await listPackSlugs()) {
      const pack = await loadPackOrUnreachable(slug);
      const window = computeExposureWindow(pack);
      if (window === null) return expect.unreachable(`${slug} has no exposure window`);

      const compromised = new Set(
        pack.compromisedVersions.map((entry) => `${entry.ecosystem}:${entry.name}@${entry.version}`),
      );
      const exposed = pack.services.filter((service) =>
        service.resolved.some(
          (resolution) =>
            compromised.has(`${resolution.ecosystem}:${resolution.name}@${resolution.version}`) &&
            resolution.resolvedAtMs >= window.startMs &&
            resolution.resolvedAtMs < window.endMs,
        ),
      );

      expect(exposed.length).toBeGreaterThan(0);
      expect(exposed.length).toBeLessThan(pack.services.length);
    }
  });
});

describe("computeExposureWindow", () => {
  test("event-stream stayed installable for weeks and ua-parser-js for hours", async () => {
    const eventStream = computeExposureWindow(await loadPackOrUnreachable("event-stream-2018"));
    const uaParser = computeExposureWindow(await loadPackOrUnreachable("ua-parser-js-2021"));
    if (eventStream === null || uaParser === null) {
      return expect.unreachable("both packs have a compromise before its advisory");
    }

    expect(eventStream.durationMs / WEEK_MS).toBeGreaterThan(4);
    expect(eventStream.durationMs / WEEK_MS).toBeLessThan(20);

    expect(uaParser.durationMs / HOUR_MS).toBeGreaterThan(1);
    expect(uaParser.durationMs / HOUR_MS).toBeLessThan(24);

    // The contrast is the point of shipping both packs, so assert the gap, not just the units.
    expect(eventStream.durationMs / uaParser.durationMs).toBeGreaterThan(100);
  });
});

describe("parseIncidentPack cross-field rules", () => {
  test("a timeline entry outside the window fails with its field path", async () => {
    const pack = structuredClone(await loadPackOrUnreachable("ua-parser-js-2021"));
    const firstEntry = pack.timeline[0];
    if (firstEntry === undefined) return expect.unreachable("pack has no timeline");
    firstEntry.atMs = pack.windowEndMs + 1;

    const failure = readFailureOrUnreachable(parseIncidentPack(pack), "timeline outside window");
    expect(failure.reason).toBe("invalid_input");
    expect(failure.message).toContain("timeline.0.atMs");
    expect(failure.message).toContain("outside the pack window");
  });

  test("a resolution may name a clean version but not a non-version", async () => {
    const pack = await loadPackOrUnreachable("ua-parser-js-2021");

    const cleanResolution = structuredClone(pack);
    const cleanTarget = cleanResolution.services[0]?.resolved[0];
    if (cleanTarget === undefined) return expect.unreachable("pack has no service resolution");
    cleanTarget.version = "9.9.9";
    expect(parseIncidentPack(cleanResolution).ok).toBe(true);

    const brokenResolution = structuredClone(pack);
    const brokenTarget = brokenResolution.services[0]?.resolved[0];
    if (brokenTarget === undefined) return expect.unreachable("pack has no service resolution");
    brokenTarget.version = "latest";

    const failure = readFailureOrUnreachable(parseIncidentPack(brokenResolution), "non-semver version");
    expect(failure.reason).toBe("invalid_input");
    expect(failure.message).toContain("services.0.resolved.0.version");
  });

  test("an advisory naming an unexplained package fails with its field path", async () => {
    const pack = structuredClone(await loadPackOrUnreachable("ua-parser-js-2021"));
    const affected = pack.advisories[0]?.affects[0];
    if (affected === undefined) return expect.unreachable("pack has no advisory range");
    affected.name = "some-unrelated-package";

    const failure = readFailureOrUnreachable(parseIncidentPack(pack), "unexplained package");
    expect(failure.message).toContain("advisories.0.affects.0.name");
  });
});

describe("loader failures are values, not throws", () => {
  test("malformed JSON and a mismatched slug both fail by name", async () => {
    // A temporary directory keeps the broken fixtures out of the curated pack directory,
    // which holds one file per incident and nothing else.
    const directory = await mkdtemp(join(PACK_DIRECTORY, ".tmp-loader-"));
    try {
      await writeFile(join(directory, "broken-pack.json"), '{"slug": "broken-pack",', "utf8");

      // Valid content, wrong file name: the pack still declares the ua-parser-js slug.
      const renamed = await loadPackOrUnreachable("ua-parser-js-2021");
      await writeFile(join(directory, "renamed-pack.json"), JSON.stringify(renamed), "utf8");

      const malformed = readFailureOrUnreachable(
        await loadIncidentPack("broken-pack", directory),
        "malformed JSON",
      );
      expect(malformed.reason).toBe("invalid_input");
      expect(malformed.message).toContain("broken-pack.json");
      expect(malformed.message).toContain("not valid JSON");

      const mismatched = readFailureOrUnreachable(
        await loadIncidentPack("renamed-pack", directory),
        "slug mismatch",
      );
      expect(mismatched.message).toContain("renamed-pack.json");
      expect(mismatched.message).toContain("ua-parser-js-2021");

      // One bad file fails the batch rather than disappearing from the incident list.
      expect((await loadAllIncidentPacks(directory)).ok).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("a missing pack and a missing directory both return not_found", async () => {
    const missingPack = readFailureOrUnreachable(
      await loadIncidentPack("no-such-incident", PACK_DIRECTORY),
      "missing pack",
    );
    expect(missingPack.reason).toBe("not_found");

    const missingDirectory = readFailureOrUnreachable(
      await loadAllIncidentPacks(join(PACK_DIRECTORY, "no-such-directory")),
      "missing directory",
    );
    expect(missingDirectory.reason).toBe("not_found");
  });
});
