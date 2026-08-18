import { Panel, PanelBody, PanelHeader, Tray } from "@/components/ui/panel";
import { DataValue, DefinitionRow, Eyebrow, FieldLabel, UnitSuffix } from "@/components/ui/text";
import { HopBadge } from "@/components/ui/verdict";
import { formatCount } from "@/lib/format";

import type { LeaderboardRow } from "./leaderboard-rows";

/**
 * One account's reach, opened from the row above.
 *
 * The table ranks; this panel is where the ranking becomes checkable. Every count in the table
 * appears here as the things it counted: which packages the account can publish, which services
 * were found downstream of them and how far away each one is. A reader who does not believe the
 * "8 services" in a cell can read the eight names.
 *
 * The two halves are separated because they are different kinds of statement, and the sheet
 * refuses to encode that difference with colour alone. The left half is measured: it is a walk
 * over MAINTAINS, VERSION_OF, DEPENDS_ON and RESOLVED edges that exist in the slice. The right
 * half is modelled: it counts what a worm would reach if it harvested the publish token of every
 * project that installed the poisoned package, and the slice holds no evidence about whose CI
 * runs what. The assumption is printed under those numbers verbatim, from the library that
 * produced them, so the figures cannot be rendered anywhere without it.
 * sourceRef: HOP_TWO_ASSUMPTION in src/lib/analysis/maintainer-surface.ts.
 */

export type AccountReachProps = {
  row: LeaderboardRow;
  /** How many accounts the ranking placed, for the rank reading. */
  rankedRows: number;
  /** Service nodes the ranking examined: the denominator of the reach. */
  servicesConsidered: number;
};

export function AccountReach({ row, rankedRows, servicesConsidered }: AccountReachProps) {
  const { subject, direct, modelled } = row.surface;

  return (
    <Panel>
      <PanelHeader
        eyebrow="opened account"
        title={<span className="font-data">{subject.maintainerKey}</span>}
        aside={
          <span className="flex items-baseline gap-1">
            <DataValue>{row.rank}</DataValue>
            <UnitSuffix>of {formatCount(rankedRows)} ranked</UnitSuffix>
          </span>
        }
      />

      <PanelBody className="flex flex-col gap-5">
        <div className="grid gap-5 md:grid-cols-2">
          <div className="flex flex-col gap-3">
            <Eyebrow>measured at one hop</Eyebrow>

            <div className="flex items-baseline gap-2">
              <DataValue scale="lg" muted={!row.isServiceReachKnown}>
                {row.serviceReading}
              </DataValue>
              <UnitSuffix>of {formatCount(servicesConsidered)} services examined</UnitSuffix>
            </div>

            <dl className="flex flex-col">
              <DefinitionRow label="Packages it can publish">
                <span className="flex items-baseline gap-1">
                  <DataValue>{formatCount(direct.packages.length)}</DataValue>
                  <UnitSuffix>{direct.packages.length === 1 ? "package" : "packages"}</UnitSuffix>
                </span>
              </DefinitionRow>
              <DefinitionRow label="Versions of those packages">
                <span className="flex items-baseline gap-1">
                  <DataValue muted={direct.versionCount === 0}>
                    {formatCount(direct.versionCount)}
                  </DataValue>
                  <UnitSuffix>in the slice</UnitSuffix>
                </span>
              </DefinitionRow>
              <DefinitionRow label="Downstream packages">
                <span className="flex items-baseline gap-1">
                  <DataValue muted={direct.dependentPackageCount === 0}>
                    {formatCount(direct.dependentPackageCount)}
                  </DataValue>
                  <UnitSuffix>
                    over {formatCount(direct.dependentVersionCount)} versions
                  </UnitSuffix>
                </span>
              </DefinitionRow>
              <DefinitionRow label="Weekly downloads on its own packages">
                <span className="flex items-baseline gap-1">
                  <DataValue muted={!row.isDownloadSumKnown}>{row.downloadReading}</DataValue>
                  {row.isDownloadSumPartial ? (
                    <UnitSuffix>
                      over {formatCount(
                        direct.packages.length - direct.packagesWithoutDownloadCount,
                      )}{" "}
                      of {formatCount(direct.packages.length)} packages
                    </UnitSuffix>
                  ) : null}
                </span>
              </DefinitionRow>
              <DefinitionRow label="What these numbers are worth">
                <FieldLabel>{row.basisReading}</FieldLabel>
              </DefinitionRow>
            </dl>

            {direct.reachedServices.length === 0 ? (
              // Not an empty state: an empty state says the answer is complete, and under
              // partial coverage this one is not. The distinction is the product.
              <p className="max-w-prose text-small text-ink-muted">
                No service in this slice resolves a version of a package this account publishes.
                That is a statement about this slice and not about the registry: the lockfiles
                ingested here cover {formatCount(servicesConsidered)} services, and a service
                nobody ingested cannot appear.
              </p>
            ) : (
              <div className="flex flex-col gap-1">
                <FieldLabel>Services reached, closest first</FieldLabel>
                <Tray>
                  <ul className="flex list-none flex-col">
                    {direct.reachedServices.map((service) => (
                      <li
                        key={service.serviceKey}
                        className="flex items-center justify-between gap-3 border-b border-edge px-3 py-2 last:border-b-0"
                      >
                        <DataValue>{service.serviceName}</DataValue>
                        <HopBadge hops={service.hopCount} />
                      </li>
                    ))}
                  </ul>
                </Tray>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-3">
            <Eyebrow>modelled at two hops</Eyebrow>

            <dl className="flex flex-col">
              <DefinitionRow label="Versions that would run the poisoned code">
                <span className="flex items-baseline gap-1">
                  <DataValue muted={modelled.candidateVersionCount === 0}>
                    {formatCount(modelled.candidateVersionCount)}
                  </DataValue>
                  <UnitSuffix>
                    over {formatCount(modelled.candidatePackageCount)} packages
                  </UnitSuffix>
                </span>
              </DefinitionRow>
              <DefinitionRow label="Of those, already declaring an install script">
                <span className="flex items-baseline gap-1">
                  <DataValue muted={modelled.candidateVersionsWithInstallScript === 0}>
                    {formatCount(modelled.candidateVersionsWithInstallScript)}
                  </DataValue>
                  <UnitSuffix>
                    over {formatCount(modelled.candidatePackagesWithInstallScript)} packages
                  </UnitSuffix>
                </span>
              </DefinitionRow>
              <DefinitionRow label="Second publish accounts this would put at risk">
                <span className="flex items-baseline gap-1">
                  <DataValue muted={modelled.candidatePackageCount === 0}>
                    {formatCount(modelled.candidatePackageCount)}
                  </DataValue>
                  <UnitSuffix>at least one each</UnitSuffix>
                </span>
              </DefinitionRow>
            </dl>

            <p className="max-w-prose text-small text-ink-muted">{modelled.assumption}</p>
          </div>
        </div>

        {direct.packages.length > 0 ? (
          <div className="flex flex-col gap-1">
            <FieldLabel>
              What one stolen token publishes, in the order the graph returned it
            </FieldLabel>
            <Tray>
              <ul className="flex list-none flex-wrap gap-x-5 gap-y-2 px-3 py-2">
                {direct.packages.map((entry) => (
                  <li key={entry.packageKey} className="flex items-baseline gap-2">
                    <DataValue>{entry.name}</DataValue>
                    <UnitSuffix>
                      {entry.weeklyDownloads === null
                        ? "downloads unknown"
                        : `${formatCount(entry.weeklyDownloads)} weekly`}
                    </UnitSuffix>
                  </li>
                ))}
              </ul>
            </Tray>
          </div>
        ) : null}
      </PanelBody>
    </Panel>
  );
}
