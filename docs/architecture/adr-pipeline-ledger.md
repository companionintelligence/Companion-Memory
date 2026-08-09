# ADR-0004: `ci.pipeline_state` — a Versioned Ledger as the Single Source of Stage Completion

| Field         | Value                          |
|---------------|--------------------------------|
| **Status**    | Accepted                       |
| **Date**      | 2026-08-09                     |
| **Author(s)** | Jobs / data-processing rebuild |
| **Reviewers** | TBD                            |

## Context

Every enrichment leg in CI-Server encoded "has this run?" as a nullability
predicate on the column it writes. Six services, one defect:

| Service | The predicate that both found work and declared it done |
|---|---|
| `SearchIndexBackfillService.missingIds` | `LEFT JOIN ci_search.embeddings e … WHERE e.entity_id IS NULL` (`domains/maintenance/services/SearchIndexBackfillService.ts:389-398`) |
| `GeocodeBatchListener.selectCandidates` | `event.location_coordinates IS NULL` (`domains/geocode/listeners/GeocodeBatchListener.ts:400-403`) |
| `MediaDimensionsBackfillListener` | `file.width IS NULL` |
| `CommunicationLinkBackfillService` | fill-only-NULL guard on `to_entity_ids` |
| `EventParticipantBackfillService` | the same guard, byte-duplicated |
| `LocationEstimateService.candidatePredicate` | `metadata->>'location_source'` absent |

The geocoder states the consequence in its own comment — *"a resolved coordinate
is never re-billed"*. That is the whole bug, admitted: **the first answer an
enricher ever produced is permanent.** A better geocoder, a better embedding
model, a fixed participant matcher applies only to rows that arrive afterwards,
because nothing identifies the existing rows as needing work.

Three facts are conflated into one column, and no amount of care at the call
site separates them:

1. **"never tried"** vs **"tried and legitimately produced nothing."** An
   unreadable image stays `width IS NULL`, so every sweep re-fetches it from
   object storage and re-decodes it, forever, with no record of why it failed.
2. **"processed"** vs **"processed by which version of the code."**
   `ci_search.embeddings` (`db/postgres/migrations/20251210022334_create_embeddings_table.sql`)
   has no `model`, no dimension and no version column. Changing
   `config.embedding.model` mixes two models' vectors in the same 768-dim cosine
   space silently, with no detector; the only remedy shipped was
   `POST /api/maintenance/search-index/truncate`, an all-or-nothing wipe.
3. **"finished"** vs **"nothing left in the queue."** Nothing counts anything, so
   "is my import done?" has no answer. `IngestStatusService` reports the depth of
   one pg-boss queue and `JobMonitorService` reads `pgboss.archive`; neither can
   say whether any particular row was ever processed. That is how `ci.content`
   sat at zero embedded rows without anyone noticing.

The escape hatches those services grew — `retryNull`, `forced`, a truncate
endpoint, `CI_QUEUE_SUPPRESS` read straight off `process.env` and present in no
config file — are all the same workaround for the same missing table.

## Decision

**`ci.pipeline_state` is the single source of truth for stage completion.** It is
keyed on the natural composite `(entity_type, entity_id, stage)` — no surrogate
id, so the primary-key index *is* the index the candidate sweep needs and an
upsert gets its `ON CONFLICT` target for free — and it carries a `stage_version`
integer alongside `status`, `reason`, `attempts` and `next_attempt_at`
(`db/postgres/migrations/20260809032723_create_pipeline_control_plane.sql`).

Candidate selection everywhere becomes one query — THE ONE RULE
(`domains/pipeline/services/PipelineStateService.ts:178-220`):

```sql
SELECT s."<idCol>" AS id
  FROM "<schema>"."<table>" s
  LEFT JOIN ci.pipeline_state p
    ON p.entity_type = $1 AND p.entity_id = s."<idCol>" AND p.stage = $2
 WHERE s."<userCol>" = $3
   AND (<stage applicability predicate>)
   AND ( p.entity_id IS NULL                                    -- never processed
      OR p.stage_version < $4                                   -- enricher improved
      OR (p.status = 'failed' AND p.next_attempt_at <= now()) ) -- retry is due
   AND ($5::uuid IS NULL OR s."<idCol>" > $5::uuid)             -- keyset cursor
 ORDER BY s."<idCol>"
 LIMIT $6;
```

Three rules follow from that shape and are the substance of the decision:

- **A stage's applicability predicate may state only what a row *is*, never
  whether the stage has run.** `variant = 'ORIGINAL' AND deleted_at IS NULL AND
  content_type LIKE 'image/%'` is applicability; `width IS NULL` is completion
  and belongs to the ledger. Anti-joining the stage's *output* table is the same
  ratchet wearing a different hat and is equally forbidden.
- **Bumping an integer in `domains/pipeline/versions.ts` is the re-enrichment
  trigger, and the only one needed.** No backfill script, no `DELETE FROM`, no
  truncate, no `retryNull`, no `forced`. Versions only ever go up, and start at
  1 — a version of 0 would make rows stranded in `status='running'` by a killed
  worker permanently invisible, which is enforced at module load
  (`versions.ts:84-92`).
- **A version may be *derived* rather than hand-chosen where a config value
  already determines the answer.** `EmbedStage` computes its version from
  `(model, dimension)` via an append-only `EMBED_MODEL_GENERATIONS` map, so
  changing `CI_EMBED_MODEL` *is* the re-embed — an incremental, resumable one —
  rather than a silent corruption of the vector space.

`skipped` and `failed` must carry a `reason`, enforced in
`PipelineStateService.assertValidResult` before anything is written. The database
deliberately does **not** enforce it with a `CHECK`: a constraint that can reject
the error path turns a recoverable failure into a lost one.

Four sibling tables make the ledger operable and ship in the same migration:
`ci.pipeline_runs` (one active run per user, via a partial unique index on
`finished_at IS NULL` — a second insert raises `23505`, which means "already
running", not "error"), `ci.pipeline_shards` (keyset cursor + deadline-bounded
lease), `ci.pipeline_dead_letters` (replayable, never expiring) and
`ci.record_rejections` (*their* record failing validation, as distinct from *our*
failure to process a valid one).

Two legs are converted as proof: `enrich.media_dimensions`
(`stages/enrich/MediaDimensionsStage.ts`) and the embed stage
(`stages/index/EmbedStage.ts`). The remaining legs convert one per change, and
`STAGE_IDS` grows by exactly one entry per conversion — declaring the planned
roadmap up front would make `GET /api/pipeline/state` report a dozen stages at
0 % coverage that no code can advance.

## Alternatives Considered

### Option A — a `processed_at` / `<stage>_done` column per stage on each source table

The smallest-looking change: keep the existing sweep shape, just stop overloading
the output column.

Not selected because it is the same ratchet with more columns. A timestamp still
cannot say *which version of the enricher* wrote it, so improving a geocoder
still cannot identify the rows to repair — the only way to re-run is `UPDATE …
SET geocoded_at = NULL`, which is a hand-written destructive statement per
incident, i.e. exactly the truncate endpoint that already exists. It also costs a
migration on a large table per stage (23 stage ids are planned in
`docs/jobs-system-rebuild-plan.md` §4.2), spreads completion state across every
domain's schema so nothing can answer "which stages are behind?" in one query,
and has no place to put `attempts`, `next_attempt_at` or a skip reason without
adding those columns too.

### Option B — read completion out of pg-boss job history

pg-boss already records that a job for an entity ran and succeeded. Query
`pgboss.job` / `pgboss.archive` instead of adding a table.

Not selected for two independent reasons, the first fatal on its own:

- **Job history is not keyed by entity.** The archived column set is
  `id, name, priority, data, state, retry_*, start_after, started_on,
  singleton_key, singleton_on, expire_in, created_on, completed_on, keep_until,
  dead_letter, policy, output` (pg-boss 10.3.2, `src/plans.js:920-936`). The
  entity is buried inside the `data` JSONB — and after this branch's slice
  refactor a single job carries up to `MAX_SLICE_SIZE` = 1000 ids, so "did entity
  X complete?" is not answerable even by digging into the payload. There is no
  version at all.
- **Retention is short, and it is a queue's concern rather than a ledger's.**
  Read out of the vendored pg-boss 10.3.2 source rather than the docs:
  completed jobs move from `pgboss.job` to `pgboss.archive` after
  `ARCHIVE_DEFAULT = 60*60*12` — 12 hours (`src/attorney.js:198-206`,
  `src/plans.js:920-936`) — and archive rows are then deleted on the
  `deleteAfter` interval (`src/boss.js:26` → `src/plans.js:913-918`, `DELETE
  FROM pgboss.archive WHERE archived_on < now() - interval …`). This repo passes
  `deleteAfterHours: 24` (`domains/events/services/PGBossEventService.ts:82`),
  which **is** honoured on v10: `applyDeleteConfig` runs on the constructor
  config and accepts that spelling (`src/attorney.js:167`, `:312-336`). So this
  appliance's job history is gone in roughly 36 hours.

  This corrects `docs/jobs-system-rebuild-plan.md` §14.2 item 7, which records
  `deleteAfterHours` as an inert v9 name and retention as "v10's 14-day
  default". The 14 days is real but is a different thing: `keep_until` defaults
  to `now() + interval '14 days'` (`src/plans.js:195`) and the archive sweep
  applies it only to jobs *still in a pre-active state* — `OR (state < 'active'
  AND keep_until < now())` (`src/plans.js:928`). It is a TTL on unstarted work,
  not history retention on completed work. Either way the conclusion is
  unchanged, and stronger: tuning these upward would make the queue's hot table
  carry the corpus's permanent history — the wrong table doing the wrong job,
  with `pgboss.job` already the most contended relation on the box.

### Option C — a dedicated "reprocess" queue per re-run

When an enricher improves, enqueue a re-run and let the workers churn.

Not selected because it answers the wrong question. A queue can express *"run
this again"* but not *"which rows are stale"* — so the only implementable
version is re-run **everything**, every time, with no way to stop halfway, no way
to tell a completed re-run from an abandoned one, and no way to exclude the rows
a stage legitimately skipped. On the shared-Ollama appliance (§ Consequences)
that is the difference between a targeted pass and hours of contended inference.
It also cannot express the retry arm: a transient failure and a permanent one
look identical to a queue.

### Option D — Temporal-style durable workflow state

Model each entity's journey as a durable workflow and let the engine own
completion, retries and resumption.

Not selected because main has just removed Temporal — PR #1904
(`c984f5613 feat(jobs): replace Temporal with pg-boss as the single scheduler`)
consolidated on pg-boss crons that `POST /functions/run`, with completion
arriving by webhook against a `DEFERRED` job. Adding a second durable execution
engine to a single-household appliance one week after deleting the first is the
opposite direction of travel, and the operational surface (a separate server, its
own datastore, its own upgrade path) is not something a household appliance can
carry. The durable state the pipeline actually needs is five Postgres tables in
the same transactional store as the data — which is what this ADR adopts.

## Consequences

### What this buys

- Improving an enricher repairs history. One integer, one commit, in the same
  diff as the code that justifies it.
- "Tried and produced nothing" becomes a stated outcome (`skipped` +
  `reason='probe_failed'`) instead of permanent churn. The old
  media-dimensions leg re-fetched and re-decoded every unreadable file on every
  sweep, forever.
- Changing `CI_EMBED_MODEL` becomes an observable, resumable re-embed instead of
  a silently mixed vector space.
- "Is my import finished?" is answerable — `PipelineStateService.coverage()` —
  with the deliberate caveat that `total` means "rows this stage has recorded an
  opinion about", not "rows that exist". Eligibility needs the source table, and
  quoting coverage as a completion percentage without an eligible-row count
  beside it would be the same unearned confidence this subsystem replaces.
- A crash costs one slice. Slices are `DEFAULT_SLICE_SIZE` = 200 ids and the
  claim lease is 15 minutes; everything already completed survives in the ledger.

### What it costs — honestly

- **The ledger is O(subjects × applicable stages) rows.** A representative tuple
  measures 120 bytes via `pg_column_size` on the appliance's Postgres 18.4
  (136 with a `reason`); with the line pointer and the primary-key entry, call it
  ~200 B per row all-in — an estimate, not a measurement. The corpus on this
  worktree's dev database is currently empty (every `ci.*` table measured at 0
  rows), so steady-state size here is **unmeasured**. Against the 881 k-row
  corpus cited in `docs/jobs-system-rebuild-plan.md:1449` and the 23 planned
  stage ids, the arithmetic upper bound is ~20 M rows ≈ 4 GB of heap before
  indexes, and `ci.pipeline_state` carries two secondary indexes on top of its
  primary key. The real figure is materially lower — most stages apply to one
  entity type, and `enrich.media_dimensions` applies only to image/video
  originals in `ci.files` — but the growth is real and nothing prunes it.
- **The LEFT JOIN is a per-source-row primary-key probe that is *not*
  index-only.** The PK `(entity_type, entity_id, stage)` covers the join keys,
  but the staleness predicate reads `stage_version`, `status` and
  `next_attempt_at`, none of which are in any index — so every matched row costs
  a heap fetch. An `INCLUDE` on those three would make it index-only, and adding
  it later is not free: dbmate wraps each migration in a transaction, where
  `CREATE INDEX CONCURRENTLY` is illegal, so a post-hoc index on a large
  `ci.pipeline_state` is either a blocking build with the appliance down or an
  out-of-band operation outside the migration system. Keeping this join fast on
  `ci.files`, `ci.events` and `ci.communications` is a standing obligation, not a
  solved problem.
- **Bumping a version is a real load event.** Ollama is not a compose service —
  the API reaches a single *host* process through `host.docker.internal`, shared
  by interactive chat, embeddings, `llava:7b`, `llama3.2-vision:11b`,
  `MemoryCompactionService`, `GraphEnrichmentService`, the `summary-service`
  sidecar and HBPE's Qwen. Nothing admits or prioritises against it. The
  mitigations that exist today are partial: a dedicated `pipeline-embed` queue,
  a global ceiling of 10 in-flight jobs with 6 per queue
  (`config/default.json:140-144`), and `MAX_SLICES_PER_SWEEP` = 5 self-pacing
  backpressure. A real admission controller is Phase 5 and does not exist yet.
  Until then, **dry-run before you bump**: get the candidate count before you get
  the bill.
- **Seeding is the sharpest edge in the migration.** With an empty ledger, day
  one qualifies every existing row for every stage — a full re-embed and a full
  re-geocode against a billed provider, unannounced. Every conversion therefore
  ships a seeding migration deriving `done`/`skipped` rows at the current version
  from the leg's existing done-signal, and the acceptance test is that the first
  sweep after deploy enqueues ~0.
- **Stage ids and versions are permanent, one-way commitments.** Renaming a stage
  id abandons every ledger row written under the old name: the sweep stops
  finding them, coverage silently drops to zero, and the whole corpus is
  reprocessed under the new id. Rolling a version *back* is worse — already
  processed rows sit stale-forward above the current watermark and are never
  re-selected again, including by the next bump, until it passes the abandoned
  high-water mark. A bad version is superseded by v+1; it is never reverted.
- **Nothing recorded before cutover has a raw source record.** Rows already in
  `ci.events`/`ci.communications`/`ci.content` were ingested through lanes that
  discarded the source payload (`payloadOf: (r) => r`). They can be re-enriched
  from their typed columns but never re-projected from source. The lossless
  guarantee starts at cutover.

### Owed work — the control plane has no user foreign key

None of the five tables carry an FK to `ci.users`, and that is deliberate: the
control plane has to stay writable for an entity whose user row is mid-repair or
has not landed yet, and a sweep must never fail on a dangling reference. The
whole design point is that a failure degrades to "re-derive next tick".

The cost is orphaned rows on user deletion, and it is not uniform. Erasure and
export discover user-scoped tables by looking for a `user_id` / `owner_user_id`
column in the `ci`, `ci_search` and `hbpe` schemas
(`domains/portability/userDataTables.ts`, `DISCOVER_USER_TABLES_SQL`). Verified
against the live dev database:

| Table | Has `user_id`? | Fate on user delete |
|---|---|---|
| `ci.pipeline_state` | yes (nullable) | discovered and deleted — **except rows written by user-less stages, where `user_id` is NULL** |
| `ci.pipeline_runs` | yes | discovered and deleted |
| `ci.record_rejections` | yes (nullable) | discovered; NULL-user rows survive, and they hold raw payloads |
| `ci.pipeline_shards` | no | cascades via `run_id REFERENCES ci.pipeline_runs(id) ON DELETE CASCADE` |
| `ci.pipeline_dead_letters` | **no** | **left behind — and the row holds the failed job's `payload` JSONB** |

So a reaper is owed for at least `ci.pipeline_dead_letters` and for NULL-`user_id`
rows in `ci.pipeline_state` and `ci.record_rejections`. This sits inside a larger
gap the rebuild plan records rather than closes: there is no erasure/`deleteUser`
path anywhere in the API today, and Minio has no deletion path at all (zero
`removeObject` calls). Whether retained raw payloads are redacted or purged on
erasure is an open decision (`docs/jobs-system-rebuild-plan.md` §14.1).

### Related change shipped alongside

`PGBossEventService.send()` previously enqueued every event onto **every**
registered queue; each worker re-checked whether it had a listener and no-opped.
Measured on a freshly booted stack that had done nothing but boot and seed, every
work queue held an identical 90 jobs — one event became 14 rows, 13 of which were
fetched, dispatched to nothing and completed. A ~93 % waste rate before a single
row of personal data existed. `send()` now routes through
`EventListenerRegistry.getQueuesFor(eventName)`. This is not the ledger decision,
but it is the reason the pipeline can declare three queues by resource class
(`PIPELINE_QUEUES`) and expect them to mean something.

## References

- Migration: `backend/apps/api/db/postgres/migrations/20260809032723_create_pipeline_control_plane.sql`
- THE ONE RULE and its invariants: `backend/apps/api/src/domains/pipeline/services/PipelineStateService.ts`,
  `backend/apps/api/src/domains/pipeline/__tests__/theOneRule.spec.ts`
- The re-run watermark: `backend/apps/api/src/domains/pipeline/versions.ts`
- Stage ids, queues and sizing constants: `backend/apps/api/src/domains/pipeline/constants.ts`
- Converted legs: `backend/apps/api/src/domains/pipeline/stages/enrich/MediaDimensionsStage.ts`,
  `backend/apps/api/src/domains/pipeline/stages/index/EmbedStage.ts`
- Full ten-phase plan, current-state audit with `path:line` citations, and the
  open decisions: [`docs/jobs-system-rebuild-plan.md`](../jobs-system-rebuild-plan.md)
- Sibling ADRs: [ADR-0002](adr/0002-timescaledb-hypertable-criteria.md) (why
  `ci.pipeline_state` is a plain table — natural uniqueness requirement, Gate 1),
  [ADR-0003](adr/0003-tenancy-column.md) (why the tenancy column is `user_id`)
