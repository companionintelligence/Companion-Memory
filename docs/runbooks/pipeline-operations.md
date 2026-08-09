# Pipeline operations runbook

> **Operator runbook** — read, steer and stop the enrichment pipeline
> (`ci.pipeline_*` + the `pipeline-index` / `pipeline-enrich` / `pipeline-embed`
> pg-boss queues). Design background:
> [`docs/jobs-system-rebuild-plan.md`](../jobs-system-rebuild-plan.md) and the
> migration `backend/apps/api/db/postgres/migrations/20260809032723_create_pipeline_control_plane.sql`.
> For bulk imports see the [bulk load runbook](../../backend/apps/api/db/postgres/BULK_LOAD_RUNBOOK.md);
> to wipe and start over, the [ingest reset runbook](../../backend/apps/api/db/postgres/INGEST_RESET_RUNBOOK.md).

**There is no operator UI and no `/api/pipeline/*` endpoint yet** (Phase 2 adds
the endpoints, Phase 5 the page). Everything below is `psql` and `curl`. Source
comments that mention `GET /api/pipeline/state` are describing work that has not
landed — do not go looking for it. See [§10](#10-what-does-not-exist-yet).

```bash
make dbshell        # psql on this worktree's database
make dburl          # connection URL, for DataGrip / a second psql
```

---

## 0. The one thing to know before you touch anything

**Work is DERIVED, never stored.** No queue holds the backlog. A stage sweeps
its source table `LEFT JOIN ci.pipeline_state` and takes whatever is missing,
out of date, or due for retry:

```sql
--- THE ONE RULE (PipelineStateService.selectStale)
  AND ( p.entity_id IS NULL                                    -- never processed
     OR p.stage_version < $current                             -- enricher improved
     OR (p.status = 'failed' AND p.next_attempt_at <= now()) ) -- retry is due
```

Three consequences that decide almost every call you will make at 2am:

| Because | You can |
|---------|---------|
| the queue holds no state | **delete queued pipeline jobs freely.** The next sweep re-derives exactly the same remainder. Deleting is a pause, not a data loss |
| a crash leaves ledger rows at `stage_version = 0` | do nothing. `claim()` never stamps a version, so a stranded row is stale by definition and comes back |
| eligibility is `stage_version < current` | re-run any stage over the whole corpus by incrementing one integer in `versions.ts` |

### Vocabulary

| Table | Holds | Written by |
|-------|-------|-----------|
| `ci.pipeline_state` | one row per `(entity_type, entity_id, stage)` — the ledger | `PipelineStateService` only |
| `ci.pipeline_dead_letters` | terminal job failures **with the payload**, replayable | `PipelineSliceListener` (per throw) + `DeadLetterReaperListener` (from `pgboss.job`) |
| `ci.pipeline_runs` | one invocation per user; `desired_state` is operator intent | **nothing yet** — Phase 2 |
| `ci.pipeline_shards` | resumable cursor + lease per `(run, stage, shard)` | **nothing yet** — Phase 2 |
| `ci.record_rejections` | records refused at the door (THEIR bug, not ours) | **nothing yet** — Phase 2 |

| `status` | Meaning | Swept again? |
|----------|---------|--------------|
| `pending` | reserved; nothing writes it today | yes (below current version) |
| `running` | claimed by a worker, lease 15 min | yes, once stale or the lease expires |
| `done` | processed successfully at `stage_version` | only after a version bump |
| `skipped` | deliberately not processed, `reason` says why | only after a version bump |
| `failed` | transient failure; `next_attempt_at` gates the retry | yes, when the gate is due |
| `quarantined` | out of retries (5 attempts). **Needs a human or a bump** | **no** |

### The versions CTE

Almost every query needs the stage's *current* version, which lives in code, not
in the database. Read it from
`backend/apps/api/src/domains/pipeline/versions.ts` (`STAGE_VERSIONS`) and paste
it into this CTE — it is reused verbatim below.

```sql
WITH current_versions(stage, version) AS (
  VALUES ('enrich.media_dimensions', 1)   -- from domains/pipeline/versions.ts
)
```

```bash
# what the running code thinks the versions are
grep -A3 'STAGE_VERSIONS' backend/apps/api/src/domains/pipeline/versions.ts
```

---

## 1. Is the pipeline doing anything?

### 1a. Runs and shards — the intended answer

```sql
-- Active runs. One per user, enforced by pipeline_runs_active_uniq.
SELECT id, user_id, kind, desired_state, status, started_at,
       date_trunc('second', now() - started_at) AS age, detail
  FROM ci.pipeline_runs
 WHERE finished_at IS NULL
 ORDER BY started_at;

-- Shard cursors and leases for those runs.
SELECT sh.stage, sh.shard_key, sh.status, sh.cursor, sh.lease_owner,
       sh.lease_expires_at,
       sh.lease_expires_at < now() AS lease_expired
  FROM ci.pipeline_shards sh
  JOIN ci.pipeline_runs r ON r.id = sh.run_id
 WHERE r.finished_at IS NULL
 ORDER BY sh.stage, sh.shard_key;
```

> **Both return zero rows today, always.** The tables are migrated but nothing
> writes them — the runner that materializes runs and shards is Phase 2. Slices
> currently carry `runId: null, shardId: null`
> (`PipelineDispatchService.runSweepHop`). An empty result here is **not**
> evidence that the pipeline is idle. Use 1b and 1c.

### 1b. What is actually in flight — the ledger

```sql
SELECT stage,
       count(*)                                                        AS running,
       min(updated_at)                                                 AS oldest_claim,
       date_trunc('second', now() - min(updated_at))                   AS held_for,
       count(*) FILTER (WHERE updated_at < now() - interval '15 min')  AS lease_expired
  FROM ci.pipeline_state
 WHERE status = 'running'
 GROUP BY stage
 ORDER BY stage;
```

`running` climbing and `held_for` staying under a minute or two = healthy.
`lease_expired > 0` = a worker died; see [§7](#7-a-worker-died-mid-slice).

### 1c. What is queued — pg-boss

```sql
SELECT j.name AS queue, j.state, count(*) AS jobs,
       sum(coalesce(jsonb_array_length(j.data->'ids'), 0)) AS entity_ids,
       date_trunc('second', now() - min(j.created_on))     AS oldest
  FROM pgboss.job j
 WHERE j.name IN ('pipeline-index', 'pipeline-enrich', 'pipeline-embed')
 GROUP BY 1, 2
 ORDER BY 1, 2;
```

### 1d. Where the sweep has got to

The sweep is a chain of self-requeuing jobs; its cursor lives in `pgboss.job.data`,
so you can read its progress without any cooperation from the running process.

```sql
SELECT j.id, j.name AS queue, j.state, j.created_on, j.started_on,
       j.data->>'stage'          AS stage,
       j.data->>'cursor'         AS cursor,
       (j.data->>'hop')::int     AS hop,
       (j.data->>'dispatched')::int AS dispatched
  FROM pgboss.job j
 WHERE j.name IN ('pipeline-index', 'pipeline-enrich', 'pipeline-embed')
   AND j.data->>'name' = 'pipeline.sweep'
   AND j.state IN ('created', 'active', 'retry')
 ORDER BY j.created_on DESC
 LIMIT 20;
```

`hop` climbing and `cursor` advancing = the sweep is walking the corpus. `hop`
frozen with `state = 'created'` = the hop is sitting behind its own slices,
which is the intended backpressure — the sweep rides the same queue at the same
priority as the slices it produced, so it cannot outrun the workers.

> Always keep `j.name IN (...)` in the predicate. `pgboss.job` is `PARTITION BY
> LIST (name)`; dropping it scans all 22 partitions.

---

## 2. How far along is a stage?

```sql
WITH current_versions(stage, version) AS (
  VALUES ('enrich.media_dimensions', 1)   -- from domains/pipeline/versions.ts
)
SELECT p.stage,
       v.version                                            AS current_version,
       count(*)                                             AS ledger_rows,
       count(*) FILTER (WHERE p.status = 'done')            AS done,
       count(*) FILTER (WHERE p.status = 'skipped')         AS skipped,
       count(*) FILTER (WHERE p.status = 'failed')          AS failed,
       count(*) FILTER (WHERE p.status = 'quarantined')     AS quarantined,
       count(*) FILTER (WHERE p.status = 'running')         AS running,
       count(*) FILTER (WHERE p.status = 'pending')         AS pending,
       count(*) FILTER (WHERE p.stage_version < v.version)  AS stale,
       round(100.0 * count(*) FILTER (WHERE p.status IN ('done', 'skipped'))
             / nullif(count(*), 0), 1)                      AS pct_settled
  FROM ci.pipeline_state p
  LEFT JOIN current_versions v ON v.stage = p.stage
 GROUP BY p.stage, v.version
 ORDER BY p.stage;
```

> **`pct_settled` is not "percent of your data".** The denominator is *rows this
> stage has recorded an opinion about*, not rows that exist. A stage that has
> never run reads 0 rows and 0 %, and a stage that has processed 12 of 400,000
> files reads 100 %. The honest denominator needs the source table and the
> stage's applicability predicate — that is the candidate count in
> [§5b](#5b-count-the-candidates-first).

Group by reason when a bucket looks wrong:

```sql
SELECT stage, status, reason, count(*) AS rows, max(updated_at) AS last_seen
  FROM ci.pipeline_state
 WHERE status IN ('skipped', 'failed', 'quarantined')
 GROUP BY 1, 2, 3
 ORDER BY rows DESC
 LIMIT 30;
```

Reasons are stable, greppable tokens, not sentences. The ones in the tree today:

| Stage | Reason | Outcome | Means |
|-------|--------|---------|-------|
| `enrich.media_dimensions` | `source_row_missing` | skipped | the file row vanished or changed owner between sweep and slice |
| | `no_object_key` | skipped | no bytes to probe (key cleared mid-flight) |
| | `unsupported_content_type` | skipped | not an image or video (mime changed mid-flight) |
| | `probe_failed` | skipped | bytes read, decoder produced nothing. **A better decoder + a version bump is the only fix** |
| | `object_storage_read_failed` | failed | Minio/S3 threw. Retried |
| | `dimension_write_failed` | failed | probe worked, the `UPDATE` did not |
| `index.embed` | *(text skip tokens)* | skipped | `embedSkipReason` — empty / too short / trivial reaction / bare URL |
| | `ollama_unreachable` | failed | connection-level failure. See [§6](#6-ollama-is-down-or-saturated) |
| | `embed_call_failed` | failed | Ollama answered and refused |
| | `embedding_dimension_mismatch` | failed | model returned the wrong width for `vector(768)` |
| | `empty_embedding_vector` | failed | model returned nothing for a document |
| | `embedding_write_failed` | failed | the upsert into `ci_search.embeddings` threw |
| *any* | `stage_returned_no_result` | failed | the stage silently dropped an id it was given. **A bug in the stage** |
| *any* | `stage_threw: <message>` | failed | the whole slice threw; every claimed id got this |

---

## 3. Why is this row not being processed?

Take the entity id and walk it. Do not guess — every step below is one of the
sweep's own clauses.

**Step 1 — what does the ledger say about it?**

```sql
SELECT stage, stage_version, status, reason, attempts, next_attempt_at,
       user_id, updated_at
  FROM ci.pipeline_state
 WHERE entity_id = '<entity-uuid>'
 ORDER BY stage;
```

Read the answer off this table:

| What you see | Why the sweep skips it | Fix |
|--------------|------------------------|-----|
| no rows at all | never offered to any stage — it fails the *applicability* predicate, has a NULL `user_id`, or no sweep has run | step 2 |
| `done` / `skipped` at the current version | working as designed. That is what "processed" means | bump the version ([§5](#5-re-enrich-after-improving-an-enricher)) |
| `failed`, `next_attempt_at` in the future | the retry gate has not opened. Backoff is `60s × 2^(attempts-1)`, capped at 6 h | wait, or see [§6c](#6c-revive-quarantined-rows) |
| `quarantined` | spent its 5 attempts. **No sweep will ever reclaim it** | [§6c](#6c-revive-quarantined-rows) or a version bump |
| `running`, `updated_at` older than 15 min | crashed worker. Already eligible again | [§7](#7-a-worker-died-mid-slice) |
| `stage_version` **greater** than the current version | someone rolled a version back. The row is invisible to every future sweep | bump the version past the abandoned high-water mark. Never revert |

**Step 2 — would the sweep select it?** This is THE ONE RULE narrowed to one id
(shown for `enrich.media_dimensions`; substitute the stage's own
`source`/`predicate` from its `StageSource`, e.g. `MEDIA_DIMENSIONS_SOURCE`).

```sql
SELECT s.id,
       s.user_id,
       (s.variant = 'ORIGINAL'
        AND s.deleted_at IS NULL
        AND s.key IS NOT NULL
        AND (s.content_type LIKE 'image/%' OR s.content_type LIKE 'video/%')) AS applicable,
       p.status, p.stage_version, p.reason, p.attempts, p.next_attempt_at,
       ( p.entity_id IS NULL
      OR p.stage_version < 1                                        -- current version
      OR (p.status = 'failed' AND p.next_attempt_at <= now()) )     AS stale_arm
  FROM ci.files s
  LEFT JOIN ci.pipeline_state p
    ON p.entity_type = 'file'
   AND p.entity_id   = s.id
   AND p.stage       = 'enrich.media_dimensions'
 WHERE s.id = '<entity-uuid>';
```

- **no row returned** → the id is not in the source table at all.
- **`applicable = false`** → the stage does not apply to this row. Correct behaviour, not a bug.
- **`user_id IS NULL`** → unreachable. Every sweep is user-scoped (`s.user_id = $3`); a row with no owner can never be selected by any stage.
- **`applicable AND stale_arm` both true** → the sweep *will* take it. It is queued, or no sweep is running. Go to [§1](#1-is-the-pipeline-doing-anything).

**Step 3 — did a slice carrying it die?** See [§4b](#4b-every-failure-for-one-record).

---

## 4. What failed, and why?

### 4a. Triage

```sql
-- Ours: jobs that died. Payload preserved, replayable.
SELECT queue, event_name, stage, count(*) AS letters,
       min(failed_at) AS first_seen, max(failed_at) AS last_seen
  FROM ci.pipeline_dead_letters
 WHERE replayed_at IS NULL
 GROUP BY 1, 2, 3
 ORDER BY letters DESC;
```

Two writers land in this table and `queue` tells them apart:

- `queue` = a pipeline queue → written by `PipelineSliceListener` on **every**
  throw, including the retries. The *first* row for a job usually carries the
  informative error; by the third attempt the cause is often just "connection
  refused".
- `queue = 'dead-letter'` → harvested from `pgboss.job` by
  `DeadLetterReaperListener` after pg-boss exhausted its 3 retries. `id` is the
  originating pg-boss job id, so it correlates straight back to `pgboss.job`
  while that row still exists.

```sql
-- Theirs: records refused by validation, with the raw payload.
SELECT source_kind, reason, count(*) AS rows, max(rejected_at) AS last_seen
  FROM ci.record_rejections
 GROUP BY 1, 2
 ORDER BY rows DESC
 LIMIT 30;
```

> `ci.record_rejections` is empty today — nothing writes it yet (Phase 2). An
> empty result means "no writer", not "no rejections".

### 4b. Every failure for one record

A slice covers ~200 entities and records `entity_id = NULL` (attributing a slice
failure to one row would be a guess), so the ids live inside the payload. Both
halves are needed:

```sql
SELECT id, queue, event_name, stage, entity_type, failed_at, replayed_at,
       left(error, 300) AS error
  FROM ci.pipeline_dead_letters
 WHERE entity_id = '<entity-uuid>'
    OR payload->'ids' ? '<entity-uuid>'
 ORDER BY failed_at;
```

Then the ledger's own record of the same event:

```sql
SELECT stage, status, reason, attempts, next_attempt_at, updated_at
  FROM ci.pipeline_state
 WHERE entity_id = '<entity-uuid>';
```

> The `?` operator is a jsonb key/element test, not a bind placeholder. It works
> in `psql`; through a driver that uses `?` for parameters you must escape it or
> use `jsonb_exists(payload->'ids', '<uuid>')`.

Full payload for a replay:

```sql
SELECT jsonb_pretty(payload), error FROM ci.pipeline_dead_letters WHERE id = '<letter-id>';
```

> **There is no replay endpoint.** `replayed_at` exists so a replay-all can be
> idempotent, but the code that re-emits a letter is Phase 2. Today a replay is:
> read the payload, re-enqueue it by hand ([§9c](#9c-hand-enqueue-a-job)), then
> `UPDATE ci.pipeline_dead_letters SET replayed_at = now() WHERE id = …`.

### 4c. Force a dead-letter harvest

The reaper runs on cron `40 */2 * * * *` (every 2 minutes, off the top of the
minute). To not wait for it, enqueue `pipeline.dead_letter.reap` — see
[§9c](#9c-hand-enqueue-a-job) — or just read `pgboss.job` directly:

```sql
SELECT id, created_on, data->>'name' AS event_name,
       left(output->>'message', 200) AS error
  FROM pgboss.job
 WHERE name = 'dead-letter'
 ORDER BY created_on DESC
 LIMIT 50;
```

---

## 5. Re-enrich after improving an enricher

**This is the point of the whole subsystem. One integer, one commit, no backfill
script, no truncate, no `forced` flag.**

### 5a. Read the current state first

```bash
grep -n 'STAGE_VERSIONS' -A20 backend/apps/api/src/domains/pipeline/versions.ts
```

`index.embed` is the exception: its version is **derived from the embedding
model**, not hand-written. Changing `CI_EMBED_MODEL` *is* the bump — see
`EMBED_MODEL_GENERATIONS` in
`backend/apps/api/src/domains/pipeline/stages/index/EmbedStage.ts`. An
undeclared model refuses to boot rather than inventing a version.

### 5b. Count the candidates FIRST

Run this **before** the bump, with the version you are about to bump *to*.
Everything at the old version is below it, so this is exactly the work you are
about to create.

```sql
-- enrich.media_dimensions, bumping 1 -> 2, for one user
SELECT count(*) AS candidates
  FROM ci.files s
  LEFT JOIN ci.pipeline_state p
    ON p.entity_type = 'file'
   AND p.entity_id   = s.id
   AND p.stage       = 'enrich.media_dimensions'
 WHERE s.user_id = '<user-uuid>'
   AND s.variant = 'ORIGINAL'
   AND s.deleted_at IS NULL
   AND s.key IS NOT NULL
   AND (s.content_type LIKE 'image/%' OR s.content_type LIKE 'video/%')
   AND ( p.entity_id IS NULL
      OR p.stage_version < 2                                     -- the NEW version
      OR (p.status = 'failed' AND p.next_attempt_at <= now()) );
```

```sql
-- index.embed, for one user. Source is ci.content, no applicability predicate.
SELECT count(*) AS candidates
  FROM ci.content s
  LEFT JOIN ci.pipeline_state p
    ON p.entity_type = 'content'
   AND p.entity_id   = s.id
   AND p.stage       = 'index.embed'
 WHERE s.user_id = '<user-uuid>'
   AND ( p.entity_id IS NULL
      OR p.stage_version < 2                                     -- the NEW generation
      OR (p.status = 'failed' AND p.next_attempt_at <= now()) );
```

Turn the count into a time estimate from **measured** throughput, not a guess:
run one sweep, then read the `Processed pipeline slice` log lines (they carry
`claimed` and are one per ~200 ids) and divide.

> **Do this before an embedding bump, every time.** The appliance runs ONE
> Ollama process, shared with interactive chat, HBPE and the summary sidecar. A
> full-corpus re-embed is hours of contended inference. Get the candidate count
> before you get the bill.

### 5c. Bump

1. Change the enricher.
2. Increment its integer in `versions.ts` **in the same commit** — the version
   and the code that justifies it have to be reviewable together.
3. Deploy and **restart the API**. Versions are read at module load
   (`stageVersion()`), and `EmbedStage` captures its version at construction, so
   a bump has no effect until the process restarts.

> **Versions only ever go UP.** Rolling one back leaves already-processed rows
> looking stale-*forward* (`stage_version < current` is false), so they are
> never re-selected again — including by the next bump, until it climbs past the
> abandoned high-water mark. A bad version is superseded by v+1, never reverted.
> Fractional versions truncate to an integer in Postgres, so `1.5` is a silent
> no-op; the boot guard in `versions.ts` rejects both mistakes.

### 5d. Start the sweep

Nothing starts automatically after a restart — no cron sweeps a stage. The only
sweep trigger reachable over HTTP today:

```bash
curl -sS -X POST https://<host>/api/maintenance/backfill-media-dimensions \
  -H 'x-api-key: <key>' -H 'content-type: application/json' -d '{}'
```

> **This endpoint has a stale precondition.** It counts candidates with the OLD
> `width IS NULL` predicate and returns `{"status":"noop"}` **without emitting
> anything** when that count is 0. So once every file has a width, it will
> refuse to start a sweep — including the re-probe sweep a version bump exists
> to create. `body.limit` is accepted and ignored (a sweep runs to completion).
> When it no-ops, hand-enqueue the sweep instead: [§9c](#9c-hand-enqueue-a-job).

### 5e. Watch it

```sql
-- in psql: run, then \watch 15
WITH current_versions(stage, version) AS (
  VALUES ('enrich.media_dimensions', 2)
)
SELECT p.stage,
       count(*) FILTER (WHERE p.stage_version < v.version) AS still_stale,
       count(*) FILTER (WHERE p.stage_version = v.version
                          AND p.status IN ('done','skipped'))     AS reprocessed,
       count(*) FILTER (WHERE p.status = 'failed')                AS failed,
       count(*) FILTER (WHERE p.status = 'quarantined')           AS quarantined,
       count(*) FILTER (WHERE p.status = 'running')               AS running
  FROM ci.pipeline_state p
  JOIN current_versions v ON v.stage = p.stage
 GROUP BY p.stage;
```

Healthy: `still_stale` falls monotonically, `reprocessed` rises to match,
`failed` stays near zero. `failed` rising with a single dominant `reason` is a
dependency outage — [§6](#6-ollama-is-down-or-saturated). Done is
`still_stale = 0` **and** an empty `pipeline-*` queue ([§1c](#1c-what-is-queued--pg-boss)).

---

## 6. Ollama is down or saturated

### 6a. The symptom

The old system's symptom was a number that **stopped going up** — indistinguishable
from a drain that finished. Here it is a number that **goes up, with a reason**:

```sql
SELECT date_trunc('minute', updated_at) AS minute, reason, count(*)
  FROM ci.pipeline_state
 WHERE stage = 'index.embed'
   AND status IN ('failed', 'quarantined')
   AND updated_at > now() - interval '2 hours'
 GROUP BY 1, 2
 ORDER BY 1 DESC;
```

| Reason | Read it as |
|--------|-----------|
| `ollama_unreachable` | the host process is not answering — `ECONNREFUSED`, `ETIMEDOUT`, `fetch failed`. Appliance-level, affects every row |
| `embed_call_failed` | Ollama answered and refused. Model-level: wrong model name, model not pulled, OOM on a long document |

Every id in the failing batch gets its own ledger row with a retry gate, so the
outage reads as a rate. Cross-check the host:

```bash
# Host from config: services.ollama.host / embedding.host (OLLAMA_EMBED_HOST),
# default http://host.docker.internal:11434 — i.e. :11434 on the appliance host.
curl -sS http://localhost:11434/api/tags | head -c 400   # up? is CI_EMBED_MODEL pulled?
docker stats --no-stream                                 # saturated?
```

### 6b. Pausing

Ranked by how much you disturb.

1. **Do nothing.** Backoff is already exponential in the ledger —
   `60s × 2^(attempts-1)`, capped at 6 h — and it survives a restart because it
   is a column, not a timer. A brief outage self-heals.

2. **Drop the queued embed work** (see [§9](#9-emergency-stop)). Blunt, safe,
   reversible: the ledger has no rows for un-dispatched ids, so a later sweep
   re-derives them.

3. **Suppress the queue at boot** — `CI_QUEUE_SUPPRESS=pipeline-embed`, then
   restart the API. Exact semantics, because they are not obvious:
   `sendMany` (slices) honours suppression and drops the batch **with a loud
   warning**; `send()` with an explicit queue (the sweep's own next hop) does
   **not**. So the sweep keeps hopping and keeps advancing its cursor while
   every slice is discarded. Nothing is lost — no ledger rows are written for
   discarded ids, so a re-run after unsuppressing re-derives them — but the
   sweep will report "drained" having done nothing. Unset it and sweep again.

> **A long outage quarantines the corpus.** Five attempts (`MAX_ATTEMPTS_BEFORE_QUARANTINE`)
> and a row goes `quarantined`, which **no sweep ever reclaims**. With the
> backoff schedule that is roughly a working day of a dead Ollama. If the outage
> will be long, stop the sweep (option 2 or 3) instead of letting it burn the
> attempt budget.

### 6c. Revive quarantined rows

Quarantine is not a tombstone, but it needs an explicit act. Either bump the
stage version (re-selects quarantined rows along with everything else), or reset
the ledger directly — the supported DB operation until the control plane lands:

```sql
-- Dry run: what would come back?
SELECT stage, reason, count(*)
  FROM ci.pipeline_state
 WHERE stage = 'index.embed' AND status = 'quarantined'
 GROUP BY 1, 2;

-- Re-admit them: failed + a due gate is the sweep's third arm.
UPDATE ci.pipeline_state
   SET status          = 'failed',
       attempts        = 0,           -- give back the retry budget
       next_attempt_at = now(),
       updated_at      = now()
 WHERE stage  = 'index.embed'
   AND status = 'quarantined'
   AND reason = 'ollama_unreachable';   -- scope it: do NOT revive poison records
```

> Keep the `reason` filter. Reviving `probe_failed`-style rows that quarantined
> for a real reason just spends the same attempts again on the same bytes.

---

## 7. A worker died mid-slice

Nothing to repair. The design costs you one lease period.

**Why:** `claim()` deliberately does not stamp `stage_version` — it inserts a
literal `0`. So a row abandoned in `status = 'running'` sits below every live
stage version (which is why `versions.ts` refuses version 0) and satisfies the
staleness sweep's second arm. `claim()`'s conflict guard additionally re-takes
any `running` row whose `updated_at` is older than `CLAIM_LEASE_SECONDS`
(15 minutes).

**Find the abandoned rows:**

```sql
SELECT stage, entity_type, entity_id, stage_version, attempts,
       updated_at, date_trunc('second', now() - updated_at) AS held_for
  FROM ci.pipeline_state
 WHERE status = 'running'
   AND updated_at < now() - interval '15 minutes'
 ORDER BY updated_at
 LIMIT 50;
```

**Confirm nothing is stranded.** This must return **zero rows** — a `running`
row at or above the current version satisfies no arm of the sweep and would be
invisible forever:

```sql
WITH current_versions(stage, version) AS (
  VALUES ('enrich.media_dimensions', 1)   -- from domains/pipeline/versions.ts
)
SELECT p.stage, p.entity_id, p.stage_version, v.version AS current_version,
       p.attempts, p.updated_at
  FROM ci.pipeline_state p
  JOIN current_versions v ON v.stage = p.stage
 WHERE p.status = 'running'
   AND p.stage_version >= v.version
 ORDER BY p.updated_at
 LIMIT 50;
```

Rows here mean a version was rolled **back**. Fix by bumping past the abandoned
high-water mark, not by reverting.

Then start a sweep ([§5d](#5d-start-the-sweep)) and watch `running` fall. Do not
hand-edit `running` rows to `failed` — the lease and the version already do it,
and an `UPDATE` that also clears `attempts` hides a genuinely poisonous record.

---

## 8. Queue depth and backlog

```sql
-- Depth by queue and state, with the id count actually pending.
SELECT j.name AS queue, j.state, count(*) AS jobs,
       sum(coalesce(jsonb_array_length(j.data->'ids'), 0)) AS entity_ids,
       min(j.created_on) AS oldest,
       date_trunc('second', now() - min(j.created_on)) AS oldest_age
  FROM pgboss.job j
 WHERE j.name IN ('pipeline-index', 'pipeline-enrich', 'pipeline-embed')
 GROUP BY 1, 2
 ORDER BY 1, 2;

-- What kind of job: sweep hops vs slices.
SELECT j.name AS queue, j.data->>'name' AS event, j.state, count(*)
  FROM pgboss.job j
 WHERE j.name IN ('pipeline-index', 'pipeline-enrich', 'pipeline-embed')
 GROUP BY 1, 2, 3
 ORDER BY 1, 2, 3;

-- Everything on the box, when the pipeline looks starved by other traffic.
SELECT name AS queue, state, count(*)
  FROM pgboss.job
 WHERE state IN ('created', 'active', 'retry')
 GROUP BY 1, 2
 ORDER BY 3 DESC;

-- Retrying jobs: state='retry' with a high retry_count is about to dead-letter.
SELECT j.id, j.name AS queue, j.data->>'name' AS event, j.retry_count, j.retry_limit,
       j.start_after, left(j.output->>'message', 200) AS last_error
  FROM pgboss.job j
 WHERE j.name IN ('pipeline-index', 'pipeline-enrich', 'pipeline-embed')
   AND j.state = 'retry'
 ORDER BY j.retry_count DESC
 LIMIT 30;
```

Capacity, for reading those numbers (`backend/apps/api/config/default.json` →
`queues`, overridable by env):

| Setting | Default | Meaning |
|---------|---------|---------|
| `queues.concurrency` (`CI_QUEUE_CONCURRENCY`) | 10 | in-flight jobs across **all** queues |
| `queues.perQueueConcurrency` (`CI_QUEUE_PER_QUEUE_CONCURRENCY`) | 6 | ceiling for any one queue |
| `queues.fetchBatchSize` | 10 | jobs fetched per poll |

Pipeline jobs are enqueued at `BACKFILL_JOB_PRIORITY` (**-10**), below ordinary
traffic — by design, so a million-row sweep cannot delay a user action. pg-boss
fetches `ORDER BY priority DESC, created_on`, so a deep pipeline backlog behind
busy interactive queues is expected, not a fault.

There is also a read-only HTTP view (whole box, not pipeline-specific):

```bash
curl -sS https://<host>/jobs/dashboard -H 'x-api-key: <key>'          # JobsController
curl -sS https://<host>/api/maintenance/ingest-status -H 'x-api-key: <key>'
```

---

## 9. Emergency stop

A runaway sweep is stopped by deleting its jobs. **This is safe** — the queue
holds no state that the ledger cannot re-derive.

### 9a. Stop it

```sql
-- 1. LOOK FIRST.
SELECT name, state, count(*)
  FROM pgboss.job
 WHERE name IN ('pipeline-index', 'pipeline-enrich', 'pipeline-embed')
   AND state IN ('created', 'retry')
 GROUP BY 1, 2;

-- 2. Delete everything not yet started. Kills the sweep chain AND its slices:
--    the sweep only continues by re-enqueuing itself, so deleting the hop ends it.
DELETE FROM pgboss.job
 WHERE name IN ('pipeline-index', 'pipeline-enrich', 'pipeline-embed')
   AND state IN ('created', 'retry');
```

Narrow it when only one stage is misbehaving:

```sql
DELETE FROM pgboss.job
 WHERE name = 'pipeline-embed'
   AND state IN ('created', 'retry')
   AND data->>'stage' = 'index.embed';
```

Reversible alternative — defer instead of delete, keeping the cursor:

```sql
UPDATE pgboss.job
   SET start_after = now() + interval '6 hours'
 WHERE name IN ('pipeline-index', 'pipeline-enrich', 'pipeline-embed')
   AND state = 'created';
```

### 9b. What this does not stop

- **`state = 'active'` jobs keep running** to completion — they are in-flight in
  the API process. One slice is ~200 entities, seconds to a couple of minutes.
  To stop those you must restart the API; their ledger rows then expire out of
  `running` after 15 minutes ([§7](#7-a-worker-died-mid-slice)).
- **Whatever started the sweep will start it again.** Today that is only a human
  calling `/api/maintenance/backfill-media-dimensions` or
  `/api/maintenance/orchestrate` — there is no cron that sweeps a stage. The one
  pipeline cron is the dead-letter reaper (`40 */2 * * * *`), which only copies
  rows and never enqueues work.
- **Nothing rolls back.** Entities already processed keep their ledger rows.
  Restarting the sweep resumes from the remainder, not from the beginning.

Afterwards, confirm the drain:

```sql
SELECT count(*) FILTER (WHERE state = 'created') AS queued,
       count(*) FILTER (WHERE state = 'active')  AS in_flight
  FROM pgboss.job
 WHERE name IN ('pipeline-index', 'pipeline-enrich', 'pipeline-embed');

SELECT stage, count(*) FROM ci.pipeline_state WHERE status = 'running' GROUP BY 1;
```

### 9c. Hand-enqueue a job

The escape hatch when no endpoint reaches what you need — starting a sweep after
[§5d](#5d-start-the-sweep) no-ops, forcing a reap, or replaying a dead letter.
`pgboss.job.data` must carry the event name in `name`; the worker dispatches on
`${data.name}:${queue}`.

```sql
-- Start a media-dimensions sweep from the beginning, for one user.
INSERT INTO pgboss.job (name, data, priority, retry_limit, dead_letter)
VALUES ('pipeline-enrich',
        jsonb_build_object('name', 'pipeline.sweep',
                           'stage', 'enrich.media_dimensions',
                           'userId', '<user-uuid>',
                           'cursor', NULL),
        -10, 3, 'dead-letter');

-- Force a dead-letter harvest now instead of waiting for the cron.
INSERT INTO pgboss.job (name, data, priority, retry_limit, dead_letter)
VALUES ('pipeline-index',
        jsonb_build_object('name', 'pipeline.dead_letter.reap'),
        -10, 3, 'dead-letter');
```

> Set `retry_limit` and `dead_letter` explicitly. A raw `INSERT` uses the
> partition's column defaults (`retry_limit = 2`, `dead_letter = NULL`), not the
> options `PGBossEventService` passes through `boss.send()` — so without them a
> failing hand-inserted job vanishes instead of dead-lettering.
>
> The queue must match the stage's declared queue or `PipelineSliceListener`
> refuses the slice ("Refusing to process it on the wrong resource pool"):
> `enrich.media_dimensions` → `pipeline-enrich`, `index.embed` → `pipeline-embed`.

---

## 10. What does not exist yet

Verified against the tree; do not go looking for these.

| Missing | Reality today |
|---------|---------------|
| `GET /api/pipeline/state`, `/dead-letters` | **No pipeline controller exists.** Source comments referring to them describe Phase 2. Use §1–§4 |
| Operator UI / pipeline page | Phase 5. `"jobs.page"` is still `false` in `config/default.json` |
| Pause / resume / cancel | `ci.pipeline_runs.desired_state` is the intended channel and nothing reads or writes it. Today pausing is [§9](#9-emergency-stop) and reviving is [§6c](#6c-revive-quarantined-rows) — DB operations |
| Runs and shards | `ci.pipeline_runs` / `ci.pipeline_shards` are migrated and permanently empty; no code writes them. Sweeps are ad-hoc (`runId: null, shardId: null`) |
| Record rejections | `ci.record_rejections` is migrated and empty; no writer yet |
| Dead-letter replay | `replayed_at` exists; the re-emit path does not. Replay by hand ([§9c](#9c-hand-enqueue-a-job)) |
| Bound stage implementations | **Check before trusting a sweep.** `stageProviders` in `backend/apps/api/src/domains/pipeline/index.ts` is an empty array at the time of writing, so `enrich.media_dimensions` is declared but **unbound** — every slice fails with `no provider is bound to token "PipelineStage:enrich.media_dimensions"`. `EmbedStage` exists but its id `index.embed` is absent from `STAGE_IDS` / `STAGE_VERSIONS` / `STAGE_REGISTRY`, so `index.embed` is not sweepable at all. Confirm with the grep below before diagnosing anything else |

```bash
# Which stages can actually run right now?
grep -n 'stageProviders' -A6 backend/apps/api/src/domains/pipeline/index.ts
grep -n 'STAGE_REGISTRY: Record' -A6 backend/apps/api/src/domains/pipeline/services/StageRegistry.ts
```

An unbound or unknown stage fails loudly and lands in
`ci.pipeline_dead_letters` with the fix in the error text — check §4 first when
a sweep enqueues slices and coverage stays at zero.
