# Patient Zero: build plan

An incident radar for the npm and PyPI supply chain. It models the package
registry as a graph in HydraDB and answers, in seconds, who is hit by a
compromised package, since when, and through which exact dependency path. On top
of that it predicts single points of failure before any compromise happens.

- Hackathon: Hack Hydra (HydraDB), August 12-20, 2026, online, open source.
- Track: 02, direction A (Supply chain blast radius).
- Team size target: solo (1), scalable to 4.
- Deliverables: public GitHub repo, demo video of 3 minutes or less, submission form.

---

## 0. The trap that decides everything: two different products named HydraDB

There are two products with this name. Picking the wrong one is an instant
disqualification risk under the rule "HydraDB not used meaningfully."

- The OSS repo the hackathon open-sources, `github.com/hydra-db/hydradb`: an
  object-store-native distributed graph database written in Rust. OpenCypher
  queries, GraphBLAS traversal, Neo4j-compatible Bolt connectivity, an HTTPS
  query API, and native path procedures. Licensed AGPL-3.0.
- The managed `hydradb-sdk` on PyPI and `docs.hydradb.com`: a proprietary
  retrieval engine (dense vectors, BM25, and a document knowledge graph behind a
  single `/query` endpoint), owned by AGI Context, INC, marked proprietary and
  confidential.

Patient Zero is a graph-traversal problem, and the hackathon judges graph-native
approaches built on the OSS repo. This project builds on the OSS graph database
(Bolt, OpenCypher, and the `algo.*` path procedures), not the SDK. Anyone who
runs `pip install hydradb-sdk` and builds a retrieval-augmented chatbot has built
the wrong thing.

Everything below targets the OSS graph database interface as documented in its
README.

---

## 1. What we are building

The graph answers the questions the track names explicitly:

1. Blast radius. Given a compromised `package@version`, which of your services
   are transitively exposed, through which exact dependency path, and at what hop
   distance.
2. Which version introduced the vulnerability. The earliest version inside an
   advisory's affected range.
3. Resolved while live (bitemporal). Which lockfiles resolved the bad version
   during the window it was published but not yet disclosed.
4. Shared maintainer and shared infrastructure. Which other packages one
   compromise could reach through the accounts and people behind them.
5. Typosquats nearby. Names one edit-hop from a popular package, ranked by graph
   proximity to your own dependency closure.

The original centerpiece, on top of the track's list:

6. Maintainer infection surface. A predictive single-point-of-failure
   leaderboard: if one maintainer's publish token leaks, which packages can be
   poisoned within k publish hops, and which of your services sit downstream. It
   is computed before any compromise. Existing tools scan reactively; this ranks
   upstream humans by worst-case worm reach.

Two product features make it usable rather than a canned demo:

- Scan my project. Paste a real `package-lock.json` or `requirements.txt` and get
  a live blast radius against the existing graph.
- Local persistence scanner. Walk a checked-out repo's `node_modules`, `.claude/`,
  and `.vscode/` for the worm-persistence artifacts the track calls out, and link
  any hits back to nodes in the graph.

The demo hook is a time scrubber that replays a real worm minute by minute:
services light up hop by hop, with a "detected at 09:06" marker set against the
days that real disclosure actually took.

---

## 2. Why HydraDB, stated as what dies without it

- Scale. npm is roughly 3 million packages and tens of millions of versioned
  nodes. The core query is a reverse transitive closure over that graph, which
  the track itself says a vector index cannot answer at all. Object-store-native
  storage plus GraphBLAS traversal is built for graphs too large to sit in
  memory.
- Correctness over time. Snapshot-consistent reads make the bitemporal replay
  correct: pin one snapshot, apply the time filter, get a stable answer while the
  graph keeps changing underneath.
- First-class traversal. The native path procedures (`algo.SSpaths`,
  `algo.MSpaths`) make blast radius a server-side operation, not client-side query
  fan-out.

Remove HydraDB and the project falls back to recursive registry API calls that
cannot answer the multi-hop question at scale. That is the one sentence for the
judges and the video.

Honesty note on scale: the demo runs on a curated slice (section 5). The scale
claim is about the architecture, and it is backed by an optional bulk load from
the deps.dev public export (section 6). The pitch is stated as "slice today,
architecture proven to scale," never as "we ingested all of npm" unless the bulk
load is actually run.

Upstream publishes traversal benchmarks measured against MinIO on a single
15-core machine, supernode fanouts from 50 to 10,000, covering per-hop cost,
worker scaling, write cost, and cold-cache behavior
([hydra-db.github.io/benchmark](https://hydra-db.github.io/benchmark/)). The
README cites those for the engine and publishes our own measured numbers for
the slice, so no performance claim in the video is invented.

---

## 3. Locked decisions

Chosen defaults, with rationale. Two require human sign-off and are marked.

- Ecosystem: npm first. PyPI blast radius is a stretch goal once the npm path is
  green. Reason: npm has the richer public maintainer and per-version publish-time
  data, and the incidents that resonate with these judges are npm incidents.
- Stack: TypeScript end to end, Bun as the only package manager, Next.js App
  Router for the web app, `neo4j-driver` over Bolt for graph access. Reason: the
  standards require Next.js plus Bun for any new frontend, and keeping one
  language and one manager avoids a second toolchain. The curated slice is small
  enough that TypeScript ingestion is fine. Versions checked against the npm
  `latest` tags and upstream releases on 2026-08-16: Next.js 16.3.1, Bun 1.3.14,
  TypeScript 7.0.2, neo4j-driver 6.2.0 (Bolt 5.x compatible), semver 7.8.5.
  Scaffold with `bunx create-next-app@latest patient-zero --ts --app --use-bun`,
  which re-resolves the current stable at M0 rather than trusting these numbers
  later.
- Scale strategy: build and demo on the curated slice. Keep a documented,
  optional bulk-load path from the deps.dev BigQuery export to substantiate the
  scale claim if time allows. Reframe the pitch honestly either way.
- Bitemporal strategy: harvest real `package-lock.json` git history from a small
  set of real public repositories as the ground truth for "resolved while live."
  Keep a clearly labeled modeled fallback if the harvest underdelivers.
- Repo (resolved): https://github.com/Andy00L/patient-zero, public, created
  inside the hackathon window. Bootstrap block in section 13. The `.claude/`
  kit goes into `.gitignore` in the first real commit and is never staged or
  pushed.
- Design palette (human sign-off): the frontend runs the Claude Design loop, and
  the color palette is an approval gate proposed before UI is built.

---

## 4. Data model

### Engine constraints that shape this model (verified from source)

HydraDB identifies every node by a non-negative integer `id`, and patterns match
on that `id` (per the repo's `cypher-compat.md`). Natural keys like
"npm:chalk:5.3.1" are not identities; they are stored as string properties. The
ingestion layer keeps a deterministic key-to-id map (natural key to integer id),
and the analysis layer resolves keys to integer ids before every query and
path-procedure call. Relationships carry an integer `id` too.

The Cypher subset is deliberately small: no `IN`, no `min` or `max`, `WITH` is
pass-through only, and one statement per request. All multi-step composition
lives in TypeScript (`src/lib/analysis/`), not in Cypher. `WHERE` compares a
property to a literal or a parameter, so any answer that would compare two node
properties first resolves one side to a scalar and passes it as a parameter.

The model separates two kinds of resolution that the first draft blurred:

- The general resolution graph from deps.dev. An approximation of what a range
  resolves to, time-dependent because a range resolves to a newer version the
  moment one publishes.
- The ground-truth resolution from real lockfiles. `Service` to `Version` edges
  taken from actual `package-lock.json` files, carrying a real timestamp.

Nodes. Every node has an integer `id` assigned by the id-map; the fields below
are properties:

```
Package    { id, key: "npm:chalk", ecosystem, name }
Version    { id, key: "npm:chalk:5.3.1", ecosystem, name, version,
             published_at, has_install_script, weekly_downloads }
Maintainer { id, key: "npm:@user", ecosystem, username, email }
Service    { id, key, name, source: "seed" | "uploaded" }
Advisory   { id, ghsa_id: "GHSA-...", published_at, modified_at, summary }
```

Relationships. Each carries an integer `id`. Bitemporal properties carry two
clocks: valid time (when the fact was true in the world) and known time (when it
became known to us).

```
(Version)    -[:VERSION_OF]->                    (Package)
(Version)    -[:DEPENDS_ON { range }]->          (Package)   // declared semver range
(Version)    -[:RESOLVES_TO]->                   (Version)   // deps.dev current resolution
(Version)    -[:DEPENDED_ON_BY]->                (Version)   // optional reverse, see section 7
(Maintainer) -[:MAINTAINS]->                     (Package)   // publish rights (proxy)
(Service)    -[:RESOLVED { resolved_at }]->      (Version)   // lockfile ground truth, valid time
(Advisory)   -[:AFFECTS { introduced, fixed }]-> (Package)   // range facts
(Advisory)   -[:AFFECTS_VERSION]->               (Version)   // precomputed range membership
(Version)    -[:TYPOSQUAT_OF { distance }]->     (Package)
```

Resolution edge note: deps.dev provides a current resolution, so `RESOLVES_TO`
is stored static rather than temporal. The bitemporal "resolved while live"
answer comes from the `Service -[:RESOLVED]-> Version` lockfile edges and their
`resolved_at`, not from `RESOLVES_TO`. This drops the unpopulated
`valid_from`/`valid_to` pair the first draft asserted without a source.

Resolved from source, no longer open questions:

- Path procedures confirmed: `algo.SPpaths`, `algo.SSpaths`, `algo.MSpaths` with
  config keys `sourceNode`, `targetNode`, `sourceLabel`, `sourceProperty`,
  `sourceValues`, `targetLabel`, `targetProperty`, `targetValues`, `relTypes`,
  `relDirection`, `maxLen` (required, unbounded traversal is rejected), and
  `pathCount`, yielding `path`, `pathWeight`, `pathCost`.
- Node lookup goes through the integer id-map, which removes the earlier open
  question about declaring a property index for string-key lookups.
- Reverse traversal confirmed: `relDirection` accepts `incoming`, `outgoing`
  (the default when omitted), and `both`, per `src/query/path_procedure.rs`.
  The default index policy (`GraphIndexPolicy::Full` in `src/core/config.rs`)
  also writes a reverse adjacency index, so incoming traversal is index-backed
  out of the box. The materialized `DEPENDED_ON_BY` edge is optional insurance,
  kept or dropped after an M0 measurement, not a correctness requirement.

---

## 5. Data sources and ingestion scope

All sources are public and are disclosed in the README with attribution.

| Source | Endpoint | What it gives |
| --- | --- | --- |
| deps.dev (Google Open Source Insights) | `api.deps.dev/v3`, and BigQuery `bigquery-public-data.deps_dev_v1` for bulk | resolved dependency edges for npm and PyPI |
| npm registry | `registry.npmjs.org/<pkg>` | `maintainers[]`, per-version `time{}` publish timestamps, install-script presence |
| PyPI | `pypi.org/pypi/<pkg>/json` | releases and upload times |
| OSV.dev | `POST api.osv.dev/v1/querybatch`, `GET /v1/vulns/<id>` | affected ranges plus `published` and `modified`, the known-time clock |
| GitHub repo history | `package-lock.json` across commits of selected public repos | historical lockfile resolutions, the valid-time source for "resolved while live" |

Slice for the demo, chosen to stay buildable in the window:

- The top 5,000 to 10,000 npm packages by download count.
- The complete dependency closure of the incident packages.
- Around 20 `Service` nodes. These are curated so they are genuinely downstream of
  the incident packages, otherwise the blast-radius demo would render empty. They
  are seeded from real public lockfiles.

This is roughly 50,000 to 200,000 `Version` nodes and a few hundred thousand
edges. Comfortable for the slice, and it makes blast radius land on named
services.

Incident replay pack, curated JSON with real timestamps:

- event-stream and flatmap-stream, November 2018.
- ua-parser-js hijack, October 2021.
- node-ipc (peacenotwar), March 2022.
- A TanStack-style worm encoded with the hackathon's own figures (84 malicious
  artifacts across 42 packages within six minutes) so the demo lands in the
  judges' framing.

---

## 6. Ingestion architecture

The load path is chunked `UNWIND` over Bolt, not a bulk loader. The repo's only
import example, `examples/falkor_import.rs`, is FalkorDB-specific, so there is no
generic loader to reuse. The details, all verified from source:

- Use the mandated `UNWIND` batch forms. A vertex upsert is `MERGE` by id then
  `SET` (folding other properties into the `MERGE` pattern is rejected). An edge
  batch is `UNWIND $rows AS row MATCH (s {id: row.src}), (d {id: row.dst})
  CREATE (s)-[:REL {id: row.rel_id, ...}]->(d)`. One relationship pattern per
  batch, one hop, directed. Batches are accepted only through the Bolt or HTTP
  transport, never the in-process shard API.
- Size chunks under the enforced budgets, whose defaults are known from
  `src/core/config.rs`: `max_query_scan_edges` 1,000,000,
  `max_query_intermediate_rows` 250,000, `max_query_result_vertices` 100,000,
  `max_query_runtime_ms` 30,000, `max_traversal_hops` 16 (caps `maxLen`). A
  query returning fewer rows than expected may have hit a budget rather than a
  bug. Chunk near 4,096 rows per request, matching the engine's own trusted
  append chunk default. One active writer per cell, so ingest is a
  single-writer job by design.
- Run `graph-indexer` alongside `graph-node`. Path procedures use compiled CSC
  generations when present; with no usable generation, traversal falls back to
  bounded canonical reads that run into the scan budgets above. Ingest, then let
  the indexer publish generations before the demo traversals run.
- Order of load: packages, then versions with publish times, then maintainer
  edges, then the deps.dev resolution edges (with the materialized reverse), then
  advisories from OSV (including precomputed `AFFECTS_VERSION` edges), then
  services from lockfiles.

Object store and roles. `graph-node` and `graph-indexer` coordinate only through
a shared object store. For the demo, either `CLOUD_PROVIDER=local` with one
volume mounted into both containers (simplest single-host setup), or
`CLOUD_PROVIDER=aws` against a MinIO container. The exact environment for MinIO
mode, from the chart's rendered config: `CLOUD_PROVIDER=aws`, `AWS_BUCKET_NAME`,
`AWS_DEFAULT_REGION`, `AWS_ALLOW_HTTP=true`, and `AWS_ENDPOINT` pointing at the
MinIO service, plus MinIO credentials through the standard AWS variable pair.
The development example uses bucket `graph-development`, plaintext enabled, and
a 32-plus-character dev token. Indexer knobs are environment variables too:
`GRAPH_INDEXER_INTERVAL_MS`, `GRAPH_INDEXER_BUILD_MODE` (`full` or
`incremental`), and its own admin endpoint on 9091 (`GRAPH_INDEXER_ADMIN_ADDR`).
The query budgets are tunable the same way (`GRAPH_MAX_QUERY_SCAN_EDGES`,
`GRAPH_MAX_QUERY_RUNTIME_MS`). `CLOUD_PROVIDER` accepts `local`, `memory`,
`aws`, `azure`, `gcp`. Pin the release image `ghcr.io/hydra-db/hydradb:0.1.1`
by digest: upstream `main` is force-pushed, and v0.1.1 is the first
multi-architecture release.

Optional scale substantiation: a one-time bulk load from the deps.dev BigQuery
export (`bigquery-public-data.deps_dev_v1`) to reach the multi-million-node range
that backs the HydraDB pitch, chunked in with the same `UNWIND` forms. Prefer the
deps.dev REST API and direct incident fetches for the day-to-day slice to avoid
Google Cloud billing; use BigQuery only for the optional big load.

---

## 7. Query catalog mapped to graph operations

The Cypher subset is small, so each answer is one simple statement or a short
sequence composed by the TypeScript layer. Every natural key is resolved to its
integer id through the id-map before the call.

Blast radius, the reverse closure from a compromised version to your services.
`chalk@5.3.1` is resolved to its integer id first, then:

```cypher
CALL algo.SSpaths({
  sourceNode: $compromisedVersionId,   // integer id from the id-map
  relTypes: ['RESOLVES_TO'],
  relDirection: 'incoming',            // who depends on me; reverse index exists by default
  maxLen: 12,                          // engine cap: max_traversal_hops = 16
  pathCount: 5000
}) YIELD path
RETURN path
```

Resolved while live, the bitemporal answer. Property-to-property comparison is
not in the subset, so the TypeScript layer first resolves two scalars (the bad
version's publish time and the advisory's disclosure time), then runs the
windowed query with parameters:

```cypher
MATCH (service:Service)-[resolved:RESOLVED]->(badVersion {id: $badVersionId})
WHERE resolved.resolved_at >= $publishedAt
  AND resolved.resolved_at < $knownAt
RETURN service.name AS service, resolved.resolved_at AS resolved_at
ORDER BY resolved_at
```

Which version introduced it. Range membership is computed in TypeScript with a
semver library at ingest and written as `AFFECTS_VERSION` edges, so the query
needs no range parsing and no `min`, which the subset lacks:

```cypher
MATCH (advisory {id: $advisoryId})-[:AFFECTS_VERSION]->(version:Version)
RETURN version.version AS version, version.published_at AS published_at
ORDER BY published_at ASC
LIMIT 1
```

Shared-maintainer reach uses `algo.MSpaths` from the compromised package's
maintainer ids. Typosquats are precomputed at ingest (candidate generation via an
n-gram or BK-tree index to avoid an all-pairs edit-distance scan), stored as
`TYPOSQUAT_OF` edges, then ranked in TypeScript by graph proximity to the
service closure.

Semver comparison note: string comparison is not semver comparison. Range
membership and ordering facts are computed in TypeScript with a semver library
at ingest and written as explicit edges and integer properties (epoch
timestamps), so Cypher never parses ranges or version strings.

---

## 8. Maintainer infection surface

1. Build the maintainer-to-package bipartite graph from `MAINTAINS`, then derive a
   co-maintenance graph.
2. Model worm self-propagation as a directed can-poison traversal:
   - Hop 1 is solid from data: a leaked token poisons every package that
     maintainer can publish to.
   - Hop 2 and beyond is a stated worst-case model, not observed data. The proxy
     is: package X is a build or dev dependency of a package maintained by
     maintainer Y, therefore a worm in X could run in Y's environment and harvest
     Y's token. We do not have data on whose CI runs what, so this is labeled a
     model in the UI and the README.
3. Compose with blast radius: for each maintainer, total the downstream services
   and weekly downloads reachable within k hops.
4. Rank into a single-point-of-failure leaderboard, precomputed across all
   maintainers with one `algo.MSpaths` pass.

Scope caveat to state plainly: infection surface is only complete for maintainers
whose packages are fully inside the ingested slice. A maintainer's long tail of
packages outside the slice is not counted, so the leaderboard is a lower bound on
the slice, not a global claim.

---

## 9. Abstention model

The track rewards knowing when the answer is not there. An empty result in a slice
is not proof of safety, so the system distinguishes three states and never
presents the third as the first:

- Provably not exposed. The full dependency closure of the queried service was
  ingested, and no path exists. This is a real negative.
- Exposed. At least one path exists; the path is shown.
- Unknown. The queried package or service sits outside the ingested slice, so the
  system abstains and says so rather than implying safety.

Each answer carries which of these states it is in, plus the evidence path when
one exists.

---

## 10. Frontend

Built through the Claude Design loop, not hand-improvised. The color palette is an
approval gate: proposed, approved by the human, then built.

Screens:

- Blast radius view. Enter a `package@version`; the graph renders exposed services
  with exact paths and hop counts, and an abstention state when the target is
  outside the slice.
- Time scrubber. Drag across an incident window; nodes and edges appear as they
  were published, services turn red the moment they resolved the bad version, and
  a known-time line sweeps across to show the live-but-unknown gap.
- Maintainer leaderboard. The single-point-of-failure ranking, with the hop-2
  model clearly labeled, and a drill-down into any maintainer's predicted reach.
- Typosquat panel and local scanner results, with hits linked back to graph nodes.
- Scan my project. Upload a lockfile, ingest it as a `Service`, and get a live
  blast radius.

---

## 11. Security posture

The security-audit skill fires when a change touches a trust boundary. Two
features here do:

- Lockfile upload. Treat uploaded files as untrusted input: cap size, parse
  defensively, never execute anything from them, and scope what is stored.
- Local persistence scanner. It reads paths on the user's machine. It stays
  strictly read-only, is opt-in per run, reports only indicator matches, and logs
  no file contents or secrets.

The audit is run in full when these features are built, before the demo freeze.

---

## 12. Repository layout

```
patient-zero/
  docker-compose.yml         # HydraDB node + indexer + MinIO + the app, seeded on first run
  src/app/                   # Next.js App Router (UI and route handlers)
  src/lib/hydra/             # Bolt driver, query and path-procedure wrappers
  src/lib/ingest/            # deps.dev, npm, PyPI, OSV clients; chunked writers
  src/lib/analysis/          # blast radius, bitemporal, maintainer BFS, typosquat, abstention
  scripts/                   # one-shot ingest, incident-pack loader, lockfile-history harvester
  data/incidents/            # curated replay JSON with real timestamps
  test/                      # focused correctness fixtures
  LICENSE                    # Apache-2.0 or MIT for our code; see licensing note
  README.md                  # setup, how HydraDB is used, attribution, dataset disclosure
```

HydraDB runs from the published image `ghcr.io/hydra-db/hydradb:0.1.1` (the
newest tag, v0.1.1, as of 2026-08-16), pinned by digest because upstream `main`
is force-pushed. The image ships both binaries: `/usr/local/bin/graph-node` is
the entrypoint and `/usr/local/bin/graph-indexer` sits beside it, so the compose
indexer service reuses the same image with the entrypoint overridden. The image
runs as UID 10001, so bind mounts need matching ownership (or use named
volumes). Exposed ports: 7687 (Bolt), 8443 (HTTP), 9090 (admin and metrics),
and 9443. OTLP export is compiled in and activates through
`OTEL_EXPORTER_OTLP_ENDPOINT`. Both roles point at the same object store.
Required environment, verified from source: `CLOUD_PROVIDER` (and
`LOCAL_PATH` for local), `GRAPH_NAMESPACE`, `GRAPH_ID`, `GRAPH_CELL_ID`,
`GRAPH_CELLS`, `GRAPH_DATA_PATH`, `GRAPH_NODE_ID`, `GRAPH_BOLT_ADDR`,
`GRAPH_ADVERTISED_BOLT_ADDR`, `GRAPH_BOLT_NODE_ADDRESSES`, `GRAPH_HTTP_ADDR`,
`GRAPH_ADMIN_ADDR`, `GRAPH_AUTH_TOKEN_FILE` (token at least 32 characters),
`GRAPH_DATA_CACHE_DIR`, `GRAPH_DATA_CACHE_BYTES`, `GRAPH_ALLOW_PLAINTEXT=true`
(local only), and `RUST_MIN_STACK=33554432` (without it the node serves
`/readyz` and then aborts on the first query). The round trip is verified with a
real write and read, not just a listening port.

Licensing note: HydraDB is AGPL-3.0. This project runs it as a separate service
and talks to it over Bolt and HTTP, so our client code can carry a permissive OSI
license (Apache-2.0 recommended for its patent grant). AGPL obligations attach to
HydraDB itself and to any modification or redistribution of its source, which this
project does not do.

Reproducibility for judges: `docker compose up` boots HydraDB, the indexer, MinIO,
and the app, then runs a seed step that loads a small incident graph so the demo
works on first run without manual ingestion.

Workspace placement: the project lives inside WSL (for example `~/patient-zero`),
not under OneDrive and not on `/mnt/c`. The `.claude` kit is copied once, by
hand, from the Windows master into `~/patient-zero/.claude`, and the session
opens in that folder. Docker Desktop needs WSL integration enabled for the
distro; Bun and the git identity live inside WSL.

---

## 13. Milestones

Ordered, not time-boxed.

- M0 Foundation. Public repo and license, HydraDB node and indexer up via Docker
  with a shared object store, Bolt and HTTP round trip verified with a real
  write, and one measurement: blast radius over `relDirection: 'incoming'`
  versus a materialized `DEPENDED_ON_BY` edge, keeping the faster. The former
  source checks are done: `relDirection` accepts `incoming`, `outgoing`, `both`,
  and the query-budget defaults are recorded in section 6.
- M1 Ingestion. Data model and key-to-id map live; npm slice, OSV advisories
  (with `AFFECTS_VERSION` edges), and maintainer edges loaded through the chunked
  `UNWIND` writers; incident closures pulled in; indexer generations built. Go or
  no-go on the optional large deps.dev load.
- M2 Core queries. Blast radius, introduced-version, bitemporal resolved-while-live,
  and shared-maintainer, each a tested server function with fixtures, including the
  abstention states.
- M3 Maintainer infection surface. The can-poison traversal and the precomputed
  leaderboard, with the hop-2 model labeled.
- M4 Product features. Typosquat detection, the local persistence scanner, and the
  scan-my-project lockfile upload. Security-audit runs here.
- M5 Frontend via the Claude Design loop. Graph view, time scrubber, leaderboard,
  panels. Palette gate first.
- M6 Demo and docs. Incident replay wired to the scrubber, README via the
  readme-craft skill, and the 3-minute video to the script in section 14.
- Buffer. Performance tuning, edge cases, abstention polish, and lockfile-history
  harvest hardening.

Repo bootstrap, run once by the human inside the WSL project folder
(`~/patient-zero`), exactly as GitHub proposed it:

```bash
echo "# patient-zero" >> README.md
git init
git add README.md
git commit -m "first commit"
git branch -M main
git remote add origin https://github.com/Andy00L/patient-zero.git
git push -u origin main
```

The first real commit after this adds `.gitignore` with `.claude/` in it; the
kit is never staged or pushed. All later commits stage files explicitly, never
`git add .`.

---

## 14. Three-minute video script

- Cold open on the track's own figure: 84 malicious artifacts across 42 packages
  in six minutes, and the question, which of your services are exposed by 09:06.
- Paste an incident package. Services light up with exact paths and hop counts.
  "Detected at 09:06" sits against the days real disclosure took.
- Drag the time scrubber across the incident window to expose the live-but-unknown
  gap that the bitemporal query answers.
- Flip to prevention: the maintainer single-point-of-failure leaderboard, the
  predictive angle, with the hop-2 model labeled honestly.
- Show the typosquat panel and the local `.claude` and `.vscode` scanner finding
  worm-persistence artifacts.
- Close on the actual `algo.SSpaths` call, the graph size, and the answer latency,
  with the one sentence on what dies without HydraDB.

---

## 15. Testing strategy

Focused, not smoke-test sprawl:

- Blast radius on a tiny hand-built fixture graph with a known answer.
- The bitemporal window returns exactly the known victim set for the event-stream
  incident, which doubles as demo-truth verification.
- Introduced-version selection against a curated advisory.
- Typosquat edit-distance candidate generation.
- The k-hop maintainer traversal on a small fixture.
- Abstention: a query outside the slice returns Unknown, not a false negative.

---

## 16. Risks and mitigations

- Wrong HydraDB, highest risk. Mitigated by building on the OSS graph database,
  section 0.
- Path-procedure API mismatch. Verified in M0; fallback to bounded variable-length
  `MATCH` over the materialized reverse edge.
- Ingestion feasibility. Native bulk import and the running indexer; chunked
  `UNWIND` otherwise; slice kept modest.
- Scale claim versus built graph. Honest reframing plus the optional deps.dev bulk
  load to substantiate it.
- Bitemporal source. Real lockfile git history as ground truth; labeled modeled
  fallback if the harvest underdelivers.
- Empty demo. Seed services curated to be genuine dependents of the incident
  packages.
- Maintainer publish-rights proxy. The `maintainers` field is current-only and a
  weak proxy for real publish rights; stated as a lower-bound model.
- PyPI maintainer data is weak. Maintainer simulation scoped to npm; PyPI still
  gets blast radius.
- Node identity model. HydraDB addresses nodes by non-negative integer `id`, so
  the key-to-id map is load-bearing; it is built and tested in M1 and persisted
  alongside the ingestion state.
- Enforced query budgets. Defaults: 1,000,000 scan edges, 100,000 result
  vertices, 250,000 intermediate rows, 30,000 ms runtime, 16 traversal hops.
  Comfortable for the slice; run the indexer so `algo.*` uses compiled
  generations, and raise limits in node configuration only if the optional bulk
  load needs it.
- Fast-moving upstream. `main` is force-pushed; pin
  `ghcr.io/hydra-db/hydradb:0.1.1` by digest and never track `latest` during the
  hackathon window.

---

## 17. Submission checklist

- Public GitHub repo, no participant commits before August 12.
- OSI open-source license in the repo.
- README: setup and run steps, how HydraDB is used and why, dataset disclosure,
  third-party attribution, environment and dependency information.
- Demo video, 3 minutes or less, viewable without requesting access.
- Submission form completed before August 20, 11:59 PM PT.

---

## 18. Open items requiring the human

- Repo: done, https://github.com/Andy00L/patient-zero (bootstrap block in
  section 13).
- Prepare WSL before creating the folder: Docker Desktop WSL integration
  enabled for the distro, Bun installed inside WSL, git identity and push access
  working inside WSL, then bootstrap `~/patient-zero` and copy the kit in.
- Approve the color palette when the design loop proposes it.
- Optional: decide whether to run the large deps.dev bulk load for the scale
  claim, or ship on the slice with the honest reframing.

---

## 19. Sources verified from the HydraDB repo

Facts in sections 2 through 16 were read from the source and live registries,
not assumed:

- `README.md`: image, ports, local single-node run, path-procedure overview,
  read-consistency modes.
- `AGENTS.md`: exact environment variables, accepted `CLOUD_PROVIDER` values,
  enforced query budgets, sparse-kernel selection, the force-push warning, and
  the write-then-read verification discipline.
- `cypher-compat.md`: the accepted OpenCypher subset (integer node ids, no `IN`,
  no `min`/`max`, pass-through `WITH`, one statement per request, mandated
  `UNWIND` batch forms) and the three path-procedure signatures.
- `charts/hydradb/README.md`: node and indexer roles, CSC generation publishing
  through object-store compare-and-swap, and the MinIO development path.
- `src/query/path_procedure.rs`: `relDirection` parsing (`incoming`, `outgoing`
  as the default, `both`) and the full config-key list for the three procedures.
- `src/core/config.rs`: `GraphLimits` defaults (scan edges, result vertices,
  intermediate rows, runtime, traversal hops) and `GraphIndexPolicy::Full`
  writing the reverse adjacency index by default.
- `Dockerfile`: both binaries in the runtime image, `graph-node` as entrypoint,
  UID 10001, exposed ports including 9443, OTLP compiled in.
- `charts/hydradb/templates/configmap.yaml`: the exact environment names for S3
  and MinIO mode (`AWS_BUCKET_NAME`, `AWS_DEFAULT_REGION`, `AWS_ALLOW_HTTP`,
  `AWS_ENDPOINT`) and the full `GRAPH_*` tunable surface, including the indexer
  and query-budget variables.
- `charts/hydradb/examples/values-development.yaml`: MinIO development values
  (bucket, region, allowHttp, plaintext, dev token shape).
- GitHub tags API: v0.1.1 is the newest tag (after v0.1.0), which fixes the
  image pin.
- [hydra-db.github.io/benchmark](https://hydra-db.github.io/benchmark/):
  upstream's published traversal benchmark setup.
- npm registry `latest` tags checked on 2026-08-16 for Next.js, neo4j-driver,
  TypeScript, and semver, plus the Bun GitHub release for Bun.
- Unread, only needed if M0 hits surprises: `src/shard/path_procedure.rs`,
  `src/bin/graph_node/config.rs`, and `examples/` for write patterns.
