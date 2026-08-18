import type { Metadata } from "next";
import { connection } from "next/server";

import { Surface, SurfaceHead } from "@/components/app/surface";
import { LocalScanConsole } from "@/components/local/local-scan-console";
import { isLocalScanGateOpen } from "@/components/local/scan-contract";
import {
  GateClosedPanel,
  IndicatorCoveragePanel,
  ScanScopePanel,
} from "@/components/local/scan-scope";
import { formatCount } from "@/lib/format";
import { PERSISTENCE_INDICATORS } from "@/lib/scanner/indicators";

/**
 * The local scan surface: point it at a directory on this machine and it reports which known
 * supply-chain persistence indicators are sitting in it.
 *
 * This is the one surface that reads the filesystem instead of the ingested graph, so it is also
 * the one with a gate. Three decisions follow from that and none of them is incidental:
 *
 * 1. The gate is read here, on the server, per request. `connection()` is why: without it this
 *    page has no request-time API and Next prerenders it at build time, which would freeze the
 *    gate's value into static HTML. A machine built with scanning on and deployed with it off
 *    would still render the form, and a machine where an operator has just opened the gate would
 *    still say it is shut. Both are wrong in the direction that matters.
 * 2. A closed gate renders no form. The console is not disabled, it is absent, because a control
 *    that cannot do anything is worse than no control: the panel in its place says what the gate
 *    is and what opening it costs.
 * 3. The scope and coverage panels render in both states, above and below the fold, whether or
 *    not a scan has run. They are what makes an empty result readable: a reader who cannot see
 *    which patterns ran cannot tell "nothing matched" from "nothing was looked for".
 *
 * There is no search parameter on this surface, deliberately. A path in the URL would put a
 * location on this machine into browser history, into shareable links and into referrer headers,
 * and would turn "scan this once" into a link that rescans on every visit.
 */

export const metadata: Metadata = {
  title: "Local scan",
  description:
    "Read one directory on this machine and report which known supply-chain persistence indicators are present. Read-only, opt-in per run, and confined to the project directory.",
};

/** The question this surface answers. Stated identically whether or not the gate is open. */
const SURFACE_QUESTION = "Did anything leave a foothold in this directory?";

/**
 * The lede states the size of the claim, so the number of indicators comes from the catalogue
 * rather than from a literal that would drift the first time somebody adds one.
 */
function describeLede(indicatorCount: number): string {
  return `A read-only walk of one directory on this machine, matched against ${formatCount(indicatorCount)} persistence indicators taken from published npm and PyPI incidents. It reports which files matched and never what is in them, and it reads nothing until you ask it to.`;
}

export default async function LocalScanPage() {
  // Stops prerendering here: everything below depends on the environment and working directory of
  // the process actually serving the request. See decision 1 in the note above.
  await connection();

  const indicatorCount = PERSISTENCE_INDICATORS.length;
  const lede = describeLede(indicatorCount);

  return (
    <Surface>
      {isLocalScanGateOpen(process.env) ? (
        <LocalScanConsole
          question={SURFACE_QUESTION}
          lede={lede}
          // The directory the server was started in, which is also the only tree the route will
          // scan. Sent as the field's opening value so the first scan a reader runs is the one
          // that is certain to be allowed.
          defaultPath={process.cwd()}
          indicatorCount={indicatorCount}
        />
      ) : (
        <>
          <SurfaceHead question={SURFACE_QUESTION} lede={lede} />
          <GateClosedPanel />
        </>
      )}

      <ScanScopePanel />
      <IndicatorCoveragePanel />
    </Surface>
  );
}
