# `domains/pipeline`

One durable, versioned ledger (`ci.pipeline_state`) and one generic worker
(`PipelineSliceListener`), replacing a dozen hand-written enrichment legs that
each answered "has this run?" by looking at the column they write.

Read this before adding a stage. The full design — ten phases, every enricher,
the data model, the migration and backfill plan — is
[`docs/jobs-system-rebuild-plan.md`](../../../../../../docs/jobs-system-rebuild-plan.md).

| File | What it is |
| --- | --- |
| `constants.ts` | Queues, stage ids, slice sizes, leases, retry policy. Everything DECLARED, nothing discovered. |
| `versions.ts` | `STAGE_VERSIONS` — the re-run watermark. The point of the whole rebuild. |
| `schedule.ts` | `STAGE_SCHEDULES` — per-stage `trigger` / `cost` / `window` / `minInterval` / `maxStaleness` / `perRunCap`, plus `stageDueness()` and the boot guard `assertStageSchedules()`. |
| `types.ts` | The `Stage` contract, `StageResult`, `StageSource`, `StageSchedule`, and the event payload schemas. |
| `events.ts` | The pipeline's event surface: `pipeline.slice`, `pipeline.sweep`, `pipeline.dead_letter.reap`. |
| `services/PipelineStateService.ts` | The ledger. The only writer of `ci.pipeline_state` and the home of THE ONE RULE. |
| `services/StageRegistry.ts` | `STAGE_REGISTRY` (id → DI token) plus every boot-time guard that keeps the declarations honest. |
| `services/PipelineDispatchService.ts` | The keyset sweep, as a durable chain of self-requeuing jobs. |
| `services/PipelineControlService.ts` | The control tick and the run/shard runner: what to start for whom, `STAGE_DEPENDENCIES`, pause/resume/cancel, the lease reaper. |
| `services/PipelineRunService.ts` | `ci.pipeline_runs` / `ci.pipeline_shards` persistence behind the runner. |
| `services/EnrichmentWindowService.ts` | Whether the nightly enrichment window is open, from a zoned wall clock + `ci.pipeline_turns`. |
| `services/BackpressureService.ts` | `QUEUE_READY_CAPS` — the admission gate that stops the pipeline committing more work to a queue than it can re-decide. |
| `controllers/PipelineController.ts` | The operator HTTP surface (state, runs, pause/resume/cancel, dead letters + replay, quarantine release). |
| `listeners/PipelineSliceListener.ts` | THE generic worker. One class serves every stage that will ever exist. |
| `listeners/PipelineTickCron.ts` | The five-minute control tick (`20 */5 * * * *`), advisory-locked, calling whatever is bound to `PIPELINE_TICK`. |
| `listeners/StageArrivalListener.ts` | `ARRIVAL_SIGNALS` — turns domain create/update events into sweeps for `onArrival` stages. |
| `listeners/SearchIndexSweepRequestListener.ts` | Consumes `maintenance.search-index-backfill-request` (emitted by the importer's push stage) and starts the matching `index.*` sweeps. |
| `listeners/GraphEdgeSweepRequestListener.ts` | The same shape for the `promote.edge_*` matrix. |
| `listeners/DeadLetterReaperListener.ts` | Copies pg-boss's dead-letter queue into `ci.pipeline_dead_letters`, which nothing had ever read — and, on the same tick, reclaims the letters that have already been replayed. |
| `stages/<phase>/*.ts` | The stages themselves. Pure processing: ids in, decisions out. |
| `entities/*.ts` | TypeORM mirrors of the control-plane tables. The SQL migrations are the source of truth. |
| `__tests__/harness/README.md` | The integration harness — a real stage, a real Postgres, a fake queue. |

Schema: `20260809032723_create_pipeline_control_plane.sql` is the original five tables;
`20260809183010_identifier_claims.sql`, `20260809194756_create_pipeline_turns.sql`,
`20260810050759_create_pipeline_schedule.sql` and
`20260817210353_prefill_index_pipeline_ledger.sql` are the rest, all under
`backend/apps/api/db/postgres/migrations/`.

> ⚠️ **The controller's prefix is unusual — check it before you write a client.**
> `PipelineController` is declared `@Controller('api/pipeline')`, so Nest serves these
> routes at `/api/pipeline/...`. Both ingress paths strip a leading `/api` before
> proxying (`infrastructure/gateway/nginx.conf:132`, `scripts/dev-stack/index.ts:225`),
> and every other domain therefore declares the bare name (`@Controller('import')`,
> `@Controller('files')`, `@Controller('jobs')`) and is reached from a browser as
> `/api/import`, `/api/files`, `/api/jobs`. On the same reasoning a browser request to
> `/api/pipeline/...` arrives here as `/pipeline/...`. `MaintenanceController` has the
> same shape and is only ever called with curl inside the container, where the prefix is
> right. **Read from the decorators and the proxy config, not runtime-tested** — verify
> against a running stack before documenting a public path or filing a fix.

---

## Why this exists — the nullability ratchet

Every enrichment leg in this codebase encoded "has this run?" as a nullability
predicate on the column it writes. These are the real predicates, as they stand
in the repo today:

| Leg | Candidate predicate |
| --- | --- |
| `domains/maintenance/services/SearchIndexBackfillService.ts:458` (and `:479`) | `LEFT JOIN ci_search.embeddings e … LEFT JOIN ci_search.index_skips k … WHERE e.entity_id IS NULL AND k.entity_id IS NULL` |
| `domains/geocode/listeners/GeocodeBatchListener.ts:404` | `query.andWhere('event.location_coordinates IS NULL')` |
| `domains/maintenance/services/LocationEstimateService.ts:124` | `e.location_coordinates IS NULL` |
| `domains/files/listeners/MediaDimensionsBackfillListener.ts` (pre-conversion) | `file.variant = 'ORIGINAL' AND file.key IS NOT NULL AND file.width IS NULL` |
| `domains/maintenance/services/CommunicationLinkBackfillService.ts:210`, `:259` | `(from_entity_id IS NULL OR to_entity_ids IS NULL OR cardinality(to_entity_ids) = 0)` |
| `domains/maintenance/services/PersonStubBackfillService.ts:242`, `:299` | `(from_entity_id IS NULL OR to_entity_ids IS NULL OR cardinality(to_entity_ids) = 0)` |
| `domains/maintenance/services/EventParticipantBackfillService.ts:126-129` | `organizer_entity_id IS NULL OR participant_entity_ids IS NULL OR cardinality(participant_entity_ids) = 0` |

Four predicate shapes, seven legs, one defect: **the predicate that FINDS work
is the predicate that DECLARES it done.** Three consequences follow, and none of
them is fixable at the call site:

1. **The first — worst — answer an enricher ever produced is permanent.** The
   moment a row gets a width, a coordinate or a vector it leaves the candidate
   set forever. A better geocoder, a better decoder, a fixed participant matcher
   and a new embedding model all apply only to rows that happen to arrive
   afterwards. `GeocodeBatchListener` states it outright in a comment: *"a
   resolved coordinate is never re-billed"* — so the coarse city-centroid hits
   tagged at confidence ≤ 0.4 are frozen for the life of the appliance.
2. **"Tried and legitimately produced nothing" is indistinguishable from "never
   tried".** A corrupt JPEG, or a HEIC variant the bundled libheif cannot parse,
   stays NULL — so it is re-fetched from object storage and re-decoded on every
   single run, forever. A `ZERO_RESULTS` geocode re-qualifies on every run and
   occupies a slot in the daily budget indefinitely. The convergence hack for
   this is `ci_search.index_skips`: an entire second table whose only job is to
   stop the anti-join re-finding deliberate skips.
3. **There is no answer to "is my import finished?"** because nothing counts
   anything. `IngestStatusService` counts the depth of one pg-boss queue;
   `JobMonitorService` reads `pgboss.archive`. Neither can say whether any
   particular row was ever processed, which is how `content` sat at zero
   embedded rows unnoticed.

### Why "just add a column" was not enough

The obvious repair is a boolean or a timestamp on the target table —
`width_probed_at`, `geocoded_at`. It fails on every count:

- **It still can't re-open history.** A timestamp answers "when", not "by what".
  Improving the enricher makes every existing timestamp wrong in a way no
  predicate can express. You would need a *version* column, per stage, per
  table — and then a migration and a code change every time a new stage touches
  a table it did not previously touch.
- **It scales as (tables × stages), not as stages.** Eleven ENRICH stages over
  six typed tables is sixty-six columns, sixty-six backfills, and sixty-six
  chances for one of them to drift.
- **It has nowhere to put the reason.** `probe_failed`, `zero_results`,
  `too-short`, `unsupported_codec` — the whole vocabulary that makes a skip
  countable instead of invisible — does not fit in a nullable timestamp. That
  vocabulary is what turns "18.8k files, 2.1k still NULL" into "1,940
  `probe_failed`, 160 `object_storage_read_failed`, with the ids attached".
- **It has nowhere to put retry state.** Attempts, the backoff gate, quarantine.
  Today those are local variables inside a job, so they vanish when the process
  restarts.
- **It cannot record work on rows that do not exist yet.** GET-phase records land
  in `ci.source_records` before any typed row does.

`ci.pipeline_state` separates the three facts the predicate conflated: whether
the stage ran (`status`), what it decided (`status` + `reason`), and **which
version of the stage decided it** (`stage_version`). One table, keyed
`(entity_type, entity_id, stage)`, for every stage that will ever exist.

---

## The one rule

> **A stage never asks the target column whether it has run. It asks the
> ledger.**

This is the canonical staleness sweep, from
`PipelineStateService.selectStale()`. Every stage shares it; no stage writes its
own:

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

The three arms of the middle clause **are** the re-processing policy:

- **no ledger row** — never offered to this stage, including entities that
  existed before the stage did;
- **`stage_version` below current** — the stage improved, so every earlier answer
  is provisional. This is the arm the rebuild exists for;
- **`failed` with a due retry gate** — transient failures come back on their own
  schedule, which survives a restart because it is a column and not a timer.

`done`, `skipped` and `quarantined` rows at the current version are excluded, so
a second sweep over a converged corpus returns nothing. That property is what
makes "is my import finished?" answerable at all.

The sweep reads exactly two tables: the source and the ledger. It must never
mention the column the stage writes, and it must never anti-join the stage's
output table — `LEFT JOIN ci_search.embeddings … WHERE e.entity_id IS NULL` is
the same ratchet wearing a different hat.

Your stage contributes exactly one thing to that query: the applicability
predicate, which says **what a row IS**, never what has been done to it.
`StageRegistry.assertApplicabilityPredicate` rejects a predicate that mentions
`pipeline_state` or the ledger alias `p.`, because reaching for it is natural, it
silently works, and it re-creates the ratchet inside the mechanism built to
remove it.

---

## The five stage namespaces

A stage id is `<phase>.<name>`. The prefix is a naming convention, not something
the code enforces — it makes a stage's position in the flow legible from its id
alone and makes coverage groupable.

**38 stages are registered today.** `constants.ts` `STAGE_IDS` is the authoritative
list; the counts below are what it holds.

| Namespace | Responsibility | In this repo today |
| --- | --- | --- |
| `get.*` | Land every source record as one addressable, replayable row before anything interprets it (`get.fetch`, `get.capture`, `get.materialize`). | Nothing. Phase 6, still not started. |
| `index.*` | Make a record addressable and findable: materialize raw → typed, register identity, build keyword and vector representations. | **14** — seven dense-embed legs (`index.embed` for content plus `index.embed_{communication,event,item,person,file,browser_activity}`) and the seven matching `index.vector*` tsvector legs. Both families share the text recipes in `search-ingress/searchTexts.ts` with the live listeners. |
| `enrich.*` | Derive facts the source did not supply. | **8** — `enrich.media_dimensions`, `enrich.geocode`, `enrich.event_reverse` (the coordinate → name direction over `ci.events`, which had no scheduled producer at all — see below), `enrich.position_reverse`, `enrich.estimate_location`, `enrich.person_link`, `enrich.event_person_link`, `enrich.unfurl` (link previews: oEmbed / Wikidata / OpenGraph into `ci.unfurls`). |
| `clean.*` | Reconcile competing assertions and repair normalization. | **3** — `clean.temporal_repair`, `clean.duplicate_detect`, `clean.identifier_normalize`. |
| `promote.*` | Project winning facts into the rich graph and object model. | **14** — `promote.place`, `promote.place_position`, `promote.object`, `promote.observation`, and the ten `promote.edge_*` legs of the deterministic edge matrix (one per source table). |

`STAGE_IDS` grows by **one entry per conversion**, deliberately. Declaring the
planned roadmap up front would make the status endpoint report a dozen stages at
0 % coverage that no code can ever advance.

**Ids are permanent.** The id is the third component of `ci.pipeline_state`'s
primary key. Renaming one abandons every ledger row written under the old name:
the sweep stops finding them, coverage silently drops to zero, and the whole
corpus is re-processed under the new id. If a stage's meaning changes, bump its
version. If it is genuinely a different stage, add a new id.

### Queues

Three, one per **resource class** — not one per stage. Effective global
concurrency on the appliance is 10 in-flight jobs across every queue
(`config/default.json` → `queues.concurrency`), so more queues than resource
classes buys nothing but scheduling noise.

| Queue | Bound by | Use it when |
| --- | --- | --- |
| `pipeline-index` | Postgres | Cheap, high-throughput ledger and index writes. Also carries the pipeline's own housekeeping (sweeps, dead-letter reaps). |
| `pipeline-enrich` | Local CPU + object storage + external providers | Probes, document parsing, geocode. Slow, bursty, most likely to block for minutes. |
| `pipeline-embed` | Ollama | The single host Ollama process is shared with interactive chat, HBPE and the summary sidecar. Isolated so a full-corpus re-embed cannot take every global slot. |

---

## How to add a stage

A stage is **declared in five places** — `STAGE_IDS`, `STAGE_VERSIONS`,
`STAGE_SCHEDULES`, `STAGE_REGISTRY` and a module's `providers` — and
**implemented in one class**. Every omission has a guard; the table at the end of
this section says which one fires for which mistake.

### 1. Declare the id — `constants.ts`

```ts
export const STAGE_IDS = {
  ENRICH_MEDIA_DIMENSIONS: 'enrich.media_dimensions',
  /** Build the tsvector for ci.content rows. Postgres-bound; no external call. */
  INDEX_VECTOR: 'index.vector',
} as const;
```

### 2. Declare the version — `versions.ts`

```ts
export const STAGE_VERSIONS: Record<StageId, number> = {
  [STAGE_IDS.ENRICH_MEDIA_DIMENSIONS]: 1,
  /** v1 — initial conversion. Bump when the document builder changes shape. */
  [STAGE_IDS.INDEX_VECTOR]: 1,
};
```

Start at 1, never 0. A module-load guard enforces it; the reason is in
[crash recovery](#idempotency-and-crash-recovery).

### 3. Declare the schedule — `schedule.ts`

```ts
export const STAGE_SCHEDULES: Record<StageId, StageSchedule> = {
  [STAGE_IDS.INDEX_VECTOR]: {
    trigger: 'scheduled', // 'onArrival' | 'scheduled' | 'manual'
    cost: 'cheap', //        'cheap' | 'contended' | 'metered'
    window: 'any', //        'any' | 'enrichment'
    minInterval: 1 * HOURS, // floor: do not re-sweep this leg sooner
    maxStaleness: 6 * HOURS, // ceiling: once overdue, the window stops applying
    // perRunCap: 1_000,     // REQUIRED for cost: 'metered'
  },
};
```

`assertStageSchedules()` throws at module load for a registered stage with no
schedule, a schedule for an unknown id, a `maxStaleness` below `minInterval`, or
a metered stage with no `perRunCap`. The control tick will only ever start a
stage whose `trigger` is not `manual` (`automaticStageIds()`); metered stages are
**not** excluded from that set — cost discipline is `minInterval` +
`window: 'enrichment'` + `perRunCap`, enforced by the guard rather than by
unreachability.

Two optional declarations sit alongside it, each with its own module-load guard:
`STAGE_DEPENDENCIES` (`services/PipelineControlService.ts`), which orders
producers before consumers inside a run, and `ARRIVAL_SIGNALS`
(`listeners/StageArrivalListener.ts`), which is what actually makes
`trigger: 'onArrival'` true — declaring `onArrival` with no signal promises a
fast path that does not exist.

### 4. Declare the token — `services/StageRegistry.ts`

```ts
export const STAGE_REGISTRY: Record<StageId, string> = {
  [STAGE_IDS.ENRICH_MEDIA_DIMENSIONS]: 'PipelineStage:enrich.media_dimensions',
  [STAGE_IDS.INDEX_VECTOR]: 'PipelineStage:index.vector',
};
```

Tokens, not classes, so this file imports nothing from `../stages/` and cannot
acquire a module cycle.

### 5. Implement the stage — `stages/<phase>/<Name>Stage.ts`

```ts
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';

import { PIPELINE_QUEUES, STAGE_IDS } from '../../constants';
import type { Stage, StageResult, StageSource } from '../../types';
import { stageVersion } from '../../versions';

/**
 * Applicability, NOT completion. This says what a row IS — a content row with
 * something worth indexing. Note that it constrains the stage's INPUT columns
 * only. It must never mention `ci_search.vectors`, the table this stage writes,
 * and never `ci.pipeline_state`: either way the row leaves the candidate set the
 * moment the stage succeeds, and a version bump could never bring it back.
 *
 * Spliced into the sweep as `AND (<predicate>)`, verbatim, so it must be a
 * trusted in-repo literal. Never build it from request input. Omit it entirely
 * and every row in the table is a candidate — which is what
 * `INDEX_EMBED_SOURCE` does.
 */
export const INDEX_VECTOR_SOURCE: StageSource = {
  schema: 'ci',
  table: 'content',
  idColumn: 'id',
  userColumn: 'user_id',
  predicate: 's.text IS NOT NULL OR s.title IS NOT NULL',
};

@Injectable()
export class VectorStage implements Stage {
  readonly id = STAGE_IDS.INDEX_VECTOR;

  /** From STAGE_VERSIONS, never hardcoded — a hardcoded version makes the bump a no-op. */
  readonly version = stageVersion(STAGE_IDS.INDEX_VECTOR);

  /** Postgres-bound: one bulk UPDATE per slice, no external call. */
  readonly queue = PIPELINE_QUEUES.INDEX;

  readonly entityTypes = ['content'] as const;

  readonly source = INDEX_VECTOR_SOURCE;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(VectorStage.name);
  }

  /**
   * One result per id, always. Ids this returns nothing for are recorded
   * `failed: stage_returned_no_result` by the worker — silence is never success.
   *
   * Must be idempotent: two dispatchers can legitimately hand the same id to two
   * workers, and the claim de-duplicates the common case but is not a lock.
   */
  async run(ctx: UserServiceContext, ids: string[]): Promise<Map<string, StageResult>> {
    const results = new Map<string, StageResult>();

    // User-scoped even though the sweep already was: a slice can arrive from a
    // dead letter replayed weeks later, and re-scoping is the difference between
    // "this id is not yours" and indexing someone else's row.
    const rows = await this.dataSource.query<Array<{ id: string; text: string | null; title: string | null }>>(
      `SELECT c.id, c.text, c.title
         FROM ci.content c
        WHERE c.id = ANY($1::uuid[]) AND c.user_id = $2::uuid`,
      [ids, ctx.userId],
    );

    const byId = new Map(rows.map((row) => [row.id, row]));

    // Answer for the ids that came back with no row FIRST, so the map is
    // complete even if the work below throws in a way this does not model.
    for (const id of ids) {
      if (!byId.has(id)) {
        // Deleted or re-owned between the sweep and the slice. A skip, not a
        // failure: there is nothing to retry and nothing was lost.
        results.set(id, { outcome: 'skipped', reason: 'source_row_missing' });
      }
    }

    for (const row of rows) {
      const document = [row.text, row.title].filter((part) => part?.trim()).join(' ');

      if (document.length === 0) {
        // A skip WITH a reason. This is the row that used to simply be absent
        // from the index, indistinguishable from one that failed and one that
        // was never reached.
        results.set(row.id, { outcome: 'skipped', reason: 'empty' });
        continue;
      }

      // …one bulk upsert into ci_search.vectors for the whole slice, then:
      results.set(row.id, { outcome: 'done' });
    }

    return results;
  }
}
```

What a stage is **not**: it never touches pg-boss, never enqueues, never reads
the ledger and never writes `ci.pipeline_state`. It has no candidate query, no
keyset cursor, no page loop, no batch counters, no retry policy and no
`catch { log; continue }`. All of that lives in the dispatcher, the worker and
the ledger, once, for every stage — which is what stops the fifteenth enricher
from inventing a fifteenth pagination strategy.

Rules the contract enforces:

- **Every id gets exactly one `StageResult`.**
- **`skipped` and `failed` MUST carry a `reason`** — a stable, greppable token
  (`probe_failed`, `zero_results`, `unsupported_codec`), not a sentence.
  `PipelineStateService` throws before writing anything if one is missing.
- **Never throw for one entity.** A throw fails the whole slice: every claimed id
  gets the same reason and charges an attempt. Model per-entity failure as a
  `failed` result. Throw only for something that genuinely invalidates the slice.
- **`confidence` is `(0, 1]` and optional.** Never fabricate one — an enricher
  reporting 0.9 because it felt right teaches promotion to prefer it over a
  genuinely-measured 0.8.

### 6. Bind the implementation — `index.ts`

```ts
const stageProviders: Provider[] = [
  { provide: STAGE_REGISTRY[STAGE_IDS.INDEX_VECTOR], useClass: VectorStage },
];
```

A stage may equally be bound from its own domain module — `StageRegistry`
resolves non-strictly (`{ strict: false }`) — which is the right home for one
that needs services that module already wires. Watch for cycles: a stage that
imports another domain's barrel cannot be bound from `PipelineModule` if that
domain imports the pipeline's.

### 7. Write the spec

Unit-test `run()` against fakes (`stages/__tests__/*.spec.ts`), then use the
integration harness for anything about the ledger — see
[`__tests__/harness/README.md`](./__tests__/harness/README.md). The harness
registers a synthetic stage into the real maps at runtime and runs it against a
real Postgres with a fake queue.

### 8. Start a sweep

```ts
await pipelineDispatchService.startSweep({
  stage: STAGE_IDS.INDEX_VECTOR,
  userId,
  // entityType is required ONLY for a stage declaring more than one type.
});
```

`startSweep` returns as soon as the first hop is enqueued. Progress is read from
`PipelineStateService.coverage()`, not from a return value — that is the whole
point of making it durable. A sweep is a chain of jobs: each hop enqueues up to
`MAX_SLICES_PER_SWEEP` (5) slices of `DEFAULT_SLICE_SIZE` (200) ids, then
re-enqueues itself **behind them on the same queue at the same priority**, so it
paces itself to the workers' real throughput. FIFO ordering is still the base
mechanism; on top of it `BackpressureService` measures each queue's *ready* depth
against `QUEUE_READY_CAPS` (`pipeline-index` 500, `pipeline-enrich` 100,
`pipeline-embed` 25) and refuses admission above the cap, so the pipeline never
commits more work than it can re-decide on the next tick.

### What tells you when you forget a step

| Omission | What fires, and when |
| --- | --- |
| Id in `STAGE_REGISTRY` but not `STAGE_VERSIONS` (or vice versa) | `assertStageRegistryComplete()` throws **at module load**, naming the symmetric difference in both directions. |
| Id not in `STAGE_IDS` | Typecheck: `STAGE_REGISTRY` and `STAGE_VERSIONS` are `Record<StageId, …>`. |
| Version 0, or fractional | `versions.ts` throws at module load. (0 strands crashed workers; `1.5` truncates to 1 in Postgres, so the bump is a no-op.) |
| Id in `STAGE_IDS` but not `STAGE_SCHEDULES` (or vice versa) | `assertStageSchedules()` throws **at module load**, naming both directions. It also refuses `maxStaleness < minInterval`, a metered stage with no `perRunCap` or outside the enrichment window, and `onArrival` with a non-`any` window. |
| Declared but no provider bound | `StageRegistry.get()` throws at the first sweep or slice, with the exact `{ provide: …, useClass: … }` line to add. |
| `readonly version = 1` hardcoded | `assertConsistent` throws on first resolve — a hardcoded version makes bumping the constant silently do nothing. |
| `stage.id` ≠ registry key | Throws: the id is part of the ledger's primary key. |
| Queue not one of `PIPELINE_QUEUES` | Throws: slices sent to an unworked queue sit until retention deletes them. |
| Empty `entityTypes`, or a missing `source.{schema,table,idColumn,userColumn}` | Throws: those four are interpolated into the sweep, and a missing one produces a query that is syntactically valid over the wrong rows. |
| Predicate starting with `AND`, containing `;`, or mentioning `pipeline_state` / `p.` | Throws, with the ratchet explained. |
| `source.changedAtColumn` that is not a plain column name | Throws at first resolve. A declared column the table LACKS is only caught at query time, where the tick logs it per leg and carries on. |
| Multi-type stage swept without an `entityType` | Both the dispatcher and `selectStale` refuse — guessing would record one type's progress under another's key. |

---

## How to re-enrich

**Change the enricher, then increment its integer in `versions.ts`, in the same
commit.** That is the entire mechanism. There is no backfill script, no
`DELETE FROM`, no truncate, no `retryNull` flag and no `forced` boolean.

```diff
-  [STAGE_IDS.ENRICH_MEDIA_DIMENSIONS]: 1,
+  // v2 — HEIC support; re-probes everything recorded `skipped: probe_failed`.
+  [STAGE_IDS.ENRICH_MEDIA_DIMENSIONS]: 2,
```

The version and the code that justifies it must be reviewable together, or
nobody can tell which version produced which answer.

### Blast radius — read this before you push it

A bump makes **every ledger row for that stage below the new version a
candidate**. Not just the failures: `done`, `skipped` and `quarantined` all come
back, because `stage_version < $current` does not care what the old answer was.
That is the feature. It is also a real load event on a single appliance.

- On `enrich.media_dimensions`: every original image and video is re-fetched from
  Minio and re-decoded. Object storage and local CPU, bounded by
  `MAX_PROBE_CONCURRENCY` (4) per slice and by the `pipeline-enrich` queue.
- On `index.embed`: **the entire corpus is re-embedded through one Ollama host
  process** that is also serving interactive chat, HBPE and the summary sidecar.
  Hours of contended GPU time. The `pipeline-embed` queue exists precisely so
  this cannot take every global worker slot, but it will still be felt.
- On any stage with an external provider: a bump is a bill. `enrich.geocode`
  re-geocodes rows whose coordinates were never going to be re-billed, and
  `enrich.event_reverse` / `enrich.position_reverse` re-name every coordinate
  the provider ever answered for.

**Get the candidate count before you get the bill.** Every ledger row currently
at or above the version you are replacing is what the bump re-opens:

```sql
-- What a bump of this stage will re-process:
SELECT status, count(*)
  FROM ci.pipeline_state
 WHERE stage = 'enrich.media_dimensions'
   AND stage_version >= 1          -- the version you are about to supersede
 GROUP BY status
 ORDER BY 2 DESC;
```

Rows with no ledger entry at all are already candidates and are unaffected by the
bump. `PipelineStateService.coverage()` reports the same shape programmatically,
including a `stale` count measured against the current version.

### Two rules that are not negotiable

- **Versions only ever go UP.** Rolling one back leaves already-processed rows
  looking stale-*forward*: their recorded `stage_version` exceeds the current
  one, `stage_version < $current` is false, and they are never re-selected
  again — including by the *next* bump, until it climbs past the abandoned
  high-water mark. A bad version is superseded by v+1; it is never reverted.
- **Versions start at 1.** See below.

### Deriving a version instead of choosing one

`index.embed` does not hardcode its version: it derives it from
`(model, dimension)` via `EMBED_MODEL_GENERATIONS`, so **switching
`CI_EMBED_MODEL` is itself the re-embed**. Without that, changing the model
leaves old rows holding `nomic-embed-text` vectors and new rows holding the new
model's, in the same 768-dimensional cosine space, silently, forever.

Note what it deliberately does *not* do: `version = hash(model)`. A hash is
uniformly distributed, so switching models has a ~50 % chance of moving the
version **down**, which by the rule above would pin the whole corpus to the old
model permanently. Generations are declared and append-only, and an undeclared
model is a hard failure at boot with the exact line to add.

### When the source row changes: `source.changedAtColumn`

A version records which **rule** produced an answer, not which **input**. For a
stage over rows that never change after they land that is all it needs; for a
stage whose output is a copy of a row that does change, the first answer
outlives the row it describes until someone bumps the version for an unrelated
reason. `enrich.person_self_claim` was that stage: every number a re-import,
merge or edit dropped from a Person kept its self claim, and
`clean.duplicate_detect` re-proposed pairs on it at every scoring bump.

A stage in that position declares the timestamp its inputs' writers bump:

```ts
export const PERSON_SELF_CLAIM_SOURCE: StageSource = {
  schema: 'ci',
  table: 'entities',
  idColumn: 'entity_id',
  userColumn: 'owner_user_id',
  predicate: `entity_type = 'Person'`,
  changedAtColumn: 'updated_at',
};
```

On each tick where the leg is due, the control tick calls
`PipelineStateService.reopenChangedSources`, which re-opens (`stage_version = 0`,
through the same `reopen()` `IdentifierArrivalService` uses) every `done` /
`skipped` row at the current version whose source row was stamped after the row
was decided — `ci.pipeline_state.updated_at`, less
`SOURCE_CHANGE_GRACE_SECONDS` for a change that committed while its slice was
running. The re-opened rows then go through THE ONE RULE like any other.

This is not the ratchet. The stamp is an INPUT column the stage never writes,
it lives outside the applicability predicate, and nothing the stage does moves
it. Declare it only when every writer of the stage's inputs bumps it, when
nothing bumps it at a high rate for reasons the stage ignores, and when a
re-run is cheap — a bulk re-import changes thousands of rows at once. Its cost
on a converged leg is one more pass of the scan `hasCandidates` already makes
for that leg, per tick.

A stage that RETRACTS output on re-run needs one more thing: an applicability
predicate that still reaches a row which has lost everything. The self-claim
stage applies to every Person row, merged or not, because the moment a Person
is merged away or edited down to nothing is exactly when its claims must go.

---

## Idempotency and crash recovery

Three ledger writes bracket every slice. All three are **one statement** —
`unnest()` over parallel arrays, one `ON CONFLICT` upsert — so a 200-id slice is
one round trip. (The per-row version of this pattern is why the
communication-link backfill never finished over a 22-year history.)

| Call | Writes | Notes |
| --- | --- | --- |
| `claim(stage, entityType, ids, userId)` | `status='running'`, `attempts + 1`, `next_attempt_at = NULL`, `user_id` | Returns the ids **actually** claimed. Refuses rows another worker holds a live claim on, and rows already terminal at the current version. **Inserts `stage_version = 0` and never advances it** — see below. |
| `complete(stage, entityType, results)` | `stage_version = current`, `status`, `reason`, `attempts` / `transient_attempts`, retry gate for `failed` | A PERMANENT `failed` row whose `attempts` have hit `MAX_ATTEMPTS_BEFORE_QUARANTINE` (5) becomes `quarantined` in the same statement; a TRANSIENT one has its attempt refunded and cannot quarantine at all. Tally comes from `RETURNING`, so it reports what was actually written. |
| `fail(stage, entityType, ids, reason)` | Same, one shared reason for the whole slice | The slice-level counterpart, used when the failure is not attributable to any one row. Refuses an empty reason. |
| `releaseQuarantined(userId, { reasons, stage })` | `status='failed'`, `attempts = 0`, `transient_attempts = 0`, `next_attempt_at = now()` | Un-parks quarantined rows BY REASON — quarantine's only other exit is a version bump, which re-opens the whole corpus. Defaults to `TRANSIENT_FAILURE_REASONS`; an explicitly empty list releases nothing. Behind `POST /api/pipeline/quarantine/release`. |

### The most load-bearing zero in the subsystem

`claim()` inserts a literal `stage_version = 0` and leaves it alone on conflict.
A version is a claim about what produced a **result**, and a claim produces no
result — but the operational reason matters more:

> A row abandoned by a SIGKILLed worker sits at `status='running'`,
> `stage_version = 0`. Because the minimum live version is 1, `stage_version <
> $current` is true, so the next sweep re-selects it. If `claim()` stamped the
> version, that row would satisfy no arm of the staleness predicate and the
> entity would be stranded permanently — the exact failure mode the ledger
> exists to eliminate.

This is why `versions.ts` refuses a version of 0, and why the integration suite
asserts `stage_version = 0` from *inside* a running stage — it is only observable
mid-flight.

### What a killed worker actually costs

1. The process dies mid-slice. Rows already completed in earlier slices are
   already durable; the ledger rows for *this* slice stay `running` at version 0.
   Loss is bounded to one slice — which is what `DEFAULT_SLICE_SIZE` is sized
   for. It is about resumability, not throughput.
2. The next sweep re-selects those ids (arm 2 of the rule) and dispatches them.
3. `claim()` refuses them for up to `CLAIM_LEASE_SECONDS` (15 minutes), because
   from the ledger's point of view a `running` row that was updated recently
   might belong to a live worker. The slice returns having claimed nothing and
   does no work.
4. Once `updated_at` is older than the lease, the claim succeeds and the entities
   are re-processed. A crash costs one lease period, not a support ticket.

15 minutes is comfortably longer than the ~60 s a slice is sized for (so a
slow-but-live slice is never stolen mid-flight) and comfortably shorter than a
human noticing.

### Duplicate dispatch is absorbed, not prevented

Two overlapping sweeps — an operator clicking twice, a replayed dead letter
racing a live sweep — can hand the same id to two workers, because a claimed row
still satisfies the staleness predicate. The `ON CONFLICT … WHERE` guard lets
exactly one of them take the rows; the loser gets a shorter list and does
correspondingly less work. **This is a cooperative lease, not a distributed
lock** — stages must be idempotent, and correctness may never depend on the
claim.

### When a stage throws

`PipelineSliceListener` does four things, in this order, and the order is the
point:

1. `fail()` the claimed ids with `stage_threw: <message>` — so they carry a
   reason, an attempt count and a retry gate instead of being stranded `running`.
   Without this the next sweep re-runs them, they throw again, and the loop is
   permanent, invisible and self-renewing.
2. Write `ci.pipeline_dead_letters` with the payload **verbatim** — a dead letter
   that cannot be replayed byte-for-byte is just a log line. Written on *every*
   throw, not only the last: pg-boss retries three times and the informative
   error is frequently the first attempt's.
3. Log the error.
4. **Rethrow**, so pg-boss's own retry and dead-letter machinery still applies.
   This is a durable copy, not a replacement for it.

A payload that will not `zod`-parse is handled *outside* that try/catch: it has
no `stage` or `entityType` to record, so it goes straight to pg-boss's
dead-letter queue and `DeadLetterReaperListener` copies it into the same table
with the raw payload — the only version worth keeping for a parse failure.

### An unreplayed letter never expires; a replayed one does

`ci.pipeline_dead_letters` is written by a scheduled, batched producer —
`DEAD_LETTER_REAP_BATCH` (500) rows every two minutes, a 360k/day ceiling — and
it had no cap of any kind. `DeadLetterReaperListener.purgeReplayed` runs on the
reaper's own tick and deletes rows whose `replayed_at` is older than
`queues.replayedDeadLetterRetentionDays` (30 days;
`CI_REPLAYED_DEAD_LETTER_RETENTION_DAYS`), oldest first, bounded to
`DEAD_LETTER_PURGE_BATCH` (500) per tick — the same rate the harvest can fill, so
a backlog cannot outrun reclamation. `pipeline_dead_letters_replayed_idx` (partial,
`WHERE replayed_at IS NOT NULL`) is what keeps a tick that finds nothing free.

The scope is exactly `replayed_at IS NOT NULL`, and that is the whole design:

- a **replayed** letter has already been handed back to the bus. `replayed_at` is
  stamped only on a successful re-emit (`PipelineRunService.emitClaimedLetter`
  releases the claim on every failure path), and if the replayed job died again,
  pg-boss dead-lettered it again and the reaper harvested a NEW row. What ages
  out is the record that a replay happened, not the record itself;
- an **unreplayed** letter is never touched, at any age. Its payload is
  frequently the only surviving copy of a record the source will not re-send —
  the reason the table exists. Whether those should ever expire (a long TTL, or a
  per-`(queue, stage)` cap) is a product decision about acceptable data loss and
  is deliberately not made in code.

Retry policy lives in `constants.ts`: `RETRY_BACKOFF_BASE_SECONDS` (60), doubling
per attempt, capped at `RETRY_BACKOFF_MAX_SECONDS` (6 h), quarantine after
`MAX_ATTEMPTS_BEFORE_QUARANTINE` (5) attempts. The gate is a column, not a timer,
so it survives a restart. Quarantine is terminal for sweeps but **not a
tombstone**: a version bump re-selects quarantined rows along with everything
else, so a fixed enricher automatically re-admits the corpus it previously choked
on.

### Transient failures do not spend that budget

Five attempts at a 60 s doubling backoff is a budget spent 60 + 120 + 240 + 480 =
**900 seconds** after the first failure. That is the right sentence for a poison
record and the wrong one for an outage, and the ledger could not tell them apart:
a brief reverse-geocode provider outage once left **12,237 `ci.position` rows —
19 % of that corpus — `quarantined`**, unable to get an address, become a Location
entity, or reach the map.

So a failure is classified by its REASON. `TRANSIENT_FAILURE_REASONS` declares the
ones that describe the world rather than the row (`provider_unavailable`,
`ollama_unreachable`); everything else is permanent and behaves exactly as above.

| | permanent | transient |
| --- | --- | --- |
| counter | `attempts` (charged by `claim()`) | `transient_attempts` (`attempts` is REFUNDED) |
| backoff | 60 s × 2ⁿ, capped at 6 h | 15 min × 2ⁿ, capped at 6 h |
| terminal? | `quarantined` at 5 attempts | never |

Anything that is not another transient failure resets `transient_attempts`, so an
episode that ends leaves the next one starting at 15 minutes rather than the cap.

Two things this deliberately does **not** do. It does not raise the attempt limit
— that only delays the same failure. And it does not pattern-match error text: a
slice-level `stage_threw: connect ECONNREFUSED …` stays permanent, because
classifying an arbitrary message is a guess. `releaseQuarantined()` is the remedy
for those, applied by a human who knows what was broken.

Semantics are proven against a real database in `pipeline.integration.spec.ts`;
`__tests__/retryBudget.spec.ts` covers the policy from the bound parameters.

---

## What is NOT built yet

> **Re-verified against the tree on 2026-08-19.** Everything this section used to
> say — empty `stageProviders`, an unregistered `EmbedStage`, no controller, no
> tick, no runner, no `BackpressureService`, no seeding migration — has since
> landed. What follows is what is still genuinely absent. Do not assume a stage
> exists because the plan names it, and do not assume one is missing because an
> older revision of this file said so.

**Still absent:**

- **`get.*` is empty.** Phase 6 (GET consolidation, `ci.source_records`) has not
  started, so nothing lands a raw source record before interpretation.
- **`ci.record_rejections` has a table and an entity but no writer.** GET-phase
  validation is what fills it, so it stays empty until Phase 6.
- **`ci.derived_facts` does not exist.** `StageResult.confidence` and `.detail`
  are validated but **not persisted** — a stage may return them and they are
  simply dropped (`PipelineStateService.complete()` says so in place).
- **`DEAD_LETTER_QUEUE` is duplicated** between `domains/events/constants.ts` and
  this domain's `constants.ts`. They must stay identical or the reaper silently
  harvests nothing.
- **Phase 9 (demolition) has not started.** All seven legacy enrichment legs in
  the ratchet table above are still on disk and still wired, as is
  `LocalEventService`. `MediaDimensionsBackfillListener` has been reduced to a
  shim that converts `MediaDimensionsBackfillRequestEvent` into a pipeline sweep
  and returns immediately — so "the response came back, so the files are done"
  no longer holds — and the consumer of
  `maintenance.search-index-backfill-request` moved into this domain, but the
  services themselves are **superseded, not removed**.

**Phase status:**

| Phase | Scope | State |
| --- | --- | --- |
| 1–2 | Ledger, sweep, generic worker, dead-letter reaper, HTTP control plane. | Landed. `PipelineController` serves state, runs, pause/resume/cancel, dead letters + replay and quarantine release. |
| 3 | `enrich.geocode`, `enrich.position_reverse`, `enrich.estimate_location`; `ci.derived_facts`. | Stages landed; `ci.derived_facts` did not. `enrich.event_reverse` was added afterwards — the phase converted `GeocodeBatchListener`'s FORWARD sweep and left its reverse leg on the listener, where nothing scheduled ever ran it, so an event with a measured coordinate and no label never became a place. |
| 4 | `enrich.person_link` and `ci.identifier_claims`, replacing three byte-duplicated participant backfills. | Landed as `enrich.person_link` + `enrich.event_person_link`; the backfills they replace are not deleted (Phase 9). |
| 5 | Operator UI, pause/resume/cancel, the worker process split. | Runner + pause/resume/cancel landed in `PipelineControlService`; the worker split is `CI_ROLE` (`common/roles.ts`). There is no `PipelinePage` — dead letters surface on the Jobs page (`JobsPage/DeadLettersCard.tsx`). |
| 6 | GET consolidation: `ci.capture_events` → `ci.source_records`, per-provider mappers, ~30 `Transform*` services deleted. | Not started. |
| 7 | CLEAN: normalization, temporal repair, duplicate detection, tombstone repair, orphan and object reaping. | Three stages landed (`clean.temporal_repair`, `clean.duplicate_detect`, `clean.identifier_normalize`); tombstone repair and reaping did not. |
| 8 | PROMOTE: the rich graph and object model. | Landed — `promote.place`, `promote.place_position`, `promote.object`, `promote.observation` and the ten `promote.edge_*` legs. |
| 9 | Demolition — the old backfill services, `LocalEventService` — plus index hygiene. | Not started. |

---

## Further reading

- [`docs/jobs-system-rebuild-plan.md`](../../../../../../docs/jobs-system-rebuild-plan.md)
  — the full design. §2.6 is the ratchet inventory, §4.1 is the one rule, §4.7 is
  the five stages in detail, §11 is the phase plan, §12 the backfill plan.
- [`__tests__/harness/README.md`](./__tests__/harness/README.md) — the
  integration harness, what it fakes and why.
- `__tests__/theOneRule.spec.ts` — the staleness predicate, pinned arm by arm.
- `db/postgres/migrations/20260809032723_create_pipeline_control_plane.sql` — the
  five tables, with the reasoning for every index and the absence of every
  foreign key.
