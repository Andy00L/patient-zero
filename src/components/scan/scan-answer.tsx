import type { ReactNode } from "react";

import {
  MAX_ADVISORY_CHIPS_PER_ROW,
  MAX_LIMIT_SENTENCES,
  type ScanReport,
  type ScanRow,
  chooseHeadlineReading,
  describeReportLimits,
  describeReportingCaps,
  describeRowsCaption,
  describeSkipped,
  isEmptyScan,
  orderScanRows,
  summariseAdvisories,
} from "@/components/scan/scan-report";
import { Panel, PanelBody, PanelHeader, Tray } from "@/components/ui/panel";
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
import { AdvisoryChip, VerdictPill } from "@/components/ui/verdict";
import type { Verdict } from "@/lib/analysis/abstention";
import { formatCount, formatInstant } from "@/lib/format";

/**
 * A finished scan: the rows it could not clear, what it decided, and what it actually read.
 *
 * Three things about this component are load-bearing rather than stylistic.
 *
 * It renders the route's decisions and nothing of its own. Every verdict, rationale, count and
 * limit here arrives in the response. A browser-side second opinion assembled from the fields
 * that happen to be present is how an undecided scan turns into a clean one, so the only
 * decisions made here are which reading gets the large type and what order the rows are in,
 * both of them in scan-report.ts where they are tested.
 *
 * The table lists exposed and undecided rows only, because that is all the route returns.
 * Cleared dependencies come back as a count, so the visible caption says so: a table that
 * silently omits rows invites a reader to conclude that what is missing was fine.
 *
 * Every package name and version in this table came out of the pasted file. React renders them
 * as text, nothing is set as HTML, and no value from the file is used to build a URL, a path,
 * or an attribute other than the text of a cell.
 */

export type ScanAnswerProps = {
  report: ScanReport;
  /** True when the tray was edited after this scan ran, so the rows describe an older paste. */
  isStale: boolean;
};

export function ScanAnswer({ report, isStale }: ScanAnswerProps) {
  const { answer, lockfile, reporting, advisoryScan, source } = report;
  const rows = orderScanRows([...answer.evidence.exposed, ...answer.evidence.unknown]);
  const headline = chooseHeadlineReading(report);
  const limitSentences = describeReportLimits(report, MAX_LIMIT_SENTENCES);
  const skipped = describeSkipped(lockfile.skipped);
  const reportingCaps = describeReportingCaps(reporting);

  return (
    <div className="flex flex-col gap-4">
      {isStale ? (
        <CautionLine>
          The tray changed after this scan ran, so these rows describe the previous paste. Scan
          again to answer for what is in the tray now.
        </CautionLine>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
        <Panel>
          <PanelHeader
            eyebrow="findings"
            title={<span className="font-data">{lockfile.format}</span>}
            aside={<VerdictPill verdict={answer.verdict} rationale={answer.rationale} />}
          />
          {rows.length === 0 ? (
            <PanelBody>
              <EmptyState title={isEmptyScan(report) ? "No dependency was read from this file" : "Every dependency was decided and none is affected"}>
                {isEmptyScan(report)
                  ? `The paste parsed as ${lockfile.format} and carried no dependency entry, so nothing was checked against the slice. An empty file is not a clean result.`
                  : `All ${formatCount(lockfile.dependencyCount)} dependencies have their full closure in the slice, none is named by an advisory in it, and nothing was cut short. Cleared rows are counted rather than listed, so there is nothing to put in the table.`}
              </EmptyState>
            </PanelBody>
          ) : (
            <Table caption={describeRowsCaption(report)} isCaptionVisible>
              <TableHead>
                <TableHeaderCell>Verdict</TableHeaderCell>
                <TableHeaderCell>Dependency</TableHeaderCell>
                <TableHeaderCell>Version</TableHeaderCell>
                <TableHeaderCell isNumeric>Depth</TableHeaderCell>
                <TableHeaderCell>Scope</TableHeaderCell>
                <TableHeaderCell>Coverage</TableHeaderCell>
                <TableHeaderCell>Advisories</TableHeaderCell>
              </TableHead>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={`${row.packageKey}@${row.version ?? "unpinned"}@${row.depth}`}>
                    <TableCell>
                      <VerdictPill verdict={row.verdict} rationale={row.rationale} />
                    </TableCell>
                    <TableCell>
                      <DataValue>{row.name}</DataValue>
                    </TableCell>
                    <TableCell>
                      {row.version === null ? (
                        <span className="text-small text-ink-faint">unpinned</span>
                      ) : (
                        <DataValue>{row.version}</DataValue>
                      )}
                    </TableCell>
                    <TableCell isNumeric>
                      <DataValue muted>{formatCount(row.depth)}</DataValue>
                    </TableCell>
                    <TableCell>
                      <span className="text-small text-ink-muted">
                        {row.isDevOnly ? "dev only" : "runtime"}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="text-small text-ink-muted">{row.coverage}</span>
                    </TableCell>
                    <TableCell>
                      <AdvisoryCell row={row} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Panel>

        <Panel>
          <PanelHeader eyebrow="readout" title="What this scan decided" />
          <PanelBody className="flex flex-col gap-4">
            <div className="flex items-baseline gap-2">
              <DataValue scale="lg">{formatCount(headline.value)}</DataValue>
              <UnitSuffix>{headline.unit}</UnitSuffix>
            </div>

            {isEmptyScan(report) ? (
              <CautionLine>
                Nothing was checked. The verdict below is the route reporting that none of the
                zero dependencies it read is affected, which is not a statement about your
                project.
              </CautionLine>
            ) : null}

            <div className="flex flex-col gap-2">
              <DefinitionRow label="Exposed">
                <DataValue muted={answer.evidence.counts.exposed === 0}>
                  {formatCount(answer.evidence.counts.exposed)}
                </DataValue>
              </DefinitionRow>
              <DefinitionRow label="Undecided">
                <DataValue muted={answer.evidence.counts.unknown === 0}>
                  {formatCount(answer.evidence.counts.unknown)}
                </DataValue>
              </DefinitionRow>
              <DefinitionRow label="Cleared">
                <span className="flex items-baseline gap-2">
                  <DataValue muted={answer.evidence.clearedCount === 0}>
                    {formatCount(answer.evidence.clearedCount)}
                  </DataValue>
                  <UnitSuffix>not listed</UnitSuffix>
                </span>
              </DefinitionRow>
              <DefinitionRow label="Dependencies read">
                <DataValue muted={lockfile.dependencyCount === 0}>
                  {formatCount(lockfile.dependencyCount)}
                </DataValue>
              </DefinitionRow>
            </div>

            <AnswerLimits
              verdict={answer.verdict}
              rationale={answer.rationale}
              sentences={limitSentences}
            />
          </PanelBody>
        </Panel>
      </div>

      <Panel>
        <PanelHeader
          eyebrow="provenance"
          title="What this scan actually read"
          aside={<span className="text-unit text-ink-muted">{source.kind}</span>}
        />
        <PanelBody className="flex flex-col gap-3">
          <FieldLabel>
            Every reading below comes back with the answer. Nothing on this page was recomputed
            in the browser.
          </FieldLabel>
          <Tray>
            <div className="flex flex-col">
              <ReceiptRow label="Answered from">
                <span className="text-small text-ink">{source.detail}</span>
              </ReceiptRow>
              <ReceiptRow label="Data generated">
                <DataValue className="text-unit">{formatInstant(source.generatedAtMs)}</DataValue>
              </ReceiptRow>
              {source.degradedReason === null ? null : (
                <ReceiptRow label="Degraded">
                  <span className="text-small text-ink">{source.degradedReason}</span>
                </ReceiptRow>
              )}
              <ReceiptRow label="Format detected">
                <span className="flex items-baseline gap-2">
                  <DataValue className="text-unit">{lockfile.format}</DataValue>
                  <UnitSuffix>{lockfile.ecosystem}</UnitSuffix>
                </span>
              </ReceiptRow>
              <ReceiptRow label="Read">
                <span className="flex items-baseline gap-2">
                  <DataValue className="text-unit">{formatCount(lockfile.byteSize)}</DataValue>
                  <UnitSuffix>bytes</UnitSuffix>
                </span>
              </ReceiptRow>
              <ReceiptRow label="Skipped">
                <span className="text-small text-ink">{skipped ?? "Nothing was skipped."}</span>
              </ReceiptRow>
              <ReceiptRow label="Advisories examined">
                <span className="flex items-baseline gap-2">
                  <DataValue className="text-unit">
                    {formatCount(advisoryScan.advisoriesExamined)}
                  </DataValue>
                  <UnitSuffix>
                    of {formatCount(advisoryScan.advisoriesInGraph)} in the slice
                  </UnitSuffix>
                </span>
              </ReceiptRow>
              <ReceiptRow label="Advisory index">
                <span className="flex items-baseline gap-2">
                  <DataValue className="text-unit">
                    {formatCount(advisoryScan.affectedVersionsIndexed)}
                  </DataValue>
                  <UnitSuffix>
                    exact versions, {formatCount(advisoryScan.affectedPackagesIndexed)} packages
                  </UnitSuffix>
                </span>
              </ReceiptRow>
              <ReceiptRow label="Filename sent">
                <span className="text-small text-ink">
                  {lockfile.filenameHint ??
                    "none, the format was detected from the content of the paste"}
                </span>
              </ReceiptRow>
            </div>
          </Tray>
          {reportingCaps === null ? null : (
            <p className="text-small text-ink-muted">{reportingCaps}</p>
          )}
        </PanelBody>
      </Panel>
    </div>
  );
}

/**
 * A caution about the reading itself, drawn as a 2px accent rule at the leading edge with no
 * ground of its own. Not a tinted ground: the accent tint is what `exposed` means on this
 * surface, and a note about a stale tray borrowing it would read as a finding.
 * sourceRef: docs/UI_DESIGN_SYSTEM.md section 6 (the leading-edge rule).
 */
function CautionLine({ children }: { children: ReactNode }) {
  return <p className="border-l-2 border-accent pl-3 text-small text-ink">{children}</p>;
}

/** One line of the provenance receipt, inside the tray that holds them. */
function ReceiptRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <DefinitionRow label={label} className="border-b border-edge px-3 py-2 last:border-b-0">
      {children}
    </DefinitionRow>
  );
}

/**
 * The limits of the answer.
 *
 * An `unknown` verdict renders through `AbstainNotice`, which is the component that exists so
 * an abstention cannot be mistaken for a negative. Any other verdict still lists its limits
 * when it has them, because an exposed answer with a truncated traversal is a floor and not a
 * total.
 */
function AnswerLimits({
  verdict,
  rationale,
  sentences,
}: {
  verdict: Verdict;
  rationale: string;
  sentences: readonly string[];
}) {
  if (verdict === "unknown") {
    return <AbstainNotice rationale={rationale} limits={sentences} />;
  }

  if (sentences.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <FieldLabel>Why this answer is not the whole picture</FieldLabel>
      <ul className="flex list-none flex-col gap-1">
        {sentences.map((sentence) => (
          <li key={sentence} className="text-small text-ink-muted">
            {sentence}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The advisories a row names, in two treatments that are different on purpose.
 *
 * An advisory that names this exact version decided the row, so it gets the critical chip. An
 * advisory that names the package while this version was never materialised did NOT decide the
 * row: it is the reason the row is undecided. Giving both the same chip would make an undecided
 * row look like an exposure, and dropping the second would hide the one row a reader most needs
 * to check by hand.
 * sourceRef: src/app/api/scan/route.ts (AFFECTS_VERSION decides, AFFECTS cannot).
 */
function AdvisoryCell({ row }: { row: ScanRow }) {
  if (row.advisories.length > 0) {
    const summary = summariseAdvisories(row.advisories, MAX_ADVISORY_CHIPS_PER_ROW);
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        {summary.shown.map((advisory) => (
          <AdvisoryChip key={advisory.advisoryId}>
            <span className="font-data text-unit">{advisory.advisoryId}</span>
          </AdvisoryChip>
        ))}
        {summary.omittedCount > 0 ? (
          <span className="text-unit text-ink-muted">
            and {formatCount(summary.omittedCount)} more
          </span>
        ) : null}
      </span>
    );
  }

  if (row.packageAdvisories.length > 0) {
    const summary = summariseAdvisories(row.packageAdvisories, MAX_ADVISORY_CHIPS_PER_ROW);
    return (
      <span className="inline-flex flex-wrap items-baseline gap-2">
        <span className="text-unit text-ink-muted">package only:</span>
        {summary.shown.map((advisory) => (
          <DataValue key={advisory.advisoryId} muted className="text-unit">
            {advisory.advisoryId}
          </DataValue>
        ))}
        {summary.omittedCount > 0 ? (
          <span className="text-unit text-ink-muted">
            and {formatCount(summary.omittedCount)} more
          </span>
        ) : null}
      </span>
    );
  }

  return <span className="text-unit text-ink-faint">none in the slice</span>;
}
