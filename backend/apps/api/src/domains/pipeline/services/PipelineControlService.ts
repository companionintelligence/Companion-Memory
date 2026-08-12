import { hostname } from 'node:os';

import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { Cron } from '@ci/common/schedule';

import { SHARD_LEASE_SECONDS, STAGE_ID_LIST, STAGE_IDS, type StageId } from '../constants';
import {
  automaticStageIds,
  isMeteredStage as scheduleIsMeteredStage,
  meteredStageIds,
  stageDueness,
  type StageDueness,
} from '../schedule';
import type { Stage } from '../types';

import { EnrichmentWindowService } from './EnrichmentWindowService';
import { PipelineDispatchService } from './PipelineDispatchService';
import { PipelineRunService } from './PipelineRunService';
import { PipelineStateService } from './PipelineStateService';
import { StageRegistry } from './StageRegistry';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CONTROL TICK — the thing that makes any of the rest of this happen.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Before this file the pipeline was complete and INERT. Twelve stages resolve,
 * `PipelineDispatchService.startSweep()` works, `PipelineSliceListener` executes
 * slices, `PipelineRunService` manages runs — and **nothing called any of it**.
 * There was no cron, no scheduled caller and no route that started a sweep; the
 * only `@Cron` in the domain was the dead-letter reaper. `ci.pipeline_runs` had
 * never held a row, `ci.pipeline_shards` had never had a writer, and
 * `SHARD_LEASE_SECONDS` was declared and unused. A pipeline that cannot start is
 * indistinguishable from one that does not exist.
 *
 * This service is the only thing that starts work. Everything it does is one of
 * five obligations, and each of them exists because of a specific way the
 * control plane can wedge:
 *
 *  1. **Honour `desired_state`.** A paused or cancelled run starts nothing new,
 *     and a cancelled run is FINALISED — `pipeline_runs_active_uniq` is a
 *     partial unique index on `(user_id) WHERE finished_at IS NULL`, so a
 *     cancelled run left unfinalised locks that user out of ever starting
 *     another one, permanently, with no error anywhere.
 *  2. **Decide what is worth sweeping.** A sweep that finds nothing still costs
 *     an enqueue, a job fetch and a `LIMIT 200` staleness query per stage, and
 *     there are twelve stages. The tick probes with `LIMIT 1` first and starts
 *     nothing where nothing is stale.
 *  3. **Respect ordering.** {@link STAGE_DEPENDENCIES} declares which stages
 *     consume another's output. The tick reads that graph; it contains no
 *     hard-coded sequence.
 *  4. **Reap expired shard leases**, so a worker killed mid-slice costs one
 *     lease period instead of stranding its shard forever.
 *  5. **Be re-entrant.** Two overlapping ticks must not double-dispatch. Both
 *     guards live in Postgres, never in a field on this object — an in-memory
 *     flag is exactly what stops working the day the worker process is split
 *     out, which is the Phase 5 change this file is written to survive.
 *
 * ── Why the cron is safe with two replicas ─────────────────────────────────
 *
 * `@Cron` is `@nestjs/schedule`: in-process, and it fires in EVERY replica. That
 * is the documented blocker on splitting the worker out, and it is answered here
 * rather than avoided. Two things make a double fire a non-event:
 *
 *  - a session-level Postgres ADVISORY LOCK ({@link tick}) — the second tick
 *    takes no lock, does no probing, and returns. It is a real lock in a shared
 *    database, not a boolean in a process, and a backend that dies releases it,
 *    so a SIGKILLed tick cannot wedge the pipeline;
 *  - the SHARD LEASE ({@link claimStageShard}) — the correctness boundary. Even
 *    if two ticks somehow ran concurrently (a lock lost to a failover, a
 *    connection reset between lock and work), a stage leg is dispatched by
 *    whichever tick's `ON CONFLICT ... WHERE` won the row, and the other gets
 *    nothing back and starts nothing. The lock is an optimisation; the lease is
 *    the invariant.
 *
 * ── Cost discipline is structural, not advisory ────────────────────────────
 *
 * `enrich.geocode` and `enrich.position_reverse` egress through Portal to a paid
 * provider: a runaway loop there is a bill, not just load. They used to be
 * excluded from {@link defaultStageSet} outright, which made "costs money" and
 * "unreachable by a timer" the same statement — so the only cadence available to
 * a metered stage was never, and the user's actual request (geocode SLOWER) had
 * no expressible answer.
 *
 * They are now timer-reachable, and three declared numbers bound them instead of
 * one exclusion — all three read from `STAGE_SCHEDULES` and none of them
 * restated here:
 *
 *  - **`minInterval`** (7 days), enforced by {@link stageDueness} against the
 *    per-leg `ci.pipeline_schedule.last_started_at` this tick stamps and reads;
 *  - **`window: 'enrichment'`**, enforced by passing `EnrichmentWindowService`'s
 *    answer into the same call — one implementation of "is it 03:00 for this
 *    owner?", consulted here rather than re-derived;
 *  - **`perRunCap`**, carried into `startSweep` as `maxIds` and enforced by the
 *    dispatcher at slice granularity, so the size of a bill is bounded and not
 *    merely its frequency.
 *
 * The clock is the part with a trap in it, and the trap is why this needed a
 * table. `ci.pipeline_shards` is RUN-scoped: it CASCADEs with the run, and this
 * tick finalizes a run as soon as nothing is stale. A weekly interval measured
 * off a shard would therefore reset to never-run every few hours and a weekly
 * stage would be due on every tick — the invoice, arrived at by reusing a table.
 * `ci.pipeline_schedule` outlives runs, which is its entire job.
 *
 * ── What the tick deliberately does NOT do ─────────────────────────────────
 *
 * It never deletes a queued job, never touches pg-boss, and never writes
 * `ci.pipeline_state`. Cancel is a `desired_state` write plus shard teardown;
 * in-flight slices drain on their own and the ledger records whatever they
 * decided. Reaching into a queue to remove work always races a worker that has
 * already claimed it, which is the entire reason the schema separates the
 * control channel from the observed one.
 */

// ---------------------------------------------------------------------------
// Cadence and bounds
// ---------------------------------------------------------------------------

/**
 * Tick cadence.
 *
 * Every two minutes, at second 10 — deliberately off the top of the minute and
 * off the reaper's second 40. `SyncOrchestrator`, `AnswerInferenceCron` and
 * `McpController` all fire at second 0, and stacking a fourth scheduled job
 * there turns a quiet appliance into a periodic spike.
 *
 * Two minutes, not ten seconds: one tick costs one staleness probe per stage leg
 * (see {@link hasCandidates}), and on a converged corpus each of those is a full
 * anti-join over the source table — the measured worst case, because convergence
 * is the state an idempotent pipeline lives in permanently. Two minutes keeps
 * that under a percent of one core while still making pause and cancel feel
 * immediate at human scale.
 *
 * Declared here rather than in `constants.ts` only because that file belongs to
 * another change set; it belongs beside `DEAD_LETTER_REAP_CRON` and should move
 * there the next time that file is opened.
 *
 * ── If `PipelineTickCron` is wired, DELETE the `@Cron` on {@link tickOnSchedule} ─
 *
 * That listener is a timer whose only job is to take the cluster lock and call a
 * `PIPELINE_TICK` target, which this service is meant to be
 * (`{ provide: PIPELINE_TICK, useExisting: PipelineControlService }`). Both
 * timers driving the same body is not a correctness problem — every path goes
 * through this service's own advisory lock and then through the per-leg shard
 * lease — but it is two schedules for one loop, and the redundant one should be
 * this file's. `tick()` is the body; the timer is incidental to it, and it is
 * only here at all so that the pipeline is not left inert if that listener does
 * not land.
 */
export const PIPELINE_CONTROL_TICK_CRON = '10 */2 * * * *';

/** `kind` of the run the tick starts for itself when a user has stale work and no run. */
export const CONTINUOUS_RUN_KIND = 'continuous';

/**
 * Users examined by one tick.
 *
 * Users holding an active run are ordered first, so a bounded tick can never
 * starve a run somebody is watching in favour of an idle account. On this
 * appliance the real number is 1; the bound exists so the tick's cost stays
 * proportional to something knowable if that ever changes.
 */
export const MAX_USERS_PER_TICK = 25;

/**
 * Sweeps one tick may start, appliance-wide.
 *
 * Effective global concurrency is 10 in-flight jobs (`config/default.json` →
 * `queues.concurrency`), and one sweep hop enqueues up to `MAX_SLICES_PER_SWEEP`
 * (5) slices. Four sweeps therefore already queue more work than the appliance
 * can hold in flight; a fifth buys nothing but contention for the same ten
 * slots.
 *
 * Starved stages are not starved for long: a started leg holds its shard lease
 * for {@link SHARD_LEASE_SECONDS}, so the next tick skips it and picks the next
 * four stages in dependency order. The round-robin is emergent, not coded.
 */
export const MAX_SWEEPS_PER_TICK = 4;

/**
 * Shard leases reclaimed by one tick.
 *
 * Bounds one statement's work, exactly as `DEAD_LETTER_REAP_BATCH` does. In a
 * healthy system this matches nothing; the ceiling only engages while catching
 * up after a mass worker kill, which is precisely when not flooding the database
 * matters most.
 */
export const MAX_LEASES_REAPED_PER_TICK = 200;

/**
 * The advisory-lock key.
 *
 * `pg_try_advisory_lock(int4, int4)`, taken at SESSION level on a dedicated
 * connection and released in a `finally`. Session rather than transaction scope
 * because the tick enqueues pg-boss jobs and must not hold a transaction open
 * across them; a session lock still dies with the backend, so a SIGKILLed tick
 * releases it without anybody's help.
 *
 * `0x6369` is ASCII `ci` and is the CLASS half every advisory lock in this domain
 * shares — the same value `PipelineTickCron` declares as
 * `PIPELINE_ADVISORY_LOCK_CLASS`. Postgres advisory locks live in one flat
 * namespace shared by every session on the database and nothing warns about a
 * collision, so the class is a declared constant rather than a hash and the
 * OBJECT half must be distinct per component: that cron holds object id `1`
 * around its call into this service, and this service holds `0x7443` around the
 * body. Two ids, deliberately, so a tick driven by that cron and a tick driven by
 * anything else still exclude each other here, at the body, where the dispatching
 * happens.
 *
 * Both halves are integers rather than `hashtext('pipeline.tick')`: a hash is
 * opaque, cannot be checked for collisions by reading, and is not contractually
 * stable across Postgres major versions.
 */
export const CONTROL_TICK_LOCK_NAMESPACE = 0x6369;

/** @see CONTROL_TICK_LOCK_NAMESPACE */
export const CONTROL_TICK_LOCK_ID = 0x7443;

// ---------------------------------------------------------------------------
// Shard vocabulary
// ---------------------------------------------------------------------------

/**
 * Shard statuses this tick writes.
 *
 * `ci.pipeline_shards.status` carries NO CHECK constraint — the migration leaves
 * the vocabulary to the runner on purpose, and `PipelineRunService` reports it as
 * a pass-through tally rather than fixed buckets. This is that vocabulary, in
 * one place, because it is now shared by three statements and a reaper.
 */
export const SHARD_STATUS = {
  /** Materialised, unleased, waiting for a tick to claim it. What the reaper resets to. */
  PENDING: 'pending',
  /** Leased by a tick that has dispatched a sweep for this leg. */
  RUNNING: 'running',
  /** The leg's source is drained at the current stage version. Terminal within the run. */
  DONE: 'done',
  /** Torn down because the run was cancelled. Terminal. */
  CANCELLED: 'cancelled',
} as const;

/**
 * Statuses the lease reaper leaves alone, and that do not count as work in
 * flight when deciding whether a run may be finalised.
 *
 * Terminal is per RUN, not forever: a drained leg becomes `done`, the run
 * finalises once every leg is drained, and a later tick starts a fresh run whose
 * shards begin empty.
 */
export const TERMINAL_SHARD_STATUSES: readonly string[] = [SHARD_STATUS.DONE, SHARD_STATUS.CANCELLED];

/**
 * The only status that refuses a fresh claim — and `done` is deliberately NOT in
 * it.
 *
 * The tempting version of this constant is {@link TERMINAL_SHARD_STATUSES}, so
 * that a drained leg is never swept again within its run. It wedges, and the
 * wedge is permanent:
 *
 *  1. a leg drains and its shard becomes `done`;
 *  2. something makes it stale again INSIDE the same run — a producer stage
 *     fills the column its applicability predicate reads, an import lands new
 *     rows, a version is bumped;
 *  3. the leg now has candidates, so the run can never be finalised (that
 *     requires nothing stale anywhere), and its claim is refused forever, so the
 *     work can never be dispatched either. The run stays active, and
 *     `pipeline_runs_active_uniq` means its user can never start another one.
 *
 * Nothing is lost by allowing the re-claim, because the tick only ever tries to
 * claim a leg it has just PROVED has stale rows. A drained leg is skipped one
 * step earlier, by the probe. `cancelled` still refuses: a run being torn down
 * must not have legs resurrected under it.
 */
const UNCLAIMABLE_SHARD_STATUSES: readonly string[] = [SHARD_STATUS.CANCELLED];

// ---------------------------------------------------------------------------
// THE TICK POLICY — ordering and cost, DECLARED
// ---------------------------------------------------------------------------

/**
 * Which stages consume another stage's output.
 *
 * `stage -> the stages that must be drained before it starts`. The tick reads
 * this graph and contains no ordering of its own; adding an edge here is the
 * whole of teaching the pipeline a new dependency, and a cycle or an undeclared
 * id fails at module load ({@link assertStagePolicy}).
 *
 * ── Why the graph lives in the tick policy and not on `Stage` ───────────────
 *
 * A `dependsOn` field on the `Stage` contract would be the tidier home, and it
 * is where this belongs eventually. It is NOT here yet for two reasons, one
 * practical and one that may outlive it:
 *
 *  - `types.ts` and the twelve stage classes belong to other change sets, and a
 *    field added to the contract is twelve edits plus a registry guard;
 *  - ordering is a SCHEDULING concern, not a processing one. A stage that
 *    declared its producers would be one step from reading them, and the stage
 *    contract's whole discipline is that a stage receives ids and returns
 *    decisions — it never knows what ran before it. Keeping the graph in the
 *    scheduler keeps that boundary intact.
 *
 * ── Every edge, with the code that justifies it ────────────────────────────
 *
 *  - `enrich.estimate_location` ← `enrich.geocode`. An estimate is a COPY of a
 *    donor's coordinate and the donor pool is overwhelmingly rows the forward
 *    geocoder resolved; `EstimateLocationStage` imports
 *    `FORWARD_GEOCODE_PROVIDER_GENERATION` into its own version for exactly this
 *    reason. Estimating before geocoding produces estimates from a donor pool
 *    that does not exist yet.
 *  - `promote.place` ← `enrich.geocode`. Its applicability predicate is
 *    `s.location_coordinates IS NOT NULL` — the column geocode fills — and its
 *    city→region→country hierarchy is read out of `ci.geocode_cache`, which the
 *    forward geocoder wrote. Promoting first promotes the events that already
 *    had coordinates and silently skips the rest until a version bump.
 *  - `promote.place` ← `enrich.estimate_location`. The estimator fills the same
 *    column from a different source, so it too grows the promoter's candidate
 *    set. Transitive through geocode, and stated anyway: the graph is the
 *    documentation.
 *  - `enrich.person_link` / `enrich.event_person_link` ←
 *    `clean.identifier_normalize`. Person-linking joins
 *    `ci.entity_identifiers.value_normalized`; the cleaner is what makes that
 *    column consistent ("so identity work runs over a consistent corpus", per
 *    its `STAGE_IDS` entry). Linking first links against half-normalised keys.
 *  - `clean.duplicate_detect` ← both person-link legs. Its evidence IS
 *    `ci.identifier_claims`, and those two stages are that table's only writers;
 *    `DuplicateDetectStage` records `skipped: no_identifier_claims` for a person
 *    with none, so running it first writes a corpus of skips that only a version
 *    bump can re-open.
 *
 * Stages absent from this map depend on nothing: `enrich.media_dimensions`,
 * `index.embed`, `enrich.position_reverse`, `clean.temporal_repair` and
 * `promote.object` all read source data no other stage rewrites.
 */
export const STAGE_DEPENDENCIES: Readonly<Partial<Record<StageId, readonly StageId[]>>> = {
  [STAGE_IDS.ENRICH_ESTIMATE_LOCATION]: [STAGE_IDS.ENRICH_GEOCODE],
  [STAGE_IDS.PROMOTE_PLACE]: [STAGE_IDS.ENRICH_GEOCODE, STAGE_IDS.ENRICH_ESTIMATE_LOCATION],
  [STAGE_IDS.ENRICH_PERSON_LINK]: [STAGE_IDS.CLEAN_IDENTIFIER_NORMALIZE],
  [STAGE_IDS.ENRICH_EVENT_PERSON_LINK]: [STAGE_IDS.CLEAN_IDENTIFIER_NORMALIZE],
  [STAGE_IDS.CLEAN_DUPLICATE_DETECT]: [STAGE_IDS.ENRICH_PERSON_LINK, STAGE_IDS.ENRICH_EVENT_PERSON_LINK],
  // The edge projections are pure consumers of the linkage columns their
  // producers fill: person-link writes communications' from/to columns; the
  // event leg additionally reads `location_entity_id`, which `promote.place`
  // writes. Projecting first would write a night of `done` rows over unlinked
  // sources that only the producers' next version bump could re-open.
  [STAGE_IDS.PROMOTE_EDGE_COMMUNICATION]: [STAGE_IDS.ENRICH_PERSON_LINK],
  [STAGE_IDS.PROMOTE_EDGE_EVENT]: [STAGE_IDS.ENRICH_EVENT_PERSON_LINK, STAGE_IDS.PROMOTE_PLACE],
  [STAGE_IDS.PROMOTE_EDGE_INVENTORY]: [STAGE_IDS.PROMOTE_OBJECT],
  // The observation leg's `resolved_object_id` is `promote.object`'s output;
  // its other columns (content/event/place) are set at capture time. The
  // receipt, position and device legs read only ingest/capture-time columns —
  // no producer stage, so no entry.
  [STAGE_IDS.PROMOTE_EDGE_OBSERVATION]: [STAGE_IDS.PROMOTE_OBJECT],
};

/**
 * Stages that spend money.
 *
 * Both egress through Portal to a paid, metered provider. `enrich.geocode`
 * forward-geocodes `ci.events.location_name`; `enrich.position_reverse` reverse-
 * geocodes `ci.position`, the largest table on the appliance.
 *
 * Membership no longer decides REACHABILITY — see the cost note in this file's
 * header. It is kept because "which stages spend money?" is a question an
 * operator route, a log line and a spec all ask, and deriving it once here beats
 * three copies of `cost === 'metered'`.
 */
// DERIVED from STAGE_SCHEDULES, never restated. Which stages cost money is a
// property of the stage's schedule policy (schedule.ts), and holding the same
// fact in two places is how the two drift — the boot guard there is what makes
// this list trustworthy.
export const METERED_STAGES: ReadonlySet<StageId> = new Set<StageId>(meteredStageIds());

/** Whether starting this stage costs money at an external provider. */
export const isMeteredStage = scheduleIsMeteredStage;

/**
 * The stages a run sweeps when it names none: every stage a timer may ever
 * start, which is everything not `trigger: 'manual'`.
 *
 * Metered stages ARE in it. That is the whole of the cadence change, and it is
 * only safe because the three things that used to be missing are now present:
 * {@link serviceUser} consults {@link stageDueness} with a durable per-leg
 * `lastStartedAt` and the enrichment window, and every sweep it starts carries
 * the stage's `perRunCap`. Admitting them before that existed would have made a
 * weekly stage reachable every two minutes — which is why the exclusion was
 * right until this commit and wrong after it.
 *
 * Delegates to `automaticStageIds()` rather than filtering here: which stages a
 * timer may start is a property of the schedule, and `schedule.ts` is where it
 * is declared and boot-guarded.
 *
 * Declaration order is phase order (`STAGE_ID_LIST` is ordered `index` →
 * `enrich` → `clean` → `promote`), which is also a valid topological order, so
 * the tick's sort is stable and reads in pipeline order.
 */
export function defaultStageSet(): StageId[] {
  return automaticStageIds();
}

/**
 * Topologically order a set of stage ids, producers first.
 *
 * Kahn's algorithm over {@link STAGE_DEPENDENCIES}, restricted to the given set:
 * an edge to a stage that is not in the set is dropped, because a producer that
 * is not part of this run cannot be waited for. Ties are broken by declaration
 * order, so the result is deterministic and a tick's log line is comparable to
 * the previous tick's.
 *
 * Exported because the ordering is a claim about the pipeline that deserves its
 * own assertions, independent of the tick that consumes it.
 */
export function orderStages(stageIds: readonly StageId[]): StageId[] {
  const inSet = new Set<StageId>(stageIds);
  // Declaration order, deduplicated — the caller may pass a run's hand-written
  // list in any order at all.
  const ordered = STAGE_ID_LIST.filter((stageId) => inSet.has(stageId));

  const remaining = new Map<StageId, Set<StageId>>(
    ordered.map((stageId) => [
      stageId,
      new Set((STAGE_DEPENDENCIES[stageId] ?? []).filter((producer) => inSet.has(producer))),
    ]),
  );

  const result: StageId[] = [];

  while (remaining.size > 0) {
    // The first stage in DECLARATION order whose producers are all placed.
    const next = ordered.find((stageId) => remaining.get(stageId)?.size === 0);

    if (next == null) {
      // Unreachable: `assertStagePolicy` proves the whole graph acyclic at module
      // load, and a subset of a DAG is a DAG. Thrown rather than degraded to
      // declaration order, because silently ignoring a cycle would run a consumer
      // ahead of its producer — the exact thing this function exists to prevent.
      throw new Error(
        `Pipeline stage dependency cycle among: ${[...remaining.keys()].sort().join(', ')}. ` +
          `STAGE_DEPENDENCIES must be acyclic.`,
      );
    }

    result.push(next);
    remaining.delete(next);

    for (const producers of remaining.values()) {
      producers.delete(next);
    }
  }

  return result;
}

/**
 * Module-load guard over the two declarations above.
 *
 * Same reasoning as `assertStageRegistryComplete`, and run at module load for the
 * same reason: every one of these mistakes is silent at runtime. An edge naming a
 * stage id that does not exist is an edge that never blocks anything; a cycle
 * makes the ordering arbitrary; a metered stage that slipped into the default set
 * is a recurring charge nobody authorised. The earliest failure is the cheapest.
 */
export function assertStagePolicy(): void {
  const declared = new Set<string>(STAGE_ID_LIST);
  const problems: string[] = [];

  for (const [consumer, producers] of Object.entries(STAGE_DEPENDENCIES)) {
    if (!declared.has(consumer)) {
      problems.push(`"${consumer}" is a key of STAGE_DEPENDENCIES but is not a declared stage id`);
    }

    for (const producer of producers ?? []) {
      if (!declared.has(producer)) {
        problems.push(
          `"${consumer}" declares a dependency on "${producer}", which is not a declared stage id`,
        );
      }

      if (producer === consumer) {
        problems.push(`"${consumer}" declares a dependency on itself`);
      }
    }
  }

  for (const stageId of METERED_STAGES) {
    if (!declared.has(stageId)) {
      problems.push(`"${stageId}" is in METERED_STAGES but is not a declared stage id`);
    }
  }

  if (problems.length === 0) {
    // Only meaningful once the ids check out; a cycle report naming a typo would
    // send a reader looking for the wrong bug.
    try {
      orderStages([...STAGE_ID_LIST]);
    } catch (err: unknown) {
      problems.push(err instanceof Error ? err.message : String(err));
    }

    // The "a timer must never reach a metered stage" assertion USED to live here.
    // It is deliberately gone: the decision is that geocoding runs SLOWER, not
    // never, so metered stages are now timer-reachable on a weekly minInterval,
    // inside the enrichment window, bounded by a perRunCap. Keeping the old
    // assertion would fail the boot on the very policy that was chosen.
    //
    // Cost discipline did not weaken, it moved — `assertStageSchedules()` in
    // schedule.ts runs at module load and is where a metered stage is now stopped
    // from declaring `trigger: 'onArrival'`, which is the shape that would bill
    // per imported row.
  }

  if (problems.length > 0) {
    throw new Error(`Pipeline control policy is invalid — ${problems.join('; ')}.`);
  }
}

assertStagePolicy();

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * One unit of scheduling: a stage AND the entity type it is being swept for.
 *
 * The stage is not the unit, because `ci.pipeline_state` is keyed per
 * `(entity_type, entity_id, stage)` and a stage declaring two types is two
 * independent sweeps with two independent cursors. That is also exactly what
 * `ci.pipeline_shards.shard_key` is for, so a leg maps one-to-one onto a shard.
 */
export interface StageLeg {
  stageId: StageId;
  stage: Stage;
  entityType: string;
}

/** What one tick did. Returned for the log line, for tests, and for an operator route. */
export interface ControlTickReport {
  /** The advisory lock was held elsewhere, or the control plane is not migrated. Nothing ran. */
  skipped: boolean;

  /** Why, when {@link skipped}. `null` otherwise. */
  skipReason: string | null;

  /** Expired shard leases handed back for re-claiming. */
  leasesReaped: number;

  usersServiced: number;

  /** Runs the tick created because a user had stale work and no active run. */
  runsStarted: number;

  /** Runs finalised — drained or cancelled. Both stamp `finished_at`. */
  runsFinalized: number;

  /** Runs skipped because `desired_state` is `paused`. */
  runsPaused: number;

  /** Sweeps actually dispatched. */
  sweepsStarted: number;

  /** Stage legs with stale rows that were held back behind an undrained producer. */
  legsBlocked: number;

  /** Stage legs whose source is drained; their shard is now `done`. */
  legsDrained: number;

  /**
   * Stage legs with stale rows that are not DUE — swept inside their
   * `minInterval`, or waiting for the enrichment window to open.
   *
   * The number that makes "why did geocode not run last night?" answerable
   * without a debugger. On a converged appliance this is the largest count in
   * the report and that is the system working: it is the difference between a
   * nightly pipeline and a permanent background tenant.
   */
  legsNotDue: number;
}

/**
 * What one tick measured about the appliance before it looked at any user.
 *
 * Measured once and passed down so every dueness decision in a pass is made
 * against the same instant and the same window reading. A tick that re-read
 * either per user could serve the first user under an open window and the second
 * under a shut one, from the same tick, with nothing in the log to explain it.
 */
interface TickConditions {
  /** `WindowStatus.open` — may the appliance spend on enrichment right now? */
  windowOpen: boolean;

  /** The instant this tick judges every leg against. */
  now: Date;
}

/** One `ci.pipeline_schedule` row, as the tick reads it. */
interface LegScheduleRow {
  stage: string;
  entity_type: string;
  last_started_at: Date | string;
}

/** One active run, as the tick reads it. */
interface ActiveRunRow {
  user_id: string;
  run_id: string | null;
  kind: string | null;
  desired_state: string | null;
  detail: Record<string, unknown> | null;
}

function emptyReport(): ControlTickReport {
  return {
    skipped: false,
    skipReason: null,
    leasesReaped: 0,
    usersServiced: 0,
    runsStarted: 0,
    runsFinalized: 0,
    runsPaused: 0,
    sweepsStarted: 0,
    legsBlocked: 0,
    legsDrained: 0,
    legsNotDue: 0,
  };
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

@Injectable()
export class PipelineControlService {
  /**
   * What this process stamps into `ci.pipeline_shards.lease_owner`.
   *
   * Advisory — `lease_expires_at` is what the reaper trusts — but it is the only
   * thing that answers "which box was holding this when it stopped?", which is
   * the first question after a stuck run. Host plus pid, because the Phase 5
   * split puts two of these on the same host.
   */
  private readonly leaseOwner = `${hostname()}:${process.pid}`;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly stateService: PipelineStateService,
    private readonly runService: PipelineRunService,
    private readonly dispatchService: PipelineDispatchService,
    private readonly stageRegistry: StageRegistry,
    /**
     * The one implementation of "may the appliance spend right now?".
     *
     * Injected rather than re-derived, because a second copy of "is it 03:00 in
     * the owner's zone?" is exactly the drift `schedule.ts` splits its
     * responsibilities to avoid. The tick asks it once and hands the answer to
     * {@link stageDueness}, which owns no clock of its own.
     *
     * Only {@link EnrichmentWindowService.status} is called — the READ-ONLY
     * form. `takeTurn()` also charges the nightly budget and moves the rotation
     * pointer, which is a second scheduling decision (WHO is served) on top of
     * this one (WHICH stages are due) and belongs to its own change.
     */
    private readonly windowService: EnrichmentWindowService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PipelineControlService.name);
  }

  // -------------------------------------------------------------------------
  // Entry points
  // -------------------------------------------------------------------------

  /**
   * The scheduled tick.
   *
   * Catches everything, exactly as `DeadLetterReaperListener.reapOnSchedule`
   * does and for the same reason: nothing awaits a `@Cron` method, so a rejection
   * here is an unhandled promise rejection, and `application.ts` answers those
   * with `process.exit(1)`. On a two-minute timer that is a crash loop — the
   * component whose job is to keep the pipeline moving taking down the API
   * because one tick failed. The next tick retries in two minutes and nothing is
   * lost, because every fact the tick relies on is a row rather than a variable.
   */
  @Cron(PIPELINE_CONTROL_TICK_CRON)
  async tickOnSchedule(): Promise<void> {
    try {
      await this.tick();
    } catch (err: unknown) {
      this.logger.error(
        'Pipeline control tick failed; will retry on the next tick',
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  /**
   * One pass of the control loop.
   *
   * Public and awaited, so an operator route, a test or a future worker process
   * can drive a tick directly and read what it did. Unlike {@link tickOnSchedule}
   * this one PROPAGATES: a caller that asked for a tick wants to hear that it
   * failed.
   */
  async tick(): Promise<ControlTickReport> {
    const report = emptyReport();

    const runner = this.dataSource.createQueryRunner();

    try {
      await runner.connect();

      const locked = await this.tryLock(runner);

      if (!locked) {
        // The overwhelmingly common cause is the OTHER replica's cron, firing at
        // the same second on the same schedule. Debug, not warn: on a two-replica
        // deployment this is the steady state, and a warning per tick would be
        // the whole log.
        report.skipped = true;
        report.skipReason = 'another control tick holds the advisory lock';

        this.logger.debug('Pipeline control tick skipped; another tick holds the lock');

        return report;
      }

      try {
        await this.runTick(report);
      } finally {
        // Before the connection goes back to the pool. A session-level advisory
        // lock outlives the transaction but not the backend, so an un-released
        // lock on a POOLED connection would survive until that connection is
        // recycled — a wedge lasting minutes for no reason.
        await runner.query('SELECT pg_advisory_unlock($1::int, $2::int)', [
          CONTROL_TICK_LOCK_NAMESPACE,
          CONTROL_TICK_LOCK_ID,
        ]);
      }
    } finally {
      await runner.release();
    }

    return report;
  }

  // -------------------------------------------------------------------------
  // The pass
  // -------------------------------------------------------------------------

  /** Everything a tick does while holding the lock. */
  private async runTick(report: ControlTickReport): Promise<void> {
    if (!(await this.controlPlanePresent())) {
      // The control-plane migration is created by dbmate, not by pg-boss at boot,
      // so it is absent on a node that started before `migrate-database`
      // finished. Same guard, and same reason, as the dead-letter reaper's: on a
      // timer, an unguarded missing relation is a log line every two minutes
      // forever.
      report.skipped = true;
      report.skipReason = 'the pipeline control plane is not migrated on this database';

      this.logger.debug('Pipeline control tick skipped; ci.pipeline_runs / ci.pipeline_shards are missing');

      return;
    }

    // FIRST, before anything is dispatched. A shard whose lease expired while its
    // worker was being killed is work nobody is doing; reclaiming it before the
    // dispatch pass means this tick can pick it straight back up rather than
    // waiting another two minutes.
    report.leasesReaped = await this.reapExpiredShardLeases();

    const conditions = await this.tickConditions();

    const rows = await this.activeRunRows();

    for (const row of rows) {
      report.usersServiced += 1;

      try {
        await this.serviceUser(row, report, conditions);
      } catch (err: unknown) {
        // One user's failure must not cost every other user their tick. The
        // failure is durable in the sense that matters — nothing was consumed, so
        // the next tick re-derives exactly the same remainder.
        this.logger.error(
          `Pipeline control tick failed for user ${row.user_id}; other users are unaffected`,
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }

    if (report.sweepsStarted > 0 || report.runsFinalized > 0 || report.leasesReaped > 0) {
      this.logger.log('Pipeline control tick', { ...report });
    }
  }

  /**
   * Reconcile one user's run, creating one if there is DUE work and none exists.
   *
   * `conditions` is measured once for the whole tick and passed down, so every
   * leg of every user is judged against one instant and one window reading.
   */
  private async serviceUser(
    row: ActiveRunRow,
    report: ControlTickReport,
    conditions: TickConditions,
  ): Promise<void> {
    const userId = row.user_id;

    // ── 1. desired_state comes first, before a single candidate is counted ──
    //
    // A cancelled or paused run must cost nothing. Probing twelve stages for a
    // run that is not allowed to start anything would be the most expensive way
    // possible to do nothing.
    if (row.run_id != null && row.desired_state === 'cancelled') {
      await this.tearDownCancelledRun(row.run_id, report);

      return;
    }

    if (row.run_id != null && row.desired_state === 'paused') {
      report.runsPaused += 1;

      return;
    }

    const stageIds = this.stageSetFor(row);
    const legs = this.legsFor(stageIds);

    // ── 2. What is worth sweeping ──────────────────────────────────────────
    const candidates = new Map<string, boolean>();

    for (const leg of legs) {
      candidates.set(this.legKey(leg), await this.hasCandidates(leg, userId));
    }

    // ── 3. WHICH of those may run right now ────────────────────────────────
    //
    // ONE read per user per tick, not one per leg: a user has at most a dozen
    // rows here and the tick already issues a staleness probe per leg, so a
    // second per-leg round trip would double the tick's statement count to
    // answer a question one `WHERE user_id = $1` covers.
    const lastStartedAt = await this.legScheduleFor(userId);

    const dueness = new Map<string, StageDueness>(
      legs.map((leg) => [
        this.legKey(leg),
        stageDueness({
          stageId: leg.stageId,
          lastStartedAt: lastStartedAt.get(this.legKey(leg)) ?? null,
          windowOpen: conditions.windowOpen,
          now: conditions.now,
        }),
      ]),
    );

    // THE SET THE REST OF THIS METHOD IS ABOUT: stale AND allowed to run now.
    //
    // Filtering here rather than at the dispatch loop is what fixes a real
    // ordering bug, and it is the reason this is one set and not two.
    // `enrich.estimate_location` and `promote.place` are NIGHTLY consumers of a
    // WEEKLY producer, so on the six nights `enrich.geocode` is not due it still
    // has candidates — and a consumer blocked whenever its producer merely HAS
    // work would be held back six nights in seven, by a producer that was never
    // going to run on any of them. A producer that is not due is not a producer
    // anybody is waiting for.
    const dueWithCandidates = new Set<StageId>(
      legs
        .filter(
          (leg) => candidates.get(this.legKey(leg)) === true && dueness.get(this.legKey(leg))?.due === true,
        )
        .map((leg) => leg.stageId),
    );

    // ── 4. Ordering, from the declared graph ───────────────────────────────
    const blocked = this.blockedStages(stageIds, dueWithCandidates);

    // ── 5. Nothing DUE anywhere: finalise, or do nothing at all ────────────
    if (dueWithCandidates.size === 0) {
      if (row.run_id == null) {
        // No run, no due work. The overwhelmingly common tick on a converged
        // appliance, and it must cost nothing beyond the probes.
        return;
      }

      // Recorded BEFORE the live-lease check, and the order matters. A leg swept
      // three ticks ago holds its lease for SHARD_LEASE_SECONDS whether or not
      // the sweep finished in seconds — nothing calls back to release it — so
      // asking about leases first would delay every finalisation by up to a lease
      // period for no reason. Marking drained is safe here precisely because
      // nothing is stale: a slice genuinely in flight leaves its rows `running`
      // at `stage_version = 0`, which the probe still counts as a candidate.
      //
      // THE RUN IS FINALISED EVEN IF SOME LEGS ARE MERELY NOT DUE, and that is
      // deliberate. `pipeline_runs_active_uniq` allows one unfinished run per
      // user, so holding this one open for the six days until a weekly stage
      // comes round would lock the user out of ever pressing "reprocess" — a
      // cadence change silently disabling the manual escape hatch. A run
      // represents work in flight, not a subscription to future work; the next
      // tick that finds something due starts a fresh one.
      let waiting = 0;

      for (const leg of legs) {
        if (candidates.get(this.legKey(leg)) === true) {
          // Stale but not due. Deliberately NOT marked drained: the leg has work
          // and saying `done` about it would put a falsehood in the run's
          // progress view, which is the one place an operator looks to answer
          // "is my import finished?".
          report.legsNotDue += 1;
          waiting += 1;

          continue;
        }

        await this.markShardDrained(row.run_id, leg);
        report.legsDrained += 1;
      }

      if (await this.hasLiveShardLease(row.run_id)) {
        // A leg outside this run's current stage set still holds a lease. Rare —
        // it means the run's `detail.stages` changed mid-flight — and it resolves
        // itself when the lease expires and the reaper takes it back.
        return;
      }

      // `finishRun` ALWAYS stamps `finished_at`, which is what releases
      // `pipeline_runs_active_uniq` and lets the next tick start a fresh run when
      // new rows land or a version is bumped.
      //
      // The reason distinguishes the two ways a run ends with nothing to do,
      // because they mean opposite things to whoever reads it later: `drained`
      // is "there is no work left", `not_due` is "there is work left and it is
      // not time" — the second is the expected end of a run on an appliance with
      // a weekly stage, and reporting it as `drained` would make the geocoder
      // look converged while 95 events still wait for it.
      await this.runService.finishRun(row.run_id, 'completed', {
        finalizedBy: 'control-tick',
        finalizedReason: waiting > 0 ? 'not_due' : 'drained',
        legsNotDue: waiting,
      });

      report.runsFinalized += 1;

      return;
    }

    // ── 6. There IS due work. Make sure there is a run to attribute it to ──
    let runId = row.run_id;

    if (runId == null) {
      // `startRun` catches the unique violation and hands back whoever won, so
      // this is safe against a racing tick and against an operator clicking
      // "reprocess" in the same second.
      const started = await this.runService.startRun(
        { userId },
        { kind: CONTINUOUS_RUN_KIND, detail: { startedBy: 'control-tick' } },
      );

      if (started.created) {
        report.runsStarted += 1;
      } else if (started.run.desiredState !== 'running') {
        // We lost the race to a run that is paused or cancelled. Honouring
        // `desired_state` outranks the work we were about to start; the next tick
        // reads it from the top.
        return;
      }

      runId = started.run.id;
    }

    // ── 7. Dispatch, producers first, bounded ──────────────────────────────
    for (const leg of orderStages(stageIds).flatMap((stageId) =>
      legs.filter((candidate) => candidate.stageId === stageId),
    )) {
      // BLOCKED IS CHECKED FIRST, and the order is load-bearing. A blocked leg
      // frequently has nothing stale — `promote.place` has no candidates until
      // something fills `location_coordinates` — and marking it drained would
      // record "finished" about a stage that has not been offered its input yet.
      // Nothing about a block is written down: it is re-derived every tick, which
      // is what lets a producer finishing at any moment release its consumers on
      // the very next pass.
      if (blocked.has(leg.stageId)) {
        report.legsBlocked += 1;

        continue;
      }

      if (candidates.get(this.legKey(leg)) !== true) {
        // Drained, and no producer owes it anything. Recorded on the shard so the
        // run's progress view is honest about which legs are finished.
        await this.markShardDrained(runId, leg);
        report.legsDrained += 1;

        continue;
      }

      const due = dueness.get(this.legKey(leg));

      if (due?.due !== true) {
        // Stale, unblocked, and NOT ITS TURN. Checked after the drained branch
        // because "nothing to do" is a fact worth recording whatever the clock
        // says, and before the claim because a claim would take a ten-minute
        // lease on a leg that is not going to be swept.
        //
        // Nothing is written down, exactly as for a block: dueness is re-derived
        // every tick from `ci.pipeline_schedule`, so a leg becomes due the moment
        // its interval elapses rather than the next time something remembers to
        // clear a flag.
        report.legsNotDue += 1;

        continue;
      }

      if (report.sweepsStarted >= MAX_SWEEPS_PER_TICK) {
        continue;
      }

      const shardId = await this.claimStageShard(runId, leg);

      if (shardId == null) {
        // Another tick holds this leg's lease, or it is terminal within this run.
        // Either way somebody else is responsible for it.
        continue;
      }

      // THE CLOCK IS STAMPED BEFORE THE SWEEP IS STARTED, not after it.
      //
      // The two failure modes are not symmetric. Stamping first and then failing
      // to dispatch costs a metered leg one interval — it is skipped until next
      // week, loudly, in the log line below, having spent nothing. Stamping after
      // a successful dispatch and then losing the process (a deploy, an OOM kill,
      // a connection reset in the millisecond between the two) leaves no record
      // that the sweep ever started, so the next tick finds the leg due again and
      // re-dispatches it — against a paid provider, on a two-minute cadence, for
      // as long as the crash keeps happening. A week of delay is recoverable; a
      // loop against a metered API is what this whole gate exists to prevent.
      await this.recordStageStart(userId, leg);

      try {
        await this.dispatchService.startSweep({
          stage: leg.stageId,
          userId,
          // Named ALWAYS, not only for multi-type stages: the shard is keyed by
          // it, and letting the dispatcher default would mean the shard and the
          // ledger could disagree about which type was swept.
          entityType: leg.entityType,
          // The declared `perRunCap`, carried from the schedule this leg was
          // just judged against rather than looked up again — so the number that
          // authorised the sweep is the number that bounds it. `null` (uncapped)
          // becomes `undefined`, which is what `StartSweepInput` spells it.
          maxIds: due.perRunCap ?? undefined,
        });

        report.sweepsStarted += 1;
      } catch (err: unknown) {
        // The lease is deliberately LEFT IN PLACE. `startSweep` throws only for a
        // wiring fault (an unbound stage), which a retry every two minutes cannot
        // fix but a deploy can; the held lease is a free backoff that expires in
        // SHARD_LEASE_SECONDS and lets the leg be retried once, not hammered.
        //
        // The schedule stamp is left in place too, and it is the louder of the
        // two: this leg now waits a full `minInterval` before it is due again. On
        // a weekly stage that is a week of nothing, which is why this is an error
        // and names the leg — the cost of the alternative is on the claim above.
        this.logger.error(
          `Pipeline control tick could not start a sweep for ${leg.stageId} (${leg.entityType}); ` +
            `its shard lease is left to expire and its schedule stamp stands, so the leg is not due ` +
            `again until its minInterval elapses`,
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }
  }

  /**
   * Tear a cancelled run down and finalise it.
   *
   * THE point of this method is the `finishRun` call, and the reason is a
   * one-way trap in the schema: `pipeline_runs_active_uniq` is a partial unique
   * index on `(user_id) WHERE finished_at IS NULL`, and cancelling writes only
   * `desired_state`. A cancelled run that nothing finalises therefore stays
   * ACTIVE forever, and its user can never start another run — no error, no log
   * line, no way out but SQL. The migration says so outright: "a cancelled run
   * stays active until a worker finalizes it". This is that worker.
   *
   * Shards holding a LIVE lease are left alone for one more tick. A worker is
   * inside that leg right now; letting it finish its slice costs at most one
   * lease period and means the ledger records what it actually decided instead of
   * abandoning a claim. The wait is bounded by {@link SHARD_LEASE_SECONDS} and
   * cannot be unbounded, because a lease that is never renewed always expires —
   * which is what makes "eventually finalised" a guarantee rather than a hope.
   */
  private async tearDownCancelledRun(runId: string, report: ControlTickReport): Promise<void> {
    await this.dataSource.query(
      `UPDATE ci.pipeline_shards
          SET status           = $2,
              lease_owner      = NULL,
              lease_expires_at = NULL
        WHERE run_id = $1::uuid
          AND status <> ALL($3::text[])
          AND (lease_expires_at IS NULL OR lease_expires_at < now())`,
      [runId, SHARD_STATUS.CANCELLED, TERMINAL_SHARD_STATUSES],
    );

    if (await this.hasLiveShardLease(runId)) {
      this.logger.debug('Cancelled pipeline run still has a live shard lease; finalizing on a later tick', {
        runId,
      });

      return;
    }

    await this.runService.finishRun(runId, 'cancelled', {
      finalizedBy: 'control-tick',
      finalizedReason: 'cancelled',
    });

    report.runsFinalized += 1;
  }

  // -------------------------------------------------------------------------
  // Policy resolution
  // -------------------------------------------------------------------------

  /**
   * Which stages this run sweeps.
   *
   * `detail.stages`, when present and usable, IS the answer. Absent, the run gets
   * {@link defaultStageSet}.
   *
   * Naming a stage decides only WHICH stages this run considers — it is not a
   * bypass. Everything in the resulting set is still judged by
   * {@link stageDueness}, so a run that names `enrich.geocode` a day after the
   * last one still gets `too_soon`, and the operator's escape hatch from a
   * cadence is the schedule, not a hand-written run. That is a deliberate change
   * from when naming a stage was the ONLY way to reach it and therefore had to
   * mean "do it now".
   *
   * An unusable `detail.stages` (not an array, or naming nothing declared) falls
   * back to the default rather than to the empty set: an empty set would make the
   * run instantly "drained" and finalise it, so a typo would look exactly like a
   * successful, complete run.
   */
  private stageSetFor(row: ActiveRunRow): StageId[] {
    const requested = row.detail?.stages;

    if (!Array.isArray(requested)) {
      return defaultStageSet();
    }

    const declared = new Set<string>(STAGE_ID_LIST);
    const named = requested.filter(
      (value): value is StageId => typeof value === 'string' && declared.has(value),
    );
    const unknown = requested.filter((value) => typeof value !== 'string' || !declared.has(value));

    if (unknown.length > 0) {
      this.logger.warn('Pipeline run names stages that are not declared; ignoring them', {
        runId: row.run_id,
        unknown,
      });
    }

    if (named.length === 0) {
      return defaultStageSet();
    }

    return named;
  }

  /**
   * Expand stage ids into legs, dropping any stage that cannot be resolved.
   *
   * `StageRegistry.get` throws for a declared-but-unbound stage. That is right at
   * a sweep's call site and wrong here: one unbound stage must not cost every
   * other stage its tick, and the tick runs on a timer where a throw is a crash
   * loop. Logged at error level, so the wiring fault is loud without being fatal.
   */
  private legsFor(stageIds: readonly StageId[]): StageLeg[] {
    const legs: StageLeg[] = [];

    for (const stageId of stageIds) {
      let stage: Stage;

      try {
        stage = this.stageRegistry.get(stageId);
      } catch (err: unknown) {
        this.logger.error(
          `Pipeline control tick cannot resolve stage "${stageId}"; skipping it this tick`,
          err instanceof Error ? err : new Error(String(err)),
        );

        continue;
      }

      for (const entityType of stage.entityTypes) {
        legs.push({ stageId, stage, entityType });
      }
    }

    return legs;
  }

  /**
   * Which stages must not start yet, because something they consume is not done.
   *
   * `withCandidates` is the DUE set — stale AND allowed to run now — and passing
   * the unfiltered one would resurrect the same defect this restriction already
   * guards against in the other direction. Blocking is TRANSITIVE and propagates
   * only through stages that are actually in this run's set, because a producer
   * the run does not include is not being waited for; by exactly the same
   * argument, a producer that is not DUE is not being waited for either.
   * `enrich.estimate_location` and `promote.place` are nightly consumers of the
   * weekly `enrich.geocode`, so on the six nights it is not due it still has
   * candidates — and counting those would block two free stages six nights in
   * seven behind a producer that was never going to run on any of them.
   *
   * Computed in dependency order so one pass suffices: by the time a stage is
   * examined, every producer of it already has an answer.
   */
  private blockedStages(stageIds: readonly StageId[], withCandidates: ReadonlySet<StageId>): Set<StageId> {
    const inSet = new Set<StageId>(stageIds);
    const blocked = new Set<StageId>();

    for (const stageId of orderStages(stageIds)) {
      const producers = (STAGE_DEPENDENCIES[stageId] ?? []).filter((producer) => inSet.has(producer));

      const waitingOn = producers.some((producer) => withCandidates.has(producer) || blocked.has(producer));

      if (waitingOn) {
        blocked.add(stageId);
      }
    }

    return blocked;
  }

  /**
   * Measure the appliance once, before any user is looked at.
   *
   * ── A window that cannot be read is a CLOSED window ────────────────────────
   *
   * `EnrichmentWindowService.status()` already fails closed on its own terms (an
   * unmigrated `ci.pipeline_turns` answers `unavailable`), and a THROW is caught
   * here and answered the same way, for `BackpressureService`'s reason: a wrong
   * "no" costs one tick and the next one re-asks, while a wrong "yes" is Ollama
   * contention against somebody who is awake, or a geocoding call nobody
   * authorised.
   *
   * "Closed" is not "stopped", which is what makes failing closed affordable
   * here rather than a way to wedge the pipeline. `stageDueness` tests
   * `maxStaleness` BEFORE the window, so a leg the window has held back long
   * enough becomes overdue and runs at whatever hour it happens to be — 3 days
   * for a nightly stage, 30 for a metered one. A window that is permanently
   * unreadable therefore degrades the appliance to its `maxStaleness` cadence
   * rather than to silence, and a leg that has never run ignores the window
   * outright.
   */
  private async tickConditions(): Promise<TickConditions> {
    const now = new Date();

    try {
      const window = await this.windowService.status(now);

      if (!window.open) {
        this.logger.debug('Enrichment window is shut; only overdue legs will be swept this tick', {
          state: window.state,
          nextOpensAt: window.nextOpensAt,
        });
      }

      return { windowOpen: window.open, now };
    } catch (err: unknown) {
      this.logger.error(
        'The enrichment window could not be read; this tick treats it as shut, so only legs past ' +
          'their maxStaleness will be swept',
        err instanceof Error ? err : new Error(String(err)),
      );

      return { windowOpen: false, now };
    }
  }

  /**
   * Does this leg have anything stale at all?
   *
   * THE ONE RULE at `LIMIT 1`, through `PipelineStateService.selectStale` — the
   * same statement the sweep pages with, never a second copy of the staleness
   * predicate. A re-implementation here would be a second definition of "stale"
   * free to drift from the one that actually dispatches, and the whole subsystem
   * exists because seven legs each had their own.
   *
   * `LIMIT 1` rather than a `count(*)` deliberately: the tick's question is "is
   * there anything?", not "how much?". A count has to visit every candidate; this
   * stops at the first, so a busy stage answers in microseconds. The expensive
   * case is a CONVERGED stage, which must exhaust the anti-join to prove there is
   * nothing — and convergence is the state an idempotent pipeline lives in
   * permanently, which is why the tick's cadence is two minutes and not two
   * seconds.
   *
   * Twelve `LIMIT 1` probes rather than one `UNION ALL` round trip for the same
   * reason: the union would have to be assembled here from the stages' sources,
   * which means writing the predicate again.
   */
  private async hasCandidates(leg: StageLeg, userId: string): Promise<boolean> {
    const ids = await this.stateService.selectStale(leg.stage, userId, null, 1, leg.entityType);

    return ids.length > 0;
  }

  // -------------------------------------------------------------------------
  // Durable primitives — the SQL whose semantics live nowhere else
  // -------------------------------------------------------------------------

  /**
   * Take the tick's advisory lock, or report that somebody else has it.
   *
   * `pg_try_advisory_lock`, never `pg_advisory_lock`: the blocking form would
   * queue every replica's cron behind the winner and then run them all in
   * sequence, which is a slower version of the double-dispatch it was meant to
   * prevent. Trying and giving up is the whole idea — a tick that cannot get the
   * lock has nothing to do, because the tick that holds it is doing it.
   */
  private async tryLock(runner: {
    query(sql: string, params?: unknown[]): Promise<unknown>;
  }): Promise<boolean> {
    const rows = (await runner.query('SELECT pg_try_advisory_lock($1::int, $2::int) AS locked', [
      CONTROL_TICK_LOCK_NAMESPACE,
      CONTROL_TICK_LOCK_ID,
    ])) as Array<{ locked: boolean }>;

    return rows[0]?.locked === true;
  }

  /**
   * Both control-plane tables the tick writes, the ledger it reads, and the
   * schedule it now judges every leg against.
   *
   * `ci.pipeline_schedule` is in this list, and it is the reason to notice the
   * list at all. Without it nothing can answer "when did this leg last run?",
   * every leg reads as never-run, and a weekly metered stage would be swept on
   * EVERY tick of an unmigrated node — the exact failure the gate exists to
   * prevent, arrived at by a node that started before `migrate-database`
   * finished. Refusing to tick at all is the fail-closed answer and it is
   * self-healing: the probe is re-run every tick and nothing is consumed, so the
   * pass resumes on its own the moment the migration lands.
   */
  private async controlPlanePresent(): Promise<boolean> {
    const rows = await this.dataSource.query<Array<{ present: boolean }>>(
      `SELECT to_regclass('ci.pipeline_runs')     IS NOT NULL
          AND to_regclass('ci.pipeline_shards')   IS NOT NULL
          AND to_regclass('ci.pipeline_state')    IS NOT NULL
          AND to_regclass('ci.pipeline_schedule') IS NOT NULL AS present`,
    );

    return rows[0]?.present === true;
  }

  /**
   * When each of this user's legs last had a sweep STARTED.
   *
   * One statement per user per tick, keyed `stage\0entity_type` to match
   * {@link legKey}. A leg with no row is absent from the map, and the ABSENCE is
   * the answer: `stageDueness` reads `null` as infinite staleness and therefore
   * as overdue, which is what makes a freshly imported appliance enrich
   * immediately instead of waiting a week for its first geocode.
   *
   * Public for the same reason as {@link reapExpiredShardLeases} and
   * {@link claimStageShard}: what it means is in the statement and in the round
   * trip through Postgres's `timestamptz`, and a mock agrees with whatever it is
   * asked.
   */
  async legScheduleFor(userId: string): Promise<Map<string, Date>> {
    const rows = await this.dataSource.query<LegScheduleRow[]>(
      `SELECT stage, entity_type, last_started_at
         FROM ci.pipeline_schedule
        WHERE user_id = $1::uuid`,
      [userId],
    );

    const schedule = new Map<string, Date>();

    for (const row of rows) {
      // `Date` on node-postgres, a string on some drivers and after a JSON round
      // trip. Coerced rather than trusted, because the failure is silent: an
      // Invalid Date arithmetics to NaN, every comparison against it is false,
      // and `staleness < minInterval` being false is DUE — a metered stage
      // becoming due every tick because a driver handed back a string.
      const startedAt =
        row.last_started_at instanceof Date ? row.last_started_at : new Date(row.last_started_at);

      if (Number.isNaN(startedAt.getTime())) {
        // Fail CLOSED, in the direction the cost lives: treated as started right
        // now, so the leg waits a full interval rather than being swept on every
        // tick until somebody notices.
        this.logger.error(
          `ci.pipeline_schedule holds an unreadable last_started_at for ${row.stage} ` +
            `(${row.entity_type}); treating the leg as just-started so it is not due again until its ` +
            `minInterval elapses`,
        );

        schedule.set(this.key(row.stage, row.entity_type), new Date());

        continue;
      }

      schedule.set(this.key(row.stage, row.entity_type), startedAt);
    }

    return schedule;
  }

  /**
   * Stamp "a sweep for this leg started now", cross-run and durable.
   *
   * The counterpart to {@link claimStageShard} and deliberately NOT part of it:
   * a shard is run-scoped and CASCADEs away with its run, and a weekly interval
   * measured off something that is deleted every few hours is a weekly interval
   * that never elapses. Two writes, two lifetimes, on purpose.
   *
   * `now()` rather than `EXCLUDED.last_started_at` on the update arm: they are
   * the same value here, and naming the function makes it obvious that a
   * re-claim moves the clock forward instead of preserving whatever the insert
   * happened to carry.
   *
   * Public so the upsert's semantics — that a second claim MOVES the stamp and
   * increments the counter rather than inserting a second row — can be asserted
   * against a real Postgres.
   */
  async recordStageStart(userId: string, leg: StageLeg): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO ci.pipeline_schedule AS s (user_id, stage, entity_type, last_started_at, starts)
       VALUES ($1::uuid, $2, $3, now(), 1)
       ON CONFLICT (user_id, stage, entity_type) DO UPDATE
          SET last_started_at = now(),
              starts          = s.starts + 1,
              updated_at      = now()`,
      [userId, leg.stageId, leg.entityType],
    );
  }

  /**
   * Hand expired shard leases back.
   *
   * A worker that is SIGKILLed never releases anything, so without this a shard
   * sits `running` with a dead owner and the run never moves again — and because
   * {@link claimStageShard} refuses a leg whose lease is live, the stall would
   * outlive every restart. Reclaiming is a status reset, not a deletion: the
   * shard keeps its identity and its cursor, so the leg resumes rather than
   * restarting.
   *
   * Deliberately NOT scoped to a run or a user. A stranded lease is stranded
   * regardless of whose run it belongs to, including a run that is paused, and a
   * reaper that only visited runs it was already reconciling would leave exactly
   * the shards nobody is looking at.
   *
   * Bounded by {@link MAX_LEASES_REAPED_PER_TICK}. `UPDATE` takes no `LIMIT`,
   * hence the subquery; ordering by the deadline takes the longest-stranded
   * first, so a catch-up after a mass kill drains oldest-first instead of
   * arbitrarily.
   *
   * ── Why the UPDATE is wrapped in a CTE ─────────────────────────────────────
   *
   * `DataSource.query` does NOT hand back the rows for an `UPDATE ... RETURNING`.
   * TypeORM's `PostgresQueryRunner` special-cases the `UPDATE` and `DELETE`
   * commands and resolves `[raw.rows, raw.rowCount]` — a two-element array,
   * whatever the statement returned. Read as rows that is silently, uniformly
   * WRONG: `length` is 2 for a statement that matched nothing, `[0]` is the
   * record array rather than a record, and no test against a mocked `DataSource`
   * can see it because the mock answers with whatever shape the test wrote.
   * Wrapping the write in a CTE makes the outer command a `SELECT`, which takes
   * TypeORM's default branch and returns the rows themselves.
   *
   * Public so its semantics — which live ENTIRELY in this statement — can be
   * asserted against a real Postgres. A mock agrees with whatever it is asked.
   */
  async reapExpiredShardLeases(limit: number = MAX_LEASES_REAPED_PER_TICK): Promise<number> {
    const rows = await this.dataSource.query<Array<{ id: string }>>(
      `WITH reaped AS (
         UPDATE ci.pipeline_shards
            SET status           = $1,
                lease_owner      = NULL,
                lease_expires_at = NULL
          WHERE id IN (
                  SELECT s.id
                    FROM ci.pipeline_shards s
                   WHERE s.lease_expires_at IS NOT NULL
                     AND s.lease_expires_at < now()
                     AND s.status <> ALL($2::text[])
                   ORDER BY s.lease_expires_at
                   LIMIT $3)
      RETURNING id)
       SELECT id FROM reaped`,
      [SHARD_STATUS.PENDING, TERMINAL_SHARD_STATUSES, limit],
    );

    if (rows.length > 0) {
      // Warn: reaching this line means a worker died holding work, which is worth
      // seeing even though it is fully recovered from.
      this.logger.warn(`Reclaimed ${rows.length} expired pipeline shard lease(s)`, {
        reaped: rows.length,
        moreLikely: rows.length === limit,
      });
    }

    return rows.length;
  }

  /**
   * Claim a leg for this tick, or return `null` because somebody else has it.
   *
   * This is the re-entrancy guarantee, and it is a DATABASE fact rather than a
   * field on this object. Two ticks racing over the same leg both run the same
   * upsert; the `ON CONFLICT ... WHERE` lets exactly one of them through, and the
   * loser is handed no row and starts no sweep. An in-memory guard would give the
   * same answer today and the wrong one the moment the worker process is split
   * out — which is the change this whole file is shaped around.
   *
   * The two arms of the guard are the two ways a leg is unavailable:
   *
   *  - a live lease — another tick dispatched this leg less than
   *    {@link SHARD_LEASE_SECONDS} ago and its sweep may still be draining;
   *  - a `cancelled` status — the run is being torn down and must not have legs
   *    resurrected under it. `done` is deliberately NOT refused; see
   *    {@link UNCLAIMABLE_SHARD_STATUSES} for the permanent wedge that causes.
   *
   * `cursor` is left NULL. A Phase-1 sweep carries its keyset position in
   * `pgboss.job.data` (see `PipelineDispatchService`), so there is nothing
   * truthful to put here yet; the column belongs to the sharded planner that
   * hands out ranges, and writing a stale value into it would be worse than
   * leaving it empty.
   *
   * Public for the same reason as {@link reapExpiredShardLeases}.
   */
  async claimStageShard(runId: string, leg: StageLeg): Promise<string | null> {
    const rows = await this.dataSource.query<Array<{ id: string }>>(
      `INSERT INTO ci.pipeline_shards AS s
              (run_id, stage, shard_key, "cursor", status, lease_owner, lease_expires_at)
       VALUES ($1::uuid, $2, $3, NULL, $4, $5, now() + make_interval(secs => $6::float8))
       ON CONFLICT (run_id, stage, shard_key) DO UPDATE
          SET status           = EXCLUDED.status,
              lease_owner      = EXCLUDED.lease_owner,
              lease_expires_at = EXCLUDED.lease_expires_at
        WHERE s.status <> ALL($7::text[])
          AND (s.lease_expires_at IS NULL OR s.lease_expires_at < now())
    RETURNING s.id`,
      [
        runId,
        leg.stageId,
        leg.entityType,
        SHARD_STATUS.RUNNING,
        this.leaseOwner,
        SHARD_LEASE_SECONDS,
        UNCLAIMABLE_SHARD_STATUSES,
      ],
    );

    return rows.length > 0 ? String(rows[0].id) : null;
  }

  /**
   * Record that a leg's source is drained at the current stage version.
   *
   * "Drained" is a real fact, not an absence: it means the staleness probe found
   * nothing, which — because `claim()` never advances `stage_version` — also
   * means no row is sitting claimed-but-incomplete. A row a killed worker
   * abandoned in `running` is still a candidate, so a leg cannot read as drained
   * while work is genuinely in flight.
   *
   * A cancelled shard is left alone: cancellation is the operator's decision and
   * a later tick must not quietly relabel it.
   */
  private async markShardDrained(runId: string, leg: StageLeg): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO ci.pipeline_shards AS s
              (run_id, stage, shard_key, "cursor", status, lease_owner, lease_expires_at)
       VALUES ($1::uuid, $2, $3, NULL, $4, NULL, NULL)
       ON CONFLICT (run_id, stage, shard_key) DO UPDATE
          SET status           = EXCLUDED.status,
              lease_owner      = NULL,
              lease_expires_at = NULL
        WHERE s.status <> $5`,
      [runId, leg.stageId, leg.entityType, SHARD_STATUS.DONE, SHARD_STATUS.CANCELLED],
    );
  }

  /** Is any non-terminal shard of this run still held by a worker? */
  private async hasLiveShardLease(runId: string): Promise<boolean> {
    const rows = await this.dataSource.query<Array<{ id: string }>>(
      `SELECT s.id
         FROM ci.pipeline_shards s
        WHERE s.run_id = $1::uuid
          AND s.status <> ALL($2::text[])
          AND s.lease_expires_at IS NOT NULL
          AND s.lease_expires_at >= now()
        LIMIT 1`,
      [runId, TERMINAL_SHARD_STATUSES],
    );

    return rows.length > 0;
  }

  /**
   * The users this tick will service, each with its active run if it has one.
   *
   * One round trip rather than "list users, then read each one's run": the
   * partial unique index makes the LEFT JOIN produce at most one row per user, so
   * the join cannot fan out, and ordering users WITH an active run first means a
   * bounded tick can never starve a run somebody is watching in favour of an idle
   * account.
   *
   * Deleted and deactivated users are excluded. Their rows are still in the
   * source tables and would sweep perfectly happily, which is the problem: an
   * account being wound down should not be spending Ollama time or provider
   * budget.
   */
  private async activeRunRows(): Promise<ActiveRunRow[]> {
    return this.dataSource.query<ActiveRunRow[]>(
      `SELECT u.id            AS user_id,
              r.id            AS run_id,
              r.kind          AS kind,
              r.desired_state AS desired_state,
              r.detail        AS detail
         FROM ci.users u
         LEFT JOIN ci.pipeline_runs r
           ON r.user_id = u.id
          AND r.finished_at IS NULL
        WHERE u.deleted_at IS NULL
          AND COALESCE(u.is_active, true) = true
        ORDER BY (r.id IS NULL), u.id
        LIMIT $1`,
      [MAX_USERS_PER_TICK],
    );
  }

  /** Map key for a leg. The pair is the identity; the stage id alone is not. */
  private legKey(leg: StageLeg): string {
    return this.key(leg.stageId, leg.entityType);
  }

  /**
   * The same key, from the two columns a `ci.pipeline_schedule` row carries.
   *
   * Shared with {@link legKey} rather than written twice: the schedule map is
   * looked up by leg, so the two spellings agreeing is not a style point — a
   * mismatch would silently make every lookup miss, every leg read as never-run,
   * and every weekly stage due on every tick.
   */
  private key(stageId: string, entityType: string): string {
    return `${stageId}\0${entityType}`;
  }
}
