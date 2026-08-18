import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import { AbstainNotice, EmptyState } from "@/components/ui/state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@/components/ui/table";
import { DataValue, DefinitionRow, FieldLabel, UnitSuffix } from "@/components/ui/text";
import { VerdictPill } from "@/components/ui/verdict";
import { formatCount, measureLatency, UNKNOWN_READING } from "@/lib/format";

import { SEVERITIES_WORST_FIRST, SEVERITY_LABELS, type LocalScanSuccessBody } from "./scan-contract";

/**
 * A finished scan, rendered.
 *
 * Split from the console so that file holds the state machine and this one holds the reading.
 * Nothing here has state or an effect: every value on screen was decided by the route and
 * validated against the schema before it arrived.
 *
 * The rule that shapes all three components below: a count of zero is never presented as a
 * result on its own. The readout always states how much was read next to what was found, the
 * limits are always on screen when the walk had any, and the empty case is titled after the
 * indicator set rather than after the directory. A reader who sees an empty table has to be
 * able to tell "nothing matched" from "nothing ran".
 */

export type ScanReadoutPanelProps = {
  report: LocalScanSuccessBody;
};

/**
 * The readout: the verdict, the match count, and the size of the walk that produced it.
 *
 * The walk counters are not diagnostics padding. "No indicator matched" is worth what the walk
 * behind it is worth, so the number of files read sits in the same panel as the verdict, and a
 * scan that read four files cannot pass for a scan that read four thousand.
 */
export function ScanReadoutPanel({ report }: ScanReadoutPanelProps) {
  const elapsed = measureLatency(report.walk.durationMs);
  const matchWord = report.counts.total === 1 ? "indicator match" : "indicator matches";

  return (
    <Panel>
      <PanelHeader
        eyebrow="reading"
        title={<span className="font-data">{report.rootLabel}</span>}
        aside={<VerdictPill verdict={report.verdict} rationale={report.rationale} />}
      />
      <PanelBody className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-baseline gap-2">
            <DataValue scale="lg">{formatCount(report.counts.total)}</DataValue>
            <UnitSuffix>
              {matchWord} in {formatCount(report.walk.filesVisited)} files read
            </UnitSuffix>
          </div>
          {/* The verdict's reason as text, not only as the pill's tooltip: a rationale a reader
              has to hover to find is a rationale most readers never see. */}
          <p className="max-w-prose text-small text-ink-muted">{report.rationale}</p>
        </div>

        <dl className="flex flex-col">
          {SEVERITIES_WORST_FIRST.map((severity) => {
            const count = report.counts.bySeverity[severity];
            return (
              <DefinitionRow key={severity} label={SEVERITY_LABELS[severity]}>
                <span className="flex items-baseline gap-1">
                  <DataValue muted={count === 0}>{formatCount(count)}</DataValue>
                  <UnitSuffix>{count === 1 ? "match" : "matches"}</UnitSuffix>
                </span>
              </DefinitionRow>
            );
          })}
          <DefinitionRow label="Bytes read">
            <span className="flex items-baseline gap-1">
              <DataValue muted={report.walk.bytesRead === 0}>
                {formatCount(report.walk.bytesRead)}
              </DataValue>
              <UnitSuffix>bytes</UnitSuffix>
            </span>
          </DefinitionRow>
          <DefinitionRow label="Paths skipped as unreadable">
            <span className="flex items-baseline gap-1">
              <DataValue muted={report.walk.unreadablePathCount === 0}>
                {formatCount(report.walk.unreadablePathCount)}
              </DataValue>
              <UnitSuffix>{report.walk.unreadablePathCount === 1 ? "path" : "paths"}</UnitSuffix>
            </span>
          </DefinitionRow>
          <DefinitionRow label="Symlinks leaving the directory">
            <span className="flex items-baseline gap-1">
              <DataValue muted={report.walk.skippedOutsideRootCount === 0}>
                {formatCount(report.walk.skippedOutsideRootCount)}
              </DataValue>
              <UnitSuffix>not followed</UnitSuffix>
            </span>
          </DefinitionRow>
          <DefinitionRow label="Walk took">
            <span className="flex items-baseline gap-1">
              {/* Null only if the clock disagreed with itself, and stated rather than blanked. */}
              <DataValue>{elapsed === null ? UNKNOWN_READING : elapsed.value}</DataValue>
              {elapsed === null ? null : <UnitSuffix>{elapsed.unit}</UnitSuffix>}
            </span>
          </DefinitionRow>
        </dl>

        {report.verdict === "unknown" ? (
          <AbstainNotice
            rationale={report.rationale}
            limits={report.limits.map((limit) => limit.described)}
          />
        ) : (
          <div className="flex flex-col gap-1">
            <FieldLabel>Why this reading is not the whole picture</FieldLabel>
            {report.limits.length === 0 ? (
              <p className="max-w-prose text-small text-ink-muted">
                Nothing cut the walk short: it stayed inside every cap, every path under this
                directory was readable, and no symlink pointed out of it. What the indicator set
                does not cover is listed below, and that gap is unaffected by any of this.
              </p>
            ) : (
              <ul className="flex list-none flex-col gap-1">
                {report.limits.map((limit) => (
                  <li key={limit.id} className="max-w-prose text-small text-ink-muted">
                    {limit.described}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}

export type FindingsTableProps = {
  findings: LocalScanSuccessBody["findings"];
};

/**
 * The matches, worst first, in the order the route sorted them.
 *
 * Four columns and no fifth: the indicator, its severity, where it is, and the line. What is
 * deliberately absent is the matched text. The indicator's own explanation says what the pattern
 * looks for, which is enough to act on, and a matched line from a credential stealer is a
 * credential. The path is relative to the scanned directory, so the table cannot be read back as
 * a map of this machine.
 *
 * `Table` scrolls horizontally on a narrow viewport rather than dropping a column, because every
 * column here is load-bearing for acting on a hit.
 */
export function FindingsTable({ findings }: FindingsTableProps) {
  return (
    <Panel>
      <PanelHeader
        eyebrow="matches"
        title="What matched, worst first"
        aside={
          <>
            <DataValue>{formatCount(findings.length)}</DataValue>
            <UnitSuffix>{findings.length === 1 ? "row" : "rows"}</UnitSuffix>
          </>
        }
      />
      <PanelBody>
        <Table caption="Persistence indicators that matched in the scanned directory, highest severity first">
          <TableHead>
            <TableHeaderCell>Indicator</TableHeaderCell>
            <TableHeaderCell>Severity</TableHeaderCell>
            <TableHeaderCell>Path</TableHeaderCell>
            <TableHeaderCell isNumeric>Line</TableHeaderCell>
          </TableHead>
          <TableBody>
            {findings.map((finding) => (
              // The route reports one row per file and indicator, so this pair is unique.
              <TableRow key={`${finding.relativePath}::${finding.indicatorId}`}>
                <TableCell>
                  <span className="flex flex-col gap-1">
                    <span>{finding.title}</span>
                    <span className="max-w-prose text-small text-ink-muted">
                      {finding.explanation}
                    </span>
                  </span>
                </TableCell>
                <TableCell
                  className={finding.severity === "high" ? "text-ink" : "text-ink-muted"}
                >
                  {/* Severity is an ordered scale, so it is carried by the sort order and by ink
                      weight rather than by a colour: the critical hue on this sheet means an
                      advisory, and 27 red chips in one column would mean nothing. */}
                  {finding.severity}
                </TableCell>
                <TableCell>
                  <span className="flex flex-col gap-1">
                    <DataValue>{finding.relativePath}</DataValue>
                    {finding.packageName === null ? null : (
                      <span className="flex items-baseline gap-1">
                        <UnitSuffix>package</UnitSuffix>
                        <DataValue muted>{finding.packageName}</DataValue>
                      </span>
                    )}
                  </span>
                </TableCell>
                <TableCell isNumeric>
                  {finding.lineNumber === null ? (
                    // A path-only indicator has no line: the file existing is the finding.
                    <UnitSuffix>path only</UnitSuffix>
                  ) : (
                    <DataValue>{formatCount(finding.lineNumber)}</DataValue>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </PanelBody>
    </Panel>
  );
}

export type NoMatchesStateProps = {
  /** How many indicators ran. Named in the copy so the claim states its own size. */
  indicatorCount: number;
};

/**
 * The empty result.
 *
 * Titled after the indicator set, never after the directory, and it does not contain the word
 * clean. "No indicator matched" is a statement about 27 patterns; "this directory is clean" is a
 * statement about every way a machine can be compromised, and this scan cannot make the second
 * one. The panel listing what the set does not cover sits directly below on the same surface.
 */
export function NoMatchesState({ indicatorCount }: NoMatchesStateProps) {
  return (
    <EmptyState title={`No indicator in this set of ${formatCount(indicatorCount)} matched`}>
      That is a statement about these patterns, not a clean bill of health for this machine. The
      set matches published indicators from real npm and PyPI incidents, so a technique nobody has
      written up, a payload with no known filename, and anything outside the directory you named
      all produce exactly this result. What the set does not look for is listed below, and the
      reading above says how much was read to get here.
    </EmptyState>
  );
}
