import { isRecording, recordOperation } from "@/lib/graph/statements";
import type { GraphStatement, GraphTransport } from "@/lib/hydra/transport";
import type { DecodedRow } from "@/lib/hydra/wire";
import type { Failure, Result } from "@/lib/result";

/**
 * A transport that writes down the statement it sent, then delegates.
 *
 * This is the half of the operation record that can show real query text, because every
 * statement HydraDB receives passes through `GraphTransport.run` and nothing else. Wrapping
 * here rather than in the gateway means the text recorded is the text sent, including the
 * chunking the gateway does internally: a read of 600 node ids appears as three statements
 * because three statements were issued.
 *
 * The recorded text carries no credential. Both transports authenticate out of band, over an
 * HTTP bearer header or as the Bolt password, and the token never enters a query.
 * sourceRef: src/lib/hydra/config.ts.
 *
 * Parameter values are deliberately not recorded. They are the one place a query could carry
 * something a reader should not see, and the statement text plus the gateway's own operation
 * line already say what was asked.
 */
export class RecordingTransport implements GraphTransport {
  constructor(private readonly inner: GraphTransport) {}

  async run(statement: GraphStatement): Promise<Result<DecodedRow[], Failure>> {
    if (!isRecording()) return this.inner.run(statement);

    const startedAt = performance.now();
    const result = await this.inner.run(statement);
    const durationMs = performance.now() - startedAt;

    recordOperation({
      operation: "cypher",
      detail: describeParameters(statement),
      statement: statement.text,
      durationMs,
      resultCount: result.ok ? result.value.length : -1,
      failureReason: result.ok ? null : result.failure.reason,
    });

    return result;
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  describe(): string {
    return this.inner.describe();
  }
}

/**
 * The parameter names a statement carried, without their values.
 *
 * Which parameters a query took is useful when reading it: it tells a reader whether the batch
 * forms were used and how the statement was shaped. What each one held is not, and printing it
 * would put ingest payloads on a page.
 */
function describeParameters(statement: GraphStatement): string {
  const names = Object.keys(statement.parameters);
  if (names.length === 0) return "no parameters";
  return `parameters ${names.sort().join(", ")}`;
}
