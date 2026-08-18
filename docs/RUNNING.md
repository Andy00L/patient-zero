# Running Patient Zero

From a clean checkout to a verified HydraDB round trip. Every HydraDB behaviour this
document relies on is recorded, with its source reference, in
[docs/HYDRADB.md](./HYDRADB.md); this file is the operational half and does not repeat
it.

## 1. Prerequisites

| What | Version | Why |
| --- | --- | --- |
| Docker Engine with Compose v2 | any current release | `docker compose` reads the `depends_on` conditions and healthchecks this project's compose file uses |
| Bun | 1.3.14 (`packageManager` in package.json) | the app and every script run on Bun, not Node |
| Free loopback ports | 7687, 8443, 9090 | Bolt, the query API, and the admin endpoint are published on 127.0.0.1 |
| Disk | about 1 GB | the HydraDB image plus the graph store in a named volume |

The image is `ghcr.io/hydra-db/hydradb:0.1.1`, pinned by digest in
`docker-compose.yml`, and it is public: no registry login is needed.

## 2. The sequence

```bash
git clone <this repo> patient-zero
cd patient-zero
bun install

cp .env.example .env

# Generate a token and put it in .env as HYDRA_AUTH_TOKEN.
openssl rand -hex 32
# or, without openssl:
#   LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 48; echo

# Start HydraDB and wait for the node to report itself ready.
docker compose up --wait

# Prove a real write and read back.
bun run hydra:health
```

`docker compose up --wait` returns once the healthchecks pass. Without `--wait`, run
`docker compose up -d` and watch `docker compose ps`: the `graph-node` row goes from
`starting` to `healthy`, usually in a few seconds.

A successful health check prints six facts and exits 0:

```
[runHealthCheck] config read, graph=default namespace=default cell=cell-0 token=<token:64 chars>
[runHealthCheck] admin endpoint http://127.0.0.1:9090 (derived from HYDRA_HTTP_URL)
[waitForNodeReadiness] ready after 1 attempt(s), 0s
[runRoundTrip] writing 2 probe node(s) as Version at ids 9000000000000000, 9000000000000001
[printReport] HydraDB health check
[printReport]   transport           http
[printReport]   endpoint            http http://127.0.0.1:8443/v1/graphs/default cell=cell-0
[printReport]   ready               yes, after 1 attempt(s) in 65ms
[printReport]   write latency ms    79
[printReport]   read latency ms     136
[printReport]   round trip matched  yes
[runHealthCheck] round trip matched, HydraDB is serving reads and writes
```

The latencies are examples. Anything else on the last line, or a non-zero exit code,
means the round trip did not happen; section 4 covers what each failure means.

`bun run hydra:health --bolt` runs the same check over Bolt instead of HTTP. It is
behind a flag because whether `neo4j-driver` 6.2.0 still offers Bolt 5.4, the highest
version this server accepts, is unverified (docs/HYDRADB.md section 11). A Bolt
handshake failure says so and does not fall back to HTTP.

The check writes two probe nodes at ids 9000000000000000 and 9000000000000001, under
the `Version` label. That id range is reserved for health checks: the id map assigns
real ids sequentially from 0, so a probe can never overwrite ingested data, and MERGE
on the id means repeated runs keep updating the same two nodes instead of growing the
graph.

## 3. What is running

| Service | Role |
| --- | --- |
| `hydra-init` | One-shot. Creates `/data/store` and `/data/cache` in the shared volume, writes the auth token to `/data/auth-token`, and chowns everything to uid 10001. Exits 0, and the node waits for that. |
| `graph-node` | The query node. Bolt on 7687, the HTTP query API on 8443, `/readyz` and `/metrics` on 9090. |
| `graph-indexer` | Compiles index generations from the same object store, one cycle every 5 seconds. Not required for correctness, but without it path procedures fall back to bounded canonical reads that spend the scan budget and come back as 429. |

Both roles share one named volume and coordinate through the object store inside it
and through nothing else. `docker compose logs -f graph-node` is the first place to
look when something is wrong.

## 4. When it does not work

### The health check says the token is too short, or still contains change-me

```
[readHydraConfigFromEnv] HYDRA_AUTH_TOKEN must be at least 32 characters, got 0
```

or, from `docker compose up`:

```
[hydra-init] HYDRA_AUTH_TOKEN is 0 characters. HydraDB refuses to start under 32.
```

HydraDB itself refuses to start on a token under 32 characters or one containing
`change-me`, whatever its length. Generate one with the command in section 2, put it in
`.env`, then `docker compose down && docker compose up --wait`. A restart is needed
because `hydra-init` writes the token file at start, and the node reads that file once.

### 401 unauthenticated, when the node is clearly up

```
[classifyErrorResponse] HydraDB rejected the credentials, check HYDRA_AUTH_TOKEN
```

`.env` and the token file inside the volume have drifted apart, which happens when the
token in `.env` is edited without restarting the stack. `docker compose down && docker
compose up --wait` rewrites the file from `.env`. The message deliberately carries no
detail from the server: the actionable fact is which setting to check.

### The node never becomes healthy, or /readyz answers 503 forever

Almost always the store directory. `CLOUD_PROVIDER=local` needs `LOCAL_PATH` to point
at a directory that **already exists**, and local mode will not create it. That is what
`hydra-init` is for, so this failure means the init step did not do its job: check
`docker compose logs hydra-init` and confirm it printed
`/data/store, /data/cache and /data/auth-token are ready for uid 10001`.

The related trap is ownership. The image runs as uid 10001, so a bind mount owned by
your own user would leave the node unable to write. This compose file uses a named
volume chowned by `hydra-init` for exactly that reason; if you change it to a bind
mount, you own that problem.

### The node is healthy, then the first query kills it

```
thread '...' has overflowed its stack
```

`RUST_MIN_STACK` is unset. The node builds, serves `/readyz`, and aborts on the first
query, which reads like a crash out of nowhere. Neither the image nor the upstream Helm
chart sets it, despite it being mandated upstream, so `docker-compose.yml` sets
`RUST_MIN_STACK=33554432` (32 MiB) on both services. If you run the image by hand,
export it yourself.

### 429 resource_exhausted

```
[classifyErrorResponse] traversal exceeded an engine budget: ... native_path_edges ...
[reportFailure] engine budget rejected: native_path_edges
```

This is a budget rejection, not rate limiting. Retrying the same query changes nothing;
the fix is to narrow it. The operation name says which limit was hit, and the analysis
layer branches on it: `native_path_max_len` and `native_path_count` mean lower `maxLen`
or `pathCount`, `native_path_edges` means the traversal scanned too much of the graph,
`native_path_selector_candidates` means the multi-source selector matched too many
nodes. The limits and their defaults are in docs/HYDRADB.md section 6.

### 421 not_cell_writer

```
[classifyErrorResponse] HydraDB is not serving this query: ...
[reportFailure] context status=421 ... code=not_cell_writer owner=node-1
```

The write reached a node that does not own the cell, and `owner` names the one that
does. On a single-node compose run this means `HYDRA_CELL_ID` in `.env` does not match
`GRAPH_CELL_ID` in `docker-compose.yml`, or `GRAPH_CELLS` does not contain it.

### 408, the query times out

The node accepted the request and did not finish it inside `HYDRA_QUERY_TIMEOUT_MS`. A
timeout is 408 and never 429, so it is a slow query rather than a rejected one: check
`docker compose logs graph-node`, and check that `graph-indexer` is healthy, because an
unindexed traversal reads canonical storage.

### Nothing is listening on the admin port

```
[waitForNodeReadiness] nothing is listening on http://127.0.0.1:9090/readyz after 3 attempts.
Start HydraDB with `docker compose up -d graph-node`, ...
```

The check gives up after three attempts rather than waiting out its 90 second budget: a
node that is up but not ready answers 503, so three failures to get any response at all
mean the port is not there. Either the stack is not running, or the ports are remapped,
in which case set `HYDRA_ADMIN_URL` (see `.env.example`).

### A port is already in use

```
Error ... bind for 127.0.0.1:7687 failed: port is already allocated
```

Something else holds 7687, 8443 or 9090. Stop it, or remap the host side in
`docker-compose.yml`. If you remap 8443 or 9090, update `HYDRA_HTTP_URL` and set
`HYDRA_ADMIN_URL`; if you remap 7687, also change `GRAPH_ADVERTISED_BOLT_ADDR`, because
that is the address the node hands back to a Bolt driver.

### Starting over

```bash
docker compose down -v
```

`-v` deletes the named volume, which is the whole graph. The next `up` starts from an
empty store, and a re-ingest is expected to start from empty anyway.

## 5. If Docker is not available

The analysis layer talks to a `GraphGateway`, and HydraDB is only one implementation of
it. The other is `MemoryGraph` in `src/lib/graph/memory-gateway.ts`, an in-process graph
that mirrors the engine's constraints rather than being permissive: it bounds traversal
by `maxLength`, caps results by `pathCount`, and returns the same
`query_budget_exceeded` failure at the same 1,000,000 edge expansion budget. Code that
works against it is not relying on behaviour the real engine refuses.

Two ways to use it:

- Point `HYDRA_SNAPSHOT_PATH` at an exported slice (see `.env.example`). The app then
  answers from the snapshot and states in the UI which source answered, so a snapshot
  answer is never presented as a live one.
- Run the test fixtures, which build a graph with a hand-known answer:
  `bun test`.

What you cannot do without a server is `bun run hydra:health`. It exists to prove a
real round trip against a real engine, so it fails loudly rather than reporting a
green check against an in-process stand-in.
