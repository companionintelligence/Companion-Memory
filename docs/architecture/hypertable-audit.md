# Partitioning audit: every hypertable in the schema

> Status: **accepted; remediation landed.** Re-verified against `main` on
> 2026-08-19: all three remediation migrations are in the tree —
> `20260807071631_departition_position.sql`,
> `20260807072056_departition_user_snapshots.sql` and
> `20260807072321_dehypertable_communications.sql` — and the rule is written down
> as [ADR-0002](adr/0002-timescaledb-hypertable-criteria.md). Workstream steps
> 1, 3, 4, 5 and 7 are done, step 2 is decided-as-no, and only step 6 remains
> open (and see the note under it: the table it concerns was never created).
>
> **[2026-08-26] `ci.user_snapshots` is gone, not retained.** This audit called it
> the table with "the strongest unrealised retention argument". The follow-up
> found the reason retention was never worth arguing about: the table had no
> `SELECT` anywhere in the repo, and its ingest mutation
> (`ingestUserSnapshot`) had no caller in any repo — nor could it, since its
> `JwtAuthGuard` 401s the api-key/Portal-OIDC credentials CI-Capture presents,
> and CI-Capture's supported lane POSTs the same payload to `/v1/events`
> instead. Dropped in `20260826202515_retire_user_snapshots`, which settles the
> retention question the only way it can be settled for a dataset with no
> consumer. **Two** surviving hypertables now: `ci.position` and
> `hbpe.prediction_log`. Everything below is the pre-2026-08-26 state.
>
> Supersedes and merges the earlier
> `COMMUNICATIONS-HYPERTABLE-CASE.md`. Originally written against main as of
> 2026-08-05; reconciled against main as of 2026-08-07 — the deltas found are
> flagged inline with **[2026-08-07]**. The body below is left in its
> pre-remediation voice on purpose: it is the argument, and the argument is what
> ADR-0002 rests on.
>
> Audits every `create_hypertable` call in the migration history in both
> directions: hypertables that should not exist, and tables that arguably should
> be partitioned but are not. Establishes the criteria for future decisions.
>
> **Method note.** Derived entirely from committed migrations and `git log`,
> replayed chronologically. No live database was consulted. Table lifecycle,
> authorship, and SQL are **fact**; row counts, sizes, and chunk counts are
> **estimates**, deliberately generous to the hypertable. Verification queries
> are at the end.

## Verdict

Twelve `create_hypertable` calls exist in the history. **Four survive.**

| | Count |
|---|---|
| Hypertables created | 12 |
| Whose table was later **dropped entirely** | 7 |
| **De-partitioned**, table kept | 1 |
| **Surviving** | **4** |

Of the four survivors: **one is correct, two are right tables with wrong
configuration, and one is actively causing data corruption.**

> **[2026-08-19] All three defects are now fixed.** `ci.position` and
> `ci.user_snapshots` are time-only hypertables (space partition dropped);
> `ci.communications` is a plain table with the provenance triple enforced
> directly and `ci.communications_source_dedup` retired. That leaves **three**
> surviving hypertables — `ci.position`, `ci.user_snapshots`,
> `hbpe.prediction_log` — and one more de-partitioned table. The counts in the
> table above are the 2026-08-05 snapshot and are left as written.

Separately: **exactly one retention policy exists in the entire schema.**
Retention is the strongest reason to reach for TimescaleDB, and 11 of 12
hypertables never used it. Six of the nine compression policies ever written are
attached to tables that no longer exist.

**Recommended actions, in value-to-risk order, detailed at the end:** drop the
space partition from `position` and `user_snapshots`, add retention to both,
de-hypertable `communications`, then write the rule down.

## Timeline

From `git log`, because the history answers most of the "why" this document
would otherwise guess at.

| Date | Who | What |
|---|---|---|
| 2025-09-26 | MLTQ | `communications` created as a hypertable (`cut2`), with six siblings in one batch |
| 2025-10-09 | MLTQ | `browser_activity` + `screen_captures` created as hypertables |
| 2025-11-21 | Kyle Baran | Adds `id UUID` to `browser_activity`. File is named `add_id_as_pk` but declares **no primary key** — it could not, on a hypertable |
| **2026-01-04** | **Steven Berry** | **De-partitions `browser_activity`.** `PRIMARY KEY (id)` lands here, six weeks after the column |
| 2026-06-23 | Liam Broza | **One commit** (`d5136a777`, #1531) adds a provenance triple to both `browser_activity` and `communications`. Clean key on the former, `time` forced into the latter |
| 2026-06-24 | Liam Broza | Surrogate-id PK for `communications`; the old `(time, user_id, communication_type)` PK was rejecting distinct messages that shared a timestamp |
| 2026-06-28 | Liam Broza | `ci.communications_source_dedup`, after 35,018 duplicate rows. PR #1593: *"move communications dedup off the hypertable so re-imports stay idempotent"* |
| 2026-07-01 | Steven Berry | Reissues that migration to resolve a version collision |
| 2026-07-06 | Liam Broza | **[2026-08-07]** Provenance triple lands on `ci.position` too (`20260707045911`, #1672). The index is **deliberately non-unique** — the migration's own comment: *"uniqueness on a hypertable would have to include the partition key (time)"* — and same-second distinct fixes collapsing into one row is written off as a *"documented limitation"* |

Nobody has defended the hypertable. Two engineers independently routed around it,
and one already removed a hypertable from the same batch for exactly this reason.
The 2026-07-06 position migration makes it a third routing-around: the same Gate 1
restriction forced the position triple to give up uniqueness entirely.

The original decision reads as fast platform scaffolding rather than per-table
judgement: seven tables hypertabled in one September sitting with identical
`(time-ish, user_id, 4)` parameters, and seven of the twelve eventually deleted.

## When a hypertable earns its keep

The criteria. This argument is against a misapplication, not against TimescaleDB.

### Disqualifying gates

**Gate 1 — no natural uniqueness requirement.** Structural, not a tradeoff. Every
unique index on a hypertable must contain every partitioning column. If the table
needs `UNIQUE(natural_key)`, it cannot be a hypertable. Full stop.

**Gate 2 — nothing needs a foreign key pointing *into* it.** FKs out to regular
tables are fine. References in are awkward at best and unsound once chunks drop.

### Affirmative gates

**Gate 3 — retention or downsampling is a real requirement.** The strongest
positive reason. Dropping a chunk is O(1) metadata; `DELETE ... WHERE time < x`
over millions of rows is not. If nothing ages out, the biggest win is unavailable
by definition.

**Gate 4 — writes are machine-generated.** Rule of thumb ≥10⁴ rows/day/user.
Sensors and inference loops clear this. Humans do not.

**Gate 5 — reads are dominated by time-range scans.** Chunk exclusion is the
mechanism. If hot queries are point lookups on a non-time key, partitioning does
not merely fail to help, it multiplies every lookup by the chunk count.

**Gate 6 — plausibly exceeds ~50–100 GB.** Below that a plain B-tree in
`shared_buffers` wins on every axis.

**A table must clear Gates 1 and 2, then at least Gate 3, or both 4 and 5.**

### Two configuration rules

**Never use space partitioning in this schema.** The `number_partitions` argument
spreads a large tenant population across I/O paths. CI-Server is an appliance for
**one person, or at most a family** — 1 to 5 users. Hashing 1–5 values into 4
buckets leaves buckets permanently empty and multiplies chunk count by four for
no possible upside.

**`chunk_time_interval` must match the data's time span, not the wall clock.** The
7-day default assumes a table accumulating forward from today. A table backfilled
with 25 years of imported history gets ~1,300 chunks on day one.

### The worked example: `hbpe.prediction_log`

```sql
CREATE TABLE hbpe.prediction_log (... PRIMARY KEY (id, predicted_at));
SELECT create_hypertable('hbpe.prediction_log', 'predicted_at');
SELECT add_retention_policy('hbpe.prediction_log', INTERVAL '90 days', if_not_exists => true);
```

Passes every gate: surrogate PK only (1), nothing references a forecast row (2),
a real 90-day retention policy (3) — **the only one in the schema** — machine
generated (4), read as time windows for accuracy scoring (5).

And it **omits the space partition**. Compare
`create_hypertable('hbpe.prediction_log', 'predicted_at')` with
`create_hypertable('communications', 'time', 'user_id', 4)`. It is the newest
hypertable in the history; the lesson had been learned, it just never propagated
backwards.

## The four survivors

| Table | Partition | Retention | Verdict |
|---|---|---|---|
| `hbpe.prediction_log` | `predicted_at` only | **90 days** | ✅ Correct. Leave alone. |
| `ci.position` | `time`, `user_id`, 4 | none | ⚠️ Keep, drop space partition, add retention |
| `ci.user_snapshots` | `observed_at`, `user_id`, 4 | none | ⚠️ Keep, drop space partition, add retention |
| `ci.communications` | `time`, `user_id`, 4 | none | ❌ Remove |

### ⚠️ `ci.position` — right table, wrong configuration

GPS traces are the genuine article: continuous machine sampling, ≥10⁴ rows/day,
read as time ranges, no natural uniqueness requirement. Gates 1, 2, 4, 5 pass.
Partitioning is justified.

The 4-way `user_id` space partition is pure overhead, and there is no retention
or downsampling policy, only compression at 7 days. GPS is the textbook
downsampling candidate — full resolution recent, thinned after a year. **Gate 3
is available here and unused**, which leaves the main benefit on the table.

**[2026-08-07]** Since this was written, `position` also acquired the provenance
triple (`20260707045911`) — with a **non-unique** index, because Gate 1 made the
real key impossible. The importer maps same-triple re-sends onto existing rows in
application code instead: the same enforced-by-convention drift the
`communications` section below documents. The rebuild keeps the triple columns
and index; once the space partition is gone the index stays non-unique anyway
(the `(time, user_id)` PK already collapses same-second fixes, which the
migration records as the operative limitation).

### ⚠️ `ci.user_snapshots` — right table, wrong configuration

Device capture: `monotonic_ms`, `focus_app`, `fs_event_count`,
`snapshot`/`patch`. Machine-generated at high rate. Gates 1, 2, 4, 5 pass, and it
carries a thoughtful `compress_segmentby = 'user_id, device_id, producer,
snapshot_kind'`.

Same two issues. Of every table in the schema this has the **strongest
unrealised retention argument** — it is disposable telemetry kept forever.

## ❌ The `communications` case

### It already corrupted data

From `20260702012519_communications_source_dedup_table.sql`:

> `communications_source_triple_uniq` HAD to include `time` because
> `ci.communications` is a TimescaleDB hypertable [...] and TimescaleDB
> hard-rejects UNIQUE indexes that don't cover every partition column [...]
> **two import sweeps days apart minted two communications rows for the same
> provenance triple (27,700 dup imessage rows, 7,318 dup google_voice rows on a
> real local DB). Every future re-import would mint another generation.**

**35,018 duplicate rows.** The correct idempotency key is the provenance triple.
Gate 1 forbade it, `time` was smuggled in, `time` proved unstable across
re-syncs, and the guarantee collapsed.

### The controlled experiment

We ran the A/B by accident. On 2026-06-23 Liam Broza added a provenance triple to
two tables for the same reason **in a single commit** (`d5136a777`, #1531). The
only variable that differs is whether the table was still partitioned.

`20260623120200` — `browser_activity`, **de-partitioned**:
```sql
-- The table was departitioned (PK on id), so a plain partial unique index applies.
CREATE UNIQUE INDEX browser_activity_source_triple_uniq
  ON ci.browser_activity (user_id, source_type, source_system, source_id)
  WHERE source_id IS NOT NULL;
```

`20260623120100` — `communications`, **still a hypertable**:
```sql
-- ...so every UNIQUE index MUST include both partitioning columns.
CREATE UNIQUE INDEX communications_source_triple_uniq
  ON ci.communications (user_id, time, source_type, source_system, source_id)
  WHERE source_id IS NOT NULL;
```

| | `browser_activity` | `communications` |
|---|---|---|
| Unique key | clean triple | `time` forced in |
| Single-column `id` PK possible | yes | no |
| Duplicate rows produced | none | **35,018** |
| Companion cleanup table | none | `ci.communications_source_dedup` |

Nine days later the companion table existed. `browser_activity` has needed
nothing since.

`browser_activity` is the closest structural analogue to `communications` in the
schema: a human-driven activity stream that superficially looks like telemetry.
It got fixed. **`communications` is the same call left unmade.**

### Workarounds still in the tree

1. `ci.communications_source_dedup` — a table whose only job is holding the
   uniqueness invariant the hypertable rejected.
2. A **soft, application-maintained** pointer back to the communication, because
   "Hypertable FKs are awkward (the PK is composite `(time, user_id, id)` and
   chunk drops would cascade here)."
3. The surrogate-PK rewrite. The original PK "forbids two DISTINCT messages that
   share a timestamp + type — rampant in bulk chat history (~7% of imessage, ~3%
   of google_voice rows in a real export)."
4. `communications_source_triple_uniq`, still carrying a `time` column.

Items 1 and 2 are **constraints enforced by application convention instead of by
the database** — precisely the failure mode the entity-model refactor exists to
eliminate.

### It fails the gates on scale too

Even setting Gate 1 aside, the affirmative case is absent.

**Row count.** A very heavy digital user generates ~500 rows/day across email,
SMS, chat, and calls. Against 25 years of complete archives that is ~4.6M rows;
realistically ~1.8M; typically ~500K. **A family of five heavy users with full
25-year archives lands near 9M rows.**

**Size.** `content_embedding vector(768)` was dropped in `20260213113000`, which
removed the single biggest factor. What remains is ~300 bytes of heap plus TOASTed
and compressed body text, call it ~1.2 KB/row. **1M rows ≈ 1.5 GB; 10M ≈ 14 GB.**
Against a 50–100 GB threshold, even the family worst case is an order of
magnitude short.

**Chunk count.** `create_hypertable('communications', 'time', 'user_id', 4)`
passes no interval, so it takes the 7-day default:

```
25 years × 52 weeks              = 1,300 time chunks
1,300 × 4 space partitions       = 5,200 chunks
1,000,000 rows / 5,200 chunks    ≈ 190 rows per chunk
```

Chunks are meant to hold millions. At ~190 rows, per-chunk overhead dominates the
data by orders of magnitude. With 7 indexes that is ~36,400 index relations,
roughly 290 MB of scaffolding around ~1 GB of data. A query that cannot exclude
chunks takes an `AccessShareLock` on every one, risking outright failure with
`out of shared memory / You might need to increase max_locks_per_transaction`.

**Gate 5 fails on the indexes themselves:**

| Index | Leading column | Can exclude chunks? |
|---|---|---|
| `communications_thread_idx` | `thread_id` | No |
| `communications_from_idx` | `from_entity_id` | No |
| `communications_to_idx` (GIN) | `to_entity_ids` | No |
| `communications_category_idx` | `category` | No |
| `communications_source_triple_uniq` | `user_id, time` | Partially |
| `communications_user_id_time_idx` | `user_id, time` | Yes |

Four of six are point lookups on non-partition keys, each fanning out across all
5,200 chunks. **The hypertable makes the dominant query shapes dramatically more
expensive in exchange for chunk exclusion on a shape that barely appears.**

**Gate 3 fails outright:** there is no retention policy on communications. It is a
personal archive; you never delete. Meanwhile the 30-day compression policy is in
direct tension with the field-level audit trail described in
ENTITY-INHERITANCE-MATRIX.md.

### Conversion

Reuse `20260104075933_departition_browser_activity.sql`, which did exactly this:

0. **Precondition — see "The trigger problem" below.** Capture whatever triggers
   exist on the live table and land them as migrations *first*. The template
   below ends in `DROP TABLE`, which takes every trigger with it and recreates
   none.
1. Rename `ci.communications` aside; rename its constraints to free the names.
2. Create a plain `ci.communications` with `PRIMARY KEY (id)`.
3. `INSERT ... SELECT`. At ~1.5 GB, minutes.
4. Add the real key:
   `UNIQUE (user_id, source_type, source_system, source_id) WHERE source_id IS NOT NULL` — no `time`.
5. Drop the old table.
6. Drop `ci.communications_source_dedup` and the code maintaining its soft
   pointer. `CommunicationService.createMany` reverts to a plain `ON CONFLICT`.
7. Keep `communications_user_id_time_idx`; it covers the time-range queries.
   Note the browser_activity template **recreated no secondary indexes at all**,
   only the PK and the check constraints. Enumerate the ones on communications
   explicitly rather than trusting the template; `backend/apps/summary` queries
   the table by `(user_id, time)` (`insight_aggregator.py:303`) and would fall
   to a seq scan on the largest table in the schema.

`Communication` then joins the entity model as a normal CTI detail table.

### The trigger problem

`backend/apps/hbpe/src/ci/pipeline/ingester.py:36` listens on three PostgreSQL
channels:

```python
CHANNELS = ("ci_events", "ci_browser_activity", "ci_communications")
```

**There is no `pg_notify` anywhere in this repository.** Not in the migrations,
not in the TypeScript. The entire migration history contains two `CREATE TRIGGER`
statements and neither is a notify. So those triggers were either applied by hand
to live databases, or they never existed and HBPE's live-ingest path has never
fired.

**[2026-08-07] The severity is lower than the paragraph below implies.** The
ingester anticipates exactly this: its own comment reads *"Push-based NOTIFY (if
producers are installed) gives instant invalidation; this slower poll guarantees
the cache still refreshes even where no NOTIFY trigger exists yet"*, and it runs
a 30-second safety poll of `hbpe.token_stream` alongside the LISTEN loop
(`ingester.py`, `SAFETY_POLL_SEC`). Missing triggers therefore cost up to ~30s of
invalidation latency, not silent permanent staleness. The concerns that remain
real: (a) if hand-applied triggers exist on a live appliance, the DB holds state
no migration reconstructs, and (b) the LISTEN path has plausibly never fired.

**[2026-08-07] Decision: no notify triggers, ever.** The LISTEN/NOTIFY layer was
patterned from the ML side, but CI-Server already has an application event
system (EventService → PGBoss) that is the preferred, traceable architecture for
exactly this. Rather than landing triggers as migrations, the resolution is the
opposite: the repository stays trigger-free by design, HBPE's live ingest rides
the safety poll until its invalidation is driven through the event system, and
the dormant LISTEN path in `ingester.py` should be retired with that move. Any
hand-applied notify trigger found on a live appliance is unsanctioned state and
should be dropped.

If hand-applied triggers are real, the live database holds state that no
migration can reconstruct, which means a rebuilt appliance behaves differently
from an existing one and nothing reports the difference.

It also means the browser_activity precedent may already have caused this gap.
That migration dropped the original table. If a `ci_browser_activity` trigger
existed on it, it died in January 2026 and no migration has recreated one. HBPE
would still be listening on a channel nobody publishes to, with no error on
either side — served by the safety poll alone.

The live-trigger inventory query is in "Verification before acting". It remains
worth running on a real appliance before deploy, but with repo-owned triggers
landing as migrations it verifies convergence rather than blocking the
communications migration.

## Already resolved

**`ci.browser_activity`** — hypertable in `20251012000000`, de-partitioned in
`20260104075933`. One-way, no `migrate:down`, **no recorded rationale** at the
time. The rationale showed up later, in the outcome (see the controlled
experiment above).

Two things that migration did not carry across, worth knowing before it is reused
as a template: it recreated no secondary indexes, and it recreated no triggers.
HBPE still listens on `ci_browser_activity`. See "The trigger problem" above.

## Dropped with their tables (7)

Not mistakes to fix, but evidence about how the original decision was made. All
created in the same September 2025 batch, all `(time-ish, user_id, 4)`, all but
one with a compression policy, all deleted within months.

| Table | Hypertabled | Dropped |
|---|---|---|
| `ci.event_history` | `20250925150600` | `20251006113900` |
| `ci.measurements` | `20250925150800` | `20260212191500` |
| `ci.activities` | `20250925153000` | `20260212191500` |
| `ci.habit_completions` | `20250925153600` | `20260212191500` |
| `ci.voice_recordings` | `20250925154400` | `20260212191500` |
| `ci.api_logs` | `20250925212830` | `20260225011833` |
| `ci.screen_captures` | `20251012000000` | `20260213131500` |

## The other direction: should anything become one?

Reviewed all 56 surviving tables. **Essentially no**, which is itself the
finding: this is a single-user appliance, and only genuine sensor streams qualify.

### The one live question: `ci.entity_mutations`

> **[2026-08-19] This table does not exist.** No migration creates it and nothing
> references it; the entity-inheritance work landed as class-table inheritance on
> `ci.entities` rather than a mutations log. The gate analysis below is retained
> because it applies verbatim to `ci.graph_deltas`, which *does* exist and is the
> table the last paragraph already redirects to.

The audit table introduced by the entity-inheritance work.

- **Gate 1**: passes. Surrogate `id` PK, no natural key.
- **Gate 2**: passes. Deliberately no FK to the subject, so a `deleted` mutation
  outlives its row.
- **Gate 3**: **the live question.** Does audit history age out?
- **Gate 4**: borderline. Human-rate interactively, but bulk ingest can emit
  millions in one sweep once the bulk audit gap closes.
- **Gate 6**: plausibly the fastest-growing table long-term — one row per write to
  everything else.

**Not yet.** Decide retention first. Unbounded history means leave it plain. If it
ages out, partition on `changed_at` with **no space partition** and an interval
sized to real volume. Same reasoning for `ci.graph_deltas`, which
`entity_mutations` replaces anyway.

### Explicitly do not partition

- **`ci.capture_events`** — carries `UNIQUE (user_id, source_system, source_id)`,
  the exact provenance key Timescale forced off `communications`. **Gate 1
  disqualifies it.** Worth a comment in the migration so nobody tries.
- **`ci_search.embeddings` / `vectors`** — large in bytes, keyed by entity, read
  by similarity. Gate 5 fails.
- **`ci.events`, `ci.content`, `ci.messages`, `ci.summaries`** — human-rate,
  point-lookup, FK targets. Gates 2, 4, 5 fail.
- **`hbpe.token_stream`** — sounds high-volume, is not: ~48 buckets/day/user
  across a few levels. Gate 4 fails by two orders.
- Everything else is reference, config, or join tables.

## Workstream

1. **Drop the space partition from `ci.position` and `ci.user_snapshots`.**
   Requires rename/copy/swap. Cuts chunk count 4× on both, no possible downside
   at 1–5 users. **No argument required; start here.**
   *[2026-08-07] Implemented on this branch.*
2. **Add retention or downsampling to both.** Pure addition, no rewrite. Converts
   them from "partitioned for no benefit" to "partitioned for the right reason."
   Needs a product decision on how long GPS traces and device telemetry are worth
   keeping. *[2026-08-07] Decided: keep both forever for now — no retention
   policy lands. Location history is core product data, and snapshots stay
   until a downsampling design (coarse rollup first, then raw drops) is done
   as its own workstream. Compression still bounds both. This leaves Gate 3
   unexercised on purpose; the partitioning survives on Gates 4 + 5.*
3. **Audit `chunk_time_interval` on all survivors.** Every one takes the 7-day
   default, wrong for anything backfilled with history.
   *[2026-08-07] Folded into step 1's rebuilds: `position` gets a 1-month
   interval (25 years of backfilled GPS ≈ 300 chunks instead of ~1,300);
   `user_snapshots` keeps 7 days explicitly (forward-accumulating telemetry,
   the default is right there and is now stated rather than inherited).*
4. **Capture the live triggers and land them as migrations.** *[2026-08-07]
   Rejected in favor of the event system. The notify layer is a side channel
   patterned from the ML side; CI-Server's EventService → PGBoss pipeline is the
   traceable, preferred architecture for driving HBPE invalidation. No triggers
   land; HBPE's safety poll carries live ingest until that wiring exists, and
   the dormant LISTEN path in `ingester.py` should be retired with it. See "The
   trigger problem". Hand-applied triggers found on a live appliance are
   unsanctioned and should be dropped.*
5. **De-hypertable `ci.communications`.** The only step with a real data
   migration and real code churn. *[2026-08-07] Implemented on this branch:
   plain table with `PRIMARY KEY (id)`, the clean provenance unique index,
   `communications_source_dedup` dropped, `createMany` back on the shared
   `bulkInsertIdempotent` path.*
6. **Decide `ci.entity_mutations` retention**, then revisit. Note that
   `ci.graph_deltas`, which `entity_mutations` is meant to replace, has an
   out-of-band Python consumer; see ENTITY-INHERITANCE-MATRIX.md before
   assuming it can simply be retired.
   *[2026-08-19] Moot for now: **`ci.entity_mutations` was never created** — no
   migration and no code reference it, so there is no retention to decide. The
   entity-inheritance work landed as CTI on `ci.entities` instead.
   `ci.graph_deltas` does exist (`20260120150000_create_graph_deltas.sql`) and is
   now written explicitly by `GraphDeltaWriter` after the database triggers that
   briefly wrote it were dropped in `20260811210000_drop_graph_delta_triggers.sql`;
   the summary sidecar reads it as one of its `data_sources_used`. Its retention
   is still undecided, and it is still not a hypertable. `ENTITY-INHERITANCE-MATRIX.md`
   is not in the repo.*
7. **Write the rule down** so the next time-stamped table does not inherit the
   pattern. The gates above are the starting point.
   *[2026-08-07] Implemented as ADR 0002 (`docs/architecture/adr/`).*

## Verification before acting

All estimates here are derived from migration files. Confirm against the live
database:

```sql
-- Do this one first: it is the only item here that can silently break a
-- second service, and the answer is not recoverable from the repository.
SELECT c.relnamespace::regnamespace AS schema, c.relname AS table, t.tgname,
       pg_get_triggerdef(t.oid)
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
WHERE NOT t.tgisinternal
ORDER BY 1, 2;

SELECT * FROM timescaledb_information.hypertables;
SELECT hypertable_name, count(*) FROM timescaledb_information.chunks GROUP BY 1;
SELECT * FROM timescaledb_information.jobs;          -- retention + compression
SELECT relname, seq_scan, idx_scan FROM pg_stat_user_tables ORDER BY seq_scan DESC;
SELECT * FROM pg_stat_user_indexes WHERE idx_scan = 0;
```

The chunk-count query is decisive. If `communications` reports chunks in the
thousands holding hundreds of rows each, the argument is settled.

## What would change my mind

- **Corpus >50M rows.** At 1–5 users that needs ~50× a heavy human sustained for
  decades. A pivot to multi-tenant would also be the first scenario where the
  `user_id` space partition means anything.
- **Time-window analytics dominate** rather than point lookups by thread and
  participant. The index table above contradicts this today.
- **Retention becomes a requirement.** Then chunk drops beat `DELETE` — and the
  correct response is to add a retention policy, which no one has done.
