import { z } from "zod";

import {
  type HttpClientOptions,
  fetchJson,
  parseTimestampMs,
} from "@/lib/ingest/fetch-json";
import { normalizePypiName } from "@/lib/ingest/pypi";
import { type Ecosystem } from "@/lib/graph/model";
import { type Failure, type Result, fail, succeed } from "@/lib/result";

/**
 * Google Open Source Insights (deps.dev) v3 read client.
 *
 * This is the only source in the project that answers "what did this range actually
 * resolve to". A registry publishes declared ranges; deps.dev publishes the resolved
 * graph, which is what the blast-radius traversal needs, so the resolution edges in the
 * graph come from here and from nowhere else.
 *
 * Every path and field below was confirmed against a live response on 2026-08-17.
 * sourceRef: https://docs.deps.dev/api/v3/
 */

const DEPS_DEV_BASE_URL = "https://api.deps.dev/v3";

/**
 * The System enum, verbatim: "Can be one of GO, RUBYGEMS, NPM, CARGO, MAVEN, PYPI,
 * NUGET". Confirmed live: the response echoes "NPM" and "PYPI" in `packageKey.system`.
 * sourceRef: https://docs.deps.dev/api/v3/
 */
export const DEPS_DEV_SYSTEMS = [
  "GO",
  "RUBYGEMS",
  "NPM",
  "CARGO",
  "MAVEN",
  "PYPI",
  "NUGET",
] as const;

export type DepsDevSystem = (typeof DEPS_DEV_SYSTEMS)[number];

/**
 * The one place the project's ecosystem names meet deps.dev's system enum.
 *
 * Kept as an explicit table rather than an uppercase() call: "pypi" happens to
 * uppercase to the right value today, but the enum is a published contract and a future
 * ecosystem (Maven is "group:artifact", not a bare name) would break the coincidence
 * silently.
 */
const DEPS_DEV_SYSTEM_BY_ECOSYSTEM: Record<Ecosystem, DepsDevSystem> = {
  npm: "NPM",
  pypi: "PYPI",
};

/** Ecosystem to deps.dev system. Total over the project's ecosystems, so no Result. */
export function toDepsDevSystem(ecosystem: Ecosystem): DepsDevSystem {
  return DEPS_DEV_SYSTEM_BY_ECOSYSTEM[ecosystem];
}

/**
 * deps.dev system back to an ecosystem. A Result rather than a null: deps.dev serves
 * five systems this project does not model, and an unrecognised one must be reported,
 * not coerced into npm.
 */
export function fromDepsDevSystem(system: string): Result<Ecosystem, Failure> {
  for (const [ecosystem, mapped] of Object.entries(DEPS_DEV_SYSTEM_BY_ECOSYSTEM)) {
    if (mapped === system) return succeed(ecosystem as Ecosystem);
  }
  return fail(
    "unsupported",
    `[fromDepsDevSystem] deps.dev system "${system}" is not an ecosystem this project models`,
  );
}

/**
 * Node relations deps.dev reports. Confirmed live on chalk 4.1.2 and react-scripts
 * 5.0.1: exactly SELF, DIRECT, INDIRECT appear. The relation stays a raw string in the
 * domain type so an added value survives ingest instead of being flattened away.
 */
export const DEPS_DEV_RELATION_SELF = "SELF";
export const DEPS_DEV_RELATION_DIRECT = "DIRECT";
export const DEPS_DEV_RELATION_INDIRECT = "INDIRECT";

/** True for the node deps.dev calls the root of the resolved graph. */
export function isRootRelation(relation: string): boolean {
  return relation === DEPS_DEV_RELATION_SELF;
}

/**
 * True for a first-hop dependency. The distinction matters to the maintainer-surface
 * model: a direct dependency is a declared choice, an indirect one is inherited.
 */
export function isDirectRelation(relation: string): boolean {
  return relation === DEPS_DEV_RELATION_DIRECT;
}

// ---------------------------------------------------------------------------
// Wire schemas
// ---------------------------------------------------------------------------

/** Confirmed live: {"system":"NPM","name":"chalk"}. */
const PACKAGE_KEY_SCHEMA = z.looseObject({
  system: z.string(),
  name: z.string(),
});

/** Confirmed live: {"system":"NPM","name":"chalk","version":"5.3.0"}. */
const VERSION_KEY_SCHEMA = z.looseObject({
  system: z.string(),
  name: z.string(),
  version: z.string(),
});

/**
 * One entry of GetPackage's `versions`. Confirmed live on
 * /v3/systems/npm/packages/chalk.
 */
const PACKAGE_VERSION_SCHEMA = z.looseObject({
  versionKey: VERSION_KEY_SCHEMA,
  publishedAt: z.string().nullish(),
  isDefault: z.boolean().nullish(),
  isDeprecated: z.boolean().nullish(),
  deprecatedReason: z.string().nullish(),
});

const PACKAGE_SCHEMA = z.looseObject({
  packageKey: PACKAGE_KEY_SCHEMA,
  versions: z.array(PACKAGE_VERSION_SCHEMA).nullish(),
});

/**
 * GetVersion. Confirmed live on /v3/systems/npm/packages/lodash/versions/4.17.15, which
 * is also where the advisoryKeys shape [{"id":"GHSA-29mw-wpgm-hmr9"}] was confirmed.
 */
const VERSION_SCHEMA = z.looseObject({
  versionKey: VERSION_KEY_SCHEMA,
  publishedAt: z.string().nullish(),
  isDefault: z.boolean().nullish(),
  isDeprecated: z.boolean().nullish(),
  deprecatedReason: z.string().nullish(),
  licenses: z.array(z.string()).nullish(),
  advisoryKeys: z.array(z.looseObject({ id: z.string() })).nullish(),
  registries: z.array(z.string()).nullish(),
});

/**
 * GetDependencies. Confirmed live on chalk 4.1.2:
 * nodes[] carry versionKey, bundled, relation, errors; edges[] carry fromNode, toNode,
 * requirement; a top-level `error` string is "" when the graph resolved cleanly.
 *
 * `fromNode` defaults to 0 because it addresses an index and the API's JSON encoding
 * may omit a zero-valued field. Confirmed live that it is emitted, but a default costs
 * nothing and removes the failure mode entirely.
 */
const DEPENDENCY_NODE_SCHEMA = z.looseObject({
  versionKey: VERSION_KEY_SCHEMA,
  bundled: z.boolean().nullish(),
  relation: z.string(),
  errors: z.array(z.string()).nullish(),
});

const DEPENDENCY_EDGE_SCHEMA = z.looseObject({
  fromNode: z.number().int().nonnegative().default(0),
  toNode: z.number().int().nonnegative().default(0),
  requirement: z.string().nullish(),
});

const DEPENDENCIES_SCHEMA = z.looseObject({
  nodes: z.array(DEPENDENCY_NODE_SCHEMA),
  edges: z.array(DEPENDENCY_EDGE_SCHEMA).nullish(),
  error: z.string().nullish(),
});

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type DepsDevVersionRef = {
  /** Raw deps.dev system, preserved so a cross-system node is never silently relabelled. */
  system: string;
  /** null when deps.dev reports a system outside this project's two ecosystems. */
  ecosystem: Ecosystem | null;
  name: string;
  version: string;
};

export type DepsDevPackageVersion = {
  version: string;
  publishedAtMs: number | null;
  isDefault: boolean;
  isDeprecated: boolean;
  deprecationReason: string | null;
};

export type DepsDevPackageFacts = {
  system: string;
  ecosystem: Ecosystem | null;
  name: string;
  versions: DepsDevPackageVersion[];
};

export type DepsDevVersionFacts = DepsDevPackageVersion & {
  system: string;
  ecosystem: Ecosystem | null;
  name: string;
  licenses: string[];
  /** Advisory ids deps.dev attaches to this version, GHSA form. */
  advisoryIds: string[];
  registries: string[];
};

export type DepsDevGraphNode = DepsDevVersionRef & {
  /** deps.dev's own label: SELF, DIRECT, or INDIRECT. Preserved verbatim. */
  relation: string;
  /** Whether the dependency ships inside its parent's tarball rather than resolving. */
  isBundled: boolean;
  /** Per-node resolution problems deps.dev reports. Empty in a clean graph. */
  errors: string[];
};

export type DepsDevGraphEdge = {
  fromNodeIndex: number;
  toNodeIndex: number;
  /** The declared range that produced this resolution, verbatim. "" when unreported. */
  requirement: string;
};

export type DepsDevDependencyGraph = {
  /** Index of the node deps.dev marks SELF. -1 when no node carries that relation. */
  rootNodeIndex: number;
  nodes: DepsDevGraphNode[];
  edges: DepsDevGraphEdge[];
  /** Graph-level resolution error deps.dev reports. null when it sent "". */
  graphError: string | null;
};

// ---------------------------------------------------------------------------
// URL building
// ---------------------------------------------------------------------------

/**
 * Encodes one path segment for deps.dev.
 *
 * Percent-encoding is mandatory here, not optional: the docs require "All path and
 * query parameters must be encoded", and confirmed live that
 * /v3/systems/npm/packages/@babel/core answers 404 while
 * /v3/systems/npm/packages/%40babel%2Fcore answers 200.
 */
function encodeDepsDevSegment(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Applies the naming rule deps.dev documents per system before encoding. PyPI names go
 * through PEP 503 normalization; npm names are used as published.
 * sourceRef: https://docs.deps.dev/api/v3/
 */
export function canonicalizeDepsDevName(ecosystem: Ecosystem, name: string): string {
  return ecosystem === "pypi" ? normalizePypiName(name) : name;
}

export function buildDepsDevPackageUrl(ecosystem: Ecosystem, name: string): string {
  const system = toDepsDevSystem(ecosystem);
  const canonicalName = canonicalizeDepsDevName(ecosystem, name);
  return `${DEPS_DEV_BASE_URL}/systems/${system}/packages/${encodeDepsDevSegment(canonicalName)}`;
}

export function buildDepsDevVersionUrl(
  ecosystem: Ecosystem,
  name: string,
  version: string,
): string {
  return `${buildDepsDevPackageUrl(ecosystem, name)}/versions/${encodeDepsDevSegment(version)}`;
}

/**
 * The dependency endpoint. The trailing ":dependencies" is a literal method suffix in
 * the path, so the colon stays unencoded while the version before it is encoded.
 */
export function buildDepsDevDependenciesUrl(
  ecosystem: Ecosystem,
  name: string,
  version: string,
): string {
  return `${buildDepsDevVersionUrl(ecosystem, name, version)}:dependencies`;
}

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

/** Package metadata plus every version deps.dev knows, with publish times. */
export async function fetchDepsDevPackage(
  ecosystem: Ecosystem,
  name: string,
  options: HttpClientOptions = {},
): Promise<Result<DepsDevPackageFacts, Failure>> {
  const fetched = await fetchJson(
    { url: buildDepsDevPackageUrl(ecosystem, name), ...options },
    PACKAGE_SCHEMA,
  );
  if (!fetched.ok) return fetched;

  const packageKey = fetched.value.packageKey;
  return succeed({
    system: packageKey.system,
    ecosystem: readEcosystemOrNull(packageKey.system),
    name: packageKey.name,
    versions: (fetched.value.versions ?? []).map((entry) => ({
      version: entry.versionKey.version,
      publishedAtMs: parseTimestampMs(entry.publishedAt),
      isDefault: entry.isDefault ?? false,
      isDeprecated: entry.isDeprecated ?? false,
      deprecationReason: readNonEmptyString(entry.deprecatedReason),
    })),
  });
}

/** Version metadata: publish time, licences, and the advisories deps.dev attaches. */
export async function fetchDepsDevVersion(
  ecosystem: Ecosystem,
  name: string,
  version: string,
  options: HttpClientOptions = {},
): Promise<Result<DepsDevVersionFacts, Failure>> {
  const fetched = await fetchJson(
    { url: buildDepsDevVersionUrl(ecosystem, name, version), ...options },
    VERSION_SCHEMA,
  );
  if (!fetched.ok) return fetched;

  const record = fetched.value;
  return succeed({
    system: record.versionKey.system,
    ecosystem: readEcosystemOrNull(record.versionKey.system),
    name: record.versionKey.name,
    version: record.versionKey.version,
    publishedAtMs: parseTimestampMs(record.publishedAt),
    isDefault: record.isDefault ?? false,
    isDeprecated: record.isDeprecated ?? false,
    deprecationReason: readNonEmptyString(record.deprecatedReason),
    licenses: record.licenses ?? [],
    advisoryIds: (record.advisoryKeys ?? []).map((advisoryKey) => advisoryKey.id),
    registries: record.registries ?? [],
  });
}

/**
 * The resolved dependency graph for one exact version.
 *
 * Nothing is flattened on the way through: the SELF/DIRECT/INDIRECT relation, the
 * bundled flag, per-node errors and the graph-level error all survive into the domain
 * type, because the maintainer-surface model separates runtime reach from build-time
 * reach and cannot do that from a bare edge list.
 *
 * An edge whose index falls outside the node array is rejected rather than dropped: a
 * dangling edge would silently shrink a blast radius, which is the one error direction
 * this project must not make.
 */
export async function fetchDepsDevDependencyGraph(
  ecosystem: Ecosystem,
  name: string,
  version: string,
  options: HttpClientOptions = {},
): Promise<Result<DepsDevDependencyGraph, Failure>> {
  const fetched = await fetchJson(
    { url: buildDepsDevDependenciesUrl(ecosystem, name, version), ...options },
    DEPENDENCIES_SCHEMA,
  );
  if (!fetched.ok) return fetched;

  return readDependencyGraph(fetched.value, `${ecosystem}:${name}:${version}`);
}

type DependenciesResponse = z.infer<typeof DEPENDENCIES_SCHEMA>;

/** Split from the fetch so the index validation is testable against a fixture. */
export function readDependencyGraph(
  response: DependenciesResponse,
  describedSubject: string,
): Result<DepsDevDependencyGraph, Failure> {
  const nodes: DepsDevGraphNode[] = response.nodes.map((node) => ({
    system: node.versionKey.system,
    ecosystem: readEcosystemOrNull(node.versionKey.system),
    name: node.versionKey.name,
    version: node.versionKey.version,
    relation: node.relation,
    isBundled: node.bundled ?? false,
    errors: node.errors ?? [],
  }));

  const edges: DepsDevGraphEdge[] = [];
  for (const edge of response.edges ?? []) {
    if (edge.fromNode >= nodes.length || edge.toNode >= nodes.length) {
      return fail(
        "upstream_rejected",
        `[readDependencyGraph] deps.dev edge ${edge.fromNode}->${edge.toNode} for ${describedSubject} points outside its ${nodes.length} nodes`,
        { context: { nodeCount: nodes.length, fromNode: edge.fromNode, toNode: edge.toNode } },
      );
    }
    edges.push({
      fromNodeIndex: edge.fromNode,
      toNodeIndex: edge.toNode,
      requirement: edge.requirement ?? "",
    });
  }

  return succeed({
    rootNodeIndex: nodes.findIndex((node) => isRootRelation(node.relation)),
    nodes,
    edges,
    graphError: readNonEmptyString(response.error),
  });
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function readEcosystemOrNull(system: string): Ecosystem | null {
  const mapped = fromDepsDevSystem(system);
  return mapped.ok ? mapped.value : null;
}

/** deps.dev sends "" rather than omitting a string field, so "" means absent. */
function readNonEmptyString(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.length === 0) return null;
  return value;
}
