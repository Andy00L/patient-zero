import { z } from "zod";

import type { Verdict } from "@/lib/analysis/abstention";
import type { IndicatorSeverity } from "@/lib/scanner/indicators";
import type { ScanFinding } from "@/lib/scanner/persistence";

/**
 * The wire contract shared by POST /api/local-scan and the /local surface.
 *
 * It lives here, next to the surface, because three modules have to agree on it: the route
 * that produces it, the server component that renders the gate state, and the client console
 * that renders the result. A copy in each would drift, and the copy that drifted would be the
 * one telling somebody their machine is clean.
 *
 * Two constraints shape this file:
 *
 * 1. It is imported by a client component, so it holds no `node:` import, no `process.env`
 *    read at module scope, and no side effect. Every type import is `import type` so nothing
 *    from the scanner library is pulled into the browser bundle.
 * 2. The response is validated at runtime on arrival, not assumed from its TypeScript type.
 *    `await response.json()` is untyped, and a response the console failed to understand has
 *    to render as a failure. An unparsed body whose `findings` array is missing would render
 *    as an empty table, which reads as a clean bill of health for a scan that never happened.
 *    That is the one failure mode this feature must not have, so the schema below is the
 *    single definition and the TypeScript types are inferred from it.
 */

/** Environment variable that opts a machine into local filesystem scanning. */
export const LOCAL_SCAN_ENV_VARIABLE = "HYDRA_LOCAL_SCAN";

/**
 * The only value that opens the gate. A truthy-ish "1", "true" or "yes" is deliberately not
 * accepted: the operator has to have typed this exact word, so the gate cannot fall open
 * because some unrelated tooling exported the variable.
 */
export const LOCAL_SCAN_ENABLED_VALUE = "enabled";

/**
 * Whether this process may read the local filesystem on request.
 *
 * The environment record is a required parameter rather than defaulting to `process.env` as
 * `readSnapshotPathFromEnv` does in src/lib/hydra/config.ts, for the reason in constraint 1
 * above: this module is shared with a client component, and a `process.env` reference in a
 * browser bundle is replaced at build time rather than read at call time. Both call sites are
 * server-side and pass `process.env` themselves.
 */
export function isLocalScanGateOpen(environment: Record<string, string | undefined>): boolean {
  return environment[LOCAL_SCAN_ENV_VARIABLE] === LOCAL_SCAN_ENABLED_VALUE;
}

/**
 * Every distinct reason a scan request is refused. The kind travels in the failure envelope's
 * `context.refusal` so the surface can name the reason instead of printing one generic error,
 * and so a test can assert on the reason rather than on prose.
 *
 * Declared as a tuple so the union, the zod enum and the copy table below all derive from one
 * list. Adding a kind without adding its copy is a type error.
 */
export const LOCAL_SCAN_REFUSAL_KINDS = [
  "gate_closed",
  "malformed_request",
  "blank_path",
  "relative_path",
  "filesystem_root",
  "home_directory",
  "shared_temp",
  "foreign_mount",
  "outside_root",
  "path_not_found",
  "not_a_directory",
  "permission_denied",
  "scan_root_changed",
] as const;

export type LocalScanRefusalKind = (typeof LOCAL_SCAN_REFUSAL_KINDS)[number];

/** What the surface shows for a refusal. `title` doubles as the failure envelope's message. */
export type LocalScanRefusalCopy = {
  title: string;
  guidance: string;
};

/**
 * Refusal copy, written for the person who typed the path.
 *
 * Not one string here names a concrete path, a home directory, or a project location. The
 * rules are described by class ("outside the project directory", "a mounted drive") so a
 * refusal cannot be used to map the filesystem of the machine running this app. The route
 * builds its wire message from `title`, so there is one wording, not two that can disagree.
 */
export const LOCAL_SCAN_REFUSALS: Record<LocalScanRefusalKind, LocalScanRefusalCopy> = {
  gate_closed: {
    title: "Local scanning is switched off on this machine",
    guidance: `The scan reads the filesystem of whatever machine runs this app, so it stays closed until an operator opens it. Set ${LOCAL_SCAN_ENV_VARIABLE}=${LOCAL_SCAN_ENABLED_VALUE} for the server process and restart it. Leave it unset anywhere the app is reachable by someone else.`,
  },
  malformed_request: {
    title: "The scan request could not be read",
    guidance:
      "The request needs a JSON body carrying an absolute path and an explicit consent flag. Reload the page and run the scan from the form.",
  },
  blank_path: {
    title: "No path was given",
    guidance: "Type the absolute path of a directory inside the project, then run the scan.",
  },
  relative_path: {
    title: "The path is not absolute",
    guidance:
      "A relative path would be resolved against the server's working directory, which is not what you can see from here. Give the full path, starting at the filesystem root.",
  },
  filesystem_root: {
    title: "That path is a filesystem root",
    guidance:
      "The scan will not walk a whole volume. Point it at one checked-out repository instead.",
  },
  home_directory: {
    title: "That path is a home directory",
    guidance:
      "A home directory holds keys, shell history and browser profiles that have nothing to do with a dependency tree. The scan will not read one.",
  },
  shared_temp: {
    title: "That path is a shared temporary directory",
    guidance:
      "Any process on this machine can write there, so an indicator found in it says nothing about this project.",
  },
  foreign_mount: {
    title: "That path crosses onto a mounted drive",
    guidance:
      "Under WSL a /mnt/<drive> path is the Windows filesystem, which is outside this session's tree. The scan stays on this side of the mount.",
  },
  outside_root: {
    title: "That path is outside the project directory",
    guidance:
      "The scan is confined to the tree the server was started in. Symlinks are resolved to their real path before this check, so a link pointing out of the project is refused here too.",
  },
  path_not_found: {
    title: "No directory exists at that path",
    guidance: "Check the spelling and run the scan again.",
  },
  not_a_directory: {
    title: "That path is not a directory",
    guidance:
      "The scan walks a tree. Give it the directory that holds the files, not a single file.",
  },
  permission_denied: {
    title: "This process cannot read that path",
    guidance:
      "The scan reads with the permissions of the process running this app and escalates nothing. Pick a path that process can already read.",
  },
  scan_root_changed: {
    title: "The directory changed while the scan was starting",
    guidance:
      "It was there when the path was checked and gone when the walk began. Run the scan again.",
  },
};

/**
 * Every reason a completed walk cannot support "nothing is here".
 *
 * The four cap ids mirror `ScanTruncationReason` in src/lib/scanner/persistence.ts. The other
 * two come from the report's counters. Any one of them present forces the verdict to
 * `unknown`, because a walk that stopped early and found nothing has not found nothing.
 */
export const LOCAL_SCAN_LIMIT_IDS = [
  "file_cap",
  "byte_cap",
  "depth_cap",
  "finding_cap",
  "unreadable_paths",
  "skipped_symlinks",
] as const;

export type LocalScanLimitId = (typeof LOCAL_SCAN_LIMIT_IDS)[number];

/**
 * One finding as it crosses the wire.
 *
 * `satisfies` ties the schema to the library's own type: if `ScanFinding` grows a field or
 * changes one, this line stops compiling instead of silently shipping a different shape. The
 * schema itself is what makes the response safe to read without a type assertion.
 *
 * sourceRef: src/lib/scanner/persistence.ts (ScanFinding)
 */
const FINDING_SCHEMA = z.object({
  indicatorId: z.string().min(1),
  severity: z.enum(["high", "medium", "low"]),
  relativePath: z.string(),
  lineNumber: z.number().int().positive().nullable(),
  title: z.string().min(1),
  explanation: z.string().min(1),
  packageName: z.string().min(1).nullable(),
}) satisfies z.ZodType<ScanFinding>;

/** Counters from the walk. Numbers only: no path, no name, no byte of any file read. */
const WALK_SCHEMA = z.object({
  filesVisited: z.number().int().nonnegative(),
  bytesRead: z.number().int().nonnegative(),
  unreadablePathCount: z.number().int().nonnegative(),
  skippedOutsideRootCount: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
});

const VERDICT_SCHEMA = z.enum(["exposed", "unknown", "not_exposed"]) satisfies z.ZodType<Verdict>;

const SEVERITY_COUNTS_SCHEMA = z.object({
  high: z.number().int().nonnegative(),
  medium: z.number().int().nonnegative(),
  low: z.number().int().nonnegative(),
}) satisfies z.ZodType<Record<IndicatorSeverity, number>>;

/** The body of a scan that ran. `ok` comes from `jsonOk`, which spreads the payload beside it. */
export const LOCAL_SCAN_SUCCESS_SCHEMA = z.object({
  ok: z.literal(true),
  /** Directory name of the scanned root. Never its absolute path. */
  rootLabel: z.string().min(1),
  verdict: VERDICT_SCHEMA,
  /** One sentence explaining how the verdict was reached, written for a person. */
  rationale: z.string().min(1),
  limits: z.array(z.object({ id: z.enum(LOCAL_SCAN_LIMIT_IDS), described: z.string().min(1) })),
  findings: z.array(FINDING_SCHEMA),
  counts: z.object({ bySeverity: SEVERITY_COUNTS_SCHEMA, total: z.number().int().nonnegative() }),
  walk: WALK_SCHEMA,
});

/** The failure envelope, narrowed to the `refusal` discriminator this surface reads. */
export const LOCAL_SCAN_FAILURE_SCHEMA = z.object({
  ok: z.literal(false),
  error: z.object({
    reason: z.string().min(1),
    message: z.string().min(1),
    context: z.object({ refusal: z.enum(LOCAL_SCAN_REFUSAL_KINDS) }).optional(),
  }),
});

export type LocalScanSuccessBody = z.infer<typeof LOCAL_SCAN_SUCCESS_SCHEMA>;
export type LocalScanLimit = LocalScanSuccessBody["limits"][number];

/**
 * What the console sends.
 *
 * `consent` is a literal `true` rather than a boolean, so a body that omits it, or that carries
 * a replayed `false`, is refused by the schema instead of reaching the walk. That is the opt-in
 * rule expressed in a type: there is no request shape that scans without asking for it.
 *
 * `path` allows an empty string on purpose. The route wants to answer "no path was given" with
 * its own refusal, and a schema rejection would collapse that into a generic parse failure.
 * The length ceiling is PATH_MAX on Linux, so anything longer cannot name a real path.
 */
export const LOCAL_SCAN_REQUEST_SCHEMA = z.object({
  path: z.string().max(4096),
  consent: z.literal(true),
});

export type LocalScanRequest = z.infer<typeof LOCAL_SCAN_REQUEST_SCHEMA>;

/**
 * Print order for findings and for the severity readout: worst first.
 *
 * sourceRef: src/lib/scanner/indicators.ts (IndicatorSeverity), and the same ranking as
 * SEVERITY_PRINT_RANK in scripts/scan-local.ts, so the CLI and the surface list one tree in
 * the same order.
 */
export const SEVERITY_RANK: Record<IndicatorSeverity, number> = { high: 0, medium: 1, low: 2 };

/** Severities worst first, for a readout that has to render all three. */
export const SEVERITIES_WORST_FIRST: readonly IndicatorSeverity[] = ["high", "medium", "low"];

/**
 * Severity as a row label. Written out rather than capitalised at the call site, because
 * `FieldLabel` is sentence case and the bare catalogue value is lower case.
 */
export const SEVERITY_LABELS: Record<IndicatorSeverity, string> = {
  high: "High severity",
  medium: "Medium severity",
  low: "Low severity",
};
