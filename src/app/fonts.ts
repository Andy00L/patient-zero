import localFont from "next/font/local";

/**
 * The two typefaces, declared once.
 *
 * Both are self-hosted from ./fonts and exposed as CSS custom properties rather than
 * class names, so globals.css can name them in @theme and every component reaches them
 * through a token instead of importing this module. See src/app/fonts/NOTICE.md for the
 * license and the attribution this project is required to carry.
 *
 * The split of roles is a rule, not a preference, and it has three parts rather than two.
 * Technor carries identity and structure: the display, title, and heading steps, and the
 * eyebrow. Tabular carries only machine-generated content (package keys, semver strings, ISO
 * timestamps, counts in a column). Everything a reader reads as sentences is set in the
 * platform neutral, which is declared directly in globals.css and needs no file here.
 * Rationale in docs/UI_DESIGN_SYSTEM.md section 3.
 */

/** Technor, the identity face. Display, title, heading, and the eyebrow treatment. */
export const displayFace = localFont({
  src: [
    { path: "./fonts/Technor-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/Technor-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/Technor-700.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-technor",
  display: "swap",
  // system-ui first: it is the one genuinely neutral fallback, and its metrics are close
  // enough to Technor that the swap is not a visible reflow.
  fallback: ["system-ui", "-apple-system", "Segoe UI", "sans-serif"],
});

/**
 * Tabular, the data face. A true monospace, which is why it is confined to data: a mono
 * spread across prose reads as a costume rather than a decision.
 */
export const dataFace = localFont({
  src: [
    { path: "./fonts/Tabular-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/Tabular-500.woff2", weight: "500", style: "normal" },
  ],
  variable: "--font-tabular",
  display: "swap",
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
  // Next adjusts a local font's fallback metrics toward Arial by default. Arial is a
  // proportional sans, so scaling a monospace fallback toward it makes the swap worse,
  // not better. The mono stack above is already a close metric match.
  adjustFontFallback: false,
});

/** Both font variables, for the html element. */
export const faceVariables = `${displayFace.variable} ${dataFace.variable}`;
