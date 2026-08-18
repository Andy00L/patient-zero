import { QueryProvenance } from "@/components/app/query-provenance";
import { Surface, SurfaceHead } from "@/components/app/surface";
import { ConfidencePicker } from "@/components/typosquats/confidence-picker";
import {
  type ConfusablePair,
  countMirroredPairs,
  countPairsByConfidence,
  keepAtFloor,
  splitByLockfilePin,
} from "@/components/typosquats/confusable-pairs";
import { PairList } from "@/components/typosquats/pair-list";
import { scanSliceForConfusables } from "@/components/typosquats/slice-scan";
import {
  CONFIDENCE_PARAMETER,
  describeFloorChoices,
  readRequestedFloor,
  selectFloor,
} from "@/components/typosquats/typosquat-query";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import { AbstainNotice, EmptyState } from "@/components/ui/state";
import { DataValue, FieldLabel, UnitSuffix } from "@/components/ui/text";
import { describeLimit } from "@/lib/analysis/abstention";
import { formatCount } from "@/lib/format";
import { requestGraph } from "@/lib/graph/request-graph";
import { withStatementLog } from "@/lib/graph/statements";

/**
 * The typosquat surface: which names in the slice are close enough to be installed by mistake.
 *
 * The surface is built around one distinction, and the two panels are that distinction rather than
 * a layout choice. A name that merely looks like a popular one is a candidate: a collision, and
 * collisions are cheap, because thousands of legitimate packages are one edit from a neighbour. A
 * candidate a lockfile in this slice actually resolved is a finding: a name that reached a disk.
 * Presenting those two in one list would produce a wall of near-miss names with the two rows that
 * matter buried in it, and a wall of near-miss names is noise rather than an answer.
 *
 * The pin is the line between the two, not the declared dependency. A manifest can name a range
 * that never resolved to anything; a lockfile entry is a version something installed. Both
 * readings appear on every row either way, so a reader can see the manifest count that did not
 * promote a pair.
 *
 * Direction is the other thing this surface refuses to guess. Which of two confusable names is the
 * imitation is settled by the popularity gap and by nothing else, and this slice carries a download
 * figure for a minority of its packages, so most pairs have no gap to measure. Those rows read
 * "confusable with" rather than "imitating", and the count of them is stated rather than hidden.
 *
 * Every figure comes from `scanForTyposquats` and from two graph traversals. Nothing is scored or
 * re-ranked here: the pairs arrive in the detector's own order and stay in it.
 * sourceRef: src/components/typosquats/slice-scan.ts.
 */

const QUESTION = "Which names here are one typo away from a package you meant to install?";

const LEDE =
  "Every name in the slice is compared against every other name in the same registry, then each side of every pair is measured against the slice's dependency and lockfile edges. A pair a lockfile resolved is a finding; a pair nothing resolved is a collision, and the two are kept apart.";

/**
 * Sentences the surface can only write once it knows what the scan produced.
 *
 * Written here rather than in the view model because they are copy about how to read a region, and
 * the view model holds no copy. Each one is conditional on a fact, so none of them appears on a
 * slice where it would not be true.
 */
function writeDirectionCaveat(pairs: readonly ConfusablePair[]): string | null {
  const mirrored = countMirroredPairs(pairs);
  if (mirrored === 0) return null;

  const scope =
    mirrored === pairs.length
      ? "Every pair here reads"
      : `${formatCount(mirrored)} of these ${formatCount(pairs.length)} pairs read`;
  return `${scope} "confusable with" rather than "imitating": the detector reported the collision from both ends, because it has no weekly download figure for at least one of the two names and the popularity gap is the only evidence that names the imitation.`;
}

export default async function TyposquatsPage({ searchParams }: PageProps<"/typosquats">) {
  const params = await searchParams;
  const requestedFloor = readRequestedFloor(params[CONFIDENCE_PARAMETER]);

  const graph = await requestGraph();
  if (!graph.ok) {
    return (
      <Surface>
        <SurfaceHead
          question={QUESTION}
          lede="The graph could not be read, so no name can be compared to another and none is shown."
        />
        <EmptyState title="The graph could not be read">
          The comparison runs over the names the slice ingested, and the slice could not be opened.
          An empty list is not the same claim as a registry with no confusable names, so nothing is
          listed rather than nothing being found. The loader reported: {graph.failure.message}
        </EmptyState>
      </Surface>
    );
  }

  const answered = await withStatementLog(() => scanSliceForConfusables(graph.value.gateway));

  if (!answered.value.ok) {
    return (
      <Surface>
        <SurfaceHead question={QUESTION} lede={LEDE} />
        <EmptyState title="The names could not be compared">
          The graph was readable but the scan did not finish, so no pair is listed rather than a
          partial board being presented as the whole set. The scan reported:{" "}
          {answered.value.failure.message}
        </EmptyState>
        <QueryProvenance record={answered.record} />
      </Surface>
    );
  }

  const answer = answered.value.value;
  const scan = answer.evidence;
  const limits = answer.limits.map(describeLimit);

  const sliceStrip = (
    <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
      <span className="flex items-baseline gap-1">
        <DataValue muted>{formatCount(scan.candidatesScanned)}</DataValue>
        <UnitSuffix>of {formatCount(scan.packagesInGraph)} names compared</UnitSuffix>
      </span>
      <span className="flex items-baseline gap-1">
        <DataValue muted>{formatCount(scan.namesWithoutDownloadCount)}</DataValue>
        <UnitSuffix>carry no weekly download figure</UnitSuffix>
      </span>
      {/* The fold is stated because the detector reports a collision once from each end, and a
          reader who compares this surface with the JSON route would otherwise see two different
          numbers for the same slice. sourceRef: src/app/api/typosquats/route.ts. */}
      <span className="flex items-baseline gap-1">
        <DataValue muted>{formatCount(scan.findingCount)}</DataValue>
        <UnitSuffix>findings folded into {formatCount(scan.pairs.length)} pairs</UnitSuffix>
      </span>
      {scan.unusableCandidateCount > 0 ? (
        <span className="flex items-baseline gap-1">
          <DataValue muted>{formatCount(scan.unusableCandidateCount)}</DataValue>
          <UnitSuffix>names the detector could not score</UnitSuffix>
        </span>
      ) : null}
    </div>
  );

  if (scan.pairs.length === 0) {
    return (
      <Surface>
        <SurfaceHead question={QUESTION} lede={LEDE} />
        <AbstainNotice rationale={answer.rationale} limits={limits} />
        <Panel>
          <PanelHeader eyebrow="coverage" title="What was compared" />
          <PanelBody>{sliceStrip}</PanelBody>
        </Panel>
        <QueryProvenance record={answered.record} />
      </Surface>
    );
  }

  const counts = countPairsByConfidence(scan.pairs);
  const choices = describeFloorChoices(counts);
  const floor = selectFloor(choices, requestedFloor);
  const listed = keepAtFloor(scan.pairs, floor);
  const { pinned, unpinned } = splitByLockfilePin(listed);

  const pinnedCaveat = writeDirectionCaveat(pinned);
  const unpinnedCaveat = writeDirectionCaveat(unpinned);

  return (
    <Surface>
      <SurfaceHead
        question={QUESTION}
        lede={LEDE}
        controls={
          // One chip is not a choice: a slice whose pairs all carry the same confidence renders no
          // control rather than a group of one.
          choices.length > 1 ? <ConfidencePicker choices={choices} selected={floor} /> : undefined
        }
      />

      <Panel>
        <PanelHeader
          eyebrow="findings"
          title="Confusable names a lockfile here resolved"
          aside={
            <span className="flex items-baseline gap-1">
              <DataValue>{formatCount(pinned.length)}</DataValue>
              <UnitSuffix>of {formatCount(listed.length)} pairs</UnitSuffix>
            </span>
          }
        />

        {/* The qualifications sit above the list rather than under it. A reader who has already
            read the rows has already formed the belief the caveat was meant to qualify. */}
        <PanelBody className="flex flex-col gap-3">
          {answer.verdict === "unknown" ? (
            <AbstainNotice rationale={answer.rationale} limits={limits} />
          ) : (
            <>
              <p className="max-w-prose text-small text-ink">{answer.rationale}</p>
              {limits.length === 0 ? null : (
                <div className="flex flex-col gap-1">
                  <FieldLabel>What this scan does not cover</FieldLabel>
                  <ul className="flex list-none flex-col gap-1">
                    {limits.map((limit) => (
                      <li key={limit} className="max-w-prose text-small text-ink-muted">
                        {limit}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}

          <div className="flex flex-col gap-1">
            <FieldLabel>How to read these two lists</FieldLabel>
            <ul className="flex list-none flex-col gap-1">
              <li className="max-w-prose text-small text-ink-muted">
                A pair is in this list because a service lockfile in the slice pinned a version of
                one of its two names. That is a name that reached a disk, which a declared
                dependency range is not.
              </li>
              <li className="max-w-prose text-small text-ink-muted">
                The pin is attributed to the name it belongs to, and which name that is changes what
                the row means. A pin on the name a typo would be aimed at means the real package is
                installed here and a mistyped install would reach the other one. A pin on the
                look-alike means something here already installed it. On a pair whose direction the
                detector could not settle, the row says which of the two names is installed and
                stops there, because that is as far as the evidence goes.
              </li>
              <li className="max-w-prose text-small text-ink-muted">
                An empty list here means no lockfile in this slice resolved a confusable name. It is
                not evidence that nobody installs one: the slice is a curated subset of npm and
                PyPI, and a service it does not hold cannot be measured.
              </li>
              <li className="max-w-prose text-small text-ink-muted">
                A scoped type-definition package and the package it types share a name by
                convention, so a pair like &quot;@types/lodash&quot; against &quot;lodash&quot; is a
                convention rather than an imitation. The detector suppresses that pair in one
                direction only, so it can still appear here with the unscoped name written as the
                imitation. Discount it.
              </li>
              {pinnedCaveat === null ? null : (
                <li className="max-w-prose text-small text-ink-muted">{pinnedCaveat}</li>
              )}
            </ul>
          </div>
        </PanelBody>

        {pinned.length === 0 ? (
          <EmptyState title="No lockfile in this slice resolved a confusable name">
            Every pair below is a name collision that nothing here installs. The traversal ran
            against all {formatCount(scan.candidatesScanned)} compared names and found no service
            whose lockfile pinned one of them, which is a complete answer about this slice and no
            answer at all about either registry.
          </EmptyState>
        ) : (
          <PairList pairs={pinned} label="Confusable names a lockfile in this slice resolved" />
        )}
      </Panel>

      <Panel>
        <PanelHeader
          eyebrow="collisions"
          title="Confusable names nothing here resolved"
          aside={
            <span className="flex items-baseline gap-1">
              <DataValue muted>{formatCount(unpinned.length)}</DataValue>
              <UnitSuffix>of {formatCount(listed.length)} pairs</UnitSuffix>
            </span>
          }
        />

        <PanelBody className="flex flex-col gap-3">
          <p className="max-w-prose text-small text-ink-muted">
            These names are close enough that an install typo would reach the wrong one, and no
            lockfile in this slice pinned either of them. A collision on its own is common: plenty
            of legitimate packages sit one edit from a neighbour. The list is here because the name
            a typo reaches is worth knowing before something installs it, not because every row is
            a problem.
          </p>
          {unpinnedCaveat === null ? null : (
            <p className="max-w-prose text-small text-ink-muted">{unpinnedCaveat}</p>
          )}
        </PanelBody>

        {unpinned.length === 0 ? (
          <EmptyState title="Every pair at this confidence was resolved by a lockfile">
            Nothing is held back here: every pair the scan found at this confidence appears in the
            list above, because a lockfile in the slice pinned one of its two names.
          </EmptyState>
        ) : (
          <PairList pairs={unpinned} label="Confusable names nothing in this slice resolved" />
        )}

        <div className="border-t border-edge px-4 py-3">{sliceStrip}</div>
      </Panel>

      <QueryProvenance record={answered.record} />
    </Surface>
  );
}
