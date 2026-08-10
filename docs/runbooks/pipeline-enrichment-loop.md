# Running an enrichment loop on a box with real data

> **Operator runbook** — start, watch, pause and re-run the enrichment loop
> against a real personal archive. Sibling to
> [`pipeline-operations.md`](./pipeline-operations.md), which is the diagnostic
> reference (what every table means, why one row is stuck, how to read a dead
> letter). **This one is about the loop itself**: making it go, seeing that it is
> going, stopping it, and knowing what a re-run will cost *before* you pay for it.
>
> Every command below was run against a live appliance holding **324,044
> imported `ci.events` rows**, and the output is the real output. Where a
> command does not work yet, that is stated with the reason.

```bash
make dbshell        # psql on this worktree's database
make dburl          # connection URL, for DataGrip or a second psql
```

---

## 0. Read this first: what a "loop" is here

There is **no backlog table**. No queue holds the list of work. The loop is a
three-line idea repeated forever:

1. ask the source table what rows a stage applies to,
2. subtract the rows the ledger says are already done **at the stage's current
   version**,
3. hand a slice of the difference to a worker, and write down what it decided.

That subtraction is the anti-join in `PipelineStateService.selectStale`. It has
three consequences that decide almost everything you will do on this page:

| Because | You can |
|---------|---------|
| the queue holds no state | **delete queued pipeline jobs freely.** The next pass re-derives exactly the same remainder. Deleting is a pause, not a data loss |
| eligibility is `stage_version < current` | re-run a stage over the whole corpus by incrementing **one integer** in `versions.ts` |
| the ledger counts everything, including deliberate skips | answer "is my import finished?" with a number instead of a shrug |

A **tick** is one pass of the control loop over one user. It reads the run's
`desired_state`, works out which stages have candidates, and starts a sweep for
the ones that do. A **sweep** is a self-requeuing chain of pg-boss jobs, each hop
enqueuing up to 5 slices of 200 ids and then re-enqueuing itself *behind* them —
so a sweep paces itself to the workers instead of enqueuing the corpus in one
pass.

---

## 1. What exists today — check this before anything else

The subsystem shipped complete and **inert**: twelve stages bind and resolve,
`startSweep()` works, `PipelineSliceListener` executes slices, `PipelineRunService`
manages runs — and until the control tick is wired, *nothing calls any of it*.

```bash
# Does anything schedule a sweep?
grep -rn "startSweep" backend/apps/api/src --include=*.ts | grep -v __tests__

# Is the control tick wired into the module?
grep -n "PipelineControlService\|PipelineTickCron\|controllers:" \
     backend/apps/api/src/domains/pipeline/index.ts
```

Both are one-line checks with an unambiguous answer. Two states you can be in:

| `grep` result | Meaning |
|---|---|
| `PipelineControlService` and `PipelineTickCron` are in `index.ts`'s `providers` | The loop is live. Continue at §3. |
| they are not | **The loop cannot start.** Wiring them is the fix; nothing on this page will do anything until then. |

```sql
-- The blunt version of the same question. Zero rows in BOTH means no loop
-- has ever run on this appliance.
SELECT (SELECT count(*) FROM ci.pipeline_runs)  AS runs_ever,
       (SELECT count(*) FROM ci.pipeline_state) AS ledger_rows;
```

```
 runs_ever | ledger_rows
-----------+-------------
         0 |           0
```

### The HTTP surface is not registered

`PipelineController` exists and is fully implemented, and it is in **no module's
`controllers` array** — not `PipelineModule` (which declares none) and not
`application.ts` (which lists only `HealthController`, `MapsConfigController`,
`TelemetryConfigController`). So:

```console
$ curl -s -o /dev/null -w "%{http_code}\n" --max-time 4 http://localhost:3000/api/pipeline/state
000
```

`000` is curl reporting no listener at all on a stopped API; with the API up you
get `404`, because the route does not exist. **Every `curl` in this runbook is
marked ✅ (works today) or ⛔ (needs the controller registered).** Until the
registration lands, use the psql equivalent given beside each one. The fix is one
line in `domains/pipeline/index.ts`:

```ts
@Module({
  controllers: [PipelineController],       // ← add
  providers: [ …, PipelineRunService ],    // ← and its service
})
```

---

## 2. Before you start: count what there is to do

**Always run the census first.** It is the only thing that tells you whether you
are about to start a five-second job or a five-hour one, and it is the only place
the two metered stages are visible as metered.

```sql
-- CANDIDATE CENSUS — what each stage's applicability predicate matches, and how
-- much of it the ledger already has an opinion about.
--
-- The predicates are copied from stages/**/*Stage.ts (the `*_SOURCE` consts).
-- They drift; if a number looks wrong, re-read the source file, which is the
-- authority. Same discipline as the versions CTE in pipeline-operations.md §0.
WITH me AS (
  SELECT user_id FROM ci.events GROUP BY user_id ORDER BY count(*) DESC LIMIT 1
),
candidates(stage, metered, n) AS (
  SELECT 'enrich.media_dimensions', false, (SELECT count(*) FROM ci.files s, me
     WHERE s.user_id = me.user_id AND s.variant = 'ORIGINAL' AND s.deleted_at IS NULL AND s.key IS NOT NULL
       AND (s.content_type LIKE 'image/%' OR s.content_type LIKE 'video/%'))
  UNION ALL SELECT 'index.embed', false, (SELECT count(*) FROM ci.content s, me WHERE s.user_id = me.user_id)
  UNION ALL SELECT 'enrich.position_reverse', TRUE, (SELECT count(*) FROM ci.position s, me
     WHERE s.user_id = me.user_id AND s.location IS NOT NULL AND s.id IS NOT NULL)
  UNION ALL SELECT 'enrich.geocode', TRUE, (SELECT count(*) FROM ci.events s, me
     WHERE s.user_id = me.user_id AND s.location_name IS NOT NULL AND btrim(s.location_name) <> ''
       AND COALESCE(s.is_deleted, false) = false)
  UNION ALL SELECT 'enrich.estimate_location', false, (SELECT count(*) FROM ci.events s, me
     WHERE s.user_id = me.user_id AND COALESCE(s.is_deleted, false) = false
       AND COALESCE(s.is_predicted, false) = false
       AND s.source_system IN ('calendar','apple_photos','google_photos','apple_health','google_fit','fitbit',
                               'strava','garmin','withings','uber','lyft','flighty','amazon','paypal','venmo',
                               'google_purchases','google_maps_places','google_location'))
  UNION ALL SELECT 'enrich.person_link', false, (SELECT count(*) FROM ci.communications s, me
     WHERE s.user_id = me.user_id AND s.participants_metadata IS NOT NULL
       AND s.participants_metadata <> '{}'::jsonb)
  UNION ALL SELECT 'enrich.event_person_link', false, (SELECT count(*) FROM ci.events s, me
     WHERE s.user_id = me.user_id AND COALESCE(s.is_deleted, false) = false AND s.metadata IS NOT NULL
       AND ( s.metadata ? 'organizerEmail' OR s.metadata ? 'organizer_email' OR s.metadata ? 'organizer'
          OR s.metadata ? 'Organizer' OR s.metadata ? 'from' OR s.metadata ? 'From'
          OR s.metadata ? 'participants' OR s.metadata ? 'Participants'
          OR s.metadata ? 'attendees' OR s.metadata ? 'Attendees'))
  UNION ALL SELECT 'clean.temporal_repair', false, (SELECT count(*) FROM ci.events s, me
     WHERE s.user_id = me.user_id AND COALESCE(s.is_deleted, false) = false)
  UNION ALL SELECT 'clean.duplicate_detect', false, (SELECT count(*) FROM ci.entities s, me
     WHERE s.owner_user_id = me.user_id AND s.entity_type = 'Person'
       AND COALESCE(s.is_active, true) = true AND s.merged_into_entity_id IS NULL)
  UNION ALL SELECT 'clean.identifier_normalize', false, (SELECT count(*) FROM ci.entities s, me
     WHERE s.owner_user_id = me.user_id AND COALESCE(s.is_active, true) = true
       AND s.merged_into_entity_id IS NULL)
  UNION ALL SELECT 'promote.place', false, (SELECT count(*) FROM ci.events s, me
     WHERE s.user_id = me.user_id AND s.location_coordinates IS NOT NULL AND s.location_name IS NOT NULL
       AND btrim(s.location_name) <> '' AND COALESCE(s.is_deleted, false) = false)
  UNION ALL SELECT 'promote.object', false, (SELECT count(*) FROM ci.events s, me
     WHERE s.user_id = me.user_id AND s.event_type IN ('purchase','order')
       AND COALESCE(s.is_deleted, false) = false)
)
SELECT c.stage,
       CASE WHEN c.metered THEN 'BILL' ELSE '' END AS meter,
       c.n AS in_scope,
       COALESCE(l.recorded, 0) AS recorded,
       c.n - COALESCE(l.recorded, 0) AS never_offered
  FROM candidates c
  LEFT JOIN (SELECT stage, count(*) AS recorded FROM ci.pipeline_state GROUP BY stage) l
    ON l.stage = c.stage
 ORDER BY c.n DESC;
```

Real output, on the appliance this runbook was written against:

```
           stage            | meter | in_scope | recorded | never_offered
----------------------------+-------+----------+----------+---------------
 clean.temporal_repair      |       |   324044 |        0 |        324044
 enrich.estimate_location   |       |     3153 |        0 |          3153
 promote.object             |       |     2777 |        0 |          2777
 enrich.media_dimensions    |       |      170 |        0 |           170
 index.embed                |       |      170 |        0 |           170
 clean.identifier_normalize |       |      170 |        0 |           170
 enrich.geocode             | BILL  |       95 |        0 |            95
 promote.place              |       |       76 |        0 |            76
 enrich.event_person_link   |       |       16 |        0 |            16
 clean.duplicate_detect     |       |        0 |        0 |             0
 enrich.position_reverse    | BILL  |        0 |        0 |             0
 enrich.person_link         |       |        0 |        0 |             0
(12 rows)

Time: 292.271 ms
```

Read it like this:

- **`never_offered` is the size of the job.** `recorded = 0` everywhere is the
  genuine starting condition of a first import: `ci.pipeline_state` is empty, so
  every row is stale for every stage.
- **`BILL` means an external, metered provider.** `enrich.geocode` and
  `enrich.position_reverse` egress through Portal. They are excluded from the
  loop's default stage set (`METERED_STAGES` in `PipelineControlService`), so the
  timer can never start them; they are reachable only from a run that *names*
  them. That exclusion is asserted at module load, so adding one to the default
  set fails the boot rather than the invoice.
- **A zero is a fact, not a gap.** `enrich.person_link` at 0 means
  `ci.communications` is empty on this box, not that the stage is broken.

---

## 3. Start a loop

### 3a. Continuous mode — the intended path

Once `PipelineTickCron` and `PipelineControlService` are in `PipelineModule`'s
providers, **there is nothing to start.** The tick fires on its own cron, takes a
Postgres advisory lock (so a second replica cannot double-fire it), opens a
`kind='continuous'` run for any user with stale rows, and sweeps the non-metered
stages in dependency order. Starting a loop is a deploy, not a command.

Confirm it woke up:

```sql
SELECT id, kind, desired_state, status, started_at, detail
  FROM ci.pipeline_runs WHERE finished_at IS NULL;
```

### 3b. Start one by hand

⛔ **Needs the controller registered.** There is no `POST /api/pipeline/runs`
route even in the implemented controller — it exposes `state`, `runs`,
`runs/:id`, `pause`, `resume`, `cancel`, `dead-letters` and `replay`, but no
create. Runs are created by the control tick.

✅ **psql equivalent.** Insert the run and let the next tick pick it up. The
partial unique index `pipeline_runs_active_uniq` makes a second active run for the
same user a `23505`, which is the point — one loop per user.

```sql
-- Start a run over specific stages. `detail.stages` is how a METERED stage is
-- reached at all; omit it and the tick uses the non-metered default set.
INSERT INTO ci.pipeline_runs (user_id, kind, desired_state, status, detail)
SELECT user_id, 'reprocess', 'running', 'queued',
       '{"startedBy":"operator","stages":["promote.object"]}'::jsonb
  FROM ci.events GROUP BY user_id ORDER BY count(*) DESC LIMIT 1
RETURNING id, kind, desired_state, status;
```

```
                  id                  |   kind    | desired_state | status
--------------------------------------+-----------+---------------+---------
 1722e423-636b-4f1e-930a-eb8510c98de2 | reprocess | running       | queued
```

> **Naming a metered stage here is an authorisation, not a convenience.** Run §2
> and §6b first and know the number.

### 3c. One stage, right now, from a REPL

The lowest-level entry point, and the one every path above eventually reaches:

```ts
await pipelineDispatchService.startSweep({
  stage: STAGE_IDS.PROMOTE_OBJECT,
  userId,
  entityType: 'event',   // required only for multi-type stages; harmless always
});
```

It returns as soon as hop 0 is enqueued. Progress is read from the ledger, never
from a return value — that is the whole point of making it durable.

---

## 4. Watch it

Four questions, in the order you will ask them.

### 4a. Is a loop running at all?

```sql
SELECT r.id, r.kind, r.desired_state, r.status,
       date_trunc('second', now() - r.started_at) AS age, r.detail
  FROM ci.pipeline_runs r
 WHERE r.finished_at IS NULL
 ORDER BY r.started_at;
```

```
                  id                  |    kind    | desired_state | status  |   age    |            detail
--------------------------------------+------------+---------------+---------+----------+-------------------------------
 1722e423-636b-4f1e-930a-eb8510c98de2 | continuous | running       | running | 00:00:00 | {"startedBy": "control-tick"}
```

`desired_state` is what you asked for; `status` is what the workers report. They
are separate channels on purpose — see §5.

⛔ `curl -s $CI/api/pipeline/runs?activeOnly=true | jq` once registered.

### 4b. Where has it got to?

```sql
SELECT sh.stage, sh.shard_key, sh.status, left(sh."cursor", 13) AS cursor_prefix,
       sh.lease_owner, sh.lease_expires_at < now() AS lease_expired
  FROM ci.pipeline_shards sh
  JOIN ci.pipeline_runs r ON r.id = sh.run_id
 WHERE r.finished_at IS NULL
 ORDER BY sh.stage, sh.shard_key;
```

```
     stage      | shard_key | status  | cursor_prefix | lease_owner | lease_expired
----------------+-----------+---------+---------------+-------------+---------------
 promote.object | event     | running | 019fe55d-e94e | api-1       | f
```

> **`cursor` may legitimately be NULL.** The control tick uses the shard row as a
> **lease**, and restarts each sweep from cursor null — the ledger's anti-join
> skips the finished prefix, so restarting is correct and cheap. Two reads a
> minute apart showing an unchanged `lease_expires_at` on a `running` shard is
> what "stuck" looks like; `lease_expired = t` means nothing owns it and the next
> tick will reclaim it.

### 4c. Is my import finished?

This is the question the pipeline was rebuilt to be able to answer.

```sql
-- Paste the CURRENT versions from domains/pipeline/versions.ts. They live in
-- code, not in the database. `index.embed` is DERIVED from the embedding model —
-- read it with: yarn workspace @ci/be-api node -e "…embedStageVersion()".
WITH current_versions(stage, version) AS (VALUES
  ('enrich.media_dimensions',1),('index.embed',1),('enrich.position_reverse',1),('enrich.geocode',1),
  ('enrich.estimate_location',1),('enrich.person_link',1),('enrich.event_person_link',1),
  ('clean.temporal_repair',1),('clean.duplicate_detect',1),('clean.identifier_normalize',1),
  ('promote.place',1),('promote.object',1))
SELECT p.stage,
       count(*)                                            AS recorded,
       count(*) FILTER (WHERE p.status = 'done')            AS done,
       count(*) FILTER (WHERE p.status = 'skipped')         AS skipped,
       count(*) FILTER (WHERE p.status = 'failed')          AS failed,
       count(*) FILTER (WHERE p.status = 'running')         AS running,
       count(*) FILTER (WHERE p.status = 'quarantined')     AS quarantined,
       count(*) FILTER (WHERE p.stage_version < v.version)  AS stale,
       max(p.attempts)                                      AS max_attempts
  FROM ci.pipeline_state p
  JOIN current_versions v ON v.stage = p.stage
 GROUP BY p.stage ORDER BY 2 DESC;
```

```
     stage      | recorded | done | skipped | failed | running | quarantined | stale | max_attempts
----------------+----------+------+---------+--------+---------+-------------+-------+--------------
 promote.object |     1000 |  750 |     250 |      0 |       0 |           0 |     0 |            1
```

- **`recorded` is not "rows that exist".** It is rows this stage has an opinion
  about. Compare it against `in_scope` from §2 — that difference is the backlog.
- **`max_attempts` is the duplicate detector.** `attempts` is incremented by
  `claim()` and nowhere else, so anything above 1 on a first pass means a row was
  claimed twice: overlapping sweeps, a re-dispatched slice, or a cursor that
  failed to advance. On a healthy first pass it is exactly `1`.
- **`skipped` is not failure.** Ask why:

```sql
SELECT stage, status, coalesce(reason, '(none)') AS reason, count(*)
  FROM ci.pipeline_state GROUP BY 1,2,3 ORDER BY 4 DESC;
```

```
     stage      | status  |          reason           | count
----------------+---------+---------------------------+-------
 promote.object | done    | (none)                    |   750
 promote.object | skipped | order_rollup_no_line_item |   250
```

250 order-level rollups with no line item — a countable backlog waiting on
`ci.receipts` to get a reader, not 250 rows that vanished. Under the predicate
this stage replaces they would simply have been absent, indistinguishable from
work that was never scheduled.

⛔ `curl -s $CI/api/pipeline/state | jq '.stages[] | {stage, done, skipped, stale, coverage}'`

### 4d. Rate and ETA

```sql
WITH settled AS (
  SELECT updated_at FROM ci.pipeline_state
   WHERE stage = 'promote.object' AND status IN ('done','skipped','quarantined'))
SELECT count(*) AS settled,
       round(count(*) / GREATEST(extract(epoch FROM (max(updated_at) - min(updated_at))), 0.001)::numeric, 1)
              AS rows_per_sec,
       2777 - count(*) AS remaining          -- `in_scope` from §2
  FROM settled;
```

```
 settled | rows_per_sec | remaining
---------+--------------+-----------
    1000 |       1001.0 |      1777
```

And the queue behind it:

```sql
SELECT name AS queue, state, count(*) FROM pgboss.job
 WHERE name LIKE 'pipeline%' GROUP BY 1,2 ORDER BY 1,2;
```

Zero rows means the sweep chain has drained, not that nothing happened. Cross-check
with 4c.

---

## 5. Pause and resume

**Pause writes intent and nothing else.** It never touches `status`, and nothing
reaches into pg-boss to delete jobs — that operation always races a worker that
has already claimed one. The tick reads `desired_state` first, before it counts a
single candidate, so a paused run costs nothing at all.

✅ psql:

```sql
UPDATE ci.pipeline_runs SET desired_state = 'paused'
 WHERE finished_at IS NULL AND user_id = '<user>'
RETURNING id, desired_state, status, finished_at;
```

```
                  id                  | desired_state | status  | finished_at
--------------------------------------+---------------+---------+-------------
 1722e423-636b-4f1e-930a-eb8510c98de2 | paused        | running |
```

Note what did **not** change: `status` is still `running` (the workers' channel,
and no worker has reported anything yet) and `finished_at` is still NULL (the run
is still active, which is what `pipeline_runs_active_uniq` keys on).

Resume:

```sql
UPDATE ci.pipeline_runs SET desired_state = 'running'
 WHERE finished_at IS NULL AND user_id = '<user>'
RETURNING id, desired_state, status;
```

```
                  id                  | desired_state | status
--------------------------------------+---------------+---------
 1722e423-636b-4f1e-930a-eb8510c98de2 | running       | running
```

⛔ `curl -X POST $CI/api/pipeline/runs/$ID/pause` · `…/resume` · `…/cancel`

### What pause does and does not stop

| | |
|---|---|
| **Stops** | the tick planning any new sweep for that run |
| **Does not stop** | slices already enqueued — they drain, which is deliberate: a claimed row must reach a terminal ledger state or it sits `running` until its 15-minute lease expires |
| **Latency** | one tick plus one slice, so seconds to a couple of minutes. A 200 means "the intent is recorded", never "everything has stopped" |
| **Resume** | continues from where the ledger says it got to. Rows already `done` at the current version are not re-selected, so a resume is never a restart even when the queued sweep jobs were deleted |

**Cancel is one-way and does not finalize the run.** `finished_at` stays NULL
until a control tick tears the shards down and calls `finishRun`, which is the
schema's own contract. On a deployment with no control tick running, **do not
cancel**: nothing will finalize it, and the user can never start another run
without hand-editing `ci.pipeline_runs`.

### Emergency stop, when there is no tick

```sql
-- Safe, because the queue holds no state: the next pass re-derives the identical
-- remainder from the ledger.
DELETE FROM pgboss.job WHERE name LIKE 'pipeline%' AND state = 'created';

-- Rows a killed worker left mid-flight. `claim()` never stamps a version, so
-- they are stale by definition and come back on their own — after the 15-minute
-- lease. Nothing needs doing.
SELECT stage, count(*) FROM ci.pipeline_state WHERE status = 'running' GROUP BY 1;
```

---

## 6. Re-run after improving an enricher

**Change the enricher, then increment its integer in `versions.ts`, in the same
commit.** That is the entire mechanism. No backfill script, no `DELETE FROM`, no
truncate, no `forced` flag.

### 6a. What a bump does

Every ledger row for that stage below the new version becomes a candidate again —
`done`, `skipped` **and** `quarantined` alike, because `stage_version < current`
does not care what the old answer was. That is the feature, and it is also a real
load event on a single appliance.

### 6b. Price it BEFORE you push the commit

```sql
-- What a v1 -> v2 bump of this stage will re-process. Run it for the version you
-- are about to SUPERSEDE (`>= 1` when going 1 -> 2).
SELECT status, coalesce(reason,'(none)') AS reason, count(*) AS rows_reopened
  FROM ci.pipeline_state
 WHERE stage = 'promote.object' AND stage_version >= 1
 GROUP BY 1,2 ORDER BY 3 DESC;
```

```
 status  |          reason           | rows_reopened
---------+---------------------------+---------------
 done    | (none)                    |           750
 skipped | order_rollup_no_line_item |           250
```

Then add the rows with **no ledger entry at all** — already candidates, and
unaffected by the bump — from §2's `never_offered`. The total is the job.

**On a metered stage this integer is the invoice.** Multiply it by the provider's
per-request price before touching `versions.ts`:

```sql
-- The whole bill for a geocode bump: rows already recorded PLUS rows never offered.
SELECT (SELECT count(*) FROM ci.pipeline_state
         WHERE stage = 'enrich.geocode' AND stage_version >= 1)         AS reopened_by_bump,
       (SELECT count(*) FROM ci.events s
         WHERE s.location_name IS NOT NULL AND btrim(s.location_name) <> ''
           AND COALESCE(s.is_deleted, false) = false)                   AS in_scope_total;
```

```
 reopened_by_bump | in_scope_total
------------------+----------------
                0 |             95
```

95 forward geocodes on this appliance today. On a box that has run the stage
before, `reopened_by_bump` is the number that was previously "never re-billed"
and is about to be billed again.

Same shape, different currency, for the two stages that are not metered but are
still expensive:

| Stage | A bump costs |
|---|---|
| `index.embed` | the **entire** `ci.content` corpus re-embedded through the ONE host Ollama process that also serves interactive chat, HBPE and the summary sidecar. Hours of contended GPU. The `pipeline-embed` queue keeps it from taking every global slot; it will still be felt |
| `enrich.media_dimensions` | every original image and video re-fetched from Minio and re-decoded |
| `clean.temporal_repair` | **dates the user has already seen will move.** It writes `start_time_original` alongside, never over, so it is reversible — but it is still user-visible |

### 6c. Bump

```diff
-  [STAGE_IDS.PROMOTE_OBJECT]: 1,
+  // v2 — reads the second retailer's line-item shape; re-promotes everything
+  // recorded `skipped: order_rollup_no_line_item`.
+  [STAGE_IDS.PROMOTE_OBJECT]: 2,
```

Several stages **derive** their version from a constant in the stage file
(`OBJECT_PROMOTION_RULE_GENERATION`, `TEMPORAL_RULE_GENERATION`, and
`index.embed` from `(model, dimension)`). For those, bump the generation *and*
the `versions.ts` mirror in the same commit — they cross-check each other and
throw at module load if they disagree.

**Two rules that are not negotiable.** Versions only ever go **up** — rolling one
back leaves processed rows looking stale-*forward* and they are never re-selected
again, including by the next bump, until it climbs past the abandoned high-water
mark. And versions start at **1**, never 0.

### 6d. Watch the re-run

Deploy, then:

```sql
-- Immediately after the deploy, before any sweep: `stale` should equal the
-- number you priced in 6b. If it is 0, the bump did not reach the running code.
WITH current_versions(stage, version) AS (VALUES ('promote.object', 2))
SELECT p.stage, count(*) AS recorded,
       count(*) FILTER (WHERE p.stage_version < v.version) AS stale
  FROM ci.pipeline_state p JOIN current_versions v ON v.stage = p.stage
 GROUP BY 1;
```

Then watch `stale` fall to zero with 4c. **You do not need to start anything**:
the control tick's next pass finds the stale rows, opens a run and sweeps. If
`stale` is not falling, the loop is not running — go back to §1.

---

## 7. Measured behaviour

From `src/domains/pipeline/__tests__/enrichmentLoop.integration.spec.ts`, which
drives the real dispatcher, worker, ledger and two real declared stages — in a
Postgres database it creates for the run and drops afterwards. Numbers, not
adjectives.

> **These are machinery numbers from a seeded corpus, not appliance numbers.**
> An earlier version of this suite ran over the operator's own 324,044 imported
> events and kept them safe with a rolled-back transaction. That did not hold —
> it committed ~599,000 ledger rows, 2,147 `ci.inventory` objects and 2,875
> time-provenance labels into a personal archive. A test that drives real
> enrichers writes real tables by name, and the only isolation worth having for
> that is a database of its own. The ratios below (ticks to converge, attempts
> per row, warm-versus-cold cost) are the properties being pinned; the
> milliseconds are a floor measured on whatever machine ran jest. To measure
> **your** appliance, use a read-only tool — `realData.integration.spec.ts` is
> the shape that does it.

### Convergence — `promote.object`, 2,790 seeded commerce events

| | |
|---|---|
| Ticks to converge | **3** (1,000 + 1,000 + 790 ids) |
| Wall clock per tick | 137, 133, 104 ms |
| Outcomes | 2,170 `done`, 620 `skipped: order_rollup_no_line_item`, 0 failed |
| Objects written | 2,170 `ci.inventory` rows, from 0 — and `done` matches that count exactly |
| Idle ticks after convergence | 5, **all dispatching 0** |
| Rows claimed more than once | **0** (`max(attempts) = 1` across all 2,790) |

### The bump

| | |
|---|---|
| Rows re-opened by v1 → v2 | **2,790** — everything, `done` and `skipped` alike |
| Ticks before the loop noticed | **1**. No operator action, no run restarted |
| Ticks to re-converge | 3 |
| `attempts` after the second pass | 2 — a real re-processing, not a bookkeeping rewrite |

### Pause and resume, mid-corpus

| | |
|---|---|
| Ticks while paused | 3, **all dispatching 0** |
| Ledger during the pause | byte-identical before and after |
| On resume | continued past the cursor; **no already-processed id was re-delivered**, and `attempts` stayed 1 on every row finished before the pause |

### Cost of one tick against 30,000 seeded rows — `clean.temporal_repair`

| Ledger state | Wall clock per 1,000 ids |
|---|---|
| empty (the easy case, and the one a naive benchmark reports) | 100, 98, 101 ms |
| **10,000 rows, cursor resumed at row 10,000** | **107, 104, 107 ms** |

- **0.11 ms per row** of pipeline machinery — sweep + claim + stage + ledger
  write — at a realistic ledger depth.
- **1.1×** cost increase going from an empty ledger to 10,000 rows. A *constant
  factor*, not a change of complexity class: under the `LEFT JOIN` form of the
  staleness sweep this was 4,401 blocks against the anti-join's 241 and a full
  sweep degraded to O(corpus²/slice). **This ratio is the thing to watch** — it
  is the one number here that is a property of the SQL rather than of the
  machine, and the spec fails if it exceeds 4×. If it climbs into double digits,
  the anti-join has been lost.
- **30 ticks** to cover 30,000 rows at 1,000 ids per tick, ≈ **0.1 minutes of
  worker time** — **machinery only**, and on a seeded corpus.

> **Do not quote 0.1 minutes as the time to enrich a corpus.** It excludes
> everything that actually costs: the stage's own work (an Ollama round trip for
> `index.embed`, a provider call for `enrich.geocode`), the queue's throughput
> ceiling — **10 in-flight jobs appliance-wide, 6 per queue**
> (`config/default.json` → `queues.concurrency`) — and the tick cadence, which
> bounds how fast a *new* sweep starts, not how fast a running one drains. The
> number is a floor and a regression tripwire: it says the ledger and the sweep
> are not the bottleneck.

Also measured, on the appliance, **before** this suite was moved off it: of the
first 6,000 `ci.events` by key order, **all 6,000** resolved to
`skipped: source_time_spec_missing`. That is correct and deliberate —
`google_voice` (309,689 rows), `twitter`, `whatsapp` and `uber` have no declared
time spec, and the stage refuses to parse a timestamp out of an opaque
idempotency key. It shows up as a countable reason instead of a silence, which is
the entire point. Re-derive it for your own archive with 4c rather than by
pointing a test at it — the query is read-only and answers the same question.

---

## 8. When it does not converge

The failure that matters is a loop that sweeps forever. On a metered stage that
is a recurring bill.

| Symptom | Cause | Fix |
|---|---|---|
| `stale` never reaches 0, `done` keeps climbing | a stage returns `done` for rows the predicate keeps re-matching — usually an applicability predicate that mentions the stage's OUTPUT column, or a `run()` that does not actually write | read the `*_SOURCE` const; the predicate must say what a row **is**, never what has been done to it |
| `max(attempts)` climbing on a first pass | two dispatchers sweeping the same stage, or a cursor that is not advancing | check for two API replicas without the advisory lock; check the log for `failed to advance its cursor` |
| `hit the hop ceiling (10000)` in the log | the cursor advances but the source never drains | the applicability predicate is matching rows the stage never terminates |
| `running` rows that never settle | worker died mid-slice | nothing to do. The 15-minute claim lease expires and the next sweep re-selects them |
| `quarantined` climbing | 5 failed attempts | read the reason, fix the enricher, **bump the version** — a bump re-admits quarantined rows |
| Ledger grows but nothing is enriched | the stage's target table is not being written | compare `done` against a `count(*)` on the target, e.g. `ci.inventory WHERE source_type = 'promote.object'` |

The single most useful check, and the one to run first:

```sql
-- Anything above 1 on a first pass means a row was processed twice.
SELECT stage, max(attempts) AS max_attempts, count(*) FILTER (WHERE attempts > 1) AS reclaimed
  FROM ci.pipeline_state GROUP BY 1 ORDER BY 2 DESC;
```

---

## 9. Further reading

- [`pipeline-operations.md`](./pipeline-operations.md) — the diagnostic
  reference: every table, every status, dead letters, one stuck row.
- [`../jobs-system-rebuild-plan.md`](../jobs-system-rebuild-plan.md) — §4.1 the
  one rule, §9 the control plane, §11 the phase plan.
- `backend/apps/api/src/domains/pipeline/README.md` — how to add a stage, and the
  ratchet inventory that explains why the ledger exists.
- `backend/apps/api/src/domains/pipeline/__tests__/enrichmentLoop.integration.spec.ts`
  — every number in §7, re-measurable with
  `yarn workspace @ci/be-api test src/domains/pipeline/__tests__/enrichmentLoop.integration.spec.ts`.
  It creates and drops a database of its own, so it needs `DATABASE_ADMIN_PASSWORD`
  (in `.env.default`) and skips without it. See
  `backend/apps/api/src/domains/pipeline/__tests__/harness/README.md`.
