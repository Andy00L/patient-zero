import type { GraphProperties } from "@/lib/graph/gateway";
import { MemoryGraph } from "@/lib/graph/memory-gateway";
import {
  type Ecosystem,
  NODE_PROPERTY_NAMES,
  type NodeLabel,
  REL_ENDPOINTS,
  REL_PROPERTY_NAMES,
  type RelType,
  type ServiceSource,
  UNKNOWN_NUMERIC_VALUE,
  advisoryKey,
  maintainerKey,
  mapKey,
  packageKey,
  serviceKey,
  versionKey,
} from "@/lib/graph/model";
import {
  EMPTY_SLICE_COUNTS,
  SLICE_MANIFEST_VERSION,
  SliceCoverage,
  type SliceManifest,
} from "@/lib/graph/slice-manifest";
import type {
  RelPropertiesByType,
  StagedAdvisory,
  StagedMaintainer,
  StagedPackage,
  StagedService,
  StagedVersion,
} from "@/lib/ingest/writer";

/**
 * Declarative fixture builder for graph-shaped tests.
 *
 * A blast-radius test is a statement about a dependency graph, so it should read as one.
 * Everything here exists to keep the graph in the test and the plumbing out of it.
 *
 * Three decisions are load-bearing:
 *
 *   1. Node ids are assigned here, sequentially, in declaration order. HydraDB addresses
 *      nodes by integer id and natural keys are only properties (docs/HYDRADB.md), so a
 *      fixture that did not own the ids could not assert on them at all.
 *   2. Property names come from the model's wire types and are checked against
 *      NODE_PROPERTY_NAMES and REL_PROPERTY_NAMES. A misspelled property in a fixture
 *      would produce a test that passes against data the real writer never writes.
 *   3. Every RESOLVES_TO gets its DEPENDED_ON_BY written beside it, exactly as
 *      graph-builder.ts stageDependencyEdges does. Blast radius walks only the reverse
 *      type, so a fixture missing it would make every traversal return nothing and every
 *      exposure test pass for the wrong reason.
 */

/** Node ids start at 1 so a test that mistakes a falsy 0 for "no node" cannot pass. */
const FIRST_NODE_ID = 1;

/** Relationships have their own id space. sourceRef: src/lib/hydra/id-map.ts. */
const FIRST_RELATIONSHIP_ID = 1;

const DEFAULT_ECOSYSTEM: Ecosystem = "npm";

/** November 2018, inside the real event-stream incident window. */
export const FIXTURE_RESOLVED_AT_MS = 1_542_931_200_000;

/** A day before the resolution above, so publish always precedes resolution. */
const DEFAULT_PUBLISHED_AT_MS = 1_542_844_800_000;

/** model.ts reserves this for "the registry reported none", never 0. */
const UNKNOWN_WEEKLY_DOWNLOADS = UNKNOWN_NUMERIC_VALUE;

/** Fixed clock, so no assertion can depend on when the suite runs. */
const FIXTURE_MANIFEST_GENERATED_AT_MS = 1_543_017_600_000;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * Node inputs carry the model's own property names (snake_case, from model.ts) for
 * everything a test may care about, and default the rest. Renaming a property in the
 * model breaks this file at compile time rather than at assertion time.
 */
export type PackageInput = {
  ecosystem?: Ecosystem;
  name: string;
  weekly_downloads?: number;
};

export type VersionInput = {
  ecosystem?: Ecosystem;
  name: string;
  version: string;
  published_at_ms?: number;
  has_install_script?: boolean;
};

export type MaintainerInput = {
  ecosystem?: Ecosystem;
  username: string;
};

export type ServiceInput = {
  name: string;
  source?: ServiceSource;
};

export type AdvisoryInput = {
  ghsa_id: string;
  published_at_ms?: number;
  modified_at_ms?: number;
  summary?: string;
};

/**
 * One relationship, keyed by its own type so it can demand exactly the properties that
 * type declares. Endpoint labels are not stated: REL_ENDPOINTS already fixes them, and
 * restating them would let a fixture contradict the model.
 */
export type FixtureEdge = {
  [TRelType in RelType]: {
    relType: TRelType;
    /** Natural key of the endpoint whose label is REL_ENDPOINTS[relType].from. */
    fromKey: string;
    /** Natural key of the endpoint whose label is REL_ENDPOINTS[relType].to. */
    toKey: string;
    properties: RelPropertiesByType[TRelType];
  };
}[RelType];

export type FixtureSpec = {
  packages?: readonly PackageInput[];
  versions?: readonly VersionInput[];
  maintainers?: readonly MaintainerInput[];
  services?: readonly ServiceInput[];
  advisories?: readonly AdvisoryInput[];
  edges?: readonly FixtureEdge[];
};

export type GraphFixture = {
  graph: MemoryGraph;
  /** mapKey(label, key) to the integer id assigned, so tests can assert on ids. */
  nodeIdByMapKey: Map<string, number>;
  /** Edges whose endpoint was never declared. A non-empty list means a broken fixture. */
  danglingEdges: string[];
};

// ---------------------------------------------------------------------------
// Edge constructors for the two types every exposure test needs
// ---------------------------------------------------------------------------

/**
 * "dependent depends on dependency", the direction deps.dev resolution runs in
 * (Version)-[:RESOLVES_TO]->(Version). The reverse edge is materialised by the builder.
 */
export function dependencyEdge(dependentVersionKey: string, dependencyVersionKey: string): FixtureEdge {
  return {
    relType: "RESOLVES_TO",
    fromKey: dependentVersionKey,
    toKey: dependencyVersionKey,
    properties: {},
  };
}

/** Lockfile ground truth, (Service)-[:RESOLVED {resolved_at_ms}]->(Version). */
export function lockfileEdge(
  serviceName: string,
  resolvedVersionKey: string,
  resolvedAtMs: number = FIXTURE_RESOLVED_AT_MS,
): FixtureEdge {
  return {
    relType: "RESOLVED",
    fromKey: serviceKey(serviceName),
    toKey: resolvedVersionKey,
    properties: { resolved_at_ms: resolvedAtMs },
  };
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

type BuilderState = {
  graph: MemoryGraph;
  nodeIdByMapKey: Map<string, number>;
  danglingEdges: string[];
  nextNodeId: number;
  nextRelationshipId: number;
};

/** Builds a MemoryGraph from a declarative description. Ids are deterministic. */
export function buildFixtureGraph(spec: FixtureSpec): GraphFixture {
  const state: BuilderState = {
    graph: new MemoryGraph(),
    nodeIdByMapKey: new Map<string, number>(),
    danglingEdges: [],
    nextNodeId: FIRST_NODE_ID,
    nextRelationshipId: FIRST_RELATIONSHIP_ID,
  };

  for (const input of spec.packages ?? []) {
    const staged: StagedPackage = {
      ecosystem: input.ecosystem ?? DEFAULT_ECOSYSTEM,
      name: input.name,
      weekly_downloads: input.weekly_downloads ?? UNKNOWN_WEEKLY_DOWNLOADS,
    };
    addFixtureNode(state, "Package", packageKey(staged.ecosystem, staged.name), staged);
  }

  for (const input of spec.versions ?? []) {
    const staged: StagedVersion = {
      ecosystem: input.ecosystem ?? DEFAULT_ECOSYSTEM,
      name: input.name,
      version: input.version,
      published_at_ms: input.published_at_ms ?? DEFAULT_PUBLISHED_AT_MS,
      has_install_script: input.has_install_script ?? false,
    };
    addFixtureNode(
      state,
      "Version",
      versionKey(staged.ecosystem, staged.name, staged.version),
      staged,
    );
  }

  for (const input of spec.maintainers ?? []) {
    const staged: StagedMaintainer = {
      ecosystem: input.ecosystem ?? DEFAULT_ECOSYSTEM,
      username: input.username,
    };
    addFixtureNode(state, "Maintainer", maintainerKey(staged.ecosystem, staged.username), staged);
  }

  for (const input of spec.services ?? []) {
    const staged: StagedService = { name: input.name, source: input.source ?? "seed" };
    addFixtureNode(state, "Service", serviceKey(staged.name), staged);
  }

  for (const input of spec.advisories ?? []) {
    const staged: StagedAdvisory = {
      ghsa_id: input.ghsa_id,
      published_at_ms: input.published_at_ms ?? DEFAULT_PUBLISHED_AT_MS,
      modified_at_ms: input.modified_at_ms ?? DEFAULT_PUBLISHED_AT_MS,
      summary: input.summary ?? "fixture advisory",
    };
    addFixtureNode(state, "Advisory", advisoryKey(staged.ghsa_id), staged);
  }

  for (const edge of materialiseReverseEdges(spec.edges ?? [])) addFixtureEdge(state, edge);

  return {
    graph: state.graph,
    nodeIdByMapKey: state.nodeIdByMapKey,
    danglingEdges: state.danglingEdges,
  };
}

/**
 * Adds the DEPENDED_ON_BY beside every RESOLVES_TO.
 *
 * The real ingest does exactly this (graph-builder.ts stageDependencyEdges), and the fixture
 * has to mirror it so a test exercises the same adjacency the app queries. The reverse type is
 * an index-shape choice rather than a workaround: direction is a procedure argument, so
 * "who depends on me" is expressible either as an incoming walk over DEPENDS_ON or as an
 * outgoing walk over the materialised reverse type, and scripts/measure-traversal.ts is what
 * decides which one is cheaper against a live server.
 */
function materialiseReverseEdges(edges: readonly FixtureEdge[]): FixtureEdge[] {
  const expanded: FixtureEdge[] = [];
  for (const edge of edges) {
    expanded.push(edge);
    if (edge.relType !== "RESOLVES_TO") continue;
    expanded.push({
      relType: "DEPENDED_ON_BY",
      fromKey: edge.toKey,
      toKey: edge.fromKey,
      properties: {},
    });
  }
  return expanded;
}

/** Assigns the id on first sight and keeps it stable, the way the id map does. */
function addFixtureNode(
  state: BuilderState,
  label: NodeLabel,
  key: string,
  staged: Readonly<Record<string, string | number | boolean>>,
): void {
  const composite = mapKey(label, key);
  const existing = state.nodeIdByMapKey.get(composite);
  const nodeId = existing ?? state.nextNodeId;
  if (existing === undefined) {
    state.nodeIdByMapKey.set(composite, nodeId);
    state.nextNodeId += 1;
  }

  const properties: GraphProperties = { key, ...staged };
  state.graph.addNode({ id: nodeId, label, properties });
}

function addFixtureEdge(state: BuilderState, edge: FixtureEdge): void {
  const endpoints = REL_ENDPOINTS[edge.relType];
  const fromNodeId = state.nodeIdByMapKey.get(mapKey(endpoints.from, edge.fromKey));
  const toNodeId = state.nodeIdByMapKey.get(mapKey(endpoints.to, edge.toKey));

  if (fromNodeId === undefined || toNodeId === undefined) {
    state.danglingEdges.push(
      `${edge.relType} from ${endpoints.from} "${edge.fromKey}" to ${endpoints.to} "${edge.toKey}"`,
    );
    return;
  }

  state.graph.addEdge({
    id: state.nextRelationshipId,
    relType: edge.relType,
    fromNodeId,
    toNodeId,
    properties: { ...edge.properties },
  });
  state.nextRelationshipId += 1;
}

/**
 * Checks a built fixture against the model registries.
 *
 * Without this, a fixture with a mistyped property name or a mislabelled endpoint would
 * still traverse, and the test on top of it would assert something about data the writer
 * could never produce. Returns one sentence per violation, empty when the fixture is
 * sound.
 */
export function findFixtureModelViolations(fixture: GraphFixture): string[] {
  const violations = fixture.danglingEdges.map(
    (edge) => `edge endpoint was never declared: ${edge}`,
  );

  const labelByNodeId = new Map<number, NodeLabel>();
  for (const node of fixture.graph.listNodes()) {
    labelByNodeId.set(node.id, node.label);
    const expected = NODE_PROPERTY_NAMES[node.label];
    const actual = Object.keys(node.properties);
    if (!sameNames(expected, actual)) {
      violations.push(
        `${node.label} ${describeNodeKey(node.properties)} carries [${sortedNames(actual)}], ` +
          `the registry declares [${sortedNames(expected)}]`,
      );
    }
  }

  for (const edge of fixture.graph.listEdges()) {
    const expectedProperties = REL_PROPERTY_NAMES[edge.relType];
    const actualProperties = Object.keys(edge.properties);
    if (!sameNames(expectedProperties, actualProperties)) {
      violations.push(
        `${edge.relType} ${edge.fromNodeId} to ${edge.toNodeId} carries ` +
          `[${sortedNames(actualProperties)}], the registry declares ` +
          `[${sortedNames(expectedProperties)}]`,
      );
    }

    const endpoints = REL_ENDPOINTS[edge.relType];
    const fromLabel = labelByNodeId.get(edge.fromNodeId);
    const toLabel = labelByNodeId.get(edge.toNodeId);
    if (fromLabel !== endpoints.from || toLabel !== endpoints.to) {
      violations.push(
        `${edge.relType} runs ${fromLabel ?? "absent"} to ${toLabel ?? "absent"}, ` +
          `the model declares ${endpoints.from} to ${endpoints.to}`,
      );
    }
  }

  return violations;
}

function describeNodeKey(properties: GraphProperties): string {
  const key = properties.key;
  return typeof key === "string" ? `"${key}"` : "with no key property";
}

function sameNames(expected: readonly string[], actual: readonly string[]): boolean {
  return sortedNames(expected) === sortedNames(actual);
}

function sortedNames(names: readonly string[]): string {
  return [...names].sort().join(",");
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

export type SliceCoverageInput = {
  closedPackageKeys?: readonly string[];
  partialPackageKeys?: readonly string[];
  closedServiceKeys?: readonly string[];
};

/**
 * Builds a SliceCoverage from the three key lists a test cares about.
 *
 * The counts stay zero because nothing in the analysis layer reads them for emptiness:
 * blast radius asks the graph itself (isGraphEmpty counts Version nodes), which is the
 * only source that cannot disagree with the data being traversed.
 */
export function buildSliceCoverage(input: SliceCoverageInput = {}): SliceCoverage {
  const manifest: SliceManifest = {
    version: SLICE_MANIFEST_VERSION,
    generatedAtMs: FIXTURE_MANIFEST_GENERATED_AT_MS,
    ecosystems: ["npm"],
    closedPackageKeys: [...(input.closedPackageKeys ?? [])],
    partialPackageKeys: [...(input.partialPackageKeys ?? [])],
    closedServiceKeys: [...(input.closedServiceKeys ?? [])],
    counts: { ...EMPTY_SLICE_COUNTS },
    notes: [],
  };
  return new SliceCoverage(manifest);
}

// ---------------------------------------------------------------------------
// The named scenario: the event-stream incident shape
// ---------------------------------------------------------------------------

/**
 * Natural keys of the event-stream scenario, so no test spells one out twice.
 *
 * The chain is the real one from the November 2018 npm incident: the payload shipped in
 * flatmap-stream, which event-stream depended on, which ps-tree depended on, which
 * nodemon depended on. chalk is the control: a real package on nobody's path to it.
 */
export const EVENT_STREAM_KEYS = {
  flatmapStreamVersion: versionKey("npm", "flatmap-stream", "0.1.1"),
  eventStreamVersion: versionKey("npm", "event-stream", "3.3.6"),
  psTreeVersion: versionKey("npm", "ps-tree", "1.2.0"),
  nodemonVersion: versionKey("npm", "nodemon", "1.18.7"),
  chalkVersion: versionKey("npm", "chalk", "5.3.1"),
  flatmapStreamPackage: packageKey("npm", "flatmap-stream"),
  eventStreamPackage: packageKey("npm", "event-stream"),
  psTreePackage: packageKey("npm", "ps-tree"),
  nodemonPackage: packageKey("npm", "nodemon"),
  chalkPackage: packageKey("npm", "chalk"),
  checkoutApiService: serviceKey("checkout-api"),
  walletWebService: serviceKey("wallet-web"),
  docsSiteService: serviceKey("docs-site"),
} as const;

/**
 * The scenario, with its answer worked out by hand.
 *
 * Reverse edges the traversal walks outward from flatmap-stream@0.1.1:
 *
 *     flatmap-stream -> event-stream -> ps-tree -> nodemon
 *
 * so the reachable versions sit at hop 1 (event-stream), hop 2 (ps-tree) and hop 3
 * (nodemon), and maxHopReached is 3 (a version distance, not a service distance).
 *
 *     checkout-api  RESOLVED event-stream@3.3.6, so 1 + 1 = 2 hops. Steps read
 *                   checkout-api, event-stream@3.3.6, flatmap-stream@0.1.1.
 *     wallet-web    RESOLVED nodemon@1.18.7, so 3 + 1 = 4 hops. Steps read wallet-web,
 *                   nodemon@1.18.7, ps-tree@1.2.0, event-stream@3.3.6,
 *                   flatmap-stream@0.1.1.
 *     docs-site     RESOLVED chalk@5.3.1 only, so it is absent from the answer.
 *
 * The Package, Maintainer and Advisory nodes are here on purpose: they give the
 * traversal other edge types to get wrong. A walk that followed VERSION_OF or MAINTAINS
 * would produce different hop counts and fail the assertions above.
 */
export function buildEventStreamScenario(): GraphFixture {
  return buildFixtureGraph({
    packages: [
      { name: "flatmap-stream" },
      { name: "event-stream", weekly_downloads: 1_900_000 },
      { name: "ps-tree" },
      { name: "nodemon" },
      { name: "chalk", weekly_downloads: 120_000_000 },
    ],
    versions: [
      { name: "flatmap-stream", version: "0.1.1", has_install_script: true },
      { name: "event-stream", version: "3.3.6" },
      { name: "ps-tree", version: "1.2.0" },
      { name: "nodemon", version: "1.18.7" },
      { name: "chalk", version: "5.3.1" },
    ],
    maintainers: [{ username: "right9ctrl" }],
    services: [{ name: "checkout-api" }, { name: "wallet-web" }, { name: "docs-site" }],
    advisories: [
      {
        ghsa_id: "GHSA-fixture-flatmap",
        summary: "flatmap-stream 0.1.1 ships a payload that reads wallet credentials",
      },
    ],
    edges: [
      dependencyEdge(EVENT_STREAM_KEYS.eventStreamVersion, EVENT_STREAM_KEYS.flatmapStreamVersion),
      dependencyEdge(EVENT_STREAM_KEYS.psTreeVersion, EVENT_STREAM_KEYS.eventStreamVersion),
      dependencyEdge(EVENT_STREAM_KEYS.nodemonVersion, EVENT_STREAM_KEYS.psTreeVersion),
      lockfileEdge("checkout-api", EVENT_STREAM_KEYS.eventStreamVersion),
      lockfileEdge("wallet-web", EVENT_STREAM_KEYS.nodemonVersion),
      lockfileEdge("docs-site", EVENT_STREAM_KEYS.chalkVersion),
      {
        relType: "VERSION_OF",
        fromKey: EVENT_STREAM_KEYS.flatmapStreamVersion,
        toKey: EVENT_STREAM_KEYS.flatmapStreamPackage,
        properties: {},
      },
      {
        relType: "MAINTAINS",
        fromKey: maintainerKey("npm", "right9ctrl"),
        toKey: EVENT_STREAM_KEYS.flatmapStreamPackage,
        properties: {},
      },
      {
        relType: "AFFECTS",
        fromKey: advisoryKey("GHSA-fixture-flatmap"),
        toKey: EVENT_STREAM_KEYS.flatmapStreamPackage,
        properties: { introduced: "0.1.1", fixed: "" },
      },
      {
        relType: "AFFECTS_VERSION",
        fromKey: advisoryKey("GHSA-fixture-flatmap"),
        toKey: EVENT_STREAM_KEYS.flatmapStreamVersion,
        properties: {},
      },
    ],
  });
}

/** Coverage that claims the whole scenario was ingested closed. */
export function buildEventStreamCoverage(): SliceCoverage {
  return buildSliceCoverage({
    closedPackageKeys: [
      EVENT_STREAM_KEYS.flatmapStreamPackage,
      EVENT_STREAM_KEYS.eventStreamPackage,
      EVENT_STREAM_KEYS.psTreePackage,
      EVENT_STREAM_KEYS.nodemonPackage,
      EVENT_STREAM_KEYS.chalkPackage,
    ],
    closedServiceKeys: [
      EVENT_STREAM_KEYS.checkoutApiService,
      EVENT_STREAM_KEYS.walletWebService,
      EVENT_STREAM_KEYS.docsSiteService,
    ],
  });
}
