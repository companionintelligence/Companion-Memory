# Pipeline smoke test

Is the pipeline control plane alive on this box, and does the staleness sweep
behave on the data that is actually here?

Every command below was run against a live dev stack holding a real imported
archive (324,044 rows in `ci.events`) and the output shown is what came back.
Nothing here writes: the one command that inserts does so inside a transaction it
rolls back, and step 6 proves the rollback.

Run them in order. Each step is a question with an answer you can read.

---

## 0. Preflight

`psql` is not installed on the host in this setup — `make dbshell` calls it and
fails with `Failed to run psql: spawnSync psql ENOENT`. The database image has
it, so shell in through the container. `make dburl` prints this worktree's URL,
including the dynamic host port, and inside the container `localhost:5432` is the
database itself, so the URL works unchanged.

```bash
cd "$(git rev-parse --show-toplevel)"
DB=$(docker ps --filter 'label=com.docker.compose.service=database' --format '{{.Names}}' | head -1)
URL=$(make dburl | tail -1)

echo "$DB"
docker exec -i "$DB" psql "$URL" -c 'select 1 as ok;'
```

```
ci-server-ci-jobs-system-rebuild-0b9904-database-1
 ok
----
  1
```

If `$DB` is empty there is no stack running for this worktree — `make dev`
first. If you do have `psql` on the host, `make dbshell` replaces the `docker
exec` prefix everywhere below.

---

## 1. Is the control plane migrated?

```bash
docker exec -i "$DB" psql "$URL" -c "
SELECT to_regclass('ci.pipeline_state')        AS pipeline_state,
       to_regclass('ci.pipeline_runs')         AS pipeline_runs,
       to_regclass('ci.pipeline_shards')       AS pipeline_shards,
       to_regclass('ci.pipeline_dead_letters') AS dead_letters,
       to_regclass('ci.record_rejections')     AS record_rejections;"
```

```
  pipeline_state   |  pipeline_runs   |  pipeline_shards   |       dead_letters       |  record_rejections
-------------------+------------------+--------------------+--------------------------+----------------------
 ci.pipeline_state | ci.pipeline_runs | ci.pipeline_shards | ci.pipeline_dead_letters | ci.record_rejections
```

Any `NULL` means the migration has not been applied — `yarn workspace @ci/be-api
migrate`.

---

## 2. Did the API register the pipeline queues?

pg-boss creates a queue when a listener declares it at boot, so this is the
cheapest proof that `PipelineModule` is wired into `application.ts` and that its
listeners loaded.

```bash
docker exec -i "$DB" psql "$URL" -c "
SELECT name FROM pgboss.queue WHERE name LIKE 'pipeline-%' OR name = 'dead-letter' ORDER BY name;"
```

```
      name
-----------------
 dead-letter
 pipeline-embed
 pipeline-enrich
 pipeline-index
```

Three `pipeline-*` queues plus `dead-letter`. Fewer means the API has not booted
against this database since the pipeline landed. (`pgboss` is created by pg-boss
at boot, not by a migration, so on a database no API has ever run against this
query errors — that is the same signal.)

---

## 3. What is there to sweep?

```bash
docker exec -i "$DB" psql "$URL" -c "
SELECT 'ci.events'   AS source, count(*) FROM ci.events
UNION ALL SELECT 'ci.content',  count(*) FROM ci.content
UNION ALL SELECT 'ci.files',    count(*) FROM ci.files
UNION ALL SELECT 'ci.position', count(*) FROM ci.position;"
```

```
   source    | count
-------------+--------
 ci.events   | 324044
 ci.content  |    170
 ci.files    |    340
 ci.position |      0
```

This is the box the numbers in step 5 were measured on. A box with a few hundred
events will produce different query plans and step 5 will not tell you anything.

---

## 4. Is the ledger recording anything?

```bash
docker exec -i "$DB" psql "$URL" -c "
SELECT stage, status, count(*) AS rows, min(stage_version) AS min_v, max(stage_version) AS max_v
  FROM ci.pipeline_state GROUP BY stage, status ORDER BY stage, status;"
```

```
 stage | status | rows | min_v | max_v
-------+--------+------+-------+-------
(0 rows)
```

Zero rows is the honest answer on a box where no sweep has been dispatched yet —
the stages are wired but nothing has asked them to run. It is not the same as
"the pipeline is broken", which is exactly the distinction the ledger exists to
make. Once a sweep runs, every entity it looked at appears here with a status,
a reason and the version that decided it.

`min_v = 0` on a `running` row is normal and load-bearing: `claim()` deliberately
does not stamp the version, so a row abandoned by a killed worker still satisfies
`stage_version < $current` and the next sweep reclaims it. `min_v = 0` on a row
that is `running` and hours old is a crashed worker, and it will be re-swept.

### Candidate count for a real stage — THE ONE RULE, by hand

This is the sweep `PipelineStateService.selectStale` issues, for
`enrich.media_dimensions` over `ci.files`, with the stage's own applicability
predicate. Run it to see how much work a stage has in front of it before you
dispatch anything.

```bash
docker exec -i "$DB" psql "$URL" <<'SQL'
SELECT user_id AS u FROM ci.files GROUP BY user_id ORDER BY count(*) DESC LIMIT 1 \gset
SELECT count(*) AS candidates_now FROM (
  SELECT s."id"
    FROM "ci"."files" s
    LEFT JOIN ci.pipeline_state p
      ON p.entity_type = 'file' AND p.entity_id = s."id" AND p.stage = 'enrich.media_dimensions'
   WHERE s."user_id" = :'u'::uuid
     AND (s.variant = 'ORIGINAL' AND s.deleted_at IS NULL AND s.key IS NOT NULL
          AND (s.content_type LIKE 'image/%' OR s.content_type LIKE 'video/%'))
     AND ( p.entity_id IS NULL
        OR p.stage_version < 1
        OR (p.status = 'failed' AND p.next_attempt_at <= now()) )
     AND (NULL::uuid IS NULL OR s."id" > NULL::uuid)
   ORDER BY s."id"
   LIMIT 200) t;
SQL
```

```
 candidates_now
----------------
            170
```

170 of 340 `ci.files` rows are originals this stage applies to, and none of them
has a ledger row yet. Bump the `< 1` to the stage's next version to get the
candidate count a version bump would produce — **get the count before you get the
bill**, especially for `index.embed`, which shares one Ollama process with
interactive chat.

---

## 5. The §14.2 measurement: does the LEFT JOIN stay index-only?

`docs/jobs-system-rebuild-plan.md` §14.2 carries this as an open risk. The answer
is **no**, and this is how to see it on your own data. Everything runs inside one
transaction that is rolled back.

The `ANALYZE` in the middle is not optional. `ci.pipeline_state` is empty on a
fresh box, so its statistics say "0 rows" and the planner would keep choosing the
empty-ledger plan no matter how many rows the transaction just inserted. On a
real appliance autoanalyze reaches the same state within minutes of the first
sweep.

```bash
docker exec -i "$DB" psql "$URL" <<'SQL'
SELECT user_id AS u FROM ci.events GROUP BY user_id ORDER BY count(*) DESC LIMIT 1 \gset
BEGIN;

\echo '--- A. ledger EMPTY'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT s."event_id" FROM "ci"."events" s
  LEFT JOIN ci.pipeline_state p
    ON p.entity_type='event' AND p.entity_id=s."event_id" AND p.stage='test.smoke'
 WHERE s."user_id" = :'u'::uuid AND (TRUE)
   AND (p.entity_id IS NULL OR p.stage_version < 1 OR (p.status='failed' AND p.next_attempt_at <= now()))
   AND (NULL::uuid IS NULL OR s."event_id" > NULL::uuid)
 ORDER BY s."event_id" LIMIT 200;

INSERT INTO ci.pipeline_state (entity_type, entity_id, stage, stage_version, status, attempts, user_id)
SELECT 'event', t.event_id, 'test.smoke', 1, 'done', 1, t.user_id
  FROM (SELECT event_id, user_id FROM ci.events WHERE user_id = :'u'::uuid
         ORDER BY event_id LIMIT 50000) t;
ANALYZE ci.pipeline_state;

\echo '--- B. ledger POPULATED (50000 rows)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT s."event_id" FROM "ci"."events" s
  LEFT JOIN ci.pipeline_state p
    ON p.entity_type='event' AND p.entity_id=s."event_id" AND p.stage='test.smoke'
 WHERE s."user_id" = :'u'::uuid AND (TRUE)
   AND (p.entity_id IS NULL OR p.stage_version < 1 OR (p.status='failed' AND p.next_attempt_at <= now()))
   AND (NULL::uuid IS NULL OR s."event_id" > NULL::uuid)
 ORDER BY s."event_id" LIMIT 200;

ROLLBACK;
SQL
```

**A — ledger empty.** The sweep walks the primary key in order and stops at the
`LIMIT`. 37 blocks, 0.145 ms.

```
 Limit (actual time=0.028..0.125 rows=200.00 loops=1)
   Buffers: shared hit=37
   ->  Merge Left Join (actual time=0.027..0.116 rows=200.00 loops=1)
         ->  Index Scan using events_pkey on events s (actual time=0.018..0.095 rows=200.00 loops=1)
               Filter: (user_id = '…'::uuid)
         ->  Sort  ->  Seq Scan on pipeline_state p        -- empty table, free
 Execution Time: 0.145 ms
```

**B — 50,000 ledger rows.** The whole table, twice, then a sort. 37,633 blocks,
69 ms.

```
 Limit (actual time=63.405..69.170 rows=200.00 loops=1)
   Buffers: shared hit=10357 read=27276
   ->  Sort  Sort Key: s.event_id
         ->  Gather  Workers Launched: 2
               ->  Hash Left Join
                     ->  Parallel Seq Scan on events s (rows=108014.67 loops=3)
                     ->  Hash  ->  Seq Scan on pipeline_state p (rows=50000 loops=3)
 Execution Time: 69.202 ms
```

`Index Scan using events_pkey` → `Parallel Seq Scan on events`, and a ~1,000×
increase in blocks read **for the same 200-row page**. The `OR` chain reads
columns from the NULL-extended side of the join, so it cannot be pushed down and
the `LIMIT` cannot reach the scan: the join is materialised in full and then
sorted. Every hop re-reads the source table, which makes a full sweep
O(corpus²/slice) rather than O(corpus).

Run it with a cursor in the `> NULL::uuid` slot to see the other half: with the
ledger populated the keyset cursor appears as `Filter:` on the sequential scan
instead of `Index Cond:` on `events_pkey`, so resuming stops costing
O(remaining).

---

## 6. Confirm nothing was written

```bash
docker exec -i "$DB" psql "$URL" -c 'SELECT count(*) AS pipeline_state_rows FROM ci.pipeline_state;'
```

```
 pipeline_state_rows
---------------------
                   0
```

Same number as step 4. The 50,000 rows never existed outside that transaction.

---

## 7. Is evidence surviving? — dead letters

```bash
docker exec -i "$DB" psql "$URL" -c "
SELECT queue, event_name, count(*), min(failed_at)::date AS first, max(failed_at)::date AS last,
       left(min(error), 60) AS sample_error
  FROM ci.pipeline_dead_letters
 GROUP BY queue, event_name ORDER BY count(*) DESC LIMIT 10;"
```

```
    queue    |    event_name     | count |   first    |    last    |           sample_error
-------------+-------------------+-------+------------+------------+-----------------------------------
 dead-letter | preview.generated |   170 | 2026-08-09 | 2026-08-09 | Invalid model specified: llava:7b
```

Rows here are the reaper working: 170 real `preview.generated` jobs burned their
retries, and their payloads are now durable and replayable instead of waiting to
expire out of `pgboss.job`. `queue = 'dead-letter'` means the row came from
`DeadLetterReaperListener`; a `pipeline-*` queue means a stage slice threw and
`PipelineSliceListener` recorded it directly.

An empty table on a box that has never run a job is expected. An empty table on a
box you know has failures means the reaper is not running — check that the API is
up, since the reap is a cron inside it (`40 */2 * * * *`).

---

## 8. The automated version of all of the above

```bash
cd backend/apps/api
yarn test src/domains/pipeline/__tests__/realData.integration.spec.ts
```

Drives `PipelineStateService` against this database, EXPLAINs the statement it
actually issued, pages 4,000 real ids at the real slice size, and takes 250 real
rows through claim → complete → version bump — all inside a transaction it rolls
back, then re-checks the ledger fingerprint to prove it. It prints the same
measurements as step 5 as a table:

```
empty ledger, hop 0 (cursor null)                             0.130 ms      37 blocks on ci.events  Index Scan using events_pkey
empty ledger, mid-corpus cursor                               0.099 ms      31 blocks on ci.events  Index Scan using events_pkey
baseline: same page, ledger still empty                       0.111 ms      37 blocks on ci.events  Index Scan using events_pkey
50000 ledger rows, hop 0 (cursor null)                       81.101 ms   35488 blocks on ci.events  Parallel Seq Scan
50000 ledger rows, cursor past the processed prefix          80.262 ms   35488 blocks on ci.events  Parallel Seq Scan
50000 ledger rows, NOT EXISTS rewrite (candidate remedy)     74.368 ms    7803 blocks on ci.events  Index Scan using events_pkey
```

The whole suite skips — loudly, with a printed reason — when no Postgres is
reachable. It fails, rather than skipping, when a database IS reachable but is
missing the control plane, because that is a broken setup and a green run would
hide it.

Its neighbours are worth running in the same breath:

```bash
yarn test src/domains/pipeline
```

`pipeline.integration.spec.ts` drives the real dispatcher, worker and ledger
end to end over a throwaway schema; `DeadLetterReaperListener.spec.ts` runs the
reaper's SQL against real Postgres. Both use the same always-rolled-back or
always-torn-down discipline.
