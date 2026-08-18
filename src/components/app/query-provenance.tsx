import { measureLatency } from "@/lib/format";
import type { ExecutedOperation, OperationRecord } from "@/lib/graph/statements";
import { Panel, PanelBody, PanelHeader, Tray } from "@/components/ui/panel";
import { EmptyState } from "@/components/ui/state";
import { DataValue, FieldLabel, UnitSuffix } from "@/components/ui/text";

/**
 * What the graph actually did to answer the question above it.
 *
 * The central claim of this product is that a graph engine answers these questions, and a
 * screenshot of a verdict proves nothing of the kind. This panel is the receipt: every
 * operation that ran, in the order it ran, with the statement text where an engine received
 * one and the time each took. It is meant to be read rather than admired, so it is set in the
 * data face on the recessed material, like the query log it is.
 *
 * Three things it refuses to do, all for the same reason:
 *
 *   - It never prints a statement that was not sent. When the in-process snapshot answers,
 *     every row says so, and the source line above the list states it in words instead of
 *     letting a reader assume the operation names were Cypher.
 *   - It never reads an empty list as an idle graph. An empty record means no scope was open
 *     while the answer was produced, which is a gap in the bookkeeping and not a finding, and
 *     the empty state says which of the two it is.
 *   - It never hides that it truncated. A capped list and a truncated statement both carry a
 *     line saying so, because a receipt that silently drops rows is worse than none.
 *
 * The graph's size is deliberately absent: StatusBar already prints the slice counts on every
 * surface, and a second copy here would be one more number to keep in sync.
 * sourceRef: src/components/app/status-bar.tsx.
 */

export type QueryProvenanceProps = {
  record: OperationRecord;
  className?: string;
};

export function QueryProvenance({ record, className }: QueryProvenanceProps) {
  const total = measureLatency(record.totalDurationMs);
  const statementCount = record.operations.filter(
    (operation) => operation.statement !== null,
  ).length;

  return (
    <Panel className={className}>
      <PanelHeader
        title="How this was answered"
        eyebrow="provenance"
        aside={
          record.operations.length > 0 ? (
            <span className="flex items-baseline gap-3">
              <span className="flex items-baseline gap-1">
                <DataValue>{record.operations.length}</DataValue>
                <UnitSuffix>
                  {record.operations.length === 1 ? "operation" : "operations"}
                </UnitSuffix>
              </span>
              {total !== null ? (
                <span className="flex items-baseline gap-1">
                  <DataValue>{total.value}</DataValue>
                  <UnitSuffix>{total.unit} in the graph</UnitSuffix>
                </span>
              ) : null}
            </span>
          ) : null
        }
      />

      {record.operations.length === 0 ? (
        <EmptyState title="No operations were recorded for this answer">
          The answer was produced without an open recording scope, so what the graph did was not
          captured. This is a gap in the record rather than a graph that did no work: an answer
          always reads something.
        </EmptyState>
      ) : (
        <PanelBody className="flex flex-col gap-3">
          {/* The source line, first, because it changes how every row below it should be read.
              It is derived from the statements themselves rather than passed in, so it cannot
              disagree with the list it introduces. */}
          <FieldLabel>
            {statementCount > 0
              ? `${statementCount} of ${record.operations.length} operations were statements sent to the engine.`
              : "No engine was contacted. Every operation below ran in this process against the loaded snapshot, which is why no statement text is shown."}
          </FieldLabel>

          <Tray>
            <ol className="flex list-none flex-col">
              {record.operations.map((operation) => (
                <OperationRow key={operation.sequence} operation={operation} />
              ))}
            </ol>
          </Tray>

          {record.wasCapped ? (
            <FieldLabel>
              The list stops at {record.operations.length} operations. More ran and were dropped
              from the record, so the times below do not add up to the whole answer.
            </FieldLabel>
          ) : null}
        </PanelBody>
      )}
    </Panel>
  );
}

/**
 * One operation.
 *
 * The row is a two-line shape rather than a table row because a statement has no fixed height,
 * and the sheet's 36px row is a promise a wrapped Cypher chain cannot keep. The hairline is on
 * the row rather than between rows, so the last one drops it and the tray's inset edge is the
 * only line at the bottom.
 */
function OperationRow({ operation }: { operation: ExecutedOperation }) {
  const latency = measureLatency(operation.durationMs);
  const failed = operation.failureReason !== null;

  return (
    <li className="flex flex-col gap-1 border-b border-edge px-3 py-2 last:border-b-0">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2">
          {/* The sequence sits in its own column so the eye can follow the order down the
              list. The data face is monospaced, so two digits of room is all it needs. */}
          <span className="w-[2ch] shrink-0 text-right font-data text-unit text-ink-faint">
            {operation.sequence}
          </span>
          <span className="shrink-0 text-small text-ink">{operation.operation}</span>
          <span className="truncate text-small text-ink-muted">{operation.detail}</span>
        </div>

        <div className="flex shrink-0 items-baseline gap-2">
          {/* A failed call returned nothing, and zero rows is a reading a successful call can
              also produce, so the count is replaced by the reason rather than printed as 0.
              The pair is ink on the critical tint, which is the one measured pairing for this
              hue: critical text on its own tint falls under the body floor.
              sourceRef: docs/UI_DESIGN_SYSTEM.md section 9. */}
          {failed ? (
            <span className="rounded-chip border-l-2 border-critical bg-tint-critical px-2 py-0.5 font-data text-unit text-ink">
              {operation.failureReason}
            </span>
          ) : (
            <span className="flex items-baseline gap-1">
              <DataValue muted>{operation.resultCount}</DataValue>
              <UnitSuffix>{operation.resultCount === 1 ? "row" : "rows"}</UnitSuffix>
            </span>
          )}
          {latency !== null ? (
            <span className="flex items-baseline gap-1">
              <DataValue>{latency.value}</DataValue>
              <UnitSuffix>{latency.unit}</UnitSuffix>
            </span>
          ) : null}
        </div>
      </div>

      {/* Visible by default: this is the evidence, and putting it behind a disclosure would
          make the one thing worth checking the one thing a reader has to ask for. */}
      {operation.statement !== null ? (
        <p className="font-data text-data break-words text-ink">{operation.statement}</p>
      ) : null}
    </li>
  );
}
