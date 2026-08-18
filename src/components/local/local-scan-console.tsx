"use client";

import { type FormEvent, useState } from "react";

import { SurfaceHead } from "@/components/app/surface";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { Panel, PanelBody, PanelHeader, Tray } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/state";
import { FieldLabel } from "@/components/ui/text";
import { formatCount } from "@/lib/format";
import { fromThrowing } from "@/lib/result";

import {
  LOCAL_SCAN_FAILURE_SCHEMA,
  LOCAL_SCAN_REFUSALS,
  LOCAL_SCAN_SUCCESS_SCHEMA,
  type LocalScanRefusalCopy,
  type LocalScanRefusalKind,
  type LocalScanRequest,
  type LocalScanSuccessBody,
} from "./scan-contract";
import { FindingsTable, NoMatchesState, ScanReadoutPanel } from "./scan-report";

/**
 * The one interactive piece of the /local surface: a path, a button, and whatever came back.
 *
 * Two properties of this component are the feature rather than implementation detail.
 *
 * It scans only on submit. There is no effect that fires on mount, no timer, no refetch on focus,
 * and the path is not persisted anywhere, so a reader who loads this page and walks away has had
 * nothing on their disk read. That is why the whole thing is a form with an explicit action
 * instead of a field that reacts as it is typed.
 *
 * It never trusts what came back. `response.json()` is untyped, and a body missing its findings
 * array would render as an empty table, which reads as a clean directory. So the answer is parsed
 * against the schema in scan-contract.ts and a body that does not match is a failure state with
 * its own copy, not a best-effort render.
 */

const LOCAL_SCAN_ENDPOINT = "/api/local-scan";

/**
 * How long this page waits. The walk's own caps bound it at 40,000 files and 64 MiB, which
 * finishes well inside this on a local disk; the limit is here so a request that never returns
 * cannot leave the button spinning with no way back.
 */
const LOCAL_SCAN_TIMEOUT_MS = 60_000;

/**
 * What the console is showing. One phase per outcome, so no state can render two answers at once
 * and no answer can survive into the next scan: submitting replaces the whole thing.
 */
type ConsoleState =
  | { phase: "idle" }
  | { phase: "scanning" }
  | { phase: "reported"; report: LocalScanSuccessBody }
  /** `refusedPath` is what was sent, so the field stops reporting itself invalid once edited. */
  | { phase: "refused"; kind: LocalScanRefusalKind; refusedPath: string }
  | { phase: "failed"; failure: "transport" | "unreadable_response" };

/**
 * The two failures the route cannot describe, because in neither case did its answer arrive
 * intact. They take the same copy shape as a refusal so one renderer covers all three.
 */
const TRANSPORT_FAILURE_COPY: LocalScanRefusalCopy = {
  title: "The scan request did not complete",
  guidance: `Either the server stopped answering, or the request passed the ${formatCount(LOCAL_SCAN_TIMEOUT_MS)} ms this page waits. No reading arrived, so nothing is shown. Check the server is still running, then run the scan again.`,
};

const UNREADABLE_RESPONSE_COPY: LocalScanRefusalCopy = {
  title: "The answer could not be read",
  guidance:
    "The server replied in a shape this surface does not recognise, so none of it is shown. A body that cannot be checked could be missing its findings, and a missing finding would draw an empty table, which reads as a directory with nothing in it.",
};

export type LocalScanConsoleProps = {
  /** The surface's question. Owned by the page, which states the same one when the gate is shut. */
  question: string;
  lede: string;
  /**
   * The path the field opens on: the directory the server was started in, which is also the only
   * tree the route will scan. It is a prop rather than a fetch, because `process.cwd()` is a
   * server reading and this component runs in the browser.
   */
  defaultPath: string;
  /** Size of the indicator set, named in the empty result so the claim states its own scope. */
  indicatorCount: number;
};

export function LocalScanConsole({
  question,
  lede,
  defaultPath,
  indicatorCount,
}: LocalScanConsoleProps) {
  const [requestedPath, setRequestedPath] = useState(defaultPath);
  const [state, setState] = useState<ConsoleState>({ phase: "idle" });

  async function runScan(): Promise<void> {
    // The previous reading is dropped before the request goes out. Leaving it on screen under a
    // spinner would let a reader act on a finding from a path they have already changed.
    setState({ phase: "scanning" });
    setState(await requestLocalScan(requestedPath));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    // Deliberately not awaited: runScan writes its own outcome into state, and a submit handler
    // that returns a promise is a promise nothing is listening to.
    void runScan();
  }

  const isScanning = state.phase === "scanning";
  const notice = describeNotice(state);

  return (
    <>
      <SurfaceHead
        question={question}
        lede={lede}
        controls={
          <form onSubmit={handleSubmit} className="flex flex-wrap items-start gap-3">
            <TextField
              label="Directory to read"
              name="path"
              value={requestedPath}
              onChange={(event) => setRequestedPath(event.target.value)}
              // A path is machine input: autocorrect and spellcheck have nothing useful to say
              // about it and both can rewrite what was typed.
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              disabled={isScanning}
              className="min-w-[26ch] flex-1"
              // The refusal reads on the control that caused it, which is what sets aria-invalid,
              // and only while the field still holds the value that was refused: marking a path
              // invalid that nothing has checked yet would be a lie to a screen reader. The panel
              // below keeps the guidance either way, so an edit does not erase what to do.
              error={
                state.phase === "refused" && state.refusedPath === requestedPath
                  ? LOCAL_SCAN_REFUSALS[state.kind].title
                  : undefined
              }
              hint="Absolute path, inside the directory this server was started in."
            />
            <div className="flex flex-col gap-2">
              {/* An empty label row, so the button's top edge lines up with the input's without a
                  hand-tuned offset. `invisible` keeps the box and drops it from the a11y tree. */}
              <FieldLabel className="invisible" aria-hidden>
                Run
              </FieldLabel>
              <Button type="submit" variant="primary" icon="search" isLoading={isScanning}>
                {isScanning ? "Reading files" : "Read this directory"}
              </Button>
            </div>
          </form>
        }
      />

      {/* The outcome as one sentence, for a reader who is not watching the panels repaint. */}
      <p aria-live="polite" className="sr-only">
        {announceState(state)}
      </p>

      {state.phase === "idle" ? (
        <Tray>
          <p className="max-w-prose text-small text-ink-muted">
            Nothing has been read yet. This surface reads no file until you press the button, and
            it reads only the path in that one request. What a scan does, and what it will not do,
            is stated below.
          </p>
        </Tray>
      ) : null}

      {isScanning ? (
        <Panel>
          <PanelHeader eyebrow="reading" title="Walking the directory" />
          <PanelBody>
            <Skeleton label="Reading the directory and matching it against the indicator set" rows={4} />
          </PanelBody>
        </Panel>
      ) : null}

      {notice === null ? null : (
        <Panel>
          <PanelHeader
            eyebrow={state.phase === "refused" ? "refused" : "failed"}
            title={notice.title}
          />
          <PanelBody>
            <p className="max-w-prose text-small text-ink-muted">{notice.guidance}</p>
          </PanelBody>
        </Panel>
      )}

      {state.phase === "reported" ? (
        <>
          <ScanReadoutPanel report={state.report} />
          {state.report.findings.length === 0 ? (
            <NoMatchesState indicatorCount={indicatorCount} />
          ) : (
            <FindingsTable findings={state.report.findings} />
          )}
        </>
      ) : null}
    </>
  );
}

/** The copy for a state that has no reading to show, or null when there is one. */
function describeNotice(state: ConsoleState): LocalScanRefusalCopy | null {
  if (state.phase === "refused") return LOCAL_SCAN_REFUSALS[state.kind];
  if (state.phase !== "failed") return null;
  return state.failure === "transport" ? TRANSPORT_FAILURE_COPY : UNREADABLE_RESPONSE_COPY;
}

/**
 * The live-region sentence. It names counts and outcomes and never the path, for the same reason
 * the report does not: this string is read aloud and copied into transcripts.
 */
function announceState(state: ConsoleState): string {
  if (state.phase === "idle") return "No directory has been read yet.";
  if (state.phase === "scanning") return "Reading the directory.";
  if (state.phase === "refused") {
    return `The scan was refused. ${LOCAL_SCAN_REFUSALS[state.kind].title}.`;
  }
  if (state.phase === "failed") {
    return state.failure === "transport"
      ? `${TRANSPORT_FAILURE_COPY.title}.`
      : `${UNREADABLE_RESPONSE_COPY.title}.`;
  }

  const { report } = state;
  const matchWord = report.counts.total === 1 ? "match" : "matches";
  return `Scan finished with ${formatCount(report.counts.total)} indicator ${matchWord} across ${formatCount(report.walk.filesVisited)} files read. Verdict: ${report.verdict.replace("_", " ")}. ${report.rationale}`;
}

/**
 * Posts one path and decodes the answer.
 *
 * Three failure paths, all of them values rather than throws: the request never completed, the
 * route refused with a reason, or the answer did not match the schema. The last one is a failure
 * state instead of a partial render, because the shape this surface cannot check is exactly the
 * shape that would draw an empty findings table.
 */
async function requestLocalScan(requestedPath: string): Promise<ConsoleState> {
  const body: LocalScanRequest = { path: requestedPath, consent: true };

  const sent = await fromThrowing("upstream_unavailable", "the local scan request failed", () =>
    fetch(LOCAL_SCAN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      // Never served from a cache. A stored "nothing matched" for a directory whose contents have
      // changed since is the one answer this surface must not repeat.
      cache: "no-store",
      signal: AbortSignal.timeout(LOCAL_SCAN_TIMEOUT_MS),
    }),
  );
  // The failure's own message is dropped rather than shown: a fetch or abort message is written
  // for a developer console, and this page has fixed copy for both cases it covers.
  if (!sent.ok) return { phase: "failed", failure: "transport" };

  const decoded = await fromThrowing("invalid_input", "the local scan answer was not JSON", () =>
    sent.value.json(),
  );
  if (!decoded.ok) return { phase: "failed", failure: "unreadable_response" };

  // Assigned through `unknown` so the parse below is the only thing that gives the body a type.
  const payload: unknown = decoded.value;

  const reported = LOCAL_SCAN_SUCCESS_SCHEMA.safeParse(payload);
  if (reported.success) return { phase: "reported", report: reported.data };

  const refused = LOCAL_SCAN_FAILURE_SCHEMA.safeParse(payload);
  const kind = refused.success ? refused.data.error.context?.refusal : undefined;
  if (kind !== undefined) return { phase: "refused", kind, refusedPath: requestedPath };

  // A failure envelope with no refusal kind lands here too: without the kind there is no reason
  // to name, and inventing one would be worse than saying the answer was unreadable.
  return { phase: "failed", failure: "unreadable_response" };
}
