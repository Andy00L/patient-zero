import type { ReactNode } from "react";

import { joinClassNames } from "@/components/ui/class-names";

/**
 * The frame every surface is built in.
 *
 * Five surfaces answer five questions against the same graph, and they are the same instrument
 * seen from five angles rather than five pages of a site. So the frame is shared and fixed: one
 * column at `--w-surface`, the question this surface answers stated at the top in the display
 * face, the controls that change the answer on the same line as the question, and the answer
 * itself below in panels.
 *
 * What is deliberately absent: a centred hero, a label stacked above the heading, and a
 * closing call to action. This tool has one job on each surface and the head says what it is;
 * the rest of the vertical space belongs to the finding.
 */

export type SurfaceProps = {
  children: ReactNode;
  className?: string;
};

export function Surface({ children, className }: SurfaceProps) {
  return (
    <main
      className={joinClassNames(
        "mx-auto flex w-full max-w-[var(--w-surface)] flex-col gap-6 px-6 py-6",
        className,
      )}
    >
      {children}
    </main>
  );
}

export type SurfaceHeadProps = {
  /**
   * The question this surface answers, written as a question. A surface named after its
   * mechanism ("Graph traversal") tells a reader nothing they can act on; a surface that asks
   * "who is exposed to this version" tells them what they will get back.
   */
  question: string;
  /**
   * One sentence of what the answer is worth: what it is computed from, and what it does not
   * cover. It sits under the question rather than over it, because a small line above a large
   * heading reads as decoration while the same line below it reads as a qualification.
   */
  lede: string;
  /** The controls that change this surface's answer. Rendered at the end of the head row. */
  controls?: ReactNode;
};

export function SurfaceHead({ question, lede, controls }: SurfaceHeadProps) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b border-edge pb-4">
      <div className="flex max-w-prose flex-col gap-1">
        <h1 className="font-display text-title text-ink">{question}</h1>
        <p className="text-small text-ink-muted">{lede}</p>
      </div>
      {controls === undefined ? null : (
        <div className="flex flex-wrap items-center gap-3">{controls}</div>
      )}
    </div>
  );
}
