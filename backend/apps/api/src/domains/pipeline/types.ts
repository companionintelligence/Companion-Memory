import { z } from 'zod';

import { type UserServiceContext } from '@ci/common/context';

import { DEFAULT_SLICE_SIZE, MAX_SLICE_SIZE } from './constants';

// ---------------------------------------------------------------------------
// The stage contract
// ---------------------------------------------------------------------------

/**
 * What a stage decided about ONE entity.
 *
 * `done | skipped | failed` are all TERMINAL as far as the stage is concerned;
 * the difference is what the ledger does next. `done` and `skipped` stop the
 * entity being re-selected until the stage version is bumped. `failed` sets a
 * retry gate (`next_attempt_at`) and the sweep picks the entity up again when
 * the gate is due, until the attempt budget is spent and it quarantines.
 */
export type StageOutcome = 'done' | 'skipped' | 'failed';

export interface StageResult {
  outcome: StageOutcome;

  /**
   * REQUIRED for `skipped` and `failed`, and enforced in code by
   * `PipelineStateService` — a result that omits it throws before anything is
   * written.
   *
   * This is not defensive pedantry, it is the fix for a measured defect: the
   * ETL layer carries ~30 `catch { log; continue }` blocks and the importer's
   * drop ledger is optional and used by a minority of importers, so the honest
   * answer to "why is this row missing?" today is that nobody recorded one. A
   * reason that is optional is a reason that is absent exactly when it matters.
   *
   * Keep it a stable, greppable token (`probe_failed`, `unsupported_codec`,
   * `no_location_name`), not a formatted sentence — it is grouped on by
   * `GET /api/pipeline/state` and used to select rows for replay.
   */
  reason?: string;

  /**
   * Confidence in `(0, 1]`, omitted when not meaningfully derivable.
   *
   * Never fabricate a number here. An enricher that reports 0.9 because that
   * felt right teaches the promoter to prefer it over a genuinely-measured 0.8,
   * which is how a worse answer permanently destroys a better one.
   */
  confidence?: number;

  /** Free-form per-entity detail for debugging. Not indexed, not queried on. */
  detail?: Record<string, unknown>;
}

/**
 * Where a stage's candidate rows live — the FROM clause of the staleness sweep.
 *
 * The sweep is generic over this, which is the whole reason one query can
 * replace `SearchIndexBackfillService.missingIds`,
 * `GeocodeBatchListener.selectCandidates`, `MediaDimensionsBackfillListener`'s
 * `width IS NULL` page, and the two participant backfills' fill-only-NULL
 * guards. Those are six hand-written candidate queries with six different
 * pagination bugs; this is one.
 */
export interface StageSource {
  /** Postgres schema of the source table (always `ci` today). */
  schema: string;

  /** Source table name. */
  table: string;

  /**
   * Identity column. Its value becomes `ci.pipeline_state.entity_id`, so it
   * must be a uuid (or castable to one) — the ledger's PK is typed.
   */
  idColumn: string;

  /** Column carrying the owning user's id; the sweep is always user-scoped. */
  userColumn: string;

  /**
   * Extra SQL AND-clause selecting the rows this stage APPLIES to, over the
   * source alias `s` — e.g. `s.variant = 'ORIGINAL' AND s.content_type LIKE
   * 'image/%'`. No leading `AND`.
   *
   * This is applicability, NOT completion. It must never reference the column
   * the stage writes: `s.width IS NULL` here would re-create the one-way
   * ratchet the ledger exists to remove, because the row would drop out of the
   * candidate set the moment the stage succeeded and a version bump could never
   * bring it back.
   *
   * Interpolated verbatim into the sweep, so it must be a trusted in-repo
   * literal. Never build it from request input.
   */
  predicate?: string;
}

// ---------------------------------------------------------------------------
// The schedule contract
// ---------------------------------------------------------------------------

/**
 * What is allowed to start a stage.
 *
 * The tick reads this; nothing else does. A stage cannot see its own trigger,
 * for the same reason it cannot see `STAGE_DEPENDENCIES` — see the note on
 * {@link Stage} about why the schedule is not a field there.
 */
export type StageTrigger =
  /**
   * New data dispatches it directly, AND the tick sweeps it as a backstop at
   * `minInterval`.
   *
   * The backstop is not redundancy for its own sake: arrival dispatch is a
   * listener plus a pg-boss job, and both can be lost (a listener that threw
   * before enqueuing, a job that spent its retries and dead-lettered, an
   * import that wrote rows with the event bus down). Without a sweep behind it
   * the loss is permanent and silent — the entity simply never appears in the
   * index and nothing counts the gap. `index.embed` is the only stage on this
   * trigger today, because search freshness is the only thing on the appliance
   * a user notices within the hour.
   */
  | 'onArrival'
  /** Only the tick starts it, at `minInterval`, inside its `window`. */
  | 'scheduled'
  /**
   * Nothing automatic ever starts it. Reachable only by a run that NAMES it in
   * `detail.stages` — i.e. a person, once, deliberately.
   *
   * Nothing declares this today, and it is still worth having: it is what makes
   * "excluded from every automatic set" a property of the schedule rather than
   * a second exclusion list beside it, which is the drift this whole file
   * exists to prevent. A stage whose sweep is destructive rather than merely
   * expensive is what it is for.
   */
  | 'manual';

/**
 * What one sweep of the stage SPENDS. Descriptive for two of the three values
 * and enforced for the third.
 */
export type StageCost =
  /**
   * Postgres and local CPU on the appliance. Nothing shared, nothing billed —
   * a bump costs time and nothing else.
   */
  | 'local'
  /**
   * Competes with an interactive user for a scarce LOCAL resource. Today that
   * means the single host Ollama process, shared with interactive chat, HBPE
   * and the summary sidecar.
   *
   * This value is DESCRIPTIVE and deliberately so: this file cannot gate Ollama,
   * because there is no honest contention signal to gate it with (the argument
   * is in `BackpressureService`'s class comment, and it is that chat, HBPE and
   * the sidecar record their usage nowhere this process can read). What actually
   * bounds a contended stage is `QUEUE_READY_CAPS['pipeline-embed']` — 25 ready
   * jobs, the tightest cap of the three, a declared reservation rather than a
   * measurement. `cost: 'contended'` is the label that sends a reader there.
   */
  | 'contended'
  /**
   * Egresses to a paid, metered provider. A sweep is a BILL, not just load.
   *
   * The ONE value in this union with teeth. `schedule.ts`'s boot guard refuses a
   * metered stage that is `onArrival`, refuses one that is not confined to the
   * enrichment window, and refuses one with no {@link StageSchedule.perRunCap}
   * — because a weekly stage with no cap still means one night a week when the
   * whole corpus hits a paid provider at once.
   */
  | 'metered';

/** When in the day the tick may START a sweep for this stage. */
export type StageWindow =
  /** Any hour. For work whose latency a user notices. */
  | 'any'
  /**
   * Only while the daily enrichment window is open — `ENRICHMENT_WINDOW` in
   * `constants.ts`, as decided by `EnrichmentWindowService`.
   *
   * This value DECLARES that a stage is confined to the window. It does not
   * decide whether the window is open: that reads a zoned wall clock, a nightly
   * budget and `ci.pipeline_turns`, and there must be exactly one
   * implementation of it. `stageDueness` takes `WindowStatus.open` as an input
   * for that reason.
   *
   * Time-boxing is about ADMISSION, never about killing work: the tick refuses
   * to start a sweep while the window is shut, and a sweep already running
   * drains on its own. Nothing in this pipeline reaches into a queue to remove
   * work — that always races a worker that has already claimed it.
   *
   * A window on its own would be a starvation trap on an appliance that is
   * asleep every night, which is why {@link StageSchedule.maxStaleness} exists
   * and overrides it.
   */
  | 'enrichment';

/**
 * WHEN a stage is allowed to run, and how much one run may cost.
 *
 * Declared once per stage in `STAGE_SCHEDULES` (`schedule.ts`). Read only by the
 * control tick.
 *
 * The four required fields answer four different questions, and dropping any one
 * of them collapses into a mechanism that has already failed here:
 *
 *  - `trigger` — what may start it at all;
 *  - `cost` — what a run spends, which is what decides how strict the rest is;
 *  - `minInterval` — the floor. Without it every stage runs on one global clock,
 *    which is what the appliance did before this file: a five-minute tick that
 *    re-probed a metered geocoder as eagerly as it re-probed a Postgres-only
 *    cleaner;
 *  - `maxStaleness` — the ceiling, and the escape hatch. Without it a windowed
 *    stage on an appliance that is powered down every night never runs again,
 *    and nothing anywhere says so.
 */
export interface StageSchedule {
  /** What may start this stage. */
  trigger: StageTrigger;

  /** What one sweep spends. */
  cost: StageCost;

  /** When in the day a sweep may START. */
  window: StageWindow;

  /**
   * SECONDS. Do not re-sweep this stage for a user sooner than this after the
   * last sweep was started for that user.
   *
   * Measured per (user, stage, entity_type) leg, never appliance-wide: a second
   * user's first import must not be held back because the first user's nightly
   * pass ran an hour ago.
   */
  minInterval: number;

  /**
   * SECONDS. Once this long has passed since the last sweep, the leg is OVERDUE
   * and its `window` no longer applies.
   *
   * This is what keeps a daily window from being a way to never run. An
   * appliance that is powered off at 03:00 every night has an enrichment window
   * it is never awake for; after `maxStaleness` its nightly stages become due at
   * whatever hour the box happens to be on, and the cost discipline that still
   * holds is {@link perRunCap}, which is the one that was about money anyway.
   *
   * A leg that has NEVER run is infinitely stale and therefore overdue by this
   * rule rather than by a special case — so a freshly imported appliance
   * enriches immediately instead of waiting for tonight, and a metered stage's
   * first pass is bounded by its cap.
   *
   * Must be >= `minInterval`; the boot guard refuses otherwise, because a
   * ceiling below the floor makes every leg permanently overdue and silently
   * deletes both the interval and the window.
   */
  maxStaleness: number;

  /**
   * Hard ceiling on entity ids ONE sweep may dispatch. Omitted means uncapped.
   *
   * For a metered stage this matters more than `minInterval` does, and the
   * measured case is `enrich.position_reverse`: `ci.position` is empty today
   * only because a debug push used the legacy GraphQL lane, and a real `/v1`
   * import fills it from 66,579 Google Fit records plus GPX and location
   * history. Weekly-with-no-cap is not slow, it is one week in which 66,000
   * fixes hit a paid provider at once. The interval decides how often the bill
   * arrives; the cap decides how big it can be.
   *
   * Enforced by the dispatcher at slice granularity, so a sweep may overshoot by
   * less than one slice (`DEFAULT_SLICE_SIZE`) before it stops. That slack is
   * deliberate: cutting a slice in half to hit an exact number would make the
   * cap a source of odd-sized slices for no benefit, and the cap is a budget
   * rather than a quota.
   */
  perRunCap?: number;
}

/**
 * One unit of work in the pipeline.
 *
 * Stages are pure processing: they receive ids, do work, and return decisions.
 * **A stage never touches pg-boss, never enqueues, never reads the ledger and
 * never writes `ci.pipeline_state`.** Dispatch and bookkeeping belong to
 * `PipelineDispatchService` and `PipelineSliceListener`, which is what makes a
 * stage trivially unit-testable and what stops each new enricher from
 * re-inventing its own batching, retry and cursor handling — the drift that
 * left nine maintenance legs with nine different pagination strategies.
 *
 * ── There is deliberately no `schedule` field here ──────────────────────────
 *
 * A stage's cadence is declared in `STAGE_SCHEDULES` (`schedule.ts`), keyed by
 * stage id, exactly as its version is declared in `STAGE_VERSIONS` and its
 * implementation token in `STAGE_REGISTRY`. {@link StageSchedule} lives in this
 * file because it is contract vocabulary; the VALUES do not, and that split is
 * the same one `STAGE_DEPENDENCIES` already makes.
 *
 * Three reasons, in the order they matter:
 *
 *  1. **The boot guard only exists if it is a map.** `assertStageRegistryComplete`
 *     is a key-set comparison between two flat declarations at MODULE LOAD, and
 *     that is the only reason a stage with no version fails the boot instead of
 *     failing a worker weeks later. A field on `Stage` is readable only after
 *     Nest has constructed the provider, so the equivalent guard could not run
 *     until `onModuleInit` — after pg-boss has created queues and started
 *     workers, and only for stages something resolved. "Every registered stage
 *     declares a schedule" would become "every stage somebody happened to
 *     resolve declared a schedule".
 *  2. **Cadence is reviewable in one diff, or it is not reviewable.** Twelve
 *     numbers spread over twelve classes cannot be read as a schedule. The one
 *     question anybody actually asks — "what does this appliance do overnight,
 *     and what does it cost?" — is answered by reading one file.
 *  3. **Scheduling is not a stage's business.** A stage that declared its own
 *     cadence would be one step from reading it, and the contract's whole
 *     discipline is that a stage receives ids and returns decisions. It does not
 *     know what ran before it (`STAGE_DEPENDENCIES`), and it does not know when
 *     it runs either.
 */
export interface Stage {
  /** Stable id, e.g. `enrich.media_dimensions`. Must appear in `STAGE_IDS`. */
  readonly id: string;

  /** Current version, read from `STAGE_VERSIONS`. Never hardcode it here. */
  readonly version: number;

  /** Which pipeline queue this stage's slices ride. Must be a `PIPELINE_QUEUES` value. */
  readonly queue: string;

  /**
   * Ledger `entity_type` values this stage writes. Usually one. More than one
   * means the sweep must be told which type it is sweeping, because
   * `ci.pipeline_state` is keyed per (entity_type, entity_id, stage).
   */
  readonly entityTypes: readonly string[];

  /** The source table the staleness sweep pages over. */
  readonly source: StageSource;

  /**
   * Process the given ids and return one result per id.
   *
   * Ids missing from the returned map are recorded as `failed:
   * stage_returned_no_result` by the worker — silence is never treated as
   * success, or a stage that quietly drops half its input would report full
   * coverage.
   *
   * Must be idempotent. Two dispatchers sweeping concurrently can legitimately
   * hand the same id to two workers; the claim de-duplicates the common case
   * but is not a distributed lock, and correctness may not depend on it.
   */
  run(ctx: UserServiceContext, ids: string[]): Promise<Map<string, StageResult>>;
}

/** The subset of a {@link Stage} the ledger needs. A full `Stage` satisfies it. */
export type StageRef = Pick<Stage, 'id' | 'version'>;

// ---------------------------------------------------------------------------
// Event payload schemas
// ---------------------------------------------------------------------------

/**
 * Payloads arrive from `pgboss.job.data` — JSON that was written by a previous
 * release of this code, possibly weeks ago, possibly by a replayed dead letter.
 * They are parsed, not cast. A malformed payload throws inside the worker,
 * which dead-letters it with the payload intact rather than letting `undefined`
 * flow into a SQL parameter and fail somewhere unrecognisable.
 *
 * The schemas are non-strict on purpose: the job envelope adds keys of its own
 * (`jobId`, and `name` is stripped by the dispatcher), and a future field must
 * not make old workers reject new jobs.
 */

/** One slice: a bounded set of entity ids for one stage, for one user. */
export const pipelineSlicePayloadSchema = z.object({
  /** Stage id; looked up in `STAGE_REGISTRY` by the worker. */
  stage: z.string().min(1),

  /** Ledger entity_type these ids are keyed under. */
  entityType: z.string().min(1),

  userId: z.string().uuid(),

  /**
   * The ids to process. Bounded by {@link MAX_SLICE_SIZE}: a slice must stay
   * small enough that losing one to a killed worker is uninteresting.
   */
  ids: z.array(z.string().uuid()).min(1).max(MAX_SLICE_SIZE),

  /** Owning run, when the slice was planned by a run rather than an ad-hoc sweep. */
  runId: z.string().uuid().nullish(),

  /** Owning shard, when the slice came from a sharded plan. */
  shardId: z.string().uuid().nullish(),
});

export type PipelineSlicePayload = z.infer<typeof pipelineSlicePayloadSchema>;

/**
 * One hop of a keyset sweep. Self-requeued with an advanced cursor until the
 * sweep runs dry, so the whole sweep is durable: it lives in `pgboss.job`, not
 * in a `while` loop inside a request handler that dies with the connection.
 */
export const pipelineSweepPayloadSchema = z.object({
  stage: z.string().min(1),

  userId: z.string().uuid(),

  /**
   * Which entity_type to sweep. Optional when the stage declares exactly one —
   * required when it declares several, because the ledger join is per type.
   */
  entityType: z.string().min(1).optional(),

  /**
   * Keyset position: the last source id already dispatched. `null`/absent
   * starts from the beginning.
   *
   * A keyset, not an OFFSET. Resuming costs O(remaining) rather than
   * O(processed), and rows inserted into the source mid-sweep can neither be
   * skipped nor handed out twice.
   */
  cursor: z.string().uuid().nullish(),

  sliceSize: z.number().int().positive().max(MAX_SLICE_SIZE).default(DEFAULT_SLICE_SIZE),

  /** Hop counter. Fuel gauge against a sweep that fails to advance; see MAX_SWEEP_HOPS. */
  hop: z.number().int().nonnegative().default(0),

  /**
   * Running total of ids dispatched by this sweep, carried across hops for the
   * log line — and, since {@link maxIds}, for the budget too.
   */
  dispatched: z.number().int().nonnegative().default(0),

  /**
   * Ceiling on ids this WHOLE sweep may dispatch, across every hop.
   * Absent/`null` is uncapped, which is what every stage without a
   * {@link StageSchedule.perRunCap} gets.
   *
   * Carried in the payload rather than re-read from `STAGE_SCHEDULES` at each
   * hop, and that is the point of it being here: a sweep is a chain of jobs that
   * outlives the process which started it, so a cap re-derived per hop would
   * change under a running sweep the moment somebody edits the schedule and
   * deploys. The number the sweep was authorised with travels with the sweep.
   *
   * Nullish rather than optional-with-a-default: `pipelineSweepPayloadSchema` is
   * non-strict and parses jobs written by earlier releases, and a default here
   * would have to be a number — there is no integer that means "uncapped".
   */
  maxIds: z.number().int().positive().nullish(),
});

export type PipelineSweepPayload = z.infer<typeof pipelineSweepPayloadSchema>;

/** On-demand dead-letter reap, in addition to the cron. */
export const pipelineDeadLetterReapPayloadSchema = z.object({
  limit: z.number().int().positive().max(10_000).optional(),
});

export type PipelineDeadLetterReapPayload = z.infer<typeof pipelineDeadLetterReapPayloadSchema>;

// ---------------------------------------------------------------------------
// Ledger result shapes
// ---------------------------------------------------------------------------

/** Per-status tally returned by `PipelineStateService.complete` / `.fail`. */
export interface LedgerWriteSummary {
  done: number;
  skipped: number;
  failed: number;
  /** Failures that spent their attempt budget and were parked for a human. */
  quarantined: number;
}

/**
 * Ledger coverage for one stage: the answer to "is my import finished?", which
 * the system has never been able to give.
 *
 * One bucket per ledger status, so the six are exhaustive and `total` is their
 * sum. Exhaustive on purpose: a status counted in no bucket would make the
 * numbers read better than reality, which is the one direction they must never
 * be wrong in.
 *
 * Counts come from `ci.pipeline_state` ALONE, so these are rows the stage has
 * recorded an opinion about — NOT rows that exist. Answering "how many are
 * eligible?" requires the stage's source table and applicability predicate and
 * belongs to the sweep.
 */
export interface StageCoverage {
  stage: string;

  /** The version `stale` is measured against. */
  stageVersion: number;

  /** Ledger rows for this stage — NOT eligible source rows. */
  total: number;

  done: number;
  skipped: number;
  failed: number;

  /** Claimed, not yet terminal. */
  pending: number;
  running: number;

  /** Terminal failures that also ran out of retries. Need a human, or a bump. */
  quarantined: number;

  /** Rows recorded below the current version — what a bump would re-process. */
  stale: number;

  /** `(done + skipped) / total`, or 0 when the ledger has no rows for the stage. */
  coverage: number;
}

/** A job that died terminally, on its way into `ci.pipeline_dead_letters`. */
export interface DeadLetterInput {
  /** Queue the job was being worked on when it threw. */
  queue: string;

  /** Event name, and the name a replay re-emits under. */
  eventName: string;

  stage?: string | null;
  entityType?: string | null;
  entityId?: string | null;

  /** The payload VERBATIM. Never trimmed — it is routinely the only surviving copy. */
  payload: Record<string, unknown>;

  /** Message and, where available, stack. */
  error: string;
}
