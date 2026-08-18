import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import { DataValue, FieldLabel, UnitSuffix } from "@/components/ui/text";
import { AdvisoryChip } from "@/components/ui/verdict";
import { formatCount } from "@/lib/format";
import { type Indicator, type IndicatorSeverity, PERSISTENCE_INDICATORS } from "@/lib/scanner/indicators";

import { LOCAL_SCAN_REFUSALS, SEVERITIES_WORST_FIRST, SEVERITY_LABELS } from "./scan-contract";

/**
 * What a local scan does, stated before one runs.
 *
 * A tool that reads a person's filesystem earns that by declaring its own limits up front, so
 * these panels are part of the feature rather than documentation about it. Two of them answer the
 * two questions somebody needs before pressing the button: what will this read, and what would
 * "nothing found" actually mean. The third covers the machine that never opted in.
 *
 * All three are server components with no state and no interactivity. Their content is fixed by
 * the indicator catalogue, so none of it belongs in the client bundle.
 */

/**
 * The scan's own properties, in the order that matters to somebody deciding whether to run it:
 * what it does, what it refuses to do, when it runs, where it stops, and what bounds it.
 *
 * Every line is a property POST /api/local-scan enforces and test/local-scan-route.test.ts
 * checks. A claim here that the route did not enforce would be worse than showing no panel.
 */
const SCAN_PROPERTIES: readonly { label: string; described: string }[] = [
  {
    label: "Mode",
    described:
      "Read only. Files are opened for reading and closed. Nothing is written, moved, renamed, deleted, or executed, and no process is started.",
  },
  {
    label: "Reads",
    described:
      "Files under the directory you name, including its node_modules tree. Build output, package caches and the git object store are skipped, and binary files are counted but not scanned.",
  },
  {
    label: "Reports",
    described:
      "The indicator that matched, its severity, the path relative to the directory you named, and the line number of the match.",
  },
  {
    label: "Never reports",
    described:
      "File contents, the matched line itself, environment values, tokens, and the absolute path of anything on this machine. A matched file is treated as if it held real credentials.",
  },
  {
    label: "Runs",
    described:
      "Once, when you press the button, for the one path in that request. Nothing scans on page load, nothing scans on a timer, and no path is kept for a second run.",
  },
  {
    label: "Stays inside",
    described:
      "The directory this server was started in. Your path is resolved to its real path before the check, so a symlink pointing out of that tree is refused, and a symlink found during the walk is counted rather than followed.",
  },
  {
    label: "Bounded by",
    described:
      "Caps on files visited, bytes read and directory depth. A run that reaches one names the cap and drops its verdict to unknown, because a walk that stopped early has not found nothing.",
  },
  {
    label: "Logs",
    described: "Nothing. A scan writes no log line, so the path you type does not end up in one.",
  },
];

/**
 * What the indicator set cannot see. This list is the reason an empty result is reported as
 * "no indicator matched" instead of as a clean machine: each line is a way a compromise stays
 * invisible to a pattern set, and a reader who has only seen the empty table needs all four.
 */
const COVERAGE_GAPS: readonly string[] = [
  "Malicious behaviour in general. The set matches published indicators from real incidents, not intent, so a technique nobody has written up yet is not in it.",
  "Payloads with no fingerprint. An obfuscated dropper with no install hook, no known filename and no known host looks like ordinary code to a pattern set.",
  "Integrity. Nothing here is compared against a registry, a signature, or a lockfile hash, so a tampered copy of a legitimate file passes.",
  "Anything not on disk in the directory you name. A compromised version this machine never installed, and a machine other than this one, leave nothing for it to find.",
  "The future. A scan reports what was on disk while it ran, not what an install or a hook does next.",
];

/**
 * The catalogue grouped worst first, computed once per server process. The catalogue is a frozen
 * constant, so recomputing this per render would buy nothing. Empty groups are dropped: the set
 * currently carries no low-severity indicator, and an empty heading reads as a rendering fault.
 */
const INDICATOR_GROUPS: readonly { severity: IndicatorSeverity; indicators: readonly Indicator[] }[] =
  SEVERITIES_WORST_FIRST.map((severity) => ({
    severity,
    indicators: PERSISTENCE_INDICATORS.filter((indicator) => indicator.severity === severity),
  })).filter((group) => group.indicators.length > 0);

/** The read-only contract, as eight properties a reader can check against the route. */
export function ScanScopePanel() {
  return (
    <Panel>
      <PanelHeader eyebrow="scope" title="What a scan reads, and what it will not do" />
      <PanelBody>
        {/* A real definition list rather than DefinitionRow: that primitive justifies a label
            against a short reading on one line, and every value here is a sentence. */}
        <dl className="flex flex-col gap-3">
          {SCAN_PROPERTIES.map((property) => (
            <div
              key={property.label}
              className="flex flex-col gap-1 border-b border-edge pb-3 last:border-b-0 last:pb-0"
            >
              <dt>
                <FieldLabel>{property.label}</FieldLabel>
              </dt>
              <dd className="max-w-prose text-small text-ink-muted">{property.described}</dd>
            </div>
          ))}
        </dl>
      </PanelBody>
    </Panel>
  );
}

/**
 * The catalogue, listed in full, plus what it cannot see.
 *
 * The whole list is on screen rather than behind a disclosure, because it is the definition of
 * every empty result this surface can produce. A reader who cannot see which patterns ran cannot
 * tell "nothing matched" from "nothing was looked for".
 */
export function IndicatorCoveragePanel() {
  return (
    <Panel>
      <PanelHeader
        eyebrow="coverage"
        title="What this set looks for, and what it cannot see"
        aside={
          <>
            <DataValue>{formatCount(PERSISTENCE_INDICATORS.length)}</DataValue>
            <UnitSuffix>indicators</UnitSuffix>
          </>
        }
      />
      <PanelBody className="flex flex-col gap-5">
        {INDICATOR_GROUPS.map((group) => (
          <div key={group.severity} className="flex flex-col gap-2">
            <FieldLabel>
              {SEVERITY_LABELS[group.severity]}, {formatCount(group.indicators.length)} of{" "}
              {formatCount(PERSISTENCE_INDICATORS.length)}
            </FieldLabel>
            <ul className="grid list-none gap-x-6 gap-y-1 md:grid-cols-2">
              {group.indicators.map((indicator) => (
                <li key={indicator.id} className="text-small text-ink-muted">
                  {indicator.title}
                </li>
              ))}
            </ul>
          </div>
        ))}

        <div className="flex flex-col gap-2">
          <FieldLabel>Outside this set</FieldLabel>
          <ul className="flex list-none flex-col gap-1">
            {COVERAGE_GAPS.map((gap) => (
              <li key={gap} className="max-w-prose text-small text-ink-muted">
                {gap}
              </li>
            ))}
          </ul>
        </div>
      </PanelBody>
    </Panel>
  );
}

/**
 * The closed gate. Rendered instead of the form, never beside it: a form that cannot run is a
 * dead control, and the honest surface for a machine that has not opted in is the reason plus
 * the one line an operator needs to change it.
 *
 * The copy comes from the same table the route answers with, so the page and the endpoint cannot
 * drift into telling a reader two different things.
 */
export function GateClosedPanel() {
  return (
    <Panel>
      <PanelHeader
        eyebrow="gate"
        title={LOCAL_SCAN_REFUSALS.gate_closed.title}
        aside={<AdvisoryChip>reads the filesystem</AdvisoryChip>}
      />
      <PanelBody>
        <p className="max-w-prose text-small text-ink-muted">
          {LOCAL_SCAN_REFUSALS.gate_closed.guidance}
        </p>
      </PanelBody>
    </Panel>
  );
}
