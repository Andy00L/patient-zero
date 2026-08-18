/**
 * The graph data model: node labels, relationship types, and the property shapes
 * written to HydraDB.
 *
 * Naming rule for this file: graph-facing property types use the exact property
 * names stored in HydraDB (snake_case, with an explicit unit suffix where the
 * value is numeric). Keeping the TypeScript field name identical to the Cypher
 * property name removes a whole class of silent mismatch bugs, because a typo
 * fails to compile instead of returning undefined at runtime. Everything outside
 * these wire types uses normal camelCase.
 *
 * HydraDB addresses every node and relationship by a non-negative integer `id`
 * and patterns match on that id (see docs/HYDRADB.md). Natural keys such as
 * "npm:chalk:5.3.1" are therefore properties, not identities. The key to id
 * translation lives in src/lib/hydra/id-map.ts and every query resolves keys to
 * integer ids before it runs.
 */

export const ECOSYSTEMS = ["npm", "pypi"] as const;
export type Ecosystem = (typeof ECOSYSTEMS)[number];

export function isEcosystem(candidate: string): candidate is Ecosystem {
  return (ECOSYSTEMS as readonly string[]).includes(candidate);
}

/** Node labels. The values are the literal labels used in Cypher patterns. */
export const NODE_LABELS = {
  package: "Package",
  version: "Version",
  maintainer: "Maintainer",
  service: "Service",
  advisory: "Advisory",
} as const;

export type NodeLabel = (typeof NODE_LABELS)[keyof typeof NODE_LABELS];

/** Relationship types. The values are the literal types used in Cypher patterns. */
export const REL_TYPES = {
  /** (Version)-[:VERSION_OF]->(Package) */
  versionOf: "VERSION_OF",
  /** (Version)-[:DEPENDS_ON {range}]->(Package), the declared semver range. */
  dependsOn: "DEPENDS_ON",
  /** (Version)-[:RESOLVES_TO]->(Version), a concrete resolution from deps.dev. */
  resolvesTo: "RESOLVES_TO",
  /** (Version)-[:DEPENDED_ON_BY]->(Version), optional materialized reverse edge. */
  dependedOnBy: "DEPENDED_ON_BY",
  /** (Maintainer)-[:MAINTAINS]->(Package), publish rights proxy. */
  maintains: "MAINTAINS",
  /** (Service)-[:RESOLVED {resolved_at_ms}]->(Version), lockfile ground truth. */
  resolved: "RESOLVED",
  /** (Advisory)-[:AFFECTS {introduced, fixed}]->(Package), the range facts. */
  affects: "AFFECTS",
  /** (Advisory)-[:AFFECTS_VERSION]->(Version), range membership precomputed. */
  affectsVersion: "AFFECTS_VERSION",
  /** (Version)-[:TYPOSQUAT_OF {edit_distance}]->(Package) */
  typosquatOf: "TYPOSQUAT_OF",
} as const;

export type RelType = (typeof REL_TYPES)[keyof typeof REL_TYPES];

// ---------------------------------------------------------------------------
// Node property shapes (the wire shape written to and read from HydraDB)
// ---------------------------------------------------------------------------

/** Properties every node carries. `id` is assigned by the id-map, never guessed. */
type NodeBase = {
  id: number;
  /** Natural key, for display and debugging. Lookups go through the id-map. */
  key: string;
};

/**
 * What a numeric property holds when its source never reported a value. Never a real
 * reading: a package nobody downloads is 0, and a graph that answered "unknown" over a
 * figure some input was holding would state an absence of information that is not absent.
 *
 * Written by src/lib/ingest/graph-builder.ts (stub packages and stub versions, the rows the
 * registry fetch never reached) and by scripts/seed-incidents.ts (an incident pack records
 * an incident, not registry statistics, and a version known only from a lockfile line has
 * no publish clock). Read by src/lib/graph/merge-snapshots.ts, which lets a real reading
 * from either input win over it, and by the analysis layer, which refuses to place a time
 * window on it instead of treating it as an instant.
 */
export const UNKNOWN_NUMERIC_VALUE = -1;

export type PackageNode = NodeBase & {
  ecosystem: Ecosystem;
  name: string;
  /** Downloads in the last 7 days at ingest time. -1 when the registry had none. */
  weekly_downloads: number;
};

export type VersionNode = NodeBase & {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  /** Publish time as epoch milliseconds. -1 when the registry has no timestamp. */
  published_at_ms: number;
  /** True when the package manifest declares an install, preinstall or postinstall script. */
  has_install_script: boolean;
};

export type MaintainerNode = NodeBase & {
  ecosystem: Ecosystem;
  username: string;
};

/** Where a Service node came from. Uploaded services are session scoped. */
export const SERVICE_SOURCES = ["seed", "uploaded"] as const;
export type ServiceSource = (typeof SERVICE_SOURCES)[number];

export type ServiceNode = NodeBase & {
  name: string;
  source: ServiceSource;
};

export type AdvisoryNode = NodeBase & {
  ghsa_id: string;
  /** Advisory disclosure time as epoch milliseconds. This is the known-time clock. */
  published_at_ms: number;
  /** Last advisory modification as epoch milliseconds. */
  modified_at_ms: number;
  summary: string;
};

// ---------------------------------------------------------------------------
// Relationship property shapes
// ---------------------------------------------------------------------------

export type DependsOnProps = {
  /**
   * The declared semver range, verbatim from the manifest. Named version_range
   * rather than range because `range` is a Cypher function name and a bare `range`
   * key inside a map literal is needless ambiguity for the parser.
   */
  version_range: string;
};

export type ResolvedProps = {
  /** When the lockfile pinned this version, epoch milliseconds. Valid-time clock. */
  resolved_at_ms: number;
};

export type AffectsProps = {
  /** First affected version from the advisory range, or "" when open ended. */
  introduced: string;
  /** First fixed version from the advisory range, or "" when unfixed. */
  fixed: string;
};

export type TyposquatProps = {
  /** Damerau-Levenshtein distance between the two package names. */
  edit_distance: number;
};

// ---------------------------------------------------------------------------
// Property name registries
// ---------------------------------------------------------------------------

/**
 * Property names per label, in a stable order.
 *
 * HydraDB's Cypher subset cannot parameterise a property name, so every write and
 * every read spells its properties out in the query text. These registries are the
 * single source of that spelling: the batch writers assign from them and the readers
 * project from them, so a write and a read can never disagree about a name.
 *
 * `id` is absent on purpose. It is set by the MERGE pattern, not by the SET clause.
 */
export const NODE_PROPERTY_NAMES: Record<NodeLabel, readonly string[]> = {
  Package: ["key", "ecosystem", "name", "weekly_downloads"],
  Version: ["key", "ecosystem", "name", "version", "published_at_ms", "has_install_script"],
  Maintainer: ["key", "ecosystem", "username"],
  Service: ["key", "name", "source"],
  Advisory: ["key", "ghsa_id", "published_at_ms", "modified_at_ms", "summary"],
};

/** Relationship property names per type, in a stable order. Empty means no properties. */
export const REL_PROPERTY_NAMES: Record<RelType, readonly string[]> = {
  VERSION_OF: [],
  DEPENDS_ON: ["version_range"],
  RESOLVES_TO: [],
  DEPENDED_ON_BY: [],
  MAINTAINS: [],
  RESOLVED: ["resolved_at_ms"],
  AFFECTS: ["introduced", "fixed"],
  AFFECTS_VERSION: [],
  TYPOSQUAT_OF: ["edit_distance"],
};

/**
 * The endpoint labels each relationship type connects. The edge batch writer needs
 * both labels in the MATCH clause, and stating them here keeps a mislabelled edge
 * from being written at all.
 */
export const REL_ENDPOINTS: Record<RelType, { from: NodeLabel; to: NodeLabel }> = {
  VERSION_OF: { from: "Version", to: "Package" },
  DEPENDS_ON: { from: "Version", to: "Package" },
  RESOLVES_TO: { from: "Version", to: "Version" },
  DEPENDED_ON_BY: { from: "Version", to: "Version" },
  MAINTAINS: { from: "Maintainer", to: "Package" },
  RESOLVED: { from: "Service", to: "Version" },
  AFFECTS: { from: "Advisory", to: "Package" },
  AFFECTS_VERSION: { from: "Advisory", to: "Version" },
  TYPOSQUAT_OF: { from: "Version", to: "Package" },
};

/**
 * The property every algo.MSpaths selector matches on. Every label carries it, so
 * one multi-source traversal can start from any set of natural keys.
 */
export const SELECTOR_PROPERTY = "key";

// ---------------------------------------------------------------------------
// Natural keys
// ---------------------------------------------------------------------------

/**
 * Natural keys in the format the plan specifies, used as node `key` properties.
 * They are namespaced by label before entering the id-map (see mapKey below),
 * because a package literally named "@someone" would otherwise collide with a
 * maintainer key and two different nodes would share one integer id.
 */
export function packageKey(ecosystem: Ecosystem, name: string): string {
  return `${ecosystem}:${name}`;
}

export function versionKey(ecosystem: Ecosystem, name: string, version: string): string {
  return `${ecosystem}:${name}:${version}`;
}

export function maintainerKey(ecosystem: Ecosystem, username: string): string {
  return `${ecosystem}:${username}`;
}

export function serviceKey(name: string): string {
  return name;
}

export function advisoryKey(ghsaId: string): string {
  return ghsaId;
}

/**
 * The globally unique string the id-map hashes to an integer id. The label
 * prefix is what makes it unique across node kinds.
 */
export function mapKey(label: NodeLabel, key: string): string {
  return `${label}|${key}`;
}

/** Parses "npm:chalk:5.3.1" back into its parts. Package names may contain "/" and "@". */
export function parseVersionKey(
  key: string,
): { ecosystem: Ecosystem; name: string; version: string } | null {
  const firstSeparator = key.indexOf(":");
  const lastSeparator = key.lastIndexOf(":");
  if (firstSeparator <= 0 || lastSeparator <= firstSeparator) return null;

  const ecosystem = key.slice(0, firstSeparator);
  if (!isEcosystem(ecosystem)) return null;

  const name = key.slice(firstSeparator + 1, lastSeparator);
  const version = key.slice(lastSeparator + 1);
  if (name.length === 0 || version.length === 0) return null;

  return { ecosystem, name, version };
}

/** Parses "npm:chalk" back into its parts. */
export function parsePackageKey(key: string): { ecosystem: Ecosystem; name: string } | null {
  const separator = key.indexOf(":");
  if (separator <= 0) return null;

  const ecosystem = key.slice(0, separator);
  if (!isEcosystem(ecosystem)) return null;

  const name = key.slice(separator + 1);
  if (name.length === 0) return null;

  return { ecosystem, name };
}

/**
 * Parses the "name@version" spec a user types in the UI. Handles scoped npm
 * names, where the leading "@" is part of the name ("@babel/core@7.24.0").
 */
export function parsePackageSpec(spec: string): { name: string; version: string } | null {
  const trimmed = spec.trim();
  if (trimmed.length === 0) return null;

  const separator = trimmed.lastIndexOf("@");
  // A leading "@" at index 0 is a scope marker, not a version separator.
  if (separator <= 0) return null;

  const name = trimmed.slice(0, separator);
  const version = trimmed.slice(separator + 1);
  if (name.length === 0 || version.length === 0) return null;

  return { name, version };
}
