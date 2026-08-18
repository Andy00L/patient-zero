# HydraDB, as verified against the source

Every fact below was read in the HydraDB source tree, not recalled. Each non-obvious
claim carries a `sourceRef` naming the file and the symbol or line it came from, inside
the engine source vendored read-only at `.scratch/hydradb-src/` at the revision pinned
during the build. A claim that could not be sourced is not stated as fact; it sits in
section 11 instead. Code comments cite this document by section rather than repeating
the references.

The engine is the OSS graph database `github.com/hydra-db/hydradb`, crate
`slatedb-graph-kernel`, AGPL-3.0. It is NOT the unrelated proprietary `hydradb-sdk`
package on PyPI, which is a document retrieval engine owned by a different company.
Mixing the two up is the disqualification risk `plan.md` section 0 names. Everything
here is the graph database: OpenCypher over HTTP or Bolt, plus the `algo.*` path
procedures.

## Contents

1. [Identity and the id map](#1-identity-and-the-id-map)
2. [The Cypher subset](#2-the-cypher-subset)
3. [Batch writes](#3-batch-writes)
4. [Path procedures](#4-path-procedures)
5. [Property indexes](#5-property-indexes)
6. [Budgets](#6-budgets)
7. [HTTP query API](#7-http-query-api)
8. [Bolt](#8-bolt)
9. [Running a node](#9-running-a-node)
10. [Corrections to the build plan](#10-corrections-to-the-build-plan)
11. [What is still unverified](#11-what-is-still-unverified)

## 1. Identity and the id map

HydraDB addresses every node and relationship by a non-negative integer `id`.
Patterns match on that integer. A natural key such as `npm:chalk:5.3.1` is a
property, never an identity.

Consequence for this project: `src/lib/hydra/id-map.ts` owns the translation from
natural key to integer id, assigns ids sequentially, and persists them append-only
so an interrupted ingest resumes. Keys are namespaced by label before assignment
(`Version|npm:chalk:5.3.1`), because a package named `@someone` and a maintainer
named `@someone` would otherwise share one id and silently merge into one node.

Ids are assigned, never hashed. A hash collision would merge two unrelated packages
into one node, and the resulting blast radius would be wrong in a way no test would
catch.

Relationship identity is a special case, and section 2.4 is where it bites: a
relationship `id` can be written, but it cannot be read back through a row query.

## 2. The Cypher subset

The parser accepts a deliberately small OpenCypher subset. Two separate parsers are
involved: `libcypher-parser` behind `src/query/opencypher.rs` for everything, and a
hand-written parser in `src/query/path_procedure.rs` entered whenever the statement
starts with `CALL algo.` (section 4).

### 2.1 What the parser accepts and refuses

| Feature | Status |
| --- | --- |
| One statement per request | Enforced. `query_access` refuses when the parse result holds anything other than exactly one directive: "query transport requires exactly one Cypher statement". `sourceRef: .scratch/hydradb-src/src/query/opencypher.rs:859-862` |
| `IN` operator | Absent. `lower_row_predicate` falls through to "WHERE currently supports boolean combinations of property comparisons". `sourceRef: .scratch/hydradb-src/src/query/opencypher.rs:2797`. `UNWIND` is not a substitute on a read, see 2.7. |
| `min`, `max` | Absent. `row_aggregate_function` recognises only count, sum, avg, collect. `sourceRef: .scratch/hydradb-src/src/query/opencypher.rs row_aggregate_function`. All version and time arithmetic is precomputed in TypeScript. |
| `CONTAINS`, `ENDS WITH`, `IS NULL`, arithmetic, function calls in `WHERE` | Absent, same fall-through as `IN`. |
| `STARTS WITH` | Present, and the one predicate that can seed an index. See 2.3 and 2.5. |
| `WITH` | Pass-through only: every in-scope binding, exactly once, bare identifiers, no DISTINCT, WHERE, ORDER BY, SKIP, or LIMIT. `sourceRef: .scratch/hydradb-src/src/query/opencypher.rs lower_passthrough_with` |
| Variable-length patterns | Must carry an explicit maximum: "unbounded variable-length MATCH requires an explicit max hop". They also cannot bind the relationship. `sourceRef: .scratch/hydradb-src/src/query/opencypher.rs lower_hop_range, and opencypher.rs:3195-3198` |
| `count(n)`, bare binding as an aggregate argument | **Rejected at parse time.** Use `count(*)` or `count(n.id)`. See 2.4. |
| `RETURN n`, `RETURN *` | Rejected. See 2.4. |
| `edge.id` on a relationship binding | **Rejected at execution.** See 2.4. |
| Labels, relationship types, property names | Query TEXT. They are AST identifiers and cannot be parameters. |
| `SKIP` and `LIMIT` counts | Integer literal **or** an integer parameter. `sourceRef: .scratch/hydradb-src/src/query/opencypher.rs constant_integer_expression, parameter arm at opencypher.rs:3481-3488`. This project still inlines them as literals, because the values come from the analysis layer's own budget and are never user text. |
| DDL (`CREATE INDEX`, `CREATE CONSTRAINT`) | Does not exist, and none is needed (section 5). The statement body must be a `CYPHER_AST_QUERY`, so a schema command fails the parser's instance check. `sourceRef: .scratch/hydradb-src/src/query/opencypher.rs:867-868` |

`range` is a Cypher function name, so this project stores the declared dependency
range under the property `version_range` rather than `range`. Whether the parser
would actually refuse `n.range` could not be checked: the keyword table lives in the
external C library, not in the vendored tree (section 11).

### 2.2 How a read runs

`execute_single_opencypher_rows` tries five fast paths in order, then falls through to
the general matcher.
`sourceRef: .scratch/hydradb-src/src/shard/query.rs:757-798`

| Fast path | Requires | sourceRef (`.scratch/hydradb-src/src/shard/query.rs`) |
| --- | --- | --- |
| Graph kernel | one edge pattern, bound source, no label and no non-id property on either endpoint, one node-id projection | `try_execute_graph_kernel_row_query`, line 995 |
| Source relationship ids | one edge pattern, source id known, destination free, **no relationship binding**, node-id projections only | `try_execute_source_relationship_id_rows_query`, line 1160; `source_relationship_id_projection_supported`, line 7052 |
| Relationship count | one edge pattern, both endpoint ids known, exactly `count(*)`, no WHERE, no ORDER BY | `relationship_count_query_edge`, lines 6990-7014 |
| Relationship rows | one edge pattern, both endpoint ids known, a relationship binding, no WHERE, no aggregate, projections limited to endpoint ids and relationship properties other than `id` | `try_execute_relationship_rows_query`, line 1094; `relationship_rows_projection_supported`, line 7176 |
| Ordered string vertex rows | exactly one node pattern with a binding, `ORDER BY <binding>.<property>`, a LIMIT, and a WHERE that proves the property is a string; no DISTINCT, no UNION, no aggregate | `ordered_string_vertex_index_spec`, lines 8118-8161 |

The general matcher runs group by group: an optional index seed, then pattern
matching, then that group's WHERE as a post-filter. A group marked OPTIONAL that
matched nothing is null filled.
`sourceRef: .scratch/hydradb-src/src/shard/query.rs match_row_pattern_groups, lines 3031-3115`

Exactly **two** index seeds exist, tried in this order.
`sourceRef: .scratch/hydradb-src/src/shard/query.rs:3058-3069`

- `relationship_predicate_seed_rows`: an equality, or an OR of equalities, on one
  **relationship** property. It needs an edge pattern whose binding is the constrained
  binding, no hop range, no pattern properties, and the latest epoch.
  `sourceRef: .scratch/hydradb-src/src/shard/query.rs relationship_predicate_seed_rows, lines 3161-3242, and row_predicate_relationship_property_constraint, lines 8172-8201`
- `prefix_predicate_seed_rows`: a group WHERE that is *exactly* one `STARTS WITH` on a
  **vertex** property. The Rust pattern match binds the whole predicate, so an AND or
  an OR containing one does not qualify. Latest epoch required.
  `sourceRef: .scratch/hydradb-src/src/shard/query.rs prefix_predicate_seed_rows, lines 3245-3306`

**There is no vertex-side twin of the relationship OR-of-equalities seed.** The
constraint extractor collapses OR arms on the same binding and property into a value
list, but the seed that consumes it only ever looks for an *edge* pattern carrying
that binding, so a node binding makes it decline. The only index-backed vertex read
shapes are: a single-key property match in the pattern (2.3), a lone `STARTS WITH`,
and the ordered index walk under `ORDER BY n.p LIMIT k` (2.2).

### 2.3 Candidates come from the pattern, never from the WHERE

`candidate_vertex_ids` calls `best_row_node_access_with_stats(cell_id, pattern, &BTreeSet::new())`.
The bound-variable set is empty and the predicate is not passed at all, so **no WHERE
clause can change how a node pattern resolves.**
`sourceRef: .scratch/hydradb-src/src/shard/query.rs candidate_vertex_ids, lines 4027-4069, call at 4036`

Four access shapes, and only four.
`sourceRef: .scratch/hydradb-src/src/shard/query_optimizer.rs best_row_node_access, lines 554-620`

| Pattern | Access | Estimate | Line |
| --- | --- | --- | --- |
| `(n:L {id: 41})`, or a binding already bound | `VertexIdSeek` | 1 | 560-564 |
| `(n:L {key: $k})` | `VertexPropertyIndex` | index statistics, fallback 8 | 567-594 |
| `(n:L)` | `VertexLabelScan` | label statistics, fallback 64 | 595-615 |
| `(n)`, no label and no property | `AllVertexScan` | 1,000,000 | 616-619 |

`AllVertexScan` is not a slow plan, it is a **failure**. `candidate_vertex_ids` returns
`None` for it and `match_node_row_pattern` turns that into 400 `invalid_request`:
"node-only MATCH requires an id, label, or property predicate".
`sourceRef: .scratch/hydradb-src/src/shard/query.rs match_node_row_pattern, lines 3559-3573`

So a selective single-value lookup must put the value **in the pattern**:

```cypher
MATCH (n:Version {key: $key0}) RETURN n.id AS id, n.key AS key LIMIT 1
```

Parameters inside a pattern property map are resolved at lowering time, so the planner
sees a concrete string and scores the property index against the label scan.
`sourceRef: .scratch/hydradb-src/src/query/opencypher.rs property_map then scalar_property_value, lines 3326-3357`

The many-value form is a label scan with an OR post-filter, no matter how selective
the values are:

```cypher
MATCH (n:Version) WHERE n.id = 41 OR n.id = 42 RETURN n.id AS id, n.version AS version
```

`n.id` on the left lowers to `RowExpression::NodeId`, not to a property read, and
compares numerically against integer literals. Cost is one label scan for the whole
chunk plus one metadata fetch per candidate. This is why `HydraGateway.resolveNodeIds`
issues one request per key: N index seeks beat one scan of every node carrying the
label.

An id in a pattern must be an integer literal or an integer parameter, never a
variable, so `UNWIND $ids AS wanted MATCH (n:Version {id: wanted})` cannot work even
before the UNWIND gate rejects it (2.7).
`sourceRef: .scratch/hydradb-src/src/query/opencypher.rs lower_row_node_pattern, lines 3280-3317`

For an edge pattern: both endpoint ids known gives `ExpandInto`, a known source gives
`BoundOutExpand`, a known destination gives `BoundInExpand` but only when the reverse
index is available (section 5).
`sourceRef: .scratch/hydradb-src/src/shard/query_optimizer.rs best_row_edge_access, lines 622-740`

### 2.4 What RETURN accepts

`sourceRef: .scratch/hydradb-src/src/query/opencypher.rs lower_match_return_rows, lines 2189-2298`

| Form | Status | sourceRef (`.scratch/hydradb-src/src/query/opencypher.rs` unless noted) |
| --- | --- | --- |
| `n.id AS x` | Accepted. Lowers to `NodeId`, not a property read. | 2262-2269 |
| `n.prop AS x` | Accepted. | 2270-2277 |
| `count(*) AS x` | Accepted. | `is_count_star`, line 3550 |
| `count(n.id)`, `sum(n.p)`, `avg(n.p)`, `collect(n.p)` | Accepted. Exactly one argument. | `lower_row_aggregate_expression`, lines 2842-2874 |
| `count(n)` | **Rejected at parse time.** | see below |
| `count(DISTINCT ...)` | Rejected: "DISTINCT aggregate arguments are not executable in Query engine". | 2850-2852 |
| `RETURN *` | Rejected: "RETURN * is not executable in Query engine". | 2225-2227 |
| `RETURN n` (bare binding) | Rejected: "RETURN currently supports `<binding>.<property>` or count(\*)". | 2271 |
| `edge.id` where `edge` binds a relationship | **Rejected at execution.** | see below |
| `edge.prop` where `prop` is not `id` | Accepted. Relationship metadata is hydrated per row. | `src/shard/query.rs binding_property, lines 8321-8327` |
| `AS` alias | Optional, taken verbatim with no validation. Without one the column is named `n.id` or `count(*)`. | 2242-2277 |
| DISTINCT, ORDER BY, SKIP, LIMIT | Accepted. | 2228, `lower_return_window`, lines 2600-2625 |

**`count(n)` is a parse error, not a slow query.** The aggregate lowering sends its one
argument through `lower_row_expression`, which accepts `<binding>.id`,
`<binding>.<property>`, or a scalar literal, in that order. A bare binding is none of
those, so it falls through to `scalar_property_value`, which ends in "property values
support integer, float, boolean, and string literals". RETURN's own error message
names the accepted forms: `<binding>.<property>` or `count(*)`. The whole statement
answers 400 `invalid_request`, so the read yields nothing at all.
`sourceRef: .scratch/hydradb-src/src/query/opencypher.rs lower_row_expression, lines 2827-2840; scalar_property_value ends at opencypher.rs:3428; the RETURN message is at opencypher.rs:2271`

The upstream test suite writes `count(*)` everywhere and `count(n)` nowhere.
`sourceRef: .scratch/hydradb-src/src/tests.rs:418, 1584, and examples/query_correctness.rs:209`

```cypher
MATCH (n:Version) RETURN count(*) AS total
```

`count(n.id)` works too. Neither is cheap: both are computed by
`aggregate_projected_rows` after every binding row has been materialised, so a label
count still pays the full label scan, one metadata hydration per candidate, and the
250,000 candidate cap in section 6. Above that size the count and its id-list fallback
fail together, and the only exact count for a large label is an ingest-side counter.
`sourceRef: .scratch/hydradb-src/src/shard/query.rs aggregate_projected_rows, line 8527`

**`edge.id` is a hard rejection, not merely an unindexed read.** `binding_property`
answers `UnsupportedQuery { feature: "relationship id properties are not executable in
Query engine" }` for property `"id"` on any relationship binding. A statement carrying
that column returns 400 and the entire read yields nothing, so a caller's tolerance for
a null `relationship_id` column never gets a chance to apply. The relationship-rows
fast path refuses it independently, and the source-relationship-id fast path accepts
only node-id projections and rejects any pattern that binds the relationship, so no
fast path rescues it either.
`sourceRef: .scratch/hydradb-src/src/shard/query.rs binding_property, lines 8313-8320; the second rejection in the relationship fast path at query.rs:8388-8394; relationship_rows_projection_supported at query.rs:7176; source_relationship_id_projection_supported at query.rs:7052`

Non-id relationship properties project fine, so the fix is to drop the column and keep
the rest of the shape:

```cypher
MATCH (n:Service {id: $nodeId})-[edge:RESOLVED]->(other)
  WHERE edge.resolved_at_ms >= $windowFrom AND edge.resolved_at_ms < $windowTo
  RETURN other.id AS other_id, edge.resolved_at_ms AS resolved_at_ms LIMIT 500
```

Relationship identity is reachable **only** through the `algo.*paths` procedures, which
hydrate each path edge with its real id themselves (section 4).

If you find `r._fid` in the upstream tests, it is an ordinary user-written fixture
property that those tests set with `with_property("_fid", ...)`, not engine-provided
identity. It is not a workaround and it does not exist on a relationship this project
writes.
`sourceRef: .scratch/hydradb-src/src/tests.rs:7903 and 8188-8198 write it; src/tests.rs:8249 reads it back`

### 2.5 What WHERE accepts

`sourceRef: .scratch/hydradb-src/src/query/opencypher.rs lower_row_predicate, lines 2721-2797`

| Form | Status | Line |
| --- | --- | --- |
| `AND`, `OR`, `NOT` | Accepted, any nesting. | 2751-2762, 2787-2793 |
| `=`, `<>`, `<`, `>`, `<=`, `>=` | Accepted, and nothing else. | `row_comparison_op`, 2807-2825 |
| Chained comparison (`a < b < c`) | Accepted, lowered to an AND chain. | 2726-2748 |
| `STARTS WITH` | Accepted. Right side must be a string literal or a string parameter. | 2767-2777 |
| `IN`, `CONTAINS`, `ENDS WITH`, `IS NULL`, arithmetic, function calls | Rejected: "WHERE currently supports boolean combinations of property comparisons". | 2797 |
| Operands | `<binding>.id`, `<binding>.<property>`, integer, float, boolean, string, or a parameter of those types. | `lower_row_expression`, 2827-2840 |

A comparison with a property on **both** sides lowers and executes: both sides go
through `lower_row_expression` and both are evaluated per row by `eval_row_expression`,
which handles `RowExpression::Property` on either side. It is never index backed, and
no upstream test covers it, so treat it as a post-filter of last resort.
`sourceRef: .scratch/hydradb-src/src/shard/query.rs row_predicate_matches, lines 8053-8076, and eval_row_expression, lines 8221-8235`

Comparison semantics, all in `.scratch/hydradb-src/src/shard/query.rs`:

- Numbers compare across representations: unsigned, signed, and float are mutually
  ordered. `sourceRef: query.rs numeric_property_order`
- A missing property makes a comparison false rather than an error.
  `sourceRef: query.rs compare_row_values, lines 8239-8245`
- An ordered comparison between a string and a number is a hard error, not false:
  "ordered comparisons require numeric or matching string values". Equality between
  mismatched types is simply false.
  `sourceRef: query.rs compare_vertex_property_values, lines 8266-8278`
- A WHERE attached to one MATCH clause belongs to that clause's group, so an OPTIONAL
  MATCH filter does not leak backwards.
  `sourceRef: .scratch/hydradb-src/src/query/opencypher.rs:2207-2220`

### 2.6 Aggregates, DISTINCT, ORDER BY, SKIP, LIMIT

Four aggregates exist and no more: `count`, `sum`, `avg`, `collect`. Names are matched
case-insensitively, each takes exactly one argument, and a DISTINCT argument is
rejected.
`sourceRef: .scratch/hydradb-src/src/query/opencypher.rs RowAggregateFunction at lines 173-178, row_aggregate_function at lines 2876-2888`

`DISTINCT`, `ORDER BY`, `SKIP`, and `LIMIT` are all accepted on RETURN. `LIMIT` is
applied after every row has been materialised, so it caps the response, not the work.
`sourceRef: .scratch/hydradb-src/src/shard/query.rs finish_projected_rows, line 4918`

### 2.7 UNWIND is not a read escape hatch

Any statement containing `UNWIND` must lower to one of a fixed set of batch shapes.
The `ParsedUnwindBatchKind` enum has **nine** variants, and exactly **one** of them is
read-shaped:

`OutNeighbors`, `CreateEdges`, `CreateEdgesBetweenLabeledVertices`, `DeleteEdges`,
`DeleteVertices`, `DeleteRelationshipsByProperty`, `UpsertVertices`,
`CreateRelationshipsBetweenLabeledVertices`, `MergeRelationshipsBetweenLabeledVertices`.
`sourceRef: .scratch/hydradb-src/src/query/opencypher.rs:57-115`

`OutNeighbors` is the only read. Its shape is rigid: `UNWIND` a parameter, then a
`MATCH` with no OPTIONAL, no hints and no WHERE, then a `RETURN` of exactly two
unsorted projections, first the source field off the row, second the destination
binding's `.id`. No DISTINCT, no ORDER BY, no SKIP, no LIMIT, and no id constraint on
the destination.
`sourceRef: .scratch/hydradb-src/src/query/opencypher.rs:1171-1220`

```cypher
UNWIND $sources AS row
  MATCH ({id: row.src})-[:FOLLOWS]->(v)
  RETURN row.src AS src, v.id AS dst
```

`sourceRef: .scratch/hydradb-src/src/client/bolt/tests.rs:958-960`

So there is **no general UNWIND-then-MATCH read**, and `UNWIND` cannot stand in for the
missing `IN` operator. Anything else containing UNWIND is 400: "UNWIND batches support
CREATE or MATCH followed by RETURN, DELETE, CREATE, or MERGE".
`sourceRef: .scratch/hydradb-src/src/query/opencypher.rs:1019-1022`

The batch input itself must be a **parameter**. Inlining rows as literal Cypher is
rejected with "UNWIND batch input must be a parameter".
`sourceRef: .scratch/hydradb-src/src/query/opencypher.rs:965-971`

### 2.8 Several patterns, several MATCH clauses, OPTIONAL MATCH, UNION

All four are supported, and none is currently used by this project.

| Form | Status | sourceRef |
| --- | --- | --- |
| Comma-separated patterns in one MATCH | Accepted. One group, joined by shared bindings. | `.scratch/hydradb-src/src/query/opencypher.rs:2204-2206` |
| Several MATCH clauses | Accepted. One group each, executed in order, each group's WHERE local to it. | `.scratch/hydradb-src/src/query/opencypher.rs:2198-2221` |
| `OPTIONAL MATCH` | Accepted. A group that matched nothing is null filled, and a null binding projects as null. | `.scratch/hydradb-src/src/shard/query.rs:3093-3105` |
| `UNION` and `UNION ALL` | Accepted. Arms must project identical column names; `UNION` dedups. | `.scratch/hydradb-src/src/query/opencypher.rs:2117-2187` |
| Nested UNION, or mixing UNION with UNION ALL | Rejected. | `.scratch/hydradb-src/src/query/opencypher.rs:2117-2187` |

Group order is not a hint, it is the join order: each group's rows multiply the previous
group's rows before the next group runs, and the running total is metered.
Put the selective group first.
`sourceRef: .scratch/hydradb-src/src/shard/query.rs match_row_pattern_groups, lines 3049-3113`

### 2.9 The security consequence

Labels, relationship types, property names, and `algo.MSpaths` selector values are all
query TEXT, not parameters. Selector values in particular: `sourceLabel`,
`sourceProperty`, `sourceValues`, `targetLabel`, `targetProperty`, `targetValues`, and
`relTypes` are read by `config_literal_string` and `config_string_list`, neither of
which has a parameter arm, so a `$param` in any of those positions is a parse error.
`sourceRef: .scratch/hydradb-src/src/query/path_procedure.rs config_literal_string at lines 364-374, config_string_list at lines 467-483`

Package and maintainer names come from public registries, so untrusted input reaches
Cypher text. `src/lib/hydra/cypher.ts` handles this with an allowlist, not an escape
routine: `encodeStringLiteral` accepts `[A-Za-z0-9._~+@/:-]` up to 512 characters and
returns a Failure for anything else. Every natural key used as an `algo.MSpaths`
selector value must satisfy that pattern and that length cap, or the statement is never
built. Escaping has to be exactly right against a parser this project cannot
exhaustively test; rejecting an unexpected character fails closed.

## 3. Batch writes

Section 2.7 lists all nine UNWIND batch shapes. This project uses two of them, both
`UNWIND` over a list-of-maps **parameter**.

### Node upsert

```cypher
UNWIND $rows AS row MERGE (n {id: row.vertex})
  SET n:Package, n.key = row.key, n.ecosystem = row.ecosystem
```

Rules, all enforced by the parser.
`sourceRef: .scratch/hydradb-src/src/query/opencypher.rs unwind_vertex_upsert_template, entered at opencypher.rs:975-998`

- The `MERGE` pattern carries no label and no property other than `id`.
- Exactly **one** label in the `SET` clause, and it is required. `SET n:Version:Npm`
  and `SET n:Version, n:Npm` are both rejected. A second label needs a second batch
  against the same ids, since the write is a metadata merge.
- Every `SET` value must read a field off the row map. `SET n.ecosystem = 'npm'` is
  rejected; the constant goes in every row instead.
- `SET n.id = ...` is rejected.
- A repeated property is rejected.
- The property key `id` is fixed, but the row field name behind it is free:
  `MERGE (n {id: row.node_id})` is accepted. The `UNWIND` alias is also free.

### Edge create, with endpoint labels

```cypher
UNWIND $rows AS row
  MATCH (s:Service {id: row.source_vertex}), (d:Version {id: row.destination_vertex})
  CREATE (s)-[:RESOLVED {id: row.relationship_vertex, resolved_at_ms: row.resolved_at_ms}]->(d)
```

The two endpoint labels may differ. The parser reads each endpoint independently into
a (field, label) pair and never compares the two, and the writer validates each side
against that endpoint's own stored metadata. The `:Entity, :Entity` pairing in the
upstream docs is an example, not a constraint.
`sourceRef: .scratch/hydradb-src/src/query/opencypher.rs unwind_bound_edge_create_template, entered at opencypher.rs:1032-1060`

Rules:

- Exactly two comma-separated endpoint node paths in the `MATCH`, each bound, each
  with exactly one label and exactly one property, `id: row.<field>`.
- The `CREATE` pattern references the bindings bare. No labels, no properties on
  `(s)` and `(d)`.
- One hop, one fixed relationship type, directed. `<-` is accepted and swaps source
  and destination. Undirected is rejected.
- **Both endpoints must already exist and already carry the stated label**, otherwise
  the batch fails with 400 `invalid_request`. Nodes are written before edges.

### Edge create, unlabeled

```cypher
UNWIND $rows AS row CREATE ({id: row.source_vertex})-[:RESOLVED]->({id: row.destination_vertex})
```

Faster: no endpoint verification. But labels on the node patterns are rejected, and
so are relationship properties, which means no relationship `id`. This project uses
the labeled form everywhere, because the endpoint check catches an id-map mistake at
write time rather than at query time.
`sourceRef: .scratch/hydradb-src/src/query/opencypher.rs:1000-1017`

### Row shape is strict

Each row must be a JSON object. Every field the statement names must be present in
every row, and must hold a scalar. An absent field, a null, or a nested object fails
the whole batch with the offending row index in the message. The id field accepts
only a non-negative integer.
`sourceRef: .scratch/hydradb-src/src/client/service.rs:2440 and 2669`

Consequence: the writers fill explicit sentinels (`published_at_ms: -1`) rather than
omitting a field.

### Undocumented merge policy markers

`__hydradb_update_if_newer_by` and `__hydradb_create_only_<property>` give
last-write-wins guards on a node upsert.
`sourceRef: .scratch/hydradb-src/src/query/opencypher.rs:18-20, with worked examples in the doc comment at opencypher.rs:3926-3956`

This project does not use them: a full re-ingest starts from an empty graph and
`MERGE` on the id is already idempotent. Recorded here because they are absent from
the upstream compatibility doc.

## 4. Path procedures

**Three** native procedures, not two. `src/query/path_procedure.rs` is a hand-written
parser, separate from libcypher-parser, entered whenever the statement starts with
`CALL algo.`. Procedure names are matched case-insensitively.
`sourceRef: .scratch/hydradb-src/src/query/path_procedure.rs is_native_path_procedure at lines 79-88, NativePathProcedureKind at lines 12-20, name dispatch at lines 270-278`

All three yield only `path`, `pathWeight`, and `pathCost`. The tail must be
`YIELD <cols> RETURN <cols>`, an optional semicolon, then end of input; duplicates are
rejected and every returned column must have been yielded. `YIELD path RETURN path` is
exactly right.
`sourceRef: .scratch/hydradb-src/src/query/path_procedure.rs parse_native_path_call, lines 279-292`

Option keys are case-sensitive and the set is closed at **eighteen** keys: anything
else is "unknown native path option". Duplicate keys are rejected.
`sourceRef: .scratch/hydradb-src/src/query/path_procedure.rs:182-204`

Shared defaults and limits:

- `relTypes` is required and non-empty, and must be a list of string literals. Each
  type goes through `validate_component` (ASCII alphanumeric plus `_`, `-`, `.`), which
  this project's `/^[A-Z][A-Z_]*$/` satisfies.
  `sourceRef: .scratch/hydradb-src/src/query/path_procedure.rs:130-140, and src/codec.rs validate_component`
- `maxLen` is optional and defaults to `max_traversal_hops`, which is 16. Above the cap
  it is `AdmissionRejected { operation: "native_path_max_len" }`, that is **429, not
  400**. This project always sends it explicitly: an unstated 16 hop walk over a
  dependency graph is not a query anyone intended.
  `sourceRef: .scratch/hydradb-src/src/query/path_procedure.rs:151-159`
- `pathCount` defaults to **1**, which is why sending it explicitly matters as much as
  `maxLen`. `resultLimit` must be greater than zero.
  `sourceRef: .scratch/hydradb-src/src/query/path_procedure.rs:160-164`
- `sourceNode`, `targetNode`, `maxLen`, `pathCount`, `resultLimit`, `maxCost`,
  `weightProp`, `costProp`, and `relDirection` each accept a parameter as well as a
  literal. The selector keys and `relTypes` do not (section 2.9).
  `sourceRef: .scratch/hydradb-src/src/query/path_procedure.rs config_string at lines 447-465, config_u64 at lines 485-500`

### `algo.SPpaths`, single pair

```cypher
CALL algo.SPpaths({sourceNode: 12, targetNode: 87, relTypes: ["RESOLVES_TO"],
  relDirection: "outgoing", maxLen: 8, pathCount: 100}) YIELD path RETURN path
```

`sourceNode` is required and `targetNode` is required too: without it the call fails
with "algo.SPpaths requires targetNode". It is the shape for "show me how A reaches B",
which the other two cannot express, since neither accepts a target node id. Every
multi-source key is rejected on it.
`sourceRef: .scratch/hydradb-src/src/query/path_procedure.rs:105-112 and 215-221`

### `algo.SSpaths`, single source

```cypher
CALL algo.SSpaths({sourceNode: 12, relTypes: ["DEPENDED_ON_BY"],
  relDirection: "outgoing", maxLen: 8, pathCount: 5000}) YIELD path RETURN path
```

- `sourceNode` is required. `targetNode` is rejected by name: "algo.SSpaths does not
  accept targetNode".
- Every multi-source key is rejected, including `targetLabel`, `targetProperty`,
  `targetValues`, `pairwise`, and `fairRelationshipVariants`. **Target filtering
  happens client side.** That costs nothing, because the engine hydrates each path
  node's complete label set on the way out.
  `sourceRef: .scratch/hydradb-src/src/query/path_procedure.rs:113-119 and 205-221`

### `algo.MSpaths`, multi source

```cypher
CALL algo.MSpaths({sourceLabel: "Maintainer", sourceProperty: "key",
  sourceValues: ["npm:sindresorhus", "npm:isaacs"], relTypes: ["MAINTAINS"],
  relDirection: "outgoing", maxLen: 4, pathCount: 50000}) YIELD path RETURN path
```

- `sourceNode` and `targetNode` are both rejected: "is not supported by algo.MSpaths;
  use indexed selectors". Sources are selected by `sourceLabel` plus `sourceProperty`
  plus `sourceValues`.
  `sourceRef: .scratch/hydradb-src/src/query/path_procedure.rs:222-229`
- Those values must be **string literals in the query text**, not parameters, which is
  the reason `encodeStringLiteral` exists (section 2.9).
- Selector values are compared as strings only: the resolver builds a
  `VertexPropertyValue::String` from each one, so an integer-valued property cannot be
  selected on. This is why every node in this project carries a string `key`.
  `sourceRef: .scratch/hydradb-src/src/shard/path_procedure.rs:603-610`
- `sourceProperty` plus value is the selective part; `sourceLabel` is only a
  post-filter applied **after** candidates are hydrated. A property value shared across
  labels costs candidate budget before being discarded.
  `sourceRef: .scratch/hydradb-src/src/shard/path_procedure.rs:636-651`
- `targetLabel`, `targetProperty`, `targetValues`, and `pairwise` are accepted here and
  only here. `targetValues` defaults its label and property to the source selector's.
  This project does not use them yet.
  `sourceRef: .scratch/hydradb-src/src/query/path_procedure.rs optional_selector, lines 312-362, and pairwise at lines 123-126`

This is the one procedure that makes the maintainer leaderboard a single server-side
pass instead of one request per maintainer.

### Direction IS an argument

`relDirection` exists on **all three** procedures. It accepts `"incoming"`,
`"outgoing"`, and `"both"`, matched case-insensitively after
`to_ascii_lowercase()`, and defaults to outgoing when the key is absent. Anything else
is "relDirection must be 'incoming', 'outgoing', or 'both'". It sits in the shared
`known` key list and is absent from the multi-source-only list, so no procedure kind
refuses it.
`sourceRef: .scratch/hydradb-src/src/query/path_procedure.rs NativePathDirection at lines 22-27, parsing at lines 141-150, key list at line 186`

The executor honours all three when expanding successors: the outgoing branch reads
out-neighbors (GraphBLAS `compiled_graphblas_out_neighbors`, or
`out_neighbors_in_storage_snapshot`), the incoming branch reads in-neighbors, and
`Both` runs both.
`sourceRef: .scratch/hydradb-src/src/shard/path_procedure.rs native_path_successors, lines 886-995, with the direction guards at 898 and 947`

The ingest still materialises `DEPENDED_ON_BY` next to `RESOLVES_TO`. Frame that
correctly: it is an **index-shape choice, not a workaround for a missing argument.** An
outgoing walk over a stored reverse type reads the forward adjacency; `relDirection:
"incoming"` over the forward type drives the reverse index instead. The two are
different code paths with different costs, and they are not interchangeable on
performance grounds. `scripts/measure-traversal.ts` is what settles which one a given
slice should use.

### Paths arrive fully hydrated

Each path node carries its **complete** label set and its **complete** property map,
not a projection. Each path relationship carries its `id`, edge type, endpoints, and
full property map, with `id` present only when the relationship was written with an
explicit `id` property.
`sourceRef: .scratch/hydradb-src/src/query/algebra.rs QueryPathNode at lines 16-20 and QueryPathRelationship at lines 27-33; hydration at src/shard/path_procedure.rs:675-704`

Consequence: client-side target filtering, path explanation, and grouping all need no
second read, and this is the only way to get a relationship id out of the engine
(section 2.4). It is why `GraphPath` in `src/lib/graph/gateway.ts` carries records
rather than bare ids.

Caveat: full hydration is what the byte budgets meter, so wide nodes on long paths hit
`native_path_cursor_bytes` sooner than node count alone suggests.

## 5. Property indexes

There is no DDL, and none is needed. A vertex property index is maintained
automatically for **every property of every vertex** on each metadata write, alongside
a label index. Selector resolution and the `STARTS WITH` seed both prefix-scan that
index rather than the graph.
`sourceRef: .scratch/hydradb-src/src/shard/query.rs scan_vertex_property_index_at at line 4801, scan_vertex_label_index_current at line 4777`

Section 2.3 is the important consequence: an automatic index only helps a read whose
**pattern** names the property. A WHERE equality on the same property does not reach it.

The reverse adjacency index is controlled by `GraphIndexPolicy`, whose `#[default]` is
`Full`, and `graph-node` sets `Full` unconditionally with no environment override. So
reverse traversal and `BoundInExpand` are index-backed on any server started from the
shipped binary.
`sourceRef: .scratch/hydradb-src/src/core/config.rs GraphIndexPolicy at lines 343-355, and src/bin/graph_node/config.rs:298`

Index-backed reads require the latest epoch. Both index seeds decline when
`read_epoch` is not current, and the engine's own test shows the same `STARTS WITH`
query succeeding at the current epoch and failing with `UnsupportedQuery` at a
historical one. This project never sends `read_epoch` (section 7 forbids it), so it
always reads the latest.
`sourceRef: .scratch/hydradb-src/src/shard/query.rs:3260, and src/tests.rs:11865-11892`

## 6. Budgets

`sourceRef: .scratch/hydradb-src/src/core/config.rs GraphLimits defaults, lines 43-51`

| Limit | Default | Tunable by env |
| --- | --- | --- |
| `max_traversal_hops` | 16 | no |
| `max_query_result_vertices` | 100,000 | no |
| `max_query_intermediate_rows` | 250,000 | no |
| `max_query_index_candidates` | 250,000 | no |
| `max_query_scan_edges` | 1,000,000 | yes, `GRAPH_MAX_QUERY_SCAN_EDGES` |
| `max_query_runtime_ms` | 30,000 | yes, `GRAPH_MAX_QUERY_RUNTIME_MS` |

Only the last two have an environment variable; the other three have no parse call in
`graph-node`'s config and stay at the defaults above.
`sourceRef: .scratch/hydradb-src/src/bin/graph_node/config.rs:240-241`

Every one of these arrives as **429 `resource_exhausted`**, not 400: `AdmissionRejected`
maps to `TOO_MANY_REQUESTS`. A `maxLen` above the hop cap is also a 429. A timeout is
408 `query_timeout`, never 429.
`sourceRef: .scratch/hydradb-src/src/client/http.rs:376-389`

The message carries a stable operation identifier, which is what lets the analysis
layer decide whether to narrow the hop count or the path count:
`native_path_max_len`, `native_path_edges`, `native_path_count`,
`native_path_vertices`, `native_path_candidates`, `native_path_cursor_bytes`,
`native_path_selector_candidates`. A cancellation reports `query_cancelled`.

### Where they bite on a read

| Check | Operation name | Where (`.scratch/hydradb-src/src/shard/query.rs`) |
| --- | --- | --- |
| Label scan candidates | `cypher_vertex_label_index_candidates` | inside the scan loop, `scan_vertex_label_index_current`, lines 4792-4795 |
| Property index candidates | `cypher_vertex_property_prefix_candidates`, `cypher_ordered_vertex_property_candidates` | lines 3292-3295, 940-943 |
| Node pattern candidates | `cypher_node_candidates` | `match_node_row_pattern`, line 3575 |
| Intermediate rows | `cypher_match_group_rows`, `cypher_match_group_pipeline_rows` | `push_binding_row`, line 5346; group loop at line 3109 |
| Edges scanned during expansion | `cypher_edge_neighbor_scan`, `cypher_edge_reverse_neighbor_scan` | lines 3813, 3855 |
| Requested LIMIT | `query_result_limit` | `finish_projected_rows`, lines 4956-4958 |
| Returned rows with no LIMIT | `query_result_rows` | line 4960 |
| Selector candidates on `algo.MSpaths` | `native_path_selector_candidates` | `src/shard/path_procedure.rs:622` |

Two consequences worth stating as rules:

- **`LIMIT` above 100,000 is rejected on sight.** The requested limit is checked against
  `max_query_result_vertices` before truncation, so `LIMIT 100001` is 429
  `resource_exhausted` on its own merits. `ensure_limit` fails only when the actual
  value **exceeds** the limit, so exactly 100,000 passes.
  `sourceRef: .scratch/hydradb-src/src/shard/query.rs:4956-4958, and src/codec.rs ensure_limit at lines 1528-1538`
- **A label scan is rejected above 250,000 labelled nodes regardless of the LIMIT.**
  `ensure_query_index_candidates` runs inside the scan loop, so the cap is hit before
  the LIMIT is ever applied.
  `sourceRef: .scratch/hydradb-src/src/shard/query.rs scan_vertex_label_index_current, lines 4777-4798`

One node metadata fetch happens per candidate row, so a label scan costs one read per
node in the label, not one read per returned row.
`sourceRef: .scratch/hydradb-src/src/shard/query.rs hydrate_binding_metadata, line 4854`

`MemoryGraph` mirrors the 1,000,000 edge expansion budget and returns the same
`query_budget_exceeded` reason, so analysis code cannot pass the fixtures while
relying on behaviour the engine will refuse.

## 7. HTTP query API

Three routes exist on the query port, 8443, and no more:

- `GET /healthz`
- `POST /v1/graphs/{graph_id}/query`
- `POST /v1/graphs/{graph_id}/queries/{query_id}/cancel`

`sourceRef: .scratch/hydradb-src/src/client/http.rs:194-201`

**`EXPLAIN` is unreachable over the wire.** `explain_opencypher_rows` exists but has no
HTTP route and no Bolt entry point; its only callers are the test suite and a bench
example. Plans can only be inferred from the rules in section 2.
`sourceRef: .scratch/hydradb-src/src/shard/query.rs:521, callers at src/tests.rs:7399 and examples/query_bench.rs:361`

Headers: `Authorization: Bearer <token>`, `X-Graph-Namespace: <GRAPH_NAMESPACE>`
(compared for equality), `Content-Type: application/json`.

### Request body

`sourceRef: .scratch/hydradb-src/src/client/http.rs HttpQueryRequestBody, lines 283-302`

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `cell_id` | string | yes | No `serde(default)`, so no server default. Missing means 422. |
| `query` | string | yes | One statement. |
| `query_id` | string | no | Server generates one when absent. |
| `parameters` | map of JSON values | no | **Plain JSON**, see below. |
| `bookmark` | string | no | Opaque, round-tripped from a prior response. |
| `read_epoch` | integer | **never send** | Any value, including 0, is a 400: "read_epoch is not a storage snapshot selector; use bookmark for causal reads". `sourceRef: src/client/http.rs:509-514` |
| `timeout_ms` | integer | no | |
| `page_size` | integer | no | Falls back to the server default. |
| `cursor` | integer | no | A `u64` offset from a prior `next_cursor`, not an opaque token. |
| `consistency` | string | no | `"causal"` or `"strong"`. |

The struct does not deny unknown fields, so a misspelled field name is **ignored**
rather than rejected. A typo in `page_size` silently becomes the server default. Every
field name in `src/lib/hydra/http-transport.ts` is spelled from the source for that
reason.

### Parameters are plain JSON

`parameters` is a `BTreeMap<String, serde_json::Value>`. The engine infers the graph
type from the JSON type: array becomes a list, object becomes a map, a number becomes
an unsigned integer, a signed integer, or a float by fit, and a string becomes a
string. `null` is rejected, as are non-string object keys, and nesting deeper than 16.

The tagged `{"type": ..., "value": ...}` envelope is **response-only**. Sending it as
a parameter would be read as a two-key map with the fields `type` and `value`.

A correct batch body:

```json
{
  "cell_id": "cell-0",
  "query": "UNWIND $rows AS row MERGE (n {id: row.vertex}) SET n:Package, n.key = row.key",
  "parameters": {
    "rows": [
      {"vertex": 7, "key": "npm:chalk"},
      {"vertex": 8, "key": "npm:debug"}
    ]
  }
}
```

The parameter name is looked up both with and without the `$` sigil, so `"rows"` and
`"$rows"` both resolve. This project sends `"rows"`, the primary lookup.

### Response values are tagged

Cells arrive as `{"type": "vertex_id", "value": 42}`. The tag set is exactly `null`,
`vertex_id`, `integer`, `signed_integer`, `float`, `boolean`, `string`, `list`, `path`.
`sourceRef: .scratch/hydradb-src/src/client/http.rs HttpQueryValue, lines 314-326`

`src/lib/hydra/wire.ts` decodes these and rejects any integer outside
`Number.MAX_SAFE_INTEGER` rather than rounding it, because a rounded node id points at
a different package.

### Errors

```json
{"error": {"code": "resource_exhausted", "message": "..."}}
```

A 421 adds `owner` inside `error`, naming the node that owns the write.

| Status | `code` | Cause |
| --- | --- | --- |
| 400 | `invalid_request` | Parse failure, unsupported query, missing parameter, scope mismatch, and every `UNWIND` shape or missing-row-field error |
| 400 | `invalid_parameter` | A parameter value that cannot be encoded |
| 400 | `missing_namespace` | `X-Graph-Namespace` absent |
| 401 | `unauthenticated` | Missing, non-bearer, or wrong token |
| 403 | `permission_denied` | Authenticated but outside the granted scope |
| 408 | `query_timeout` | Timeout, including client cancellation |
| 421 | `not_cell_writer` | Write sent to the wrong node |
| 429 | `resource_exhausted` | Any budget rejection |
| 500 | `internal` | Message flattened to "internal query execution error" |
| 503 | `routing_unavailable` | Routing not ready |

A malformed batch, a rejected `count(n)`, and a rejected `edge.id` column are all 400
`invalid_request`, so they are distinguishable only by reading `message`.

Body cap: 1 MiB by default, which bounds how many rows one batch can carry over HTTP.
`graph-node` does not override it.
`sourceRef: .scratch/hydradb-src/src/client/http.rs DEFAULT_HTTP_MAX_BODY_BYTES at line 33, applied at line 201`

## 8. Bolt

Port 7687. The server offers `[(5,4), (5,3), (5,2), (5,1)]` and picks the best
mutually supported version from the client's proposal list. A driver offering 5.8
through 5.4 lands on 5.4. A driver that has dropped 5.4 entirely fails the handshake.
`sourceRef: .scratch/hydradb-src/src/client/bolt.rs BOLT_SUPPORTED_VERSIONS at line 52`

Auth is basic, and **only the credential is checked**, so the principal is a
placeholder and the token is the password.

Bolt has no request body cap, which makes it the better transport for large ingest
batches. HTTP is nonetheless this project's default, because Bolt's negotiation cannot
be verified without a running server and a silent transport fallback would hide that.

## 9. Running a node

Image `ghcr.io/hydra-db/hydradb:0.1.1`, digest
`sha256:db78309a233be54662db29744047e985a39b51c45a270d1a1f47c31a62cdb709`, an OCI
index covering linux/amd64 and linux/arm64. Entrypoint `/usr/local/bin/graph-node`,
with `graph-indexer` beside it. Runs as `10001:10001`. Exposes 7687, 8443, 9090, 9443.

Verified single-node environment:

```
CLOUD_PROVIDER=local
LOCAL_PATH=/data/store
GRAPH_NAMESPACE=default
GRAPH_ID=default
GRAPH_CELL_ID=cell-0
GRAPH_CELLS=cell-0
GRAPH_NODE_ID=node-0
GRAPH_DATA_PATH=data
GRAPH_DATA_CACHE_DIR=/data/cache
GRAPH_DATA_CACHE_BYTES=67108864
GRAPH_BOLT_ADDR=0.0.0.0:7687
GRAPH_HTTP_ADDR=0.0.0.0:8443
GRAPH_ADMIN_ADDR=0.0.0.0:9090
GRAPH_ADVERTISED_BOLT_ADDR=127.0.0.1:7687
GRAPH_BOLT_NODE_ADDRESSES=node-0=127.0.0.1:7687
GRAPH_AUTH_TOKEN_FILE=/data/auth-token
GRAPH_ALLOW_PLAINTEXT=true
RUST_MIN_STACK=33554432
```

Four things that are easy to get wrong:

1. `RUST_MIN_STACK=33554432` is **not** set by the image or by the Helm chart, despite
   being mandated by the docs. Compose sets it. The reason is parser recursion depth in
   libcypher-parser, which is also why this project caps its OR chains (section 11).
2. `LOCAL_PATH` must already exist. Local mode does not create it.
3. The auth token must be at least 32 characters and must not contain `change-me`.
4. Readiness is `GET /readyz` on the **admin** port, 9090, not the query port. Poll it
   before the first query; this is the step a compose file most often omits.

## 10. Corrections to the build plan

`plan.md` was written before the source was read. Three of its claims are wrong. The
plan is left as the human wrote it; the corrections live here.

1. **"`maxLen` is required on path procedures."** It is optional and defaults to 16.
   `pathCount` is the one that matters more, since it defaults to 1. This project sends
   both explicitly, for the reason in section 4.
2. **"The id map removes the need for a property index."** True for `algo.SSpaths` and
   `algo.SPpaths`, false for `algo.MSpaths`, which selects on a string property and
   cannot take an integer id. Every node therefore carries a `key` property, and it is
   what the selector matches.
3. **"Batch edges need matching endpoint labels."** They do not. One batch creates
   `(s:Service)-[:RESOLVED]->(d:Version)` across two different labels.

`plan.md` section 2 also lists only `algo.SSpaths` and `algo.MSpaths` as the native
traversal surface. `algo.SPpaths` exists as well (section 4) and is the right shape for
"show the path from this compromised version to this service".

## 11. What is still unverified

Stated plainly rather than presented as fact.

- **The accepted value list for `CLOUD_PROVIDER`.** Parsing lives in the SlateDB
  dependency, outside the tree that was read. `local` is verified working.
- **The exact Bolt wire behaviour when a driver proposes a version range.** Negotiation
  is delegated to an external crate. What is verified is the offered set and that 5.4 is
  the maximum.
- **Whether `neo4j-driver` 6.2.0 still offers Bolt 5.4.** If it does not, the Bolt
  transport fails its handshake and reports `graph_unavailable`; HTTP is unaffected.
- **Whether the parser accepts `range` or `key` as a property name or an alias.** The
  RETURN lowering takes an alias verbatim with no keyword check, and neither word is a
  reserved word in the Cypher spec, but libcypher-parser's own keyword table is in the
  external C library and is not in the vendored tree. This project uses `version_range`
  for the dependency range as a precaution and does use `key` as an alias, so the `key`
  case is the one a live server should settle first.
  `sourceRef: .scratch/hydradb-src/src/query/opencypher.rs:2270-2277 takes the alias without validating it`
- **How deep an OR chain the parser tolerates.** `HydraGateway.READ_CHUNK_SIZE` is 256,
  so `buildReadNodesStatement` can emit 256 OR terms, which lower to a right-nested
  `RowPredicate::Or` of the same depth and are re-walked per candidate row. No depth or
  statement-length limit exists anywhere in `src/query/opencypher.rs` or
  `src/core/config.rs`, so the ceiling is whatever recursion libcypher-parser and the
  lowering survive. That library is an external C dependency and is not in the vendored
  tree, so the limit cannot be read. `RUST_MIN_STACK=33554432` is mandated for the
  server precisely because of parser recursion depth (section 9). A chunk size in the
  low hundreds is the conservative choice until a live server settles it.
- **The real cost of the `count(*)` label scan on a production-sized label.** The code
  path is verified; the number of nodes at which it exceeds the 30 second runtime limit
  rather than the 250,000 candidate cap is not.
- **Property-to-property comparison in a WHERE.** The code path is verified to lower and
  execute (section 2.5), but no upstream test covers it, so it has not been observed
  running against a real server.

### Answered and removed

- **"Whether `count(n)` is accepted."** Settled: it is not, at parse time, and the
  request answers 400. `count(*)` and `count(n.id)` are the accepted forms. Section 2.4
  carries the reference.
- **"Whether the path procedures take a direction."** Settled: `relDirection` exists on
  all three, takes `"incoming"`, `"outgoing"`, or `"both"` case-insensitively, and
  defaults to outgoing. Section 4 carries the reference.
