"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

import { joinClassNames } from "./class-names";
import { Icon, type IconName } from "./icon";

/**
 * The button set. Three variants, one size, and every state present from birth: default,
 * hover, focus-visible, active, disabled, and loading.
 *
 * There is no destructive variant, and that is a decision rather than an omission. This
 * tool only reads: nothing is deleted and no write is issued from the UI, so a destructive
 * button would be a control with nothing to do. docs/UI_DESIGN_SYSTEM.md section 2 records
 * the same reasoning for the `--color-destructive` token. If a destructive action is ever
 * added, the variant is added here and the token gets its own value in the sheet first.
 *
 * Motion follows the sheet's section 8: hover changes tint only, buttons never move, lift,
 * or grow on hover, and press is a 0.98 scale at --dur-micro.
 */

export type ButtonVariant = "primary" | "secondary" | "ghost";

/**
 * Per-variant classes for the resting and hover states. The grounds and inks here are the
 * measured pairs from the sheet's contrast ledger (section 9), so a variant cannot be
 * recoloured into a failing pair.
 *
 * The primary variant swaps its ink alongside its ground, which looks like an
 * inconsistency and is not: --color-field on --color-accent is 6.20:1, but the same field
 * ink on --color-accent-deep is only 3.16:1, while --color-ink on accent-deep is 5.06:1.
 * The darker ground therefore has to take the lighter ink. Keeping one ink across both
 * would ship a failing pair on one of them. The sheet's never-pair rules say the same
 * thing from the other direction.
 */
const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-accent text-field hover:bg-accent-deep hover:text-ink",
  secondary: "bg-surface text-ink shadow-raised hover:bg-tint-quiet",
  ghost: "bg-transparent text-ink-muted hover:bg-tint-quiet hover:text-ink",
};

/**
 * The unavailable appearance, kept separate from the variant above because it is applied by
 * the component rather than by the `disabled:` variant alone.
 *
 * A loading button is `disabled` in HTML, so a `disabled:` utility would drain its colour and
 * a busy primary would look exactly like an unavailable one. "Working" and "unavailable" are
 * different facts and a reader has to be able to tell them apart, so these classes are
 * withheld while the button is busy: a loading button keeps its full variant colour and
 * reports itself through the arc and `aria-busy`.
 */
const VARIANT_DISABLED_CLASSES: Record<ButtonVariant, string> = {
  primary: "disabled:bg-tint-quiet disabled:text-ink-faint",
  secondary: "disabled:bg-tint-quiet disabled:text-ink-faint disabled:shadow-none",
  ghost: "disabled:bg-transparent disabled:text-ink-faint",
};

export type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  children: ReactNode;
  variant?: ButtonVariant;
  /** A glyph from the house set, placed before the label. */
  icon?: IconName;
  /**
   * Renders the loading state. The label stays visible throughout, because the sheet's
   * first motion law is that nothing has its existence gated on a pending state.
   */
  isLoading?: boolean;
};

export function Button({
  children,
  variant = "secondary",
  icon,
  isLoading = false,
  disabled = false,
  className,
  type = "button",
  ...rest
}: ButtonProps) {
  // A loading button must not fire again, but it reports itself through aria-busy rather
  // than only through the disabled attribute, so assistive tech hears "busy" and not
  // "unavailable".
  const isInteractionBlocked = disabled || isLoading;

  return (
    <button
      type={type}
      disabled={isInteractionBlocked}
      aria-busy={isLoading || undefined}
      className={joinClassNames(
        "inline-flex h-[var(--h-control)] items-center justify-center gap-2",
        "rounded-control px-3 text-small font-medium",
        "transition-[color,background-color,box-shadow,transform]",
        "duration-[var(--dur-small)] ease-out",
        "active:scale-[0.98] active:duration-[var(--dur-micro)]",
        "disabled:active:scale-100",
        VARIANT_CLASSES[variant],
        isLoading
          ? "cursor-wait"
          : joinClassNames("disabled:cursor-not-allowed", VARIANT_DISABLED_CLASSES[variant]),
        className,
      )}
      {...rest}
    >
      {isLoading ? <LoadingArc /> : icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
}

/**
 * The loading indicator: a 270 degree arc on the same 16px grid as the icon set, so it
 * occupies the icon slot exactly and the label does not shift when loading starts.
 *
 * A continuous rotation sits outside the sheet's 320ms ceiling on purpose. The ceiling
 * governs motion that responds to an action and then settles; this reports an ongoing state,
 * the same category as the radar sweep. Under prefers-reduced-motion the global rule in
 * globals.css caps the iteration count at 1, so the arc freezes rather than spinning fast.
 */
function LoadingArc() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
      className="shrink-0 animate-spin"
    >
      <path d="M14 8a6 6 0 1 0-6 6" />
    </svg>
  );
}
