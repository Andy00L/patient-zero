import type { ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";

import { joinClassNames } from "./class-names";

/**
 * The table. Composable pieces rather than one component with a column config, because the
 * five surfaces show genuinely different columns and a config object would end up being a
 * worse version of JSX.
 *
 * Row height is the sheet's `--h-row` (36px), fixed as a token because a table row and a
 * control have to line up across surfaces built by different hands. Numbers align without
 * each cell asking for it: `th` and `td` get `tabular-nums` in globals.css.
 */

type TableSectionProps = {
  children: ReactNode;
  className?: string;
};

export type TableProps = TableSectionProps & {
  /**
   * Names the table for assistive tech. Required rather than optional: a table of package
   * keys with no caption is unreadable out of visual context, and every surface here has an
   * obvious name for its table.
   */
  caption: string;
  /** Renders the caption visibly above the table instead of only for assistive tech. */
  isCaptionVisible?: boolean;
};

export function Table({ children, caption, isCaptionVisible = false, className }: TableProps) {
  return (
    <div className={joinClassNames("w-full overflow-x-auto", className)}>
      <table className="w-full border-collapse text-left">
        <caption
          className={joinClassNames(
            "text-small text-ink-muted",
            isCaptionVisible ? "px-4 pb-3 text-left" : "sr-only",
          )}
        >
          {caption}
        </caption>
        {children}
      </table>
    </div>
  );
}

export function TableHead({ children, className }: TableSectionProps) {
  return (
    <thead className={joinClassNames("bg-surface", className)}>
      <tr className="border-b border-edge">{children}</tr>
    </thead>
  );
}

export function TableBody({ children, className }: TableSectionProps) {
  return <tbody className={className}>{children}</tbody>;
}

export type TableRowProps = TableSectionProps & {
  /**
   * Marks the row the reader is currently inspecting, for example the scrubber's cursor.
   * Rendered as the `.row-active` leading rule rather than an accent ground, because the
   * accent ground already means "exposed" on a verdict: see the recipe in globals.css.
   */
  isActive?: boolean;
};

export function TableRow({ children, isActive = false, className }: TableRowProps) {
  return (
    <tr
      aria-current={isActive ? "true" : undefined}
      className={joinClassNames(
        "h-[var(--h-row)] border-b border-edge last:border-b-0",
        "transition-colors duration-[var(--dur-small)] ease-out",
        isActive ? "row-active" : "hover:bg-tint-quiet",
        className,
      )}
    >
      {children}
    </tr>
  );
}

export type TableHeaderCellProps = Omit<
  ThHTMLAttributes<HTMLTableCellElement>,
  "className" | "children"
> & {
  children: ReactNode;
  /** Right-aligns the column. Use it for every numeric column so the digits line up. */
  isNumeric?: boolean;
  className?: string;
};

/**
 * A header cell. A column head names a region, so it takes the eyebrow treatment: the display
 * face at the 11px tracked-caps step. It carries the classes directly rather than wrapping the
 * `Eyebrow` component, because a `<th>` needs them on itself to keep `scope` and the cell's own
 * alignment, and nesting a span inside would put the padding and the type on different elements.
 */
export function TableHeaderCell({
  children,
  isNumeric = false,
  className,
  ...rest
}: TableHeaderCellProps) {
  return (
    <th
      scope="col"
      className={joinClassNames(
        "px-4 py-2 font-display text-eyebrow uppercase text-ink-faint",
        isNumeric ? "text-right" : "text-left",
        className,
      )}
      {...rest}
    >
      {children}
    </th>
  );
}

export type TableCellProps = Omit<
  TdHTMLAttributes<HTMLTableCellElement>,
  "className" | "children"
> & {
  children: ReactNode;
  isNumeric?: boolean;
  className?: string;
};

export function TableCell({ children, isNumeric = false, className, ...rest }: TableCellProps) {
  return (
    <td
      className={joinClassNames(
        "px-4 py-2 text-small text-ink",
        isNumeric ? "text-right" : "text-left",
        className,
      )}
      {...rest}
    >
      {children}
    </td>
  );
}
