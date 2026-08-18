import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The record of what the graph actually did to answer one question.
 *
 * This exists because the central claim of this project is that a graph engine answers the
 * questions, and a screenshot of a verdict does not prove that. What proves it is the list of
 * operations that ran, in order, with the statement text where there is one and the time each
 * took. A judge, or anyone auditing an answer, can read it off the surface instead of taking
 * the README's word for it.
 *
 * Two rules make the record trustworthy rather than decorative:
 *
 *   1. Only operations that actually ran are recorded. Nothing here reconstructs the query a
 *      gateway "would have" sent. When the in-process graph answers, `statement` is null and
 *      says so, because an in-process adjacency walk is not a Cypher statement and printing
 *      one would be a claim about an engine that was never contacted.
 *
 *   2. The log is scoped to one async context, not to the process. The gateway is cached at
 *      module scope and shared by every concurrent request, so a process-wide buffer would
 *      attribute one reader's queries to another reader's answer. `withStatementLog` opens a
 *      scope, and a gateway records into whichever scope its caller is running in, or nowhere.
 *
 * A statement never carries a credential: both transports send the auth token as a header or
 * as the Bolt password, never inside the query text. sourceRef: src/lib/hydra/config.ts.
 */

/**
 * How many operations one scope keeps.
 *
 * A blast radius over a wide slice can issue hundreds of chunked reads, and the point of the
 * record is to be read by a person. The cap keeps a pathological answer from turning into a
 * page of identical rows, and `wasCapped` reports that it happened rather than letting the
 * list quietly end.
 */
const MAX_RECORDED_OPERATIONS = 200;

/**
 * How much statement text is kept.
 *
 * A chunked read inlines up to 256 keys in one OR chain, which is thousands of characters of
 * repetition that says nothing the first two clauses did not. The tail is dropped with a
 * marker so the reader knows the query was longer than what they see.
 */
const MAX_STATEMENT_LENGTH = 1200;

const TRUNCATION_MARKER = " ... (truncated)";

/** One graph operation, as it ran. */
export type ExecutedOperation = {
  /** Position in the scope, from 1, so the reader sees the order the graph was asked. */
  sequence: number;
  /** The gateway method or transport call that ran, for example "pathsFromSource". */
  operation: string;
  /** What it was asked, in one line, with no credential and no endpoint in it. */
  detail: string;
  /**
   * The statement the engine received, verbatim and possibly truncated. Null when no engine
   * was contacted, which is the honest value for the in-process graph.
   */
  statement: string | null;
  /** Wall-clock milliseconds, measured around the call. */
  durationMs: number;
  /** Rows, paths, or records returned. Negative one when the call failed. */
  resultCount: number;
  /** The failure reason code when the call failed, null when it succeeded. */
  failureReason: string | null;
};

/** What one scope recorded. */
export type OperationRecord = {
  operations: readonly ExecutedOperation[];
  /** True when operations were dropped because the scope hit its cap. */
  wasCapped: boolean;
  /** Sum of the recorded durations. Not the wall-clock time of the answer, which overlaps. */
  totalDurationMs: number;
};

/**
 * The empty record.
 *
 * Returned to a caller that asks for the operations of a scope that never opened one, so a
 * surface can render "nothing recorded" instead of branching on null.
 */
export const NO_OPERATIONS: OperationRecord = {
  operations: [],
  wasCapped: false,
  totalDurationMs: 0,
};

class StatementLog {
  private readonly recorded: ExecutedOperation[] = [];
  private dropped = 0;

  record(entry: Omit<ExecutedOperation, "sequence">): void {
    if (this.recorded.length >= MAX_RECORDED_OPERATIONS) {
      this.dropped += 1;
      return;
    }
    this.recorded.push({
      sequence: this.recorded.length + 1,
      ...entry,
      statement: entry.statement === null ? null : truncateStatement(entry.statement),
    });
  }

  read(): OperationRecord {
    let totalDurationMs = 0;
    for (const operation of this.recorded) totalDurationMs += operation.durationMs;

    return {
      operations: [...this.recorded],
      wasCapped: this.dropped > 0,
      totalDurationMs,
    };
  }
}

const activeLog = new AsyncLocalStorage<StatementLog>();

/**
 * Runs `answer` with a fresh operation log and returns both the answer and what the graph did
 * to produce it.
 *
 * The value comes back untouched, including a failed `Result`: a failed answer is exactly when
 * the record matters most, because the operations show how far the graph got before it stopped.
 */
export async function withStatementLog<TValue>(
  answer: () => Promise<TValue>,
): Promise<{ value: TValue; record: OperationRecord }> {
  const log = new StatementLog();
  const value = await activeLog.run(log, answer);
  return { value, record: log.read() };
}

/**
 * Records one operation into the scope the caller is running in, if there is one.
 *
 * Called by the recording decorators in this directory and in src/lib/hydra. Outside a scope
 * it does nothing at all, which is what keeps the ingest scripts and the test suites free of
 * bookkeeping they never asked for.
 */
export function recordOperation(entry: Omit<ExecutedOperation, "sequence">): void {
  activeLog.getStore()?.record(entry);
}

/** True when a scope is open. Lets a decorator skip building a detail string for nothing. */
export function isRecording(): boolean {
  return activeLog.getStore() !== undefined;
}

function truncateStatement(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= MAX_STATEMENT_LENGTH
    ? collapsed
    : `${collapsed.slice(0, MAX_STATEMENT_LENGTH)}${TRUNCATION_MARKER}`;
}
