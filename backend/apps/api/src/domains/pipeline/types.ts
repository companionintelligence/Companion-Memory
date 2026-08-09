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

  /** Running total of ids dispatched by this sweep, carried across hops for the log line. */
  dispatched: z.number().int().nonnegative().default(0),
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
