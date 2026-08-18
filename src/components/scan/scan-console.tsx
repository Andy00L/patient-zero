"use client";

import { useState } from "react";

import { SAMPLE_LOCKFILE_LABEL, SAMPLE_LOCKFILE_TEXT } from "@/components/scan/sample-lockfile";
import { ScanAnswer } from "@/components/scan/scan-answer";
import {
  SCAN_ENDPOINT,
  SCAN_TIMEOUT_MS,
  SUPPORTED_LOCKFILE_NAMES,
  type ScanPhase,
  type ScanReport,
  classifyFailureAudience,
  decodeScanReport,
  describeScanStatus,
  readPaste,
  readScanFailure,
  refusePaste,
} from "@/components/scan/scan-report";
import { Button } from "@/components/ui/button";
import { TextAreaField } from "@/components/ui/field";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import { EmptyState, Skeleton } from "@/components/ui/state";
import { DataValue, FieldLabel, UnitSuffix } from "@/components/ui/text";
import { formatCount } from "@/lib/format";
import { type Failure, type Result, fromThrowing } from "@/lib/result";

/**
 * The paste well and every state a scan can be in.
 *
 * This is the only client component on the surface: the page renders on the server and hands
 * down the one number the browser needs, which keeps the 1,200 line lockfile parser out of the
 * bundle while still letting the field state the cap exactly.
 *
 * The tray is the recessed material cut into a raised panel, which is the depth model the sheet
 * describes for a large blob of text (appendix D). It is deliberately NOT a `Tray` wrapping a
 * `TextAreaField`: both paint `--color-sunken`, so nesting them would be soft on soft and the
 * field's own rim, including the invalid rim, would disappear into the well around it. The
 * `Tray` on this surface holds the provenance receipt instead, one level down from the panel
 * that owns it. sourceRef: docs/UI_DESIGN_SYSTEM.md appendix D, src/app/system/page.tsx.
 *
 * Nothing the reader pastes is executed, evaluated, or used to build a URL, a path, or a
 * header. The endpoint is a module constant, no filename travels with the request, and the
 * response is decoded through a schema before a single field of it is rendered.
 *
 * The tray stays editable while a scan is in flight. A 45 second lockout of a reader's own text
 * would be worse than the problem it solves, and the answer says so itself when the tray no
 * longer matches the paste it describes.
 */

export type ScanConsoleProps = {
  /**
   * The upload cap in bytes, passed down from the server so the field can name it. Both the
   * parser's character cap and the route's byte cap are this one number.
   * sourceRef: src/lib/scanner/lockfile.ts (MAX_LOCKFILE_CHARACTERS).
   */
  capBytes: number;
};

export function ScanConsole({ capBytes }: ScanConsoleProps) {
  const [pastedText, setPastedText] = useState("");
  const [phase, setPhase] = useState<ScanPhase>({ kind: "idle" });

  // Derived during render rather than kept in state: the reading is a function of the tray and
  // the cap, and a second copy of it in state is a second thing that can go stale.
  const reading = readPaste(pastedText, capBytes);
  const isSubmitting = phase.kind === "submitting";

  async function runScan(): Promise<void> {
    const refusal = refusePaste(reading);
    if (refusal !== null) {
      setPhase({ kind: "refused", failure: refusal });
      return;
    }

    setPhase({ kind: "submitting" });
    const scanned = await postLockfile(pastedText);

    if (scanned.ok) {
      setPhase({ kind: "answered", report: scanned.value, scannedText: pastedText });
      return;
    }

    // A failure about the file belongs under the field, where the file is. A failure about the
    // graph or about this page does not, because pointing a reader at their lockfile for a
    // graph outage sends them to fix the one thing that was not wrong.
    setPhase(
      classifyFailureAudience(scanned.failure) === "file"
        ? { kind: "refused", failure: scanned.failure }
        : { kind: "failed", failure: scanned.failure },
    );
  }

  function fillWithSample(): void {
    setPastedText(SAMPLE_LOCKFILE_TEXT);
    // Any previous result described a different paste, so it goes with the text it was about.
    setPhase({ kind: "idle" });
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <PanelHeader
          eyebrow="lockfile"
          title="Paste a lockfile"
          aside={
            <span className="flex items-baseline gap-2">
              <DataValue className="text-unit" muted={reading.isEmpty}>
                {formatCount(reading.byteSize)}
              </DataValue>
              <UnitSuffix>of {formatCount(capBytes)} bytes</UnitSuffix>
            </span>
          }
        />
        <PanelBody className="flex flex-col gap-4">
          <TextAreaField
            label="Lockfile contents"
            rows={12}
            value={pastedText}
            onChange={(event) => setPastedText(event.target.value)}
            error={phase.kind === "refused" ? phase.failure.message : undefined}
            hint={`Paste the contents of ${SUPPORTED_LOCKFILE_NAMES}. The format is read from the text itself, so the file does not have to keep its name. It is parsed for this one request: nothing is stored, and nothing in it is executed.`}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              icon="search"
              isLoading={isSubmitting}
              onClick={() => void runScan()}
            >
              Scan this lockfile
            </Button>
            <Button variant="secondary" icon="upload" disabled={isSubmitting} onClick={fillWithSample}>
              Fill with a sample
            </Button>
            <FieldLabel>
              The sample is a {SAMPLE_LOCKFILE_LABEL} from this repository, not a real project.
              Its package names are invented, so most of its rows come back undecided.
            </FieldLabel>
          </div>
        </PanelBody>
      </Panel>

      {/* One line, announced when a phase settles. Empty while idle and while submitting: the
          idle copy is already on screen and the skeleton announces its own label. */}
      <p aria-live="polite" className="sr-only">
        {describeScanStatus(phase)}
      </p>

      {phase.kind === "idle" ? (
        <EmptyState title="Nothing has been scanned yet">
          Every dependency in the paste is checked against the ingested slice: pinned versions
          against the advisories that name them, and everything else against what the slice
          actually holds. Anything the slice cannot decide comes back as undecided rather than as
          clean, so an empty result here is never a clean bill of health.
        </EmptyState>
      ) : null}

      {isSubmitting ? (
        <Panel>
          <PanelHeader
            eyebrow="findings"
            title="Scanning"
            aside={
              <span className="flex items-baseline gap-2">
                <DataValue className="text-unit">{formatCount(reading.byteSize)}</DataValue>
                <UnitSuffix>bytes sent</UnitSuffix>
              </span>
            }
          />
          <Skeleton label="Scanning the pasted lockfile against the ingested slice" rows={6} />
        </Panel>
      ) : null}

      {phase.kind === "refused" ? (
        <EmptyState title="Nothing was scanned">
          The paste was refused before any dependency was checked, so there is no result to
          report and no part of this file was read as an answer. The field above says why.
          Accepted files: {SUPPORTED_LOCKFILE_NAMES}.
        </EmptyState>
      ) : null}

      {phase.kind === "failed" ? (
        <EmptyState
          title="The scan could not be completed"
          action={
            <Button variant="secondary" icon="search" onClick={() => void runScan()}>
              Try the scan again
            </Button>
          }
        >
          No dependency was decided, so nothing here says anything about the pasted file. The
          scan reported: {phase.failure.message}
        </EmptyState>
      ) : null}

      {phase.kind === "answered" ? (
        <ScanAnswer report={phase.report} isStale={pastedText !== phase.scannedText} />
      ) : null}
    </div>
  );
}

/** What came back from the route, before any of it is trusted. */
type ScanResponse = {
  status: number;
  isOk: boolean;
  payload: unknown;
};

/**
 * Posts the paste and decodes the answer.
 *
 * Three failure paths, all of them values: the request never completed, the route refused, or
 * the route answered in a shape this page cannot read. The last one is a failure rather than a
 * best effort render, because a payload missing its `unknown` array would draw a table with
 * nothing undecided in it, which is the false negative this whole surface exists to prevent.
 *
 * The timeout is the reason `AbortSignal` is here at all: without it a request that never
 * returns leaves the button spinning with no way back.
 */
async function postLockfile(text: string): Promise<Result<ScanReport, Failure>> {
  const sent = await fromThrowing(
    "upstream_unavailable",
    `The scan request did not complete (a network failure, or the ${formatCount(SCAN_TIMEOUT_MS)} ms limit this page waits)`,
    async (): Promise<ScanResponse> => {
      const response = await fetch(SCAN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "text/plain;charset=utf-8" },
        body: text,
        signal: AbortSignal.timeout(SCAN_TIMEOUT_MS),
      });
      const payload: unknown = await response.json();
      return { status: response.status, isOk: response.ok, payload };
    },
  );
  if (!sent.ok) return sent;

  // A Failure that already exists is carried into a Result as it is: `fail` would rewrite its
  // reason and its message, and the route's message is the only account of what went wrong.
  if (!sent.value.isOk) {
    return { ok: false, failure: readScanFailure(sent.value.status, sent.value.payload) };
  }

  return decodeScanReport(sent.value.payload);
}
