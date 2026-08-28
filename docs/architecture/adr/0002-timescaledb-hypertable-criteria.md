# ADR-0002: Criteria for Making a Table a TimescaleDB Hypertable

| Field         | Value                    |
|---------------|--------------------------|
| **Status**    | Accepted                 |
| **Date**      | 2026-08-07               |
| **Author(s)** | Steven Berry             |
| **Reviewers** | TBD                      |

## Context

Twelve `create_hypertable` calls exist in the migration history. Seven of those
tables were later dropped entirely, one (`browser_activity`) was de-partitioned,
and of the four survivors only `hbpe.prediction_log` was configured correctly.
`communications` — a hypertable that never met any of the criteria below —
produced 35,018 duplicate rows because TimescaleDB rejects unique indexes that
omit partition columns, which forced the unstable `time` column into the
table's idempotency key. The full postmortem is in the sibling
[hypertable-audit.md](../hypertable-audit.md).

The original decisions were platform scaffolding rather than per-table
judgement: seven tables hypertabled in one sitting with identical
`(time-ish, user_id, 4)` parameters. This ADR is the rule that batch never had.

CI-Server is an appliance for one person, or at most a family — 1 to 5 users.
That context drives every rule here.

## Decision

A table becomes a hypertable only when it clears **both disqualifying gates**,
and then **Gate 3, or both Gates 4 and 5**:

1. **No natural uniqueness requirement.** Every unique index on a hypertable
   must contain every partitioning column. If the table needs
   `UNIQUE(natural_key)` — a provenance triple, an external id — it cannot be
   a hypertable. Structural; not a tradeoff.
2. **Nothing needs a foreign key pointing into it.** FKs out are fine.
   References in are unsound once chunks drop.
3. **Retention or downsampling is a real requirement.** The strongest positive
   reason: dropping a chunk is O(1) metadata, `DELETE ... WHERE time < x` is
   not. If nothing ages out, the biggest win is unavailable by definition.
4. **Writes are machine-generated.** Rule of thumb ≥10⁴ rows/day/user. Sensors
   and inference loops clear this; human activity does not.
5. **Reads are dominated by time-range scans.** Chunk exclusion is the whole
   mechanism. If the hot queries are point lookups on a non-time key,
   partitioning multiplies every lookup by the chunk count instead of helping.

A size floor applies to all of it: below ~50–100 GB a plain B-tree in
`shared_buffers` wins on every axis (Gate 6 in the audit).

Configuration rules for tables that do qualify:

- **Never use space partitioning.** Hashing 1–5 users into N buckets leaves
  buckets permanently empty and multiplies chunk count for no upside. Pass a
  time column only: `create_hypertable('<table>', '<time_col>', ...)`.
- **Set `chunk_time_interval` to match the data's time span.** The 7-day
  default assumes forward accumulation from today; a table backfilled with 25
  years of history gets ~1,300 chunks on day one. Backfilled history wants
  month-scale chunks; forward-accumulating telemetry can keep the default —
  but state it explicitly either way.
- **Pair the table with its retention (or downsampling) policy in the same
  migration** when Gate 3 is the justification. A hypertable without a
  retention policy should make a reviewer ask why it is a hypertable.

The reference specimen is `hbpe.prediction_log`: surrogate PK only, nothing
references a forecast row, a real 90-day retention policy, machine-generated
writes, time-window reads, no space partition.

## Alternatives Considered

### Option A — keep hypertables as the default for time-stamped tables

The September 2025 posture. Not selected because the history is the argument:
7 of 12 hypertables deleted, one de-partitioned, one caused data corruption
through Gate 1, and every space partition ever created was overhead. Time-first
schema does not imply time-series workload.

### Option B — ban TimescaleDB outright

Not selected: genuine sensor streams (`position`, `user_snapshots`,
`prediction_log`) benefit from chunked storage, compression, and cheap
retention. The failure mode was misapplication, not the tool.

## Consequences

- New time-stamped tables default to plain tables. The burden of proof is on
  partitioning, not against it.
- `position` and `user_snapshots` were rebuilt time-only (migrations
  `20260807071631`, `20260807072056`); `communications` was rebuilt as a plain
  table (`20260807072321`). All three used the rename/copy/swap shape — when
  reusing it, recreate the secondary indexes explicitly; the original
  `browser_activity` template recreated none.
- `ci.capture_events` and any table carrying a provenance-triple unique index
  is disqualified by Gate 1 — do not revisit.
- If `ci.entity_mutations` (or a successor audit stream) gets a bounded
  retention decision, it becomes the next candidate to evaluate against these
  gates; unbounded history means it stays plain.

> **Status check, 2026-08-19.** The rule has held: **no new hypertable has been created
> since this ADR**, and the three survivors are exactly `ci.position` (time-only,
> `chunk_time_interval => 1 month`), `ci.user_snapshots` (time-only, 7 days) and
> `hbpe.prediction_log`. `ci.entity_mutations` was never built — the graph audit trail
> is still `ci.graph_deltas`, now written explicitly by `GraphDeltaWriter` after the
> database triggers that briefly wrote it were dropped (`20260811210000`). So the "next
> candidate" above remains hypothetical, and `ci.graph_deltas` stays a plain table with
> no retention policy. The 84 migrations added since — including the whole `ci_import`
> staging schema and the `ci_derived` analytics schema — contain no `create_hypertable`
> call at all.

> **Status check, 2026-08-26.** Two survivors, not three. `ci.user_snapshots` was
> dropped (`20260826202515_retire_user_snapshots`) along with the `user-snapshots`
> domain and the `ingestUserSnapshot` mutation: it passed gates 1, 2, 4 and 5 on the
> shape of its data, but it had **no reader at all** and no reachable writer, which is
> a gate this ADR does not state and should. Read it as a precondition to the five:
> *a table nothing queries does not need a partitioning strategy, it needs deleting.*
