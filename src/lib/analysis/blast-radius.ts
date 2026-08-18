import {
  type AbstainingAnswer,
  type AnswerLimit,
  buildAnswer,
  buildUnknownAnswer,
  budgetLimitFromContext,
  decideVerdict,
  detectHopLimit,
  detectPathLimit,
} from "@/lib/analysis/abstention";
import {
  type GraphGateway,
  type GraphPath,
  type GraphPathNode,
  type GraphProperties,
  isGraphEmpty,
  readNumberProperty,
  readStringProperty,
} from "@/lib/graph/gateway";
import {
  type Ecosystem,
  type RelType,
  packageKey,
  parseVersionKey,
} from "@/lib/graph/model";
import type { SliceCoverage } from "@/lib/graph/slice-manifest";
import { type Failure, type Result, fail, succeed } from "@/lib/result";

/**
 * Blast radius: who is transitively exposed to a compromised package version, through
 * which exact path, and at what hop distance.
 *
 * This is the question the whole project exists to answer, and the shape of the graph
 * is what makes it one traversal instead of a recursive crawl.
 *
 * Two engine facts decide the algorithm:
 *
 *   1. The native path procedures take a direction: relDirection accepts "incoming",
 *      "outgoing", or "both". RESOLVES_TO runs from a version to the version it resolved
 *      a dependency to, so "who depends on me" can be read either as an incoming walk
 *      over RESOLVES_TO or as an outgoing walk over the materialised reverse type
 *      DEPENDED_ON_BY. This module asks for the reverse type explicitly because the two
 *      read different indexes and do not cost the same; scripts/measure-traversal.ts is
 *      what settles the choice per slice. Either way one call returns every dependent at
 *      every depth, with the full path hydrated.
 *      sourceRef: docs/HYDRADB.md, relDirection.
 *
 *   2. RESOLVED runs Service to Version, and there is no materialised reverse type for
 *      it, so the services that consume a reachable version are not found by asking for
 *      one. Instead this module walks from the small side: it enumerates the Service
 *      nodes, which number in the tens, and expands each one forward over RESOLVED. The
 *      request count is then the number of services rather than the number of reachable
 *      versions, which for a real incident is four orders of magnitude smaller.
 *
 * Every answer is an AbstainingAnswer. An empty exposure list is not the same claim as
 * "not exposed", and this module never conflates them.
 */

/** One node on an explained exposure path. */
export type ExposureStep = {
  nodeKind: "service" | "version";
  /** Natural key, stable across runs and safe to use as a React key. */
  key: string;
  /** Service name, or `name@version` for a version. What a person reads. */
  displayName: string;
  /** null on a service step. */
  version: string | null;
  /** The relationship traversed to arrive at this step. null on the first step. */
  viaRelType: RelType | null;
  /** Lockfile resolution time, present only on the step reached over RESOLVED. */
  resolvedAtMs: number | null;
};

/**
 * A path read in the direction a person thinks about it: the service first, the
 * compromised version last. The traversal produces the opposite order, so this is
 * reversed on the way out.
 */
export type ExposurePath = {
  steps: ExposureStep[];
  /** Relationship count, so `steps.length` is always `hopCount + 1`. */
  hopCount: number;
};

export type ServiceExposure = {
  serviceKey: string;
  serviceName: string;
  /** Hops from the service to the compromised version. 1 means a direct dependency. */
  hopCount: number;
  isDirectDependency: boolean;
  /** The shortest route found. Shortest is the one worth showing first. */
  shortestPath: ExposurePath;
  /** How many distinct routes reach the compromised version from this service. */
  pathCount: number;
};

/** A dependent version, which is the package-level half of the same answer. */
export type VersionExposure = {
  versionKey: string;
  ecosystem: Ecosystem;
  name: string;
  version: string;
  /** Hops from this version down to the compromised version. */
  hopCount: number;
  shortestPath: ExposurePath;
};

export type CompromisedSubject = {
  versionKey: string;
  packageKey: string;
  ecosystem: Ecosystem;
  name: string;
  version: string;
  nodeId: number | null;
};

export type BlastRadiusEvidence = {
  compromised: CompromisedSubject;
  /** Ordered by hop count ascending, then by name. Closest blast first. */
  exposedServices: ServiceExposure[];
  exposedVersions: VersionExposure[];
  /** Deepest hop count actually observed, which is not the same as the hop ceiling. */
  maxHopReached: number;
  /** How many Service nodes were examined, for the scan_capped limit. */
  servicesConsidered: number;
};

export type BlastRadiusOptions = {
  /**
   * Hop ceiling on the dependent walk. Eight covers the deepest real resolution chain
   * this project has measured while leaving headroom under the engine's 16 hop cap. A
   * path that actually reaches it is recorded as a hop_limit rather than ignored.
   */
  maxHops?: number;
  /**
   * Path ceiling. A widely depended-on package produces enormously many distinct
   * routes, and the answer only needs enough of them to explain each dependent.
   */
  pathCount?: number;
  /**
   * Ceiling on Service nodes enumerated. Services come from real lockfiles, so this is
   * generous; reaching it is recorded as a scan_capped limit.
   */
  maxServices?: number;
  /** Ceiling on RESOLVED edges read per service. A lockfile has a few thousand. */
  resolvedEdgesPerService?: number;
};

const DEFAULT_MAX_HOPS = 8;
const DEFAULT_PATH_COUNT = 20_000;
const DEFAULT_MAX_SERVICES = 5_000;
const DEFAULT_RESOLVED_EDGES_PER_SERVICE = 20_000;

export type BlastRadiusRequest = {
  gateway: GraphGateway;
  coverage: SliceCoverage;
  /** The compromised version, as `ecosystem:name:version`. */
  versionKey: string;
  options?: BlastRadiusOptions;
};

/**
 * Answers the blast radius question.
 *
 * Returns a Failure only when the graph itself could not be read. A subject that is
 * missing, a slice that cannot decide, and a traversal that was cut short are all
 * answers, and they come back as an `unknown` verdict carrying the reason.
 */
export async function computeBlastRadius(
  request: BlastRadiusRequest,
): Promise<Result<AbstainingAnswer<BlastRadiusEvidence>, Failure>> {
  const parsed = parseVersionKey(request.versionKey);
  if (parsed === null) {
    return fail(
      "invalid_input",
      `[computeBlastRadius] "${request.versionKey}" is not an ecosystem:name:version key`,
    );
  }

  const maxHops = request.options?.maxHops ?? DEFAULT_MAX_HOPS;
  const pathCount = request.options?.pathCount ?? DEFAULT_PATH_COUNT;
  const maxServices = request.options?.maxServices ?? DEFAULT_MAX_SERVICES;
  const resolvedEdgesPerService =
    request.options?.resolvedEdgesPerService ?? DEFAULT_RESOLVED_EDGES_PER_SERVICE;

  const subject: CompromisedSubject = {
    versionKey: request.versionKey,
    packageKey: packageKey(parsed.ecosystem, parsed.name),
    ecosystem: parsed.ecosystem,
    name: parsed.name,
    version: parsed.version,
    nodeId: null,
  };

  const emptyEvidence = (): BlastRadiusEvidence => ({
    compromised: subject,
    exposedServices: [],
    exposedVersions: [],
    maxHopReached: 0,
    servicesConsidered: 0,
  });

  const resolved = await request.gateway.resolveNodeIds({
    label: "Version",
    keys: [request.versionKey],
  });
  if (!resolved.ok) return resolved;

  const sourceNodeId = resolved.value.get(request.versionKey);
  const graphIsEmpty = await isGraphEmpty(request.gateway);
  if (!graphIsEmpty.ok) return graphIsEmpty;

  if (sourceNodeId === undefined) {
    // The version is provably not a node. Coverage is passed as absent regardless of
    // what the manifest says about the package, because the question was asked about
    // this version: a package whose closure was ingested can still be missing a
    // version that never existed, and either way there is nothing to traverse from.
    return succeed(
      buildAnswer(
        decideVerdict({
          foundEvidence: false,
          subjectCoverage: "absent",
          subjectKey: request.versionKey,
          limits: [],
          graphIsEmpty: graphIsEmpty.value,
        }),
        emptyEvidence(),
      ),
    );
  }
  subject.nodeId = sourceNodeId;

  const paths = await request.gateway.pathsFromSource({
    sourceNodeId,
    relTypes: ["DEPENDED_ON_BY"],
    direction: "outgoing",
    maxLength: maxHops,
    pathCount,
  });
  if (!paths.ok) {
    // A budget rejection is a truncated answer, not a broken one: the UI has to say
    // "we could not finish" rather than render an empty exposure list.
    if (paths.failure.reason === "query_budget_exceeded") {
      return succeed(
        buildUnknownAnswer(
          `The dependent walk from ${request.versionKey} exceeded an engine budget, so the blast radius is incomplete.`,
          emptyEvidence(),
          [budgetLimitFromContext(paths.failure.context)],
        ),
      );
    }
    return paths;
  }

  const limits: AnswerLimit[] = [];
  const hopLimit = detectHopLimit(paths.value, maxHops);
  if (hopLimit !== null) limits.push(hopLimit);
  const pathLimit = detectPathLimit(paths.value, pathCount);
  if (pathLimit !== null) limits.push(pathLimit);

  const reachable = indexReachableVersions(paths.value, sourceNodeId);

  const compromisedRead = await request.gateway.readNodes({
    label: "Version",
    nodeIds: [sourceNodeId],
  });
  if (!compromisedRead.ok) return compromisedRead;
  const compromisedNode = compromisedRead.value[0];
  const compromisedDisplay =
    compromisedNode === undefined
      ? `${parsed.name}@${parsed.version}`
      : displayVersion(compromisedNode.properties, parsed.name, parsed.version);

  const services = await collectServiceExposures({
    gateway: request.gateway,
    reachable,
    sourceNodeId,
    compromisedKey: request.versionKey,
    compromisedDisplay,
    maxServices,
    resolvedEdgesPerService,
  });
  if (!services.ok) return services;

  if (services.value.scanWasCapped) {
    limits.push({
      kind: "scan_capped",
      examined: services.value.servicesConsidered,
      total: maxServices,
    });
  }

  const exposedVersions = buildVersionExposures(reachable, request.versionKey);

  const evidence: BlastRadiusEvidence = {
    compromised: subject,
    exposedServices: services.value.exposures,
    exposedVersions,
    maxHopReached: deepestHop(reachable),
    servicesConsidered: services.value.servicesConsidered,
  };

  const foundEvidence =
    evidence.exposedServices.length > 0 || evidence.exposedVersions.length > 0;

  return succeed(
    buildAnswer(
      decideVerdict({
        foundEvidence,
        subjectCoverage: request.coverage.describePackageCoverage(subject.packageKey),
        subjectKey: request.versionKey,
        limits,
        graphIsEmpty: graphIsEmpty.value,
      }),
      evidence,
    ),
  );
}

/** A reachable dependent version, with the shortest route back to the compromised one. */
type ReachableVersion = {
  nodeId: number;
  node: GraphPathNode;
  hopCount: number;
  /** Path nodes ordered from the compromised version outward to this one. */
  outwardNodes: GraphPathNode[];
  outwardRelTypes: string[];
  /** How many distinct routes reached this version within the path budget. */
  routeCount: number;
};

/**
 * Collapses the returned paths into one entry per reachable version, keeping the
 * shortest route.
 *
 * The traversal returns every simple path, so a diamond in the dependency graph yields
 * several routes to the same version. A blast radius counts each exposed thing once
 * and explains it with its shortest route, so the collapse happens here rather than in
 * the UI, and the discarded routes are still counted.
 */
function indexReachableVersions(
  paths: readonly GraphPath[],
  sourceNodeId: number,
): Map<number, ReachableVersion> {
  const reachable = new Map<number, ReachableVersion>();

  for (const path of paths) {
    const tail = path.nodes[path.nodes.length - 1];
    if (tail === undefined || tail.id === sourceNodeId) continue;

    const existing = reachable.get(tail.id);
    if (existing !== undefined) {
      existing.routeCount += 1;
      if (path.hopCount >= existing.hopCount) continue;
      existing.hopCount = path.hopCount;
      existing.outwardNodes = path.nodes;
      existing.outwardRelTypes = path.relationships.map((edge) => edge.relType);
      continue;
    }

    reachable.set(tail.id, {
      nodeId: tail.id,
      node: tail,
      hopCount: path.hopCount,
      outwardNodes: path.nodes,
      outwardRelTypes: path.relationships.map((edge) => edge.relType),
      routeCount: 1,
    });
  }

  return reachable;
}

type ServiceCollectionRequest = {
  gateway: GraphGateway;
  reachable: Map<number, ReachableVersion>;
  sourceNodeId: number;
  compromisedKey: string;
  compromisedDisplay: string;
  maxServices: number;
  resolvedEdgesPerService: number;
};

type ServiceCollection = {
  exposures: ServiceExposure[];
  servicesConsidered: number;
  scanWasCapped: boolean;
};

/**
 * Finds the services exposed to the compromised version.
 *
 * Walks from the service side because RESOLVED has no materialised reverse type: see
 * the module comment. A service is exposed when any version it resolved is either the
 * compromised version itself or a version that transitively depends on it.
 */
async function collectServiceExposures(
  request: ServiceCollectionRequest,
): Promise<Result<ServiceCollection, Failure>> {
  const serviceIds = await request.gateway.listNodeIds({
    label: "Service",
    limit: request.maxServices,
  });
  if (!serviceIds.ok) return serviceIds;

  if (serviceIds.value.length === 0) {
    return succeed({ exposures: [], servicesConsidered: 0, scanWasCapped: false });
  }

  const serviceRecords = await request.gateway.readNodes({
    label: "Service",
    nodeIds: serviceIds.value,
  });
  if (!serviceRecords.ok) return serviceRecords;

  const serviceNameById = new Map<number, { key: string; name: string }>();
  for (const record of serviceRecords.value) {
    const key = readStringProperty(record.properties, "key") ?? `service:${record.id}`;
    const name = readStringProperty(record.properties, "name") ?? key;
    serviceNameById.set(record.id, { key, name });
  }

  const exposures: ServiceExposure[] = [];

  for (const serviceId of serviceIds.value) {
    const edges = await request.gateway.neighbors({
      nodeId: serviceId,
      nodeLabel: "Service",
      relType: "RESOLVED",
      direction: "outgoing",
      limit: request.resolvedEdgesPerService,
    });
    if (!edges.ok) return edges;

    let best: {
      hopCount: number;
      resolvedAtMs: number | null;
      reached: ReachableVersion | null;
    } | null = null;
    let routeCount = 0;

    for (const edge of edges.value) {
      const resolvedAtMs = readNumberProperty(edge.properties, "resolved_at_ms");

      if (edge.otherNodeId === request.sourceNodeId) {
        // The service resolved the compromised version itself: one hop, nothing closer.
        routeCount += 1;
        if (best === null || best.hopCount > 1) {
          best = { hopCount: 1, resolvedAtMs, reached: null };
        }
        continue;
      }

      const reached = request.reachable.get(edge.otherNodeId);
      if (reached === undefined) continue;

      routeCount += reached.routeCount;
      const hopCount = reached.hopCount + 1;
      if (best === null || hopCount < best.hopCount) {
        best = { hopCount, resolvedAtMs, reached };
      }
    }

    if (best === null) continue;

    const identity = serviceNameById.get(serviceId) ?? {
      key: `service:${serviceId}`,
      name: `service:${serviceId}`,
    };

    exposures.push({
      serviceKey: identity.key,
      serviceName: identity.name,
      hopCount: best.hopCount,
      isDirectDependency: best.hopCount === 1,
      shortestPath: buildExposurePath({
        serviceKey: identity.key,
        serviceName: identity.name,
        resolvedAtMs: best.resolvedAtMs,
        reached: best.reached,
        compromisedKey: request.compromisedKey,
        compromisedDisplay: request.compromisedDisplay,
      }),
      pathCount: routeCount,
    });
  }

  exposures.sort(compareExposures);

  return succeed({
    exposures,
    servicesConsidered: serviceIds.value.length,
    scanWasCapped: serviceIds.value.length >= request.maxServices,
  });
}

type ExposurePathRequest = {
  serviceKey: string;
  serviceName: string;
  resolvedAtMs: number | null;
  /** null when the service resolved the compromised version directly. */
  reached: ReachableVersion | null;
  compromisedKey: string;
  compromisedDisplay: string;
};

/**
 * Renders the explained path, service first.
 *
 * The traversal produced its nodes running outward from the compromised version, which
 * is the opposite of how the answer reads, so the version chain is reversed and the
 * service is prepended. The relationship labels shift with it: step i is reached over
 * the relationship that connected it to step i minus one.
 */
function buildExposurePath(request: ExposurePathRequest): ExposurePath {
  const steps: ExposureStep[] = [
    {
      nodeKind: "service",
      key: request.serviceKey,
      displayName: request.serviceName,
      version: null,
      viaRelType: null,
      resolvedAtMs: null,
    },
  ];

  if (request.reached === null) {
    // The version is known from the key that was queried, so the step carries it rather
    // than leaving the UI to re-parse the display name.
    const parsedCompromised = parseVersionKey(request.compromisedKey);
    steps.push({
      nodeKind: "version",
      key: request.compromisedKey,
      displayName: request.compromisedDisplay,
      version: parsedCompromised === null ? null : parsedCompromised.version,
      viaRelType: "RESOLVED",
      resolvedAtMs: request.resolvedAtMs,
    });
    return { steps, hopCount: 1 };
  }

  const inwardNodes = [...request.reached.outwardNodes].reverse();

  for (let index = 0; index < inwardNodes.length; index += 1) {
    const node = inwardNodes[index];
    if (node === undefined) continue;

    const key = readStringProperty(node.properties, "key") ?? `version:${node.id}`;
    const name = readStringProperty(node.properties, "name");
    const version = readStringProperty(node.properties, "version");

    steps.push({
      nodeKind: "version",
      key,
      displayName:
        name === null || version === null ? key : `${name}@${version}`,
      version,
      // The first version step is the one the service resolved; every later step was
      // reached by following the dependency inward, which is RESOLVES_TO read in the
      // direction a person walks it.
      viaRelType: index === 0 ? "RESOLVED" : "RESOLVES_TO",
      resolvedAtMs: index === 0 ? request.resolvedAtMs : null,
    });
  }

  return { steps, hopCount: steps.length - 1 };
}

function buildVersionExposures(
  reachable: Map<number, ReachableVersion>,
  compromisedKey: string,
): VersionExposure[] {
  const exposures: VersionExposure[] = [];

  for (const reached of reachable.values()) {
    const key = readStringProperty(reached.node.properties, "key");
    if (key === null) continue;

    // The ecosystem comes from the key rather than the property, so a node written
    // without a full property set still yields a well-typed ecosystem instead of a
    // guessed default.
    const parsed = parseVersionKey(key);
    if (parsed === null) continue;

    exposures.push({
      versionKey: key,
      ecosystem: parsed.ecosystem,
      name: readStringProperty(reached.node.properties, "name") ?? parsed.name,
      version: readStringProperty(reached.node.properties, "version") ?? parsed.version,
      hopCount: reached.hopCount,
      shortestPath: buildVersionOnlyPath(reached, compromisedKey),
    });
  }

  exposures.sort((left, right) =>
    left.hopCount === right.hopCount
      ? left.versionKey.localeCompare(right.versionKey)
      : left.hopCount - right.hopCount,
  );

  return exposures;
}

/** The same reversal as buildExposurePath, without a service at the head. */
function buildVersionOnlyPath(
  reached: ReachableVersion,
  compromisedKey: string,
): ExposurePath {
  const inwardNodes = [...reached.outwardNodes].reverse();
  const steps: ExposureStep[] = [];

  for (let index = 0; index < inwardNodes.length; index += 1) {
    const node = inwardNodes[index];
    if (node === undefined) continue;
    const key = readStringProperty(node.properties, "key") ?? compromisedKey;
    const name = readStringProperty(node.properties, "name");
    const version = readStringProperty(node.properties, "version");
    steps.push({
      nodeKind: "version",
      key,
      displayName: name === null || version === null ? key : `${name}@${version}`,
      version,
      viaRelType: index === 0 ? null : "RESOLVES_TO",
      resolvedAtMs: null,
    });
  }

  return { steps, hopCount: Math.max(steps.length - 1, 0) };
}

function compareExposures(left: ServiceExposure, right: ServiceExposure): number {
  if (left.hopCount !== right.hopCount) return left.hopCount - right.hopCount;
  return left.serviceName.localeCompare(right.serviceName);
}

function deepestHop(reachable: Map<number, ReachableVersion>): number {
  let deepest = 0;
  for (const reached of reachable.values()) {
    if (reached.hopCount > deepest) deepest = reached.hopCount;
  }
  return deepest;
}

function displayVersion(
  properties: GraphProperties,
  fallbackName: string,
  fallbackVersion: string,
): string {
  const name = readStringProperty(properties, "name") ?? fallbackName;
  const version = readStringProperty(properties, "version") ?? fallbackVersion;
  return `${name}@${version}`;
}
