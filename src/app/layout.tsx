import type { Metadata, Viewport } from "next";

import { StatusBar } from "@/components/app/status-bar";
import { faceVariables } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Patient Zero",
    template: "%s / Patient Zero",
  },
  description:
    "An incident radar for the npm and PyPI supply chain. Answers who is transitively exposed to a compromised package version, through which exact path, at what hop distance, and who resolved it while the payload was live.",
  applicationName: "Patient Zero",
};

/**
 * `themeColor` belongs to the viewport export, not the metadata export: Next 16 warns and
 * drops it otherwise.
 *
 * The value is the field ground rather than the signal amber, so the browser chrome
 * continues the instrument's own surface instead of framing it in a second colour. The
 * amber is reserved for exposure, and painting the window furniture with it would spend the
 * one accent on something that carries no finding.
 *
 * It is the one literal colour in the app and it has to stay that way: a viewport export is
 * serialised at build time and cannot read a CSS custom property. It must therefore be
 * changed by hand whenever `--color-field` in globals.css changes.
 */
export const viewport: Viewport = {
  themeColor: "#161211",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={faceVariables}>
      {/* The content plane sits above the page grain and vignette, which are painted
          once on the body pseudo-elements rather than per component. */}
      <body>
        {/* The rail is inside the plane rather than above it: it is part of the instrument, and
            the grain and vignette painted on the body have to sit behind it too. */}
        <div className="app-plane flex min-h-dvh flex-col">
          <StatusBar />
          {children}
        </div>
      </body>
    </html>
  );
}
