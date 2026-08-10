# The pipeline integration harness

`pipelineHarness.ts` runs a stage end to end — dispatcher, generic worker and
ledger — against a **real Postgres**. It is the first integration test this repo
has for the jobs system.

Everything else under `domains/pipeline/__tests__` is a unit test against a fake
`DataSource`. Those are fast, hermetic and worth keeping, but they are written
from the same understanding as the code they test, so they cannot notice that
the SQL is wrong. This one can.

## Two harnesses, and which one to reach for

| | Isolation | Use it when |
| --- | --- | --- |
| **`pipelineHarness.ts`** | A throwaway **schema** for its source table, plus a throwaway **stage id** for its ledger rows, in whatever database you point it at. | The stage under test is synthetic — you invent the table it sweeps. This is most pipeline tests. |
| **`scratchDatabase.ts`** | A throwaway **database**, created and dropped per run, with this repo's migrations applied. | The test drives a **real declared stage**, which names real tables (`ci.events`, `ci.inventory`) and cannot be relocated into a scratch schema. |

The second exists because of an incident, and the incident is worth reading
before choosing: see [Why `enrichmentLoop` needs a whole
database](#why-enrichmentloop-needs-a-whole-database).

---

## Running it

```bash
cd backend/apps/api
yarn test src/domains/pipeline/__tests__
```

`yarn test` is `DOTENV_CONFIG_PATH=../../../.env jest`, and the harness loads
that `.env` itself at module scope (the same thing `src/bootstrap.ts` does for
the app). So on a machine with the dev stack up, **the command above is the
whole setup** — no extra environment variables, no fixtures, no containers.

Just the integration suite:

```bash
yarn test src/domains/pipeline/__tests__/pipeline.integration.spec.ts
```

The whole suite is ~30 assertions and finishes in about two seconds.

### Prerequisites

- A Postgres reachable from the host with the pipeline control-plane migration
  applied (`ci.pipeline_state`, `ci.pipeline_dead_letters` …). If the stack is
  up, that is already true; otherwise `yarn workspace @ci/be-api migrate`.
- Nothing else. **No worker container, no pg-boss, no Ollama, no Minio.** The
  queue is in-memory and the stage is synthetic — which is the point, since the
  repo's only full-stack workflow (`.github/workflows/e2e.yml`) is
  `workflow_dispatch`-only, non-blocking, and boots none of those either.

---

## Connection: read from the environment, never hardcoded

`pipelineHarness.ts` resolves its connection in this order. (`scratchDatabase.ts`
uses only the **host and port** from it, and creates its own database — see
[Credentials](#credentials-and-why-there-is-no-fallback).)

| Source | Notes |
| --- | --- |
| `PIPELINE_TEST_DATABASE_URL` | Point this suite at a database of your choosing without moving the whole app off the dev one. |
| `DATABASE_URL` | What the dev-stack supervisor exports; the same variable `bin/dbmate.js` and `bin/dburl.js` honour. |
| `DATABASE_HOST` / `DATABASE_PORT` / `DATABASE_USERNAME` / `DATABASE_PASSWORD` / `DATABASE_NAME` | The discrete variables `config/custom-environment-variables.json` already maps. |

Only the host, port, username and database name have defaults
(`localhost:5432`, `companion`, `companion`) — those are public and live in
`config/default.json` already. **The password has no default.** It is read from
`process.env` and nothing else, and its absence is exactly the signal "there is
no database here".

For the record, the local dev stack's connection string is

```
postgres://companion:comp4nion_1ntel_ftw!@localhost:5432/companion
```

which is the throwaway credential already published in `.env.default` and in
`.github/workflows/e2e.yml`. It is written **here, in a document**, and
deliberately not in any committed `.ts` file: nothing in `src/` should contain a
password, even a worthless one, because that is how a real one eventually gets
committed next to it.

To point the suite somewhere else:

```bash
PIPELINE_TEST_DATABASE_URL='postgres://user:pass@host:5432/scratch' \
  yarn test src/domains/pipeline/__tests__
```

---

## When there is no database, the suite is SKIPPED

`databaseAvailability()` answers "can this suite run?" **synchronously**, so
`pipeline.integration.spec.ts` can pick `describe` vs `describe.skip` at
collection time:

```ts
const availability = databaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;
```

Jest has no way to skip a suite from inside an async `beforeAll`, and a suite
that "passes" by returning early from every test is worse than one that is
honestly skipped — it reports green for work it never did, which is precisely
the class of silence this whole subsystem was rebuilt to remove. Hence the
synchronous answer, which is obtained by spawning a short-lived
`node -e "net.connect(...)"` child process. That costs one process spawn per
test file and depends on nothing but a node builtin (notably not `pg`, which the
child would have to resolve through Yarn PnP).

Skipped output looks like this, and the reason is always printed:

```
console.warn
  [pipeline.integration] SKIPPED — no database configured — set PIPELINE_TEST_DATABASE_URL or …

Test Suites: 1 skipped, 0 of 1 total
Tests:       31 skipped, 31 total
```

### Three outcomes, deliberately different

| Situation | Result | Why |
| --- | --- | --- |
| No connection resolvable from the environment | **skip** | This is CI. `.github/workflows/ci.yml` runs `yarn workspace @ci/be-api test` with no database service and no `.env`, so `DATABASE_PASSWORD` is unset and the suite skips cleanly. |
| Connection resolvable, nothing listening on the port | **skip** | The stack is down. Not the developer's problem right now. |
| Something listening, but the control plane is missing | **fail**, with `Run yarn workspace @ci/be-api migrate` | This is a broken setup, not an absent one. Skipping here would turn a migration mistake into a green run. |

A TCP handshake proves something is listening, not that it is Postgres with the
migrations applied — that split is what the third row buys.

Tuning knobs:

- `PIPELINE_TEST_PROBE_TIMEOUT_MS` (default `2000`) — raise it on a slow or
  heavily loaded machine.

---

## How it stays out of your dev data

Two different mechanisms, because the two halves of the system have different
constraints.

**The source table gets a throwaway schema.** Each harness creates
`pipeline_harness_<8 hex>` at setup, puts one table in it, and drops the schema
`CASCADE` at teardown. No real table is read or written at any point.

**The ledger cannot be relocated, so it is isolated by KEY instead.**
`PipelineStateService` writes the literal `ci.pipeline_state` — correctly, it is
*the* ledger — so an integration test necessarily writes real rows into it.
`ci.pipeline_state`'s primary key is `(entity_type, entity_id, stage)`, so each
harness invents a stage id `test.harness_<same 8 hex>` that nothing else in the
system writes, and deletes by that stage id at teardown. The unique stage id is
also what makes `coverage()` assertable at all: coverage counts by stage across
**all** users, so a harness that borrowed `enrich.media_dimensions` would be
counting the operator's real files.

**Killed runs are cleaned up on the next setup.** If a test process is `kill -9`
ed before `afterAll`, the next `PipelineHarness.start()` reaps the leftovers.
The reap is bounded three ways so it can never touch anything real:

- only stages under the `test.harness_` prefix,
- only rows older than one hour,
- only schemas matching `/^pipeline_harness_[0-9a-f]{8}$/` that still carry the
  marker comment the harness wrote when it created them
  (`ci pipeline test harness; created <iso>; safe to drop`).

If you ever want to check by hand:

```sql
-- Anything the harness owns, if a run died mid-flight:
SELECT stage, count(*) FROM ci.pipeline_state
 WHERE stage LIKE 'test.harness\_%' GROUP BY stage;

SELECT nspname FROM pg_namespace WHERE nspname LIKE 'pipeline\_harness\_%';

-- Manual cleanup (the harness does this itself; this is the break-glass form):
DELETE FROM ci.pipeline_state        WHERE stage LIKE 'test.harness\_%';
DELETE FROM ci.pipeline_dead_letters WHERE stage LIKE 'test.harness\_%';
-- then DROP SCHEMA "pipeline_harness_xxxxxxxx" CASCADE; per leftover schema.
```

A clean run leaves all three of those empty.

---

## Why `enrichmentLoop` needs a whole database

Both mechanisms above rest on the same trick: the harness owns the names it
writes. It invents the source table, so the table can live in a scratch schema;
it invents the stage id, so the ledger rows can be deleted by key.

`enrichmentLoop.integration.spec.ts` owns neither. It drives two **real declared
stages** — `ObjectPromoteStage` and `TemporalRepairStage` — and a real stage
names real tables in its SQL: it reads `ci.events` and writes `ci.inventory` and
`ci.events`. That is correct; they are the appliance's tables. It also means the
suite has no way to be pointed away from them.

The first version of that spec dealt with this by funnelling every statement
through one `QueryRunner` inside a transaction it always rolled back, and said
so at length in its header. **It did not hold.** A run against the dev appliance
committed roughly 599,000 `ci.pipeline_state` rows, 2,147 `ci.inventory` objects
and 2,875 `ci.events` rows carrying repaired time provenance into somebody's
personal archive. Nothing was destroyed — `TemporalRepairStage` writes alongside
a timestamp, never over it — but none of it was authorised.

The lesson is not "be more careful with transactions":

- A rollback is a claim about **every code path the test reaches**, re-asserted
  on every future change to any of them. One service that takes its own pooled
  connection and the fence has a gate in it.
- It **fails silently**. A rollback that missed something looks exactly like one
  that did not, until somebody counts rows.
- It is **unnecessary**. The thing being protected is a database, and a database
  is a cheap object to make.

### What `scratchDatabase.ts` does instead

1. Connects with an **administrative** credential and runs
   `CREATE DATABASE ci_pipeline_scratch_<yyyymmddhhmmss>_<8 hex>`.
2. Enables the extensions `infrastructure/setup-database/entrypoint.sh` enables
   (`timescaledb`, `postgis`, `vector`, `pg_stat_statements`, `btree_gist`) —
   no migration issues `CREATE EXTENSION`, so a fresh database inherits none.
3. Writes a marker row (`pipeline_scratch.marker`) carrying a token unique to
   this run.
4. Applies every migration in `db/postgres/migrations`, in dbmate's order, each
   in its own transaction, recording them in `public.schema_migrations`.
5. Hands back a pooled `DataSource` on that database. ~1.5 s end to end.
6. Drops the database in `afterAll`, and reaps any scratch database older than
   two hours left behind by a killed run.

The migrations are applied in-process rather than by shelling out to
`bin/dbmate.js`, which cannot be spawned from jest under Yarn PnP. What is
reproduced is small and guarded: a migration that declares dbmate options on its
`-- migrate:up` line, or uses `CREATE INDEX CONCURRENTLY`, makes the applier
throw and name dbmate rather than apply it in a way dbmate would not have.

### The guard

Creating a database is not by itself a safety property — the suite that caused
the incident also believed it was isolated. So `assertScratchDatabase()` is
called **before every block of work** and again before the drop, and re-derives
four facts from the server:

1. `current_database()` is the name this run generated;
2. that name matches `/^ci_pipeline_scratch_\d{14}_[0-9a-f]{8}$/` — this is what
   catches a caller that derived its "expected" name from the connection itself,
   making the first check vacuous;
3. `pipeline_scratch.marker` exists;
4. it carries **this run's** token — so a leftover scratch database from an
   earlier run is refused too.

Anything else throws `REFUSING TO RUN`, naming what it found. All four failure
modes are exercised by `harness/__tests__/scratchDatabase.spec.ts`, including
pointing the guard at a real database with real rows in it: a guard nobody has
watched fail is a guard nobody knows is wired up.

`DROP DATABASE` is additionally guarded by re-checking the name against the
pattern immediately before it is interpolated, since Postgres has no parameter
binding for object names.

### Credentials, and why there is no fallback

`CREATE DATABASE` and `CREATE EXTENSION postgis` are superuser operations, and
`infrastructure/setup-database/entrypoint.sh` deliberately creates the
application role `companion` with neither `CREATEDB` nor `SUPERUSER`. So this
harness needs the admin credential the same script reads:

| Source | Notes |
| --- | --- |
| `PIPELINE_TEST_ADMIN_DATABASE_URL` | A full URL, including the maintenance database. |
| `DATABASE_ADMIN_PASSWORD` (+ optional `DATABASE_ADMIN_USERNAME`, default `postgres`) | What `.env.default` ships and `make dev` copies to `.env` on first run. The server coordinates come from whatever `resolveConnection()` resolves, so `PIPELINE_TEST_DATABASE_URL` still chooses **which server** — and no longer chooses the target. |

Absent both, the suite **skips**. There is deliberately no fallback to the
application connection: that connection is the operator's archive, and running
without a database of our own is the failure mode, not a degraded mode.

### The corpus

A fresh database has no events, so `loopCorpus.ts` seeds three of them — two
commerce corpora for the promote sections and one larger timeline corpus for the
scale section, each under its own user. The mix (7 purchases : 2 order rollups :
1 excluded row, interleaved) is roughly the appliance's own, so both branches of
`ObjectPromoteStage`'s extraction rule are reached and the skip vocabulary stays
observable.

What is lost, and named where the spec reports its numbers: the absolute scale.
`PIPELINE_TEST_SCALE_EVENTS` (default `30_000`) sizes the scale corpus. A number
about a 324,044-row appliance has to be measured **on** that appliance with a
read-only tool — which is the shape `realData.integration.spec.ts` already has.

---

## What is real and what is faked

**Real**, and exercised as shipped:

- Postgres, and therefore every statement in `PipelineStateService` —
  `ON CONFLICT … WHERE`, `unnest()` over parallel arrays,
  `make_interval(secs => …)`, the `power(2, attempts - 1)` backoff, the coverage
  `GROUP BY`.
- `PipelineDispatchService` — the keyset chain, the hop ceiling, the
  cursor-advance assertion, `MAX_SLICES_PER_SWEEP`.
- `PipelineSliceListener` — claim → run → reconcile → complete, and the throw
  path that fails the ledger rows and writes `ci.pipeline_dead_letters`.
- `StageRegistry` and its resolution guards; `versions.ts` and `stageVersion()`.

**Faked**, deliberately:

- **pg-boss → `HarnessQueue`.** `send`/`sendMany` only enqueue; nothing runs
  until the harness drains, exactly as with a queue. Fetch order is pg-boss's
  own (`priority DESC, created_on`).

  It is *not* `LocalEventService`, which executes listeners inline at the call
  site. Under that, the dispatcher's self-requeue becomes direct recursion, and
  the FIFO-behind-the-slices ordering that the pipeline's entire backpressure
  story rests on never exists to be observed. Draining explicitly reproduces the
  ordering *and* lets a test count hops, count slices, and see which ids each
  slice carried.

- **The stage.** One synthetic stage over one synthetic source table
  (`id`, `user_id`, `content_type`, `width`), shaped like `ci.files`. The test
  supplies its per-id decisions. `width` is the stage's OUTPUT column and exists
  for exactly one reason: to prove that a row which already HAS a width is still
  re-selected once the ledger says the stage is behind — the repair the old
  `width IS NULL` predicate made impossible.

- **`LoggerService`.** Replaced with a silent double, because the real one
  builds a pino logger with a `pino-pretty` transport, and a transport is a
  worker thread that jest reports as an open handle.

The synthetic stage is registered into `STAGE_REGISTRY` and `STAGE_VERSIONS` **at
runtime**, and removed at teardown. That is on purpose: the boot guard insists
those two maps agree, so a permanently-committed test stage would have to be
declared in `constants.ts` and would then show up in `GET /api/pipeline/state` on
a real appliance at 0 % coverage forever. Jest gives every test *file* its own
module registry, so the mutation is invisible to every other spec — including
`StageRegistry.spec.ts`, which asserts over the same maps.

---

## Writing a test with it

```ts
import { PipelineHarness, databaseAvailability } from './harness/pipelineHarness';

const availability = databaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

describeWithDatabase('my stage property', () => {
  let harness: PipelineHarness;

  beforeAll(async () => {
    harness = await PipelineHarness.start();
    await harness.seed(25); // 25 applicable rows + 2 decoys
  });

  // ALWAYS. The ledger rows live in the real ci.pipeline_state.
  afterAll(async () => {
    await harness.teardown();
  });

  it('does the thing', async () => {
    harness.setBehaviour((_ctx, ids) => new Map(ids.map((id) => [id, { outcome: 'done' }])));

    const report = await harness.sweep({ sliceSize: 4 });

    expect(report.slices).toBe(7);
    expect(new Set(report.dispatchedIds).size).toBe(25);
    expect(await harness.coverage()).toMatchObject({ total: 25, done: 25 });
  });
});
```

### API

| Member | Does |
| --- | --- |
| `PipelineHarness.start(opts?)` | Connect, create the throwaway schema, register the synthetic stage, compile the Nest module. `opts.queue`, `opts.behaviour`. |
| `seed(n, opts?)` | `n` applicable `image/jpeg` rows for `userId`, plus (by default) one `application/pdf` decoy and one row for `otherUserId`. Returns the applicable ids in sweep order. |
| `seedRows(rows)` / `sourceRows()` | Arbitrary rows in, everything back out. |
| `setBehaviour(fn)` | What the stage decides for a slice. Takes effect on the next slice. |
| `widthWriter(n)` | A behaviour that writes the OUTPUT column and reports `done`, like a real enricher. |
| `sweep({ sliceSize?, userId? })` | `startSweep` + `drain`: one full pipeline run. Returns a `DrainReport`. |
| `drain()` | Work the queue to exhaustion. Slice errors are collected, not thrown — a queue would move on, and the state the failure left behind is the state worth asserting. |
| `ledgerRows()` / `ledgerById()` | `ci.pipeline_state` for this harness's stage. |
| `coverage()` | The real `PipelineStateService.coverage()`. |
| `deadLetters()` | `ci.pipeline_dead_letters` for this harness's stage. |
| `stageVersion()` / `bumpStageVersion()` | Read and increment the re-run watermark — the same mutation a one-line commit to `versions.ts` makes. |
| `invocationLog()` / `processedIds()` / `resetInvocations()` | What the stage was actually handed. |
| `queueDouble` | The `HarnessQueue`: `history()`, `historyOf(name)`, `depth()`, `clearHistory()`. |
| `teardown()` | Drop the schema, delete the ledger and dead-letter rows, unregister the stage, close everything. |

`sourceId(n)` builds the ordered uuids the harness seeds
(`00000000-0000-4000-8000-<n padded to 12>`). Lowercase hex uuids compare
byte-wise in Postgres and lexically in JavaScript in the *same* order, so a test
can predict which ids land in which slice.

---

## What the suite currently pins

`pipeline.integration.spec.ts`, 31 tests in seven blocks:

1. **A stage end to end** — one terminal ledger row per applicable entity at the
   current version, with `attempts = 1` and the user denormalized; the
   applicability predicate and the user scope both hold; coverage reads 1.0;
   slices are bounded.
2. **The claim, seen from inside the stage** — mid-flight rows are `running` at
   **`stage_version = 0`**. That zero is what rescues a row abandoned by a killed
   worker, and it is only observable from inside `run()`.
3. **Keyset paging over more rows than one slice** — 25 rows at 4 per slice:
   7 slices across 2 hops, every id dispatched exactly once in keyset order, and
   the next hop queued *behind* the slices it produced (the backpressure).
4. **Idempotence** — a second sweep at an unchanged version enqueues zero
   slices, never calls the stage, and leaves every `updated_at` byte-identical.
5. **The bump** — a corpus whose output column is fully populated (so the old
   `width IS NULL` predicate calls it finished forever) goes stale the instant
   the version is incremented, is re-selected in full, and lands at the new
   version with `attempts = 2`.
6. **A stage that throws** — the error propagates (so pg-boss's retry still
   applies), the claimed rows land `failed` *with a reason* instead of stranded
   `running`, the retry gate is ~60 s out, a replayable dead letter is written
   with the payload intact, the rows stay out of the next sweep while the gate is
   in the future, and come back when it is due.
7. **Outcomes and reasons** — skips and failures persist their reason and land in
   the right coverage buckets; an id the stage said *nothing* about is recorded
   `failed: stage_returned_no_result` and never as success; a skip with no reason
   is refused before anything is written.

## Not covered yet

Named so nobody mistakes the harness for more than it is:

- `PGBossEventService`'s fetch/complete/fail loop. `PGBossEventService.spec.ts`
  still covers `sendMany` only; this harness replaces pg-boss rather than
  driving it.
- `DeadLetterReaperListener` (it reads `pgboss.job`, which needs a real pg-boss).
- `ci.pipeline_runs` / `ci.pipeline_shards` — not by *this* harness.
  `enrichmentLoop.integration.spec.ts` drives both, over a scratch database.
- `JobMonitorService`, `IngestResetService`, `SyncOrchestrator`,
  `MaintenanceOrchestratorService` — still without specs.
- Concurrency. The claim's `ON CONFLICT … WHERE` guard is exercised, but not two
  workers racing the same slice; that wants two connections and a barrier.
