import type { Metadata } from "next";

import { Surface, SurfaceHead } from "@/components/app/surface";
import { ScanConsole } from "@/components/scan/scan-console";
import { MAX_LOCKFILE_CHARACTERS } from "@/lib/scanner/lockfile";

export const metadata: Metadata = {
  title: "Scan my project",
  description:
    "Paste a lockfile and read, per dependency, whether the ingested slice can decide it is exposed, not exposed, or neither.",
};

/**
 * The scan surface: a reader's own lockfile against the ingested slice.
 *
 * The page is a server component with one client leaf, which is the split that matters here.
 * The scan itself is a POST from the browser, because the input is pasted rather than routed,
 * so the console has to be interactive. Everything else stays on the server, and the only value
 * that crosses is the upload cap: the field states it in bytes before a reader hits it, and
 * passing the number rather than importing the parser in the browser keeps a 1,200 line lockfile
 * parser out of the bundle.
 *
 * One number is both caps. `MAX_LOCKFILE_CHARACTERS` is the parser's limit in UTF-16 code units
 * and the route's limit in UTF-8 bytes, and a UTF-8 encoding is never smaller than the code unit
 * count, so a paste that fits the byte cap always fits the parser.
 * sourceRef: src/lib/scanner/lockfile.ts (MAX_LOCKFILE_CHARACTERS), src/app/api/scan/route.ts
 * (MAX_UPLOAD_BYTES).
 *
 * There is no server-side graph read on this page on purpose. A lockfile scan asks about a file
 * that does not exist until a reader pastes it, so rendering a graph reading before there is
 * anything to scan would be a claim about nothing. What the graph did arrives with the answer
 * and is printed in the receipt underneath it.
 */
export default function ScanPage() {
  return (
    <Surface>
      <SurfaceHead
        question="Is my own project exposed?"
        lede="Paste a lockfile. Every dependency in it is checked against the slice this tool ingested: pinned versions against the advisories that name them, and everything else against what the slice actually holds. A dependency the slice cannot decide is reported as undecided, never as clean."
      />
      <ScanConsole capBytes={MAX_LOCKFILE_CHARACTERS} />
    </Surface>
  );
}
