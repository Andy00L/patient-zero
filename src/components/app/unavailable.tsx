import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import { AbstainNotice } from "@/components/ui/state";
import { DataValue, DefinitionRow } from "@/components/ui/text";
import { redactForClient } from "@/lib/api/http";
import type { Failure } from "@/lib/result";

/**
 * What a surface renders when no graph answered.
 *
 * This is not an error page. "The graph could not be read" and "nothing depends on this
 * package" are different facts, and the whole product rests on never letting the first one look
 * like the second, so a failed load is shown with the same weight and the same wording as an
 * abstention: no answer, and no assumption of safety.
 *
 * The message is passed through `redactForClient` even though this renders on the server. A
 * loader failure embeds whichever path or endpoint it was reading, the rendered HTML reaches a
 * browser, and where a deployment keeps its files is not the reader's business. The reason code
 * beside it is what actually says which kind of problem this is.
 */

export type GraphUnavailableProps = {
  failure: Failure;
  /** What this surface would have answered, so the notice names the loss and not just the fault. */
  question: string;
};

export function GraphUnavailable({ failure, question }: GraphUnavailableProps) {
  return (
    <Panel>
      <PanelHeader title="No graph answered" eyebrow="source" />
      <PanelBody className="flex flex-col gap-4 p-4">
        <AbstainNotice
          rationale={`${question} cannot be answered, because the loader found no graph to answer from. Nothing below this line is a statement about your dependencies.`}
          limits={[redactForClient(failure.message)]}
        />

        <DefinitionRow label="Failure reason">
          <DataValue>{failure.reason}</DataValue>
        </DefinitionRow>

        <p className="max-w-prose text-small text-ink-muted">
          Two things make this surface answer: an ingest that writes a snapshot into data/graph,
          or HYDRA_SNAPSHOT_PATH pointing at a snapshot that already exists. A configured HydraDB
          takes precedence over both, and is used only after one count query proves it answers.
        </p>
      </PanelBody>
    </Panel>
  );
}
