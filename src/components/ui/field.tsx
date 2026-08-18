"use client";

import { useId } from "react";
import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";

import { joinClassNames } from "./class-names";
import { FieldLabel } from "./text";

/**
 * Text inputs, with the error slot present from birth rather than bolted on later.
 *
 * Input interiors are the sheet's recessed material (section 6): sunken ground plus an inset
 * stack, no outer shadow, so a field reads as cut into the panel instead of sitting on it.
 *
 * These are client components because they call `useId` to wire the error message to the
 * control through `aria-describedby`. Requiring callers to invent ids by hand is how a
 * description ends up pointing at nothing.
 */

/**
 * Shared interior classes. The rim states live in the `.tray-interior` recipe in globals.css,
 * because all three of them (rest, hover, invalid) are the same `box-shadow` property and one
 * property cannot be driven by three competing utilities. Focus is the app's single outline
 * treatment from the base layer, layered on top rather than replacing the rim, so an invalid
 * field that is also focused still shows both facts.
 */
const INTERIOR_CLASSES = joinClassNames(
  "tray-interior w-full text-ink px-3",
  "placeholder:text-ink-faint",
  "transition-[box-shadow,background-color] duration-[var(--dur-small)] ease-out",
  "disabled:cursor-not-allowed disabled:bg-tint-quiet disabled:text-ink-faint",
);

type SharedFieldProps = {
  label: ReactNode;
  /**
   * The error message. Present means invalid: the component sets aria-invalid from this
   * rather than taking a separate boolean, so a field cannot be marked invalid with nothing
   * to read.
   */
  error?: string;
  /** A hint that is always visible, above the control's error slot. */
  hint?: ReactNode;
  className?: string;
};

export type TextFieldProps = SharedFieldProps &
  Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "id" | "aria-invalid">;

/**
 * A single-line field. Used for the package key and version lookups.
 *
 * The interior takes the data face because every single-line field in this app takes machine
 * input: a package key, a semver range, a path glob. A reader comparing what they typed
 * against a row in a results table should be reading the same face in both places.
 */
export function TextField({ label, error, hint, className, ...rest }: TextFieldProps) {
  const controlId = useId();
  const messageId = `${controlId}-message`;

  return (
    <div className={joinClassNames("flex flex-col gap-2", className)}>
      <label htmlFor={controlId} className="w-fit">
        <FieldLabel>{label}</FieldLabel>
      </label>
      <input
        id={controlId}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? messageId : undefined}
        className={joinClassNames(INTERIOR_CLASSES, "h-[var(--h-control)] font-data text-data")}
        {...rest}
      />
      <FieldMessage id={messageId} error={error} hint={hint} />
    </div>
  );
}

export type TextAreaFieldProps = SharedFieldProps &
  Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className" | "id" | "aria-invalid">;

/**
 * A multi-line field. The lockfile paste on the scan surface is the only caller, and a whole
 * lockfile is the one input here that needs to be scanned by eye for structure, which is why
 * this is the only interior that allows a resize handle.
 */
export function TextAreaField({
  label,
  error,
  hint,
  className,
  rows = 10,
  ...rest
}: TextAreaFieldProps) {
  const controlId = useId();
  const messageId = `${controlId}-message`;

  return (
    <div className={joinClassNames("flex flex-col gap-2", className)}>
      <label htmlFor={controlId} className="w-fit">
        <FieldLabel>{label}</FieldLabel>
      </label>
      <textarea
        id={controlId}
        rows={rows}
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? messageId : undefined}
        className={joinClassNames(INTERIOR_CLASSES, "resize-y py-3 font-data text-data")}
        {...rest}
      />
      <FieldMessage id={messageId} error={error} hint={hint} />
    </div>
  );
}

/**
 * The error slot. Reserves no height when empty, because an always-present blank line under
 * every field reads as a layout bug rather than as care. The error takes precedence over the
 * hint: showing both would make the reader choose which one applies.
 */
function FieldMessage({
  id,
  error,
  hint,
}: {
  id: string;
  error?: string;
  hint?: ReactNode;
}) {
  if (error) {
    return (
      <p id={id} className="text-small text-critical">
        {error}
      </p>
    );
  }

  if (hint) {
    return (
      <p id={id} className="text-small text-ink-faint">
        {hint}
      </p>
    );
  }

  return null;
}
