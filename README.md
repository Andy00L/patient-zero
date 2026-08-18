<p align="center">
  <img src="docs/assets/icon.svg" width="88" alt="Patient Zero icon">
</p>

<h1 align="center">Patient Zero</h1>

<p align="center">
  <strong>Supply chain forensics on a graph that is allowed to say it does not know.</strong>
</p>

<p align="center">
  Built for the Hack Hydra hackathon, Track 02.
</p>

<p align="center">
  <a href="https://github.com/hydra-db/hydradb"><img alt="Hack Hydra" src="https://img.shields.io/badge/Hack_Hydra-Track_02-C8873F?style=flat-square&labelColor=161211"></a>
  <a href="https://github.com/hydra-db/hydradb"><img alt="Graph engine" src="https://img.shields.io/badge/graph-HydraDB_OSS-8A5A26?style=flat-square&labelColor=161211"></a>
  <a href="https://bun.sh"><img alt="Bun" src="https://img.shields.io/badge/runtime-Bun_1.3.14-8C8178?style=flat-square&labelColor=161211"></a>
  <a href="https://nextjs.org"><img alt="Next.js" src="https://img.shields.io/badge/Next.js-16.3.1-8C8178?style=flat-square&labelColor=161211"></a>
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache_2.0-A8A09B?style=flat-square&labelColor=161211"></a>
</p>

A lockfile records what you installed. It does not record whether you installed it
during the hours a package was compromised.

Patient Zero reconstructs that window. It loads real supply chain incidents into a
HydraDB graph, then answers three questions about them: which services resolved a
compromised version while it was live, how far the compromise could travel, and how
much of the registry one stolen publish token reaches. When the graph cannot support an
answer, the answer is `unknown` with the reason attached, never a reassuring blank.

The gap between a malicious publish and the advisory that names it, measured from the
packs in `data/incidents`:

| Incident | First compromised publish | First advisory | Window |
| --- | --- | --- | --- |
| `ua-parser-js` 0.7.29, 0.8.0, 1.0.0 | 2021-10-22 | 2021-10-22 | 8.4 hours |
| `node-ipc` 10.1.1, 10.1.2 | 2022-03-07 | 2022-03-16 | 9.5 days |
| `event-stream` 3.3.6 via `flatmap-stream` | 2018-09-09 | 2018-11-26 | 78.6 days |
| Self-replicating npm worm (modeled) | 2025-11-24 | 2025-11-25 | 13.0 hours |

Every install inside those windows is a resolution nobody flagged at the time. That is
the population this project computes.

## ⚡ Run it

Bun 1.3.14 or newer. Docker only for the live graph path.

**Without Docker.** Everything below runs against the in-process graph and the committed
snapshot, with no services and no network.

```bash
bun install
bun test                                  # analysis, scanner, snapshot and ingest suites
bun run seed                              # writes data/graph/snapshot.json from the 4 incident packs
bun run hydra:measure -- --memory         # one-hop reverse traversal, in process
bun run scan:local -- --path test/fixtures/scanner/compromised --consent
```

`bun run seed -- --incident ua-parser-js-2021` loads a single pack. The slugs are the
filenames in `data/incidents`: `event-stream-2018`, `node-ipc-2022`, `ua-parser-js-2021`,
`self-replicating-worm-2025`.

The scan is the one command with an interesting console, so here it is, with the timing
lines and five of the nine findings cut for length. Point `--path` at any checkout to scan
that one instead.

```text
$ bun run scan:local -- --path test/fixtures/scanner/compromised --consent
[printScanPlan] local persistence scan plan
[printScanPlan]   scan root       compromised
[printScanPlan]   indicators      27 from the catalog
[printScanPlan]   mode            read only, no file is written, moved, deleted, or executed
[printScanPlan]   reported        indicator id, severity, root relative path, line number, title, reason
[printScanPlan]   never reported  file contents, secrets, tokens, absolute paths
[printScanPlan]   consent         given by --consent
[printScanReport]   files visited       7
[printScanReport]   coverage            complete, every eligible file was read
[printScanReport]   findings            9 total, high 9, medium 0, low 0
[printFindings]   2. [high] workflow-dumps-all-secrets at .github/workflows/formatter_88123.yml:12
[printFindings]      what  Workflow serializes the entire secrets context
[printFindings]   3. [high] vscode-task-run-on-folder-open at .vscode/tasks.json:9
[printFindings]      what  VS Code task configured to run when the folder is opened
[printFindings]   4. [high] agent-instruction-credential-read-directive at CLAUDE.md:5
[printFindings]      what  Agent instruction file tells the agent to read credential files
[printFindings]   7. [high] install-hook-pipes-download-to-shell at node_modules/evil-pkg/package.json:6
[printFindings]      what  Install hook pipes a download into a shell
```

Without `--consent` the scan prints that same plan, reads nothing, and exits 1. Consent
is per run, not a stored setting.

**With Docker, against a live HydraDB.**

```bash
cp .env.example .env
openssl rand -hex 32     # put this in HYDRA_AUTH_TOKEN; the node refuses a token under 32 chars
docker compose up --wait
bun run hydra:health     # transport, version, node counts, budgets, readiness
```

Compose starts three services on loopback only: `hydra-init` writes the token into the
shared volume, `graph-node` serves Bolt on 7687, the query API on 8443, and `/readyz` on
9090, and `graph-indexer` runs beside it. `bun run hydra:health -- --bolt` runs the same
checks over the Bolt driver. `bun run ingest` then walks the dependency and advisory
graph outward from the incident packages using three public APIs
(`registry.npmjs.org`, `api.deps.dev`, `api.osv.dev`), caching every response under
`data/harvest`, and writes `data/graph/slice-snapshot.json` with its coverage manifest.
`bun run ingest -- --sink hydra` writes to the live node instead of a file.

Full sequence, every failure mode, and what to do when Docker is not available:
[`docs/RUNNING.md`](./docs/RUNNING.md).

## 🧭 How it works

```mermaid
flowchart TD
    packs["Incident packs<br/>data/incidents, 4 packs"] --> seed["bun run seed"]
    apis["registry.npmjs.org<br/>api.deps.dev<br/>api.osv.dev"] --> ingest["bun run ingest"]
    seed --> gw["GraphGateway<br/>one interface, two implementations"]
    ingest --> gw
    gw --> hydra["HydraDB OSS node<br/>OpenCypher, algo.SSpaths, algo.MSpaths"]
    gw --> mem["MemoryGraph<br/>in process, committed snapshot"]
    hydra --> analysis["Analysis layer<br/>5 node labels, 9 relationship types"]
    mem --> analysis
    analysis --> win["Exposure window<br/>resolved_at_ms against published_at_ms"]
    analysis --> blast["Blast radius<br/>walks DEPENDED_ON_BY"]
    analysis --> maint["Maintainer surface<br/>one MSpaths pass"]
    win --> verdict["decideVerdict<br/>exposed, not_exposed, unknown<br/>with the limits that shaped it"]
    blast --> verdict
    maint --> verdict

    classDef source fill:#231F1E,stroke:#3A322F,color:#F2EDE9
    classDef cmd fill:#2B2017,stroke:#8A5A26,color:#F2EDE9
    classDef engine fill:#1F1A18,stroke:#C8873F,color:#F2EDE9
    classDef work fill:#1F1A18,stroke:#3A322F,color:#F2EDE9
    classDef answer fill:#2B2017,stroke:#C8873F,color:#F2EDE9
    class packs,apis source
    class seed,ingest cmd
    class gw,hydra,mem engine
    class analysis,win,blast,maint work
    class verdict answer
```

The graph is small and deliberate: `Package`, `Version`, `Maintainer`, `Service`,
`Advisory`, joined by `VERSION_OF`, `DEPENDS_ON`, `RESOLVES_TO`, `DEPENDED_ON_BY`,
`MAINTAINS`, `RESOLVED`, `AFFECTS`, `AFFECTS_VERSION`, `TYPOSQUAT_OF`. Property names on
the wire are `snake_case` because that is what the engine stores.

Two design decisions carry most of the weight.

**One gateway, two implementations.** `src/lib/graph/gateway.ts` defines the only surface
the analysis layer may touch: nine semantic operations, no raw query pipe. HydraDB accepts
a small Cypher subset (one statement per request, no `IN`, no `min` or `max`), so
multi-step composition has to live in TypeScript anyway. Naming those steps at the
boundary keeps every Cypher string in one file and lets the same analysis code run against
a live node or against an in-process graph. The in-process implementation is not a mock: it
mirrors the engine's edge budget and returns the same truncation reason, so a test that
sees `query_budget_exceeded` is seeing the behaviour the live path produces.

**Reverse edges are measured, not assumed.** "Which versions depend on this compromised
version" is a reverse walk. The ingest materialises `DEPENDED_ON_BY` next to every
`RESOLVES_TO`, and blast radius walks that stored reverse type outgoing. Whether the stored
edge earns its write cost on a given slice is a question with a number attached, so
`bun run hydra:measure` times both patterns on the same data. In live mode it refuses to
fall back to anything: with no reachable node it says the measurement did not run, names
what to start, and exits non-zero. In memory mode every line it prints says the timings are
in-process TypeScript and are not an engine measurement.

## ⚖️ The verdict model

`src/lib/analysis/abstention.ts` is the part worth reading. Three verdicts:

| Verdict | Meaning |
| --- | --- |
| `exposed` | Evidence in the graph places this subject inside the window. |
| `not_exposed` | The traversal completed, over coverage recorded as closed, and found nothing. |
| `unknown` | The graph cannot decide. The reasons come attached. |

The order of the branches is the whole point. `decideVerdict` checks for an empty graph,
then for a subject absent from the slice, then for evidence, then for limits that could
have hidden evidence, and only then may return `not_exposed`, and only when the subject's
closure is recorded as closed in the slice manifest and no limit truncated the walk. An
empty traversal over a partially ingested slice reads `unknown`. There is no path through
that function where a missing ingest renders as safety.

The reasons are typed, not prose: `AnswerLimit` is a ten variant union covering
`empty_graph`, `package_absent`, `package_partial`, `hop_limit`, `path_limit`,
`budget_rejected`, `scan_capped`, `undecidable_versions`, `service_history_partial`, and
`timestamp_missing`. A hop limit is only reported when a path actually reached the ceiling.
A path limit is only reported when the returned count equals the cap. Each one names what
was not seen, which is the difference between an abstention and a shrug.

## 🔬 What it answers

**Exposure window.** Two clocks, kept apart. Valid time is when a service actually resolved
a version, from `RESOLVED.resolved_at_ms` in a lockfile. Known time is when the advisory
naming it was published, from `Advisory.published_at_ms`. The half-open window between them
is pushed down into the traversal rather than filtered after the fact, so the answer is
"these services, at these timestamps", not "these services, probably".

**Blast radius.** From one compromised version outward over the materialised reverse type,
collapsing to one entry per dependent with its shortest route, then enumerating `Service`
nodes and expanding each forward over `RESOLVED`. The service side is walked from the small
end on purpose: `RESOLVED` runs service to version and has no materialised reverse type, so
enumerating the few known services costs fewer requests than one reverse walk per reachable
version. Every cap on that walk is one of the ten limits above.

**Maintainer infection surface.** One stolen publish token reaches every package its owner
can publish to. Hop 1 is measured from `MAINTAINS` edges. Hop 2, what those packages'
dependents would inherit, is a stated worst case and lives behind `isModelled: true` in the
payload rather than being folded into the measured count. Both come back in a single
`algo.MSpaths` pass rather than one request per maintainer.

**Typosquat signals.** Named signals, not a single float: a bounded Damerau-Levenshtein
distance, PEP 503 name normalisation for PyPI so `Flask-Cors` and `flask_cors` compare
correctly, and separate structural checks. The module is pure and IO free, which is why its
behaviour is pinned by tests instead of by a screenshot.

**Local persistence scan.** 27 indicators drawn from published incident writeups, each one
carrying a note on where it came from and saying so in those words when a pattern is a
generalisation of an observed technique rather than a quoted string. It covers install
hooks, GitHub Actions workflows, editor tasks that run on folder open, agent instruction
files, and known payload artifacts. Opt in per run, read only, no file content in the
output, and every pattern bounded so a hostile file cannot turn the scan into a hang.

**Lockfile parsing.** Seven formats across two ecosystems: `npm-lock-v1`, `npm-lock-v2`,
`yarn-classic`, `yarn-berry`, `pnpm`, `requirements-txt`, `poetry-lock`, with a size cap
and a dependency cap that report truncation instead of silently trimming.

## 🗄️ Which HydraDB

There are two unrelated things with this name, and this project uses exactly one of them.

- **Used here:** [`github.com/hydra-db/hydradb`](https://github.com/hydra-db/hydradb),
  crate `slatedb-graph-kernel`, AGPL-3.0. The OSS graph database this hackathon
  open-sources: integer node and relationship ids, a small OpenCypher subset, native path
  procedures, and per-operation budgets that come back as a 429 naming the operation that
  hit them. Pinned to `ghcr.io/hydra-db/hydradb:0.1.1` by digest in
  `docker-compose.yml`.
- **Not used here:** the unrelated `hydradb-sdk` package on PyPI. It shares nothing with
  the above but the name.

HydraDB is AGPL-3.0 and runs as a separate service over its network API. Nothing from the
engine is linked into this codebase, which is Apache-2.0. What the engine does and does not
support, verified against its source rather than assumed, is written up in
[`docs/HYDRADB.md`](./docs/HYDRADB.md), including the corrections where an earlier
assumption turned out to be wrong.

## 🧾 What is verified, and what is not

A security tool that overstates its evidence is worse than one that reports less.

- **Three of the four incident packs are historical, one is modeled.** Every pack carries a
  `dataOrigin` field. `self-replicating-worm-2025` is `modeled`: it is built to the shape of
  the 2025 worm campaign, not harvested from it, and it says so in the data, in the schema
  that validates the data, and here. Sourcing splits unevenly and the split is worth
  stating: the three historical packs carry 28 distinct source URLs between them, and the
  modeled pack carries 127 of its own, which are the writeups its shape was built from
  rather than evidence about the events it describes. 155 URLs across the four, and no
  overlap between the two groups.
- **The curated data is small and countable.** 96 compromised versions across 47 packages,
  48 advisories, 30 services with 63 lockfile resolutions, and 71 timeline entries. Those
  are the numbers behind the window table above.
- **The committed ingested slice has no closed package closure, and the data says so.**
  `data/graph/demo-snapshot.json` is the curated seed merged with one ingest run: 402
  packages, 721 versions, 117 maintainers, 30 services, 77 advisories, 506 resolution
  edges. Its manifest records 0 packages `closed` and 120 `partial`, because that run used
  a depth budget of 1 and a package budget of 120. The other 282 `Package` nodes are stubs
  the expansion stopped at, and 332 versions were referenced but never fetched. A package
  that can reach a stub has an unknown remainder, so a dependency traversal over this slice
  abstains instead of reporting `not_exposed`. All 30 services are `closed`, which is why
  the bitemporal question, the one the radar opens on, can still return a real negative on
  the service side. For a wider slice:
  `bun run ingest -- --max-depth 3 --max-packages 2000 --max-versions 8`, which rewrites
  the manifest to match what it actually reached.
- **Where the two snapshots disagreed, the curated pack won, 134 times.** Merging the seed
  into the ingest found 134 conflicting properties, every one of them
  `Version.has_install_script` on a worm-pack version. The registry no longer serves the
  malicious metadata for those versions, so it reports `false` where the incident writeup
  recorded an install hook. The merge keeps the hand sourced value and records the count in
  the manifest notes rather than resolving it silently. `bun run graph:demo` exits 2 when it
  resolves a conflict, 0 when there was none, so a rebuild cannot hide one.
- **Every answer is a lower bound on the slice, and says so.** The slice manifest marks each
  package `closed`, `partial`, or `absent`, and that mark is what decides whether an empty
  traversal is allowed to read `not_exposed`.
- **Maintainer hop 2 is a stated worst case, flagged `isModelled`** in the answer payload,
  not folded into the measured hop 1 count.
- **The committed curated snapshot holds no version to version dependency edges.**
  `bun run seed` writes `VERSION_OF`, `RESOLVED`, `AFFECTS` and `AFFECTS_VERSION`, which is
  exactly what the bitemporal question needs. Multi-hop dependency blast radius needs
  `RESOLVES_TO` and its materialised reverse, which come from `bun run ingest` or a live
  node.
- **No live engine performance number is published anywhere in this repo.** Docker was not
  available in the environment this was built in, which is why the in-process graph and the
  committed snapshot exist behind the same gateway, and why `hydra:measure` in live mode
  fails loudly rather than printing something plausible.
- **The web interface is still being built.** Today's entry points are the scripts above and
  the test suite. The design system it is being built against is
  [`docs/UI_DESIGN_SYSTEM.md`](./docs/UI_DESIGN_SYSTEM.md), including the rule that
  `exposed`, `unknown`, and `not_exposed` are three visually distinct states so an
  abstention can never be mistaken for a clean result.

## 🧩 Prior art and related work

The supply chain tooling that exists is good, and two entries below are dependencies of
this project rather than rivals to it. The line that separates all of them from this one
is the clock they read. They answer "is the version you have now affected", which is a
question about known time only. This project keeps known time and valid time apart, so it
can answer a question none of them are shaped for: was this service holding the bad
version during the hours before any advisory existed, whether or not it has since been
upgraded away.

- **[Socket](https://github.com/SocketDev/socket-cli)**: analyses what a package's code
  does (install scripts, network, filesystem, and shell access) and flags it at review
  time. It judges the package; this project judges the lockfile's timing. The local
  persistence scanner here overlaps at the edges and is deliberately narrower: 27
  indicators, read only, no verdict on code it has not matched.
- **[Dependabot](https://docs.github.com/en/code-security/dependabot/dependabot-alerts/about-dependabot-alerts)
  and [Snyk](https://snyk.io)**: match the manifest you have today against advisory
  version ranges and open the bump. Both are the right tool for remediation and neither
  retains the fact that you resolved the compromised version on a Tuesday nine days
  before the advisory published, because the manifest no longer says so once it is fixed.
- **[deps.dev](https://deps.dev)**: Google's public dependency graph API, and one of the
  three sources `bun run ingest` reads. It returns a package's dependencies and never its
  dependents, which is the reason this project materialises `DEPENDED_ON_BY` at ingest
  time instead of asking an API for the reverse edge. See
  `src/lib/ingest/deps-dev.ts`.
- **[OSV](https://osv.dev)**: the advisory database, also read by the ingest. Its
  `published` field is the known-time clock every window in the table above is measured
  against. OSV states what is affected; it does not hold who resolved it, and it is not
  trying to.
- **[OpenSSF Scorecard](https://scorecard.dev)**: scores a repository's practices, such as
  branch protection and signed releases. That is a prediction about future risk from
  process; the maintainer leaderboard here is a measurement of present blast radius from
  `MAINTAINS` edges. The two are orthogonal and a serious program wants both.

## 🗂️ Repository layout

```text
src/lib/graph/       gateway contract, graph model, in-process implementation, snapshots
src/lib/hydra/       HydraDB client: transports, Cypher builders, id map, config
src/lib/analysis/    abstention, bitemporal windows, blast radius, maintainer surface, typosquat
src/lib/ingest/      registry, deps.dev and OSV clients, graph writer
src/lib/incidents/   incident pack schema and validation
src/lib/scanner/     lockfile parsers, persistence indicators
scripts/             health check, traversal measurement, seed, ingest, local scan
data/incidents/      the four incident packs, with sources
data/graph/          committed snapshots and the slice coverage manifest
docs/                engine notes, run book, UI design system
test/                unit and fixture suites for every module above
```

## 📜 License

Apache-2.0, see [`LICENSE`](./LICENSE). HydraDB is AGPL-3.0 and is used as a separate
service over its network API; no engine code is included or linked here.

**Technor** and **Tabular** are trademarks of the Indian Type Foundry. Copyright 2016-2021
Indian Type Foundry. All rights reserved. Both faces are self-hosted under
`src/app/fonts/` and are not covered by the Apache-2.0 license above; their terms are at
[fontshare.com/terms](https://fontshare.com/terms), and
[`src/app/fonts/NOTICE.md`](./src/app/fonts/NOTICE.md) carries the full notice.

Incident facts come from public advisories, registry metadata, and published writeups. The
source URL for each one lives in the pack that states it, in `data/incidents`.
