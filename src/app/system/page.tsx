import type { Metadata } from "next";
import type { ReactNode } from "react";

import { SegmentedDemo } from "@/components/system/segmented-demo";
import { Button } from "@/components/ui/button";
import { TextAreaField, TextField } from "@/components/ui/field";
import { HopRingGlyph } from "@/components/ui/hop-ring-glyph";
import { Icon, type IconName } from "@/components/ui/icon";
import { Panel, PanelBody, PanelHeader, Shell, Tray } from "@/components/ui/panel";
import { AbstainNotice, EmptyState, Skeleton } from "@/components/ui/state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@/components/ui/table";
import { DataValue, DefinitionRow, Eyebrow, FieldLabel, UnitSuffix } from "@/components/ui/text";
import { AdvisoryChip, HopBadge, VerdictPill } from "@/components/ui/verdict";

export const metadata: Metadata = {
  title: "Design system",
  description:
    "Every primitive in Patient Zero with every state it can be in, rendered on the real tokens.",
};

/**
 * The states matrix.
 *
 * design-ui requires every primitive to exist in every state before a screen is composed
 * from it, and this page is where that requirement is checked rather than asserted. Each
 * primitive appears with its default, disabled, loading, error, empty, and selected states
 * side by side, so the whole set can be verified in one screenshot at 2x.
 *
 * Hover, focus-visible, and active are pseudo-state driven and cannot be captured in a
 * static screenshot. Where a state changes the colour pair (the primary button darkens its
 * ground and lightens its ink together, because field ink on the deep amber measures 3.16:1
 * and fails), the pair is rendered a second time with the hover classes promoted onto the
 * base element and labelled as forced, so the contrast can still be read off the image.
 */

const ICON_NAMES: readonly IconName[] = [
  "hop",
  "clock",
  "package",
  "maintainer",
  "advisory",
  "confirmed",
  "unknown",
  "search",
  "upload",
  "expand",
];

/**
 * The type steps, in the order the sheet lists them, each with the face it is set in.
 *
 * The face is part of the specimen rather than an implicit default. A step's size utility does
 * not carry a face (Tailwind has no `--text-*--font-family` sub-property), so a display step
 * applied to a `span` renders in the reading face unless it asks for the display face by name.
 * That is exactly the mistake this page exists to catch, so the face is declared per step and
 * printed beside the token.
 */
const TYPE_STEPS: readonly {
  token: string;
  className: string;
  face: "display" | "text" | "data";
  sample: string;
}[] = [
  {
    token: "--text-display",
    className: "font-display text-display",
    face: "display",
    sample: "Patient Zero",
  },
  {
    token: "--text-title",
    className: "font-display text-title",
    face: "display",
    sample: "Blast radius",
  },
  {
    token: "--text-heading",
    className: "font-display text-heading",
    face: "display",
    sample: "Resolved while live",
  },
  {
    token: "--text-body",
    className: "text-body",
    face: "text",
    sample: "Seven services resolved this version while the payload was live.",
  },
  {
    token: "--text-small",
    className: "text-small",
    face: "text",
    sample: "Coverage is partial, so an empty result is not an all-clear.",
  },
  {
    token: "--text-eyebrow",
    className: "font-display text-eyebrow uppercase",
    face: "display",
    sample: "patient zero",
  },
  {
    token: "--text-data",
    className: "font-data text-data",
    face: "data",
    sample: "npm:event-stream:3.3.6",
  },
  {
    token: "--text-data-lg",
    className: "font-data text-data-lg",
    face: "data",
    sample: "78.6",
  },
  {
    token: "--text-unit",
    className: "font-data text-unit",
    face: "data",
    sample: "days live",
  },
];

/** Every palette role, so a shifted token is visible rather than inferred. */
const PALETTE_ROLES: readonly { token: string; swatchClassName: string }[] = [
  { token: "--color-field", swatchClassName: "bg-field" },
  { token: "--color-surface", swatchClassName: "bg-surface" },
  { token: "--color-sunken", swatchClassName: "bg-sunken" },
  { token: "--color-edge", swatchClassName: "bg-edge" },
  { token: "--color-edge-strong", swatchClassName: "bg-edge-strong" },
  { token: "--color-ink", swatchClassName: "bg-ink" },
  { token: "--color-ink-muted", swatchClassName: "bg-ink-muted" },
  { token: "--color-ink-faint", swatchClassName: "bg-ink-faint" },
  { token: "--color-accent", swatchClassName: "bg-accent" },
  { token: "--color-accent-deep", swatchClassName: "bg-accent-deep" },
  { token: "--color-critical", swatchClassName: "bg-critical" },
  { token: "--color-tint-accent", swatchClassName: "bg-tint-accent" },
  { token: "--color-tint-critical", swatchClassName: "bg-tint-critical" },
  { token: "--color-tint-quiet", swatchClassName: "bg-tint-quiet" },
];

export default function DesignSystemPage() {
  return (
    <main className="mx-auto flex max-w-[1100px] flex-col gap-6 px-6 py-6">
      <div className="flex items-center gap-3">
        <HopRingGlyph size={28} />
        <div className="flex flex-col">
          <h1 className="text-title text-ink">Design system</h1>
          <p className="text-small text-ink-muted">
            Every primitive, every state, on the real tokens. Rationale in
            docs/UI_DESIGN_SYSTEM.md.
          </p>
        </div>
      </div>

      <Section eyebrow="section 2" title="Palette">
        <div className="flex flex-wrap gap-3">
          {PALETTE_ROLES.map((role) => (
            <div key={role.token} className="flex w-[168px] flex-col gap-2">
              <div
                className={`h-12 rounded-chip shadow-raised ${role.swatchClassName}`}
                aria-hidden="true"
              />
              <TokenName>{role.token}</TokenName>
            </div>
          ))}
        </div>
      </Section>

      <Section eyebrow="section 3" title="Type steps">
        <div className="flex flex-col gap-5">
          {TYPE_STEPS.map((step) => (
            <div key={step.token} className="flex flex-col gap-1">
              <TokenName className="flex items-baseline gap-2">
                {step.token}
                <span className="text-ink-muted">{step.face}</span>
              </TokenName>
              <span className={`${step.className} text-ink`}>{step.sample}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section eyebrow="section 3" title="Label treatments">
        <div className="flex flex-col gap-4">
          <StateRow label="eyebrow, the display face, names a region">
            <Eyebrow>patient zero</Eyebrow>
          </StateRow>
          <StateRow label="field label, inline left of its value or above its control">
            <DefinitionRow label="Introduced in" className="w-[280px]">
              <DataValue>3.3.6</DataValue>
            </DefinitionRow>
          </StateRow>
          <StateRow label="unit suffix, after the number">
            <span className="flex items-baseline gap-1">
              <DataValue scale="lg">78.6</DataValue>
              <UnitSuffix>days live</UnitSuffix>
            </span>
          </StateRow>
        </div>
      </Section>

      <Section eyebrow="section 4" title="Verdicts, the load-bearing encoding">
        <div className="flex flex-col gap-4">
          <StateRow label="all three, same axis, different value and form">
            <div className="flex flex-wrap items-center gap-3">
              <VerdictPill verdict="exposed" rationale="Four paths reach a compromised version." />
              <VerdictPill verdict="unknown" rationale="The dependency closure is partial." />
              <VerdictPill verdict="not_exposed" rationale="Closure complete, no path found." />
            </div>
          </StateRow>
          <StateRow label="advisory severity, a separate axis">
            <div className="flex flex-wrap items-center gap-3">
              <AdvisoryChip>GHSA-mh6f-8j2x-4483</AdvisoryChip>
              <HopBadge hops={0} />
              <HopBadge hops={1} />
              <HopBadge hops={4} />
            </div>
          </StateRow>
        </div>
      </Section>

      <Section eyebrow="section 8" title="Buttons">
        <div className="flex flex-col gap-4">
          <StateRow label="default">
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" icon="search">
                Trace exposure
              </Button>
              <Button variant="secondary" icon="upload">
                Paste lockfile
              </Button>
              <Button variant="ghost" icon="expand">
                Show paths
              </Button>
            </div>
          </StateRow>
          <StateRow label="hover pair, forced onto the base element so contrast is readable">
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" icon="search" className="bg-accent-deep text-ink">
                Trace exposure
              </Button>
              <Button variant="secondary" icon="upload" className="bg-tint-quiet">
                Paste lockfile
              </Button>
              <Button variant="ghost" icon="expand" className="bg-tint-quiet text-ink">
                Show paths
              </Button>
            </div>
          </StateRow>
          <StateRow label="loading, label stays visible">
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" isLoading>
                Trace exposure
              </Button>
              <Button variant="secondary" isLoading>
                Reading slice
              </Button>
            </div>
          </StateRow>
          <StateRow label="disabled">
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" disabled>
                Trace exposure
              </Button>
              <Button variant="secondary" disabled>
                Paste lockfile
              </Button>
              <Button variant="ghost" disabled>
                Show paths
              </Button>
            </div>
          </StateRow>
        </div>
      </Section>

      <Section eyebrow="section 6" title="Inputs, recessed material">
        <div className="grid gap-5 md:grid-cols-2">
          <TextField
            label="Package key"
            placeholder="npm:event-stream"
            defaultValue="npm:event-stream"
            hint="Ecosystem prefix, then the registry name."
          />
          <TextField
            label="Version"
            defaultValue="3.3.6!!"
            error="Not a semver string, so no version could be selected."
          />
          <TextField label="Disabled" defaultValue="no slice loaded" disabled />
          <TextAreaField
            label="Lockfile"
            rows={5}
            defaultValue={'{\n  "lockfileVersion": 3,\n  "packages": {}\n}'}
            hint="Parsed in the browser session only. Nothing is stored."
          />
        </div>
      </Section>

      <Section eyebrow="section 7" title="Incident picker and the identity glyph">
        <div className="flex flex-col gap-4">
          <StateRow label="segmented control, one option disabled">
            <SegmentedDemo />
          </StateRow>
          <StateRow label="hop-ring glyph at three scales">
            <div className="flex items-center gap-4">
              <HopRingGlyph size={20} />
              <HopRingGlyph size={28} />
              <HopRingGlyph size={44} />
            </div>
          </StateRow>
          <StateRow label="icon set, ten glyphs on one 16px grid">
            <div className="flex flex-wrap items-center gap-4 text-ink-muted">
              {ICON_NAMES.map((iconName) => (
                <span key={iconName} className="flex flex-col items-center gap-2">
                  <Icon name={iconName} size={20} />
                  <TokenName>{iconName}</TokenName>
                </span>
              ))}
            </div>
          </StateRow>
        </div>
      </Section>

      <Section eyebrow="section 5" title="Table, 36px rows">
        <Table caption="Dependents of npm:event-stream at hop 1" isCaptionVisible>
          <TableHead>
            <TableHeaderCell>Package</TableHeaderCell>
            <TableHeaderCell>Verdict</TableHeaderCell>
            <TableHeaderCell isNumeric>Hops</TableHeaderCell>
            <TableHeaderCell isNumeric>Services behind</TableHeaderCell>
          </TableHead>
          <TableBody>
            <TableRow isActive>
              <TableCell>
                <DataValue>npm:flatmap-stream</DataValue>
              </TableCell>
              <TableCell>
                <VerdictPill verdict="exposed" />
              </TableCell>
              <TableCell isNumeric>
                <DataValue>1</DataValue>
              </TableCell>
              <TableCell isNumeric>
                <DataValue>7</DataValue>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell>
                <DataValue>npm:ps-tree</DataValue>
              </TableCell>
              <TableCell>
                <VerdictPill verdict="unknown" />
              </TableCell>
              <TableCell isNumeric>
                <DataValue>2</DataValue>
              </TableCell>
              <TableCell isNumeric>
                <DataValue muted>partial</DataValue>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell>
                <DataValue>npm:duplexer</DataValue>
              </TableCell>
              <TableCell>
                <VerdictPill verdict="not_exposed" />
              </TableCell>
              <TableCell isNumeric>
                <DataValue>2</DataValue>
              </TableCell>
              <TableCell isNumeric>
                <DataValue>0</DataValue>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Section>

      <Section eyebrow="section 4" title="Loading, empty, abstaining">
        <div className="flex flex-col gap-5">
          <Panel>
            <PanelHeader title="Loading" aside={<Eyebrow>reading slice</Eyebrow>} />
            <Skeleton label="Reading the dependency closure" rows={3} />
          </Panel>

          <Panel>
            <PanelHeader title="Empty, and that is the whole answer" />
            <EmptyState title="No typosquat candidates in this slice">
              All 402 package names were compared against the top downloads by edit distance,
              keyboard adjacency, and homoglyph substitution. None scored above the threshold, and
              the comparison set was complete, so this is a finding rather than a gap.
            </EmptyState>
          </Panel>

          <AbstainNotice
            rationale="Three of the four questions behind this answer could not be closed, so the tool will not say whether your service is exposed."
            limits={[
              "The dependency closure for npm:event-stream is partial, covering 402 of an unknown number of packages.",
              "The traversal stopped at 6 hops, so a longer path would not have been found.",
              "One service has no resolution history before 2018-09-12, so an earlier resolution cannot be ruled out.",
            ]}
          />
        </div>
      </Section>

      <Section eyebrow="section 6" title="Materials, three and no fourth">
        {/* Each material against the ground it actually sits on, in the nesting the five
            surfaces use. Three swatches side by side on this section's own surface would show
            the raised material on the colour it is made of, which is nil ground contrast and
            makes the demo say the opposite of what the token does. */}
        <div className="flex flex-col gap-3 rounded-shell bg-field p-4">
          <Eyebrow>field, the page ground</Eyebrow>
          <Panel className="flex flex-col gap-3 p-4">
            <Eyebrow>raised, sitting on the field</Eyebrow>
            <Tray className="flex h-20 items-end rounded-control p-3">
              <Eyebrow>recessed, cut into the raised</Eyebrow>
            </Tray>
          </Panel>
        </div>
      </Section>
    </main>
  );
}

/**
 * The caption under a specimen: a token name, an icon name, a face name.
 *
 * It borrows the unit step because what it prints is machine-generated and belongs at the
 * smallest readable size, and it is deliberately not one of the sheet's three label
 * treatments: it names the specimen above it, which is a job only this reference page has.
 */
function TokenName({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={`font-data text-unit text-ink-faint ${className ?? ""}`}>{children}</span>
  );
}

/** A section of the matrix. Uses the shell material, so the page is itself made of tokens. */
function Section({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <Shell>
      <PanelHeader title={title} eyebrow={eyebrow} />
      <PanelBody className="p-6">{children}</PanelBody>
    </Shell>
  );
}

/** One labelled state within a section, so a screenshot says which state it is showing. */
function StateRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <FieldLabel>{label}</FieldLabel>
      {children}
    </div>
  );
}
