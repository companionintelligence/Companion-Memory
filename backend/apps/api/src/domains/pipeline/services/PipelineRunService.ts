import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { BACKFILL_JOB_PRIORITY, EventListenerRegistry, EventService } from '@ci/domains/events';

import { DEAD_LETTER_QUEUE, STAGE_ID_LIST } from '../constants';
import type { PipelineRunDesiredState } from '../entities/PipelineRunEntity';
import type { StageCoverage } from '../types';
import { stageVersion } from '../versions';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Runs returned by one `GET /api/pipeline/runs` when the caller names no limit. */
export const DEFAULT_RUN_PAGE = 25;

/** Hard ceiling on runs per page. */
export const MAX_RUN_PAGE = 200;

/**
 * Shards returned with one run detail.
 *
 * A run's shards are its unit of parallelism, so in practice this is tens of
 * rows; the ceiling exists because nothing in the schema bounds it and an
 * operator endpoint that can return an unbounded result set is a denial of
 * service against the appliance it is meant to diagnose. The read asks for
 * `limit + 1` and reports {@link PipelineRunDetail.shardsTruncated} rather than
 * silently returning a short list — a progress view that quietly omits shards
 * would under-report exactly the work an operator is looking for.
 */
export const MAX_SHARDS_PER_RUN = 500;

/** Dead letters returned by one list call when the caller names no limit. */
export const DEFAULT_DEAD_LETTER_PAGE = 50;

/**
 * Hard ceiling on dead letters per page.
 *
 * Deliberately small. Every row carries its payload VERBATIM and its full error
 * with stack — that fidelity is the whole reason the table exists — so a page is
 * bounded by making it short rather than by trimming the two columns that make a
 * letter replayable and diagnosable.
 */
export const MAX_DEAD_LETTER_PAGE = 200;

/**
 * `event_name` the reaper writes for a pg-boss job whose payload carries no
 * `name` — i.e. one inserted by something other than `EventService.send`.
 *
 * DUPLICATED from the `COALESCE(NULLIF(j.data->>'name', ''), 'unknown')` in
 * `DeadLetterReaperListener.reap`. It is a literal in one SQL statement there
 * and there is no constant to import; the two must stay identical or
 * {@link PipelineRunService.replayDeadLetter} would happily "replay" a letter
 * that can never be routed.
 */
const UNATTRIBUTABLE_EVENT_NAME = 'unknown';

/**
 * Namespace for the `singletonKey` every replayed letter carries.
 *
 * A replay MUST be keyed. Queues that declare pg-boss `policy: 'short'` are
 * covered by a unique index on `(name, COALESCE(singleton_key,''))` over jobs
 * still in `created`, inserted with ON CONFLICT DO NOTHING — so keyless sends
 * collapse into ONE job and every send after the first returns a null id. A
 * bulk replay of N letters onto such a queue would enqueue the first and
 * silently drop the rest.
 *
 * The key is the LETTER's id, not the payload's identity: a replay is a
 * distinct unit of work, and re-driving one letter must not be swallowed by a
 * live job the normal producer already queued. The prefix keeps it out of every
 * producer's key namespace in both directions.
 */
export const DEAD_LETTER_REPLAY_KEY_PREFIX = 'dead-letter-replay:';

/** The partial unique index that makes "one active run per user" a database fact. */
const ACTIVE_RUN_CONSTRAINT = 'pipeline_runs_active_uniq';

// ---------------------------------------------------------------------------
// Read shapes
// ---------------------------------------------------------------------------

/** A run as the operator surface reports it. */
export interface PipelineRunSummary {
  id: string;
  kind: string;

  /** Operator intent. The CONTROL channel — what the run has been asked to do. */
  desiredState: PipelineRunDesiredState;

  /** Worker-reported state. The OBSERVED channel — what is actually happening. */
  status: string;

  startedAt: Date;
  finishedAt: Date | null;

  /**
   * `finishedAt == null`, spelled out.
   *
   * This is the predicate of `pipeline_runs_active_uniq`, so it is also the
   * answer to "can this user start another run?" — which is not derivable from
   * `status`, whose vocabulary belongs to the runner and will grow.
   */
  active: boolean;

  detail: Record<string, unknown>;

  /** Shards materialized for this run. 0 until the runner plans them. */
  shardCount: number;

  /**
   * Shards per shard status.
   *
   * A pass-through tally rather than fixed buckets: `ci.pipeline_shards.status`
   * carries no CHECK constraint, so its vocabulary belongs to the runner. Fixed
   * buckets here would silently drop any status this file had not heard of, and
   * a progress view that loses rows reads better than reality.
   */
  shardsByStatus: Record<string, number>;
}

/** One shard of a run, with its resumable cursor. */
export interface PipelineShardProgress {
  id: string;
  stage: string;
  shardKey: string;

  /**
   * Keyset position: the last source id handed out. This is what makes a run
   * resumable, and it is the single most useful number when answering "is this
   * run moving?" — two reads a minute apart that show the same cursor mean it is
   * not.
   */
  cursor: string | null;

  status: string;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;

  /**
   * The lease deadline has passed, so this shard is reclaimable regardless of
   * {@link leaseOwner}. Computed in SQL against `now()` rather than compared to
   * the API node's clock, which can differ from the database's.
   */
  leaseExpired: boolean;
}

export interface PipelineRunDetail extends PipelineRunSummary {
  shards: PipelineShardProgress[];

  /** More shards exist than {@link MAX_SHARDS_PER_RUN}; `shards` is a prefix. */
  shardsTruncated: boolean;
}

/** A dead letter as the operator surface reports it. */
export interface PipelineDeadLetterView {
  id: string;
  queue: string;
  eventName: string;
  stage: string | null;
  entityType: string | null;
  entityId: string | null;
  userId: string | null;

  /** The payload VERBATIM. Never trimmed — replay fidelity is the point of the table. */
  payload: Record<string, unknown>;

  error: string;
  failedAt: Date;

  /**
   * When this letter was successfully re-emitted, or `null` if it never was.
   *
   * Also the START OF ITS RETENTION CLOCK, which is the part that is not
   * obvious from the name: `DeadLetterReaperListener.purgeReplayed` deletes
   * stamped letters once they are older than
   * `queues.replayedDeadLetterRetentionDays` (30 days by default), so a row
   * that shows a timestamp here is a row that will eventually leave this list.
   * A `null` here is permanent — unreplayed letters have no TTL and no sweep
   * touches them, at any age.
   */
  replayedAt: Date | null;
}

/** What a replay did. */
export interface DeadLetterReplayResult {
  id: string;

  /** The name the payload was re-emitted under. */
  eventName: string;

  /** Queue it was re-emitted onto, or `null` when routed by listener registration. */
  queue: string | null;

  /** pg-boss job ids created. Never empty — an empty replay is reported as a failure. */
  jobIds: string[];

  replayedAt: Date;
}

/** One letter that was claimed but could not be re-emitted. Its claim is released. */
export interface DeadLetterReplayFailure {
  id: string;
  eventName: string;

  /** Why it did not go back on the bus, verbatim from the thrown error. */
  reason: string;
}

/** What a bulk replay did. */
export interface DeadLetterBulkReplayResult {
  /**
   * How many distinct ids the caller named, or `null` when the batch was
   * selected by filter (where "requested" is not a number the caller knows).
   */
  requested: number | null;

  /** Letters this call took ownership of — i.e. whose `replayed_at` it stamped. */
  claimed: number;

  /** The ceiling applied to the claim, after clamping. */
  limit: number;

  replayed: DeadLetterReplayResult[];
  failed: DeadLetterReplayFailure[];

  /**
   * Named ids that claimed nothing: already replayed, unknown, or another
   * user's. Empty for the filter form. NOT an error — "already replayed" is the
   * double-submit guard doing its job.
   *
   * Only ids the claim actually SCANNED appear here. An id the batch ceiling cut
   * off is unsettled, not skipped, and goes in {@link notAttempted} — the two
   * call for opposite responses from the caller ("nothing to do" vs "ask again").
   */
  skipped: string[];

  /**
   * Named ids beyond the batch ceiling, which this call never looked at. Empty
   * unless the caller passed an explicit `limit` smaller than its own id list;
   * without one the ceiling is derived from the list, so every named id is
   * scanned.
   */
  notAttempted: string[];
}

/** Which letters {@link PipelineRunService.replayDeadLetters} should claim. */
export interface BulkReplayDeadLettersInput {
  /** Explicit letters. Deduplicated before the claim. */
  ids?: string[];

  /** Only letters recorded under this event name — the "replay this one failure class" form. */
  eventName?: string;

  /** Only letters that failed at or after this instant. */
  failedAfter?: Date;

  /** Ceiling on letters claimed by this call. Clamped to {@link MAX_DEAD_LETTER_PAGE}. */
  limit?: number;
}

/** Options for {@link PipelineRunService.listRuns}. */
export interface ListRunsOptions {
  limit?: number;
  offset?: number;
  /** Only runs that have not been finalized. */
  activeOnly?: boolean;
}

/** Options for {@link PipelineRunService.listDeadLetters}. */
export interface ListDeadLettersOptions {
  queue?: string;
  stage?: string;
  /** `true` → only replayed, `false` → only un-replayed, absent → both. */
  replayed?: boolean;
  limit?: number;
  offset?: number;
}

/** What {@link PipelineRunService.startRun} was asked to create. */
export interface StartRunInput {
  /** Which pipeline this is a run of, e.g. `import` | `reprocess` | `continuous`. */
  kind: string;
  /** Seeded into `ci.pipeline_runs.detail`. */
  detail?: Record<string, unknown>;
}

/** Outcome of {@link PipelineRunService.startRun}. */
export interface StartRunResult {
  run: PipelineRunSummary;

  /**
   * `false` when a run was already active for this user and the existing one is
   * returned instead. NOT an error — see the class comment.
   */
  created: boolean;
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface RunRow {
  id: string;
  kind: string;
  desired_state: string;
  status: string;
  started_at: Date;
  finished_at: Date | null;
  detail: Record<string, unknown> | null;
  shard_count?: number | string | null;
  shards_by_status?: Record<string, number | string> | null;
}

interface ShardRow {
  id: string;
  stage: string;
  shard_key: string;
  cursor: string | null;
  status: string;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  lease_expired: boolean;
}

interface DeadLetterRow {
  id: string;
  queue: string;
  event_name: string;
  stage: string | null;
  entity_type: string | null;
  entity_id: string | null;
  user_id: string | null;
  payload: Record<string, unknown> | null;
  error: string;
  failed_at: Date;
  replayed_at: Date | null;
}

interface StageStateRow {
  stage: string;
  status: string;
  count: number | string;
  stale: number | string;
}

/**
 * Was this a violation of the one-active-run-per-user index?
 *
 * `pipeline_runs_active_uniq` is the ONLY unique index on `ci.pipeline_runs`
 * besides the primary key, and the primary key defaults to `ci.gen_uuid_v7()`,
 * so in practice a 23505 on that table means exactly one thing. It is still
 * checked by name, because "some unique constraint broke" reported as "a run is
 * already going" would be a lie that survives every test.
 *
 * The constraint name is accepted as absent, though: node-postgres populates it
 * from the server's error fields and a proxy or a pooler in between is not
 * required to. Absent-and-23505 is read as the active-run conflict; a 23505
 * naming some OTHER constraint is rethrown untouched.
 */
function isActiveRunConflict(err: unknown): boolean {
  const candidate = err as {
    code?: unknown;
    constraint?: unknown;
    driverError?: { code?: unknown; constraint?: unknown };
  } | null;

  const code = candidate?.driverError?.code ?? candidate?.code;

  if (code !== '23505') {
    return false;
  }

  const constraint = candidate?.driverError?.constraint ?? candidate?.constraint;

  return constraint == null || constraint === ACTIVE_RUN_CONSTRAINT;
}

/** Clamp a caller-supplied page size into `[1, max]`, defaulting when absent. */
function pageSize(requested: number | undefined, fallback: number, max: number): number {
  if (requested == null || !Number.isFinite(requested)) {
    return fallback;
  }

  return Math.min(Math.max(Math.trunc(requested), 1), max);
}

/**
 * The run lifecycle and the operator's read/control plane over it.
 *
 * ── What an operator could see before this ─────────────────────────────────
 *
 * Nothing. `ci.pipeline_runs`, `ci.pipeline_shards` and
 * `ci.pipeline_dead_letters` were created, mirrored as entities and then never
 * read: there is no endpoint, no UI, and the runbook's answer to "is my import
 * finished?", "what died?" and "how do I stop this?" is a psql query. The
 * reaper's whole justification — that a dead letter is REPLAYABLE — was
 * unrealised, because nothing could replay one.
 *
 * ── One active run per user, enforced in the database ──────────────────────
 *
 * `pipeline_runs_active_uniq` is a partial unique index on `(user_id) WHERE
 * finished_at IS NULL`. Two consequences drive most of the code below:
 *
 *  1. **A second insert for a user raises SQLSTATE 23505, and that is a normal
 *     outcome, not an error.** An operator double-clicking "reprocess" means "I
 *     want a run", and one is already going; {@link startRun} returns the
 *     existing run with `created: false` rather than propagating a 500. The
 *     alternative — check-then-insert — is the lost race the index exists to
 *     make impossible, so the conflict is caught rather than avoided.
 *  2. **Finalization MUST stamp `finished_at`, for every terminal status
 *     including `cancelled`.** The index keys on that column and nothing else,
 *     so a run left with a NULL `finished_at` blocks its user from ever starting
 *     another one — permanently, with no error message anywhere and no way out
 *     but SQL. {@link finishRun} therefore sets it unconditionally and only the
 *     `status` varies.
 *
 * ── Control and observation are separate channels ──────────────────────────
 *
 * `desired_state` is what the operator wants; `status` is what the workers
 * report. {@link setDesiredState} writes ONLY `desired_state` — it never touches
 * `status`, because collapsing the two channels is what forces a cancel to reach
 * into the queue and delete jobs, and that operation always races a worker that
 * has already claimed one. A worker reads `desired_state` between batches and
 * stops on its own.
 *
 * That also means **cancel does not finalize the run** (the migration is
 * explicit: "a cancelled run stays active until a worker finalizes it"). The
 * run stays active while in-flight shards drain, and the control tick calls
 * {@link finishRun}. See that method's note on what happens if no tick is
 * running.
 *
 * ── User scoping ───────────────────────────────────────────────────────────
 *
 * Every read here filters on `user_id`. That is a deliberate departure from
 * `JobMonitorService`, which asserts `context.userId` and then queries pg-boss
 * globally, returning every user's `job.data` verbatim. These tables hold
 * payloads, so the same shape of bug here would leak another user's records to
 * whoever opened the dead-letter drawer.
 */
@Injectable()
export class PipelineRunService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PipelineRunService.name);
  }

  // -------------------------------------------------------------------------
  // Coverage
  // -------------------------------------------------------------------------

  /**
   * Ledger coverage for every declared stage, for one user — the answer to "is
   * my import finished?", which this system has never been able to give.
   *
   * One round trip for all stages. The per-stage current version is carried IN
   * to the query as a parallel array and joined, because `stale` is measured
   * against a different integer per stage and running one grouped query per
   * stage would be one round trip per stage for a page that renders them all
   * together.
   *
   * Deliberately NOT `PipelineStateService.coverage()`, which asks the identical
   * question appliance-wide: it takes no user parameter, so on a multi-user
   * appliance it would answer this endpoint with somebody else's rows. The
   * result type is shared with it on purpose, so the two can never describe the
   * same numbers differently.
   *
   * Counts come from `ci.pipeline_state` alone, so `total` is "rows this stage
   * has recorded an opinion about" and NOT "rows that exist". Answering the
   * latter needs the stage's source table and applicability predicate, which is
   * the sweep's job. Quoting `coverage` as a completion percentage without an
   * eligible-row count beside it is the unearned confidence this whole subsystem
   * replaces.
   *
   * Rows recorded under a stage id that is no longer declared are invisible
   * here, because there is no current version to measure them against. Stage ids
   * are permanent by rule (they are the third component of the ledger's primary
   * key), so that state means somebody renamed one — which the README forbids
   * for exactly this reason.
   */
  async stageState(ctx: UserServiceContext): Promise<StageCoverage[]> {
    const stageIds = [...STAGE_ID_LIST];
    const versions = stageIds.map((stageId) => stageVersion(stageId));

    const rows = await this.dataSource.query<StageStateRow[]>(
      `SELECT p.stage,
              p.status,
              count(*)::int AS count,
              count(*) FILTER (WHERE p.stage_version < v.version)::int AS stale
         FROM ci.pipeline_state p
         JOIN unnest($2::text[], $3::int[]) AS v(stage, version) ON v.stage = p.stage
        WHERE p.user_id = $1::uuid
        GROUP BY p.stage, p.status`,
      [ctx.userId, stageIds, versions],
    );

    // Zero-filled up front, one entry per DECLARED stage. A stage with no ledger
    // rows must still appear at 0 — an absent stage reads as "not applicable"
    // when it actually means "never run", and those are the opposite answer to
    // the question this endpoint exists for.
    const byStage = new Map<string, StageCoverage>(
      stageIds.map((stageId, index) => [
        stageId,
        {
          stage: stageId,
          stageVersion: versions[index],
          total: 0,
          done: 0,
          skipped: 0,
          failed: 0,
          pending: 0,
          running: 0,
          quarantined: 0,
          stale: 0,
          coverage: 0,
        },
      ]),
    );

    for (const row of rows) {
      const coverage = byStage.get(row.stage);

      if (coverage == null) {
        continue;
      }

      const count = Number(row.count);

      coverage.total += count;
      coverage.stale += Number(row.stale ?? 0);

      switch (row.status) {
        case 'pending':
          coverage.pending += count;
          break;
        case 'running':
          coverage.running += count;
          break;
        case 'done':
          coverage.done += count;
          break;
        case 'skipped':
          coverage.skipped += count;
          break;
        case 'failed':
          coverage.failed += count;
          break;
        case 'quarantined':
          coverage.quarantined += count;
          break;
        default:
          // The column carries a CHECK over exactly six values, so this is
          // unreachable short of a migration adding a seventh. Still counted
          // into `total` above, so an unrecognised status makes `coverage` read
          // LOW — the only direction this number is allowed to be wrong in.
          this.logger.warn('Unrecognised pipeline_state status in stage state query', {
            stage: row.stage,
            status: row.status,
            count,
          });
          break;
      }
    }

    for (const coverage of byStage.values()) {
      coverage.coverage = coverage.total === 0 ? 0 : (coverage.done + coverage.skipped) / coverage.total;
    }

    // Declaration order, not query order: `STAGE_ID_LIST` is ordered by phase,
    // so the report reads in pipeline order rather than in whatever order
    // Postgres grouped.
    return stageIds.map((stageId) => byStage.get(stageId) as StageCoverage);
  }

  // -------------------------------------------------------------------------
  // Run lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start a run, or report the one already going.
   *
   * The insert is attempted directly rather than guarded by a "is one already
   * active?" read: that read-then-write is precisely the lost race
   * `pipeline_runs_active_uniq` was added to close, and under it two operators
   * (or one operator and a cron) both see "no active run" and both insert. Here
   * the database decides, and the loser reads back the winner's run.
   *
   * The loop runs at most twice, for the narrow race where the active run is
   * finalized between our failed insert and our read: the first attempt 23505s,
   * the read finds nothing because the blocker just finished, and the second
   * attempt succeeds. A second conflict with nothing to read back is a genuine
   * inconsistency and is raised.
   */
  async startRun(ctx: UserServiceContext, input: StartRunInput): Promise<StartRunResult> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const rows = await this.dataSource.query<RunRow[]>(
          `INSERT INTO ci.pipeline_runs (user_id, kind, desired_state, status, detail)
                VALUES ($1::uuid, $2, 'running', 'queued', $3::jsonb)
             RETURNING id, kind, desired_state, status, started_at, finished_at, detail`,
          [ctx.userId, input.kind, JSON.stringify(input.detail ?? {})],
        );

        const run = this.toRunSummary(rows[0]);

        this.logger.log('Started pipeline run', { runId: run.id, userId: ctx.userId, kind: run.kind });

        return { run, created: true };
      } catch (err: unknown) {
        if (!isActiveRunConflict(err)) {
          throw err;
        }

        const existing = await this.findActiveRun(ctx);

        if (existing != null) {
          // The expected outcome of a double-click, not a failure. The caller
          // gets the run that IS going, which is what it wanted to know.
          this.logger.debug('Pipeline run already active for user; returning the existing run', {
            runId: existing.id,
            userId: ctx.userId,
            requestedKind: input.kind,
          });

          return { run: existing, created: false };
        }
      }
    }

    throw new ConflictException(
      'A pipeline run is already active for this user, but it could not be read back. ' +
        'Retry; if this persists, ci.pipeline_runs holds an unfinalized run this user cannot see.',
    );
  }

  /**
   * The active (un-finalized) run for a user, or `null`.
   *
   * `LIMIT 1` is belt to `pipeline_runs_active_uniq`'s braces: the index makes
   * more than one impossible, and asking for one row means a broken index
   * degrades this to "reports one of them" rather than to an exception in a
   * status endpoint.
   */
  async findActiveRun(ctx: UserServiceContext): Promise<PipelineRunSummary | null> {
    const rows = await this.dataSource.query<RunRow[]>(
      `${this.runSelect()}
        WHERE r.user_id = $1::uuid
          AND r.finished_at IS NULL
        ORDER BY r.started_at DESC
        LIMIT 1`,
      [ctx.userId],
    );

    return rows.length > 0 ? this.toRunSummary(rows[0]) : null;
  }

  /**
   * Finalize a run. **Always stamps `finished_at`.**
   *
   * This is the single most load-bearing statement in the file. `finished_at IS
   * NULL` is the entire predicate of `pipeline_runs_active_uniq`, so a run that
   * reaches a terminal status without this write stays "active" forever and its
   * user can never start another run — no error, no log line, nothing to see
   * except that every subsequent start returns somebody's stale run. A cancelled
   * run is the case that gets this wrong, because "cancelled" feels like a
   * different kind of ending; here it is only a different `status`.
   *
   * `COALESCE(finished_at, now())` keeps the timestamp of the FIRST
   * finalization, so a second call (a retried tick, a replayed control job) is
   * idempotent rather than silently extending the run's measured duration.
   *
   * System-scoped on purpose: the caller is the control tick finalizing a run it
   * already resolved, not a request acting on its own data.
   *
   * NOTE (Phase 5): nothing in this repo runs a control tick yet, so nothing
   * calls this in production. Until one lands, a cancelled run stays active —
   * which is correct per the schema's contract, and which is also why cancelling
   * must not be offered on a deployment with no runner.
   */
  async finishRun(
    runId: string,
    status: string,
    detail: Record<string, unknown> = {},
  ): Promise<PipelineRunSummary | null> {
    const rows = await this.dataSource.query<RunRow[]>(
      // CTE-wrapped so the OUTER command is a SELECT. TypeORM's Postgres driver
      // special-cases UPDATE/DELETE and resolves \`[rows, rowCount]\`, so a bare
      // \`UPDATE ... RETURNING\` hands back an array whose FIRST ELEMENT is the rows
      // array — making \`rows.length === 0\` never true and \`rows[0]\` an array
      // rather than a row. Measured against live Postgres:
      //   UPDATE ... RETURNING  ->  [[{...}], 1]
      //   WITH u AS (UPDATE ...) SELECT * FROM u  ->  [{...}]
      // A mock-based spec cannot catch this: the mock returns whatever the test wrote.
      `WITH updated AS (
         UPDATE ci.pipeline_runs
            SET status      = $2,
                finished_at = COALESCE(finished_at, now()),
                detail      = detail || $3::jsonb
          WHERE id = $1::uuid
      RETURNING id, kind, desired_state, status, started_at, finished_at, detail)
       SELECT id, kind, desired_state, status, started_at, finished_at, detail FROM updated`,
      [runId, status, JSON.stringify(detail)],
    );

    if (rows.length === 0) {
      return null;
    }

    const run = this.toRunSummary(rows[0]);

    this.logger.log('Finalized pipeline run', {
      runId: run.id,
      status: run.status,
      desiredState: run.desiredState,
      finishedAt: run.finishedAt,
    });

    return run;
  }

  /**
   * Write operator intent onto a run.
   *
   * Writes `desired_state` and NOTHING else. `status` is the workers' channel,
   * and a controller that also set it would be reporting an observation it did
   * not make — the pause would read as applied the instant the request returned,
   * while a worker was still mid-batch.
   *
   * Refuses three transitions, each for a reason an operator can act on:
   *
   *  - a run that is already finalized — its workers are gone, so the intent
   *    would never be read by anything;
   *  - `cancelled` → `running`/`paused` — cancel is one-way while a run is
   *    active. The tick tears shards down on it, so "un-cancelling" would
   *    resume a run whose state has already been dismantled;
   *  - a run belonging to somebody else, which is indistinguishable from one
   *    that does not exist and is reported that way.
   *
   * Cancel of an already-cancelled run is a no-op that returns the run, so a
   * retried request (or a second click) is not an error.
   */
  async setDesiredState(
    ctx: UserServiceContext,
    runId: string,
    desiredState: PipelineRunDesiredState,
  ): Promise<PipelineRunSummary> {
    const rows = await this.dataSource.query<RunRow[]>(
      // CTE-wrapped so the OUTER command is a SELECT. TypeORM's Postgres driver
      // special-cases UPDATE/DELETE and resolves \`[rows, rowCount]\`, so a bare
      // \`UPDATE ... RETURNING\` hands back an array whose FIRST ELEMENT is the rows
      // array — making \`rows.length === 0\` never true and \`rows[0]\` an array
      // rather than a row. Measured against live Postgres:
      //   UPDATE ... RETURNING  ->  [[{...}], 1]
      //   WITH u AS (UPDATE ...) SELECT * FROM u  ->  [{...}]
      // A mock-based spec cannot catch this: the mock returns whatever the test wrote.
      `WITH updated AS (
         UPDATE ci.pipeline_runs
            SET desired_state = $3
          WHERE id = $2::uuid
            AND user_id = $1::uuid
            AND finished_at IS NULL
            AND (desired_state <> 'cancelled' OR $3 = 'cancelled')
      RETURNING id, kind, desired_state, status, started_at, finished_at, detail)
       SELECT id, kind, desired_state, status, started_at, finished_at, detail FROM updated`,
      [ctx.userId, runId, desiredState],
    );

    if (rows.length > 0) {
      const run = this.toRunSummary(rows[0]);

      this.logger.log('Set pipeline run desired state', {
        runId: run.id,
        userId: ctx.userId,
        desiredState: run.desiredState,
      });

      return run;
    }

    // Only on the miss path: one extra read to say WHICH of the three refusals
    // this was. A bare 404 for all of them would send an operator looking for a
    // run they are staring at.
    const existing = await this.getRunOrNull(ctx, runId);

    if (existing == null) {
      throw new NotFoundException(`Pipeline run ${runId} not found`);
    }

    if (!existing.active) {
      throw new ConflictException(
        `Pipeline run ${runId} finished at ${existing.finishedAt?.toISOString() ?? 'an unknown time'} ` +
          `and no longer accepts control changes.`,
      );
    }

    throw new ConflictException(
      `Pipeline run ${runId} is cancelled; a cancelled run cannot be resumed or paused. ` +
        `Start a new run once the current one has been finalized.`,
    );
  }

  // -------------------------------------------------------------------------
  // Run reads
  // -------------------------------------------------------------------------

  /** A user's runs, newest first, with a shard tally per run. */
  async listRuns(ctx: UserServiceContext, options: ListRunsOptions = {}): Promise<PipelineRunSummary[]> {
    const limit = pageSize(options.limit, DEFAULT_RUN_PAGE, MAX_RUN_PAGE);
    const offset = Math.max(Math.trunc(options.offset ?? 0), 0);

    const rows = await this.dataSource.query<RunRow[]>(
      `${this.runSelect()}
        WHERE r.user_id = $1::uuid
          AND ($2::boolean OR r.finished_at IS NULL)
        ORDER BY r.started_at DESC, r.id DESC
        LIMIT $3 OFFSET $4`,
      [ctx.userId, !(options.activeOnly ?? false), limit, offset],
    );

    return rows.map((row) => this.toRunSummary(row));
  }

  /** One run with its shards and their cursors. Throws 404 for another user's run. */
  async getRun(ctx: UserServiceContext, runId: string): Promise<PipelineRunDetail> {
    const run = await this.getRunOrNull(ctx, runId);

    if (run == null) {
      throw new NotFoundException(`Pipeline run ${runId} not found`);
    }

    // `limit + 1` so a full page is distinguishable from a page that happens to
    // land exactly on the ceiling.
    const shardRows = await this.dataSource.query<ShardRow[]>(
      `SELECT s.id,
              s.stage,
              s.shard_key,
              s."cursor",
              s.status,
              s.lease_owner,
              s.lease_expires_at,
              (s.lease_expires_at IS NOT NULL AND s.lease_expires_at < now()) AS lease_expired
         FROM ci.pipeline_shards s
        WHERE s.run_id = $1::uuid
        ORDER BY s.stage, s.shard_key
        LIMIT $2`,
      [runId, MAX_SHARDS_PER_RUN + 1],
    );

    const shardsTruncated = shardRows.length > MAX_SHARDS_PER_RUN;

    return {
      ...run,
      shardsTruncated,
      shards: shardRows.slice(0, MAX_SHARDS_PER_RUN).map((row) => ({
        id: row.id,
        stage: row.stage,
        shardKey: row.shard_key,
        cursor: row.cursor,
        status: row.status,
        leaseOwner: row.lease_owner,
        leaseExpiresAt: row.lease_expires_at,
        leaseExpired: Boolean(row.lease_expired),
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Dead letters
  // -------------------------------------------------------------------------

  /**
   * Dead letters, newest first.
   *
   * Ordered `failed_at DESC` to match `pipeline_dead_letters_queue_failed_idx`,
   * with `id DESC` as the tiebreak — ids are uuid v7, so they order by insertion
   * time and make the page stable when a batch of letters shares a timestamp.
   *
   * Scoping: a letter attributable to ANOTHER user is excluded, because the
   * payload is that user's record verbatim. Letters with a NULL `user_id` ARE
   * included: NULL means "not attributable to a user" (maintenance sweeps,
   * telemetry, a payload too malformed to read a user out of), and those are
   * frequently the most important rows in the table. Hiding them would make the
   * appliance's own failures invisible on the one screen built to show failures.
   */
  async listDeadLetters(
    ctx: UserServiceContext,
    options: ListDeadLettersOptions = {},
  ): Promise<PipelineDeadLetterView[]> {
    const limit = pageSize(options.limit, DEFAULT_DEAD_LETTER_PAGE, MAX_DEAD_LETTER_PAGE);
    const offset = Math.max(Math.trunc(options.offset ?? 0), 0);

    const rows = await this.dataSource.query<DeadLetterRow[]>(
      `SELECT d.id,
              d.queue,
              d.event_name,
              d.stage,
              d.entity_type,
              d.entity_id,
              d.user_id,
              d.payload,
              d.error,
              d.failed_at,
              d.replayed_at
         FROM ci.pipeline_dead_letters d
        WHERE (d.user_id = $1::uuid OR d.user_id IS NULL)
          AND ($2::text IS NULL OR d.queue = $2::text)
          AND ($3::text IS NULL OR d.stage = $3::text)
          AND ($4::boolean IS NULL
               OR ($4::boolean AND d.replayed_at IS NOT NULL)
               OR (NOT $4::boolean AND d.replayed_at IS NULL))
        ORDER BY d.failed_at DESC, d.id DESC
        LIMIT $5 OFFSET $6`,
      [ctx.userId, options.queue ?? null, options.stage ?? null, options.replayed ?? null, limit, offset],
    );

    return rows.map((row) => ({
      id: row.id,
      queue: row.queue,
      eventName: row.event_name,
      stage: row.stage,
      entityType: row.entity_type,
      entityId: row.entity_id,
      userId: row.user_id,
      payload: row.payload ?? {},
      error: row.error,
      failedAt: row.failed_at,
      replayedAt: row.replayed_at,
    }));
  }

  /**
   * Re-emit a dead letter's preserved payload.
   *
   * Payload fidelity is the entire reason the reaper stores `j.data` verbatim,
   * and this is the method that cashes it in: the payload goes back onto the bus
   * unmodified, so a job that died two weeks ago is re-run against today's code.
   *
   * ── Ordering, and why the stamp comes first ────────────────────────────────
   *
   * `replayed_at` is claimed BEFORE the emit, by a conditional update that only
   * matches while it is still NULL. That single statement is what makes a
   * replay-all safe to run twice and what stops two operators re-emitting the
   * same payload concurrently — the second `UPDATE` matches nothing.
   *
   * The stamp now carries a second meaning, and the release-on-failure contract
   * below is what makes it safe: a non-NULL `replayed_at` starts this letter's
   * retention clock, and `DeadLetterReaperListener.purgeReplayed` deletes it
   * once it is older than `queues.replayedDeadLetterRetentionDays`. A letter
   * whose emit failed is released back to NULL and therefore never ages out —
   * only letters the bus actually accepted are ever reclaimed.
   *
   * Emitting first and stamping after would leave a crash in between looking
   * exactly like "never replayed", and the next replay-all would re-emit it. For
   * a stage that is a duplicate, which the stage contract absorbs; for an
   * arbitrary event it is a second real side effect.
   *
   * The cost of claiming first is that a FAILED emit would leave a letter marked
   * replayed when it was not, which is a lie the operator cannot detect. So the
   * stamp is released on every failure path, including the silent one: `send()`
   * returns an empty array — it does not throw — when the event has no
   * registered listener, when it names a queue that does not exist, and when
   * pg-boss refuses the insert (a singletonKey already held by a `created` job
   * on a de-duplicating queue). An empty replay is reported as a failure rather
   * than as success, and the three causes are reported apart.
   *
   * ── Routing ────────────────────────────────────────────────────────────────
   *
   * A letter written by `PipelineSliceListener` carries the stage queue it died
   * on, and is re-emitted onto exactly that queue. A letter harvested by
   * `DeadLetterReaperListener` carries `dead-letter` — pg-boss's parking queue,
   * which has no worker — so naming it would enqueue the job where nothing will
   * ever pick it up. Those are routed by listener registration instead, which is
   * where the job would have gone had it been sent fresh.
   *
   * Replays ride {@link BACKFILL_JOB_PRIORITY} regardless of what the original
   * job carried: a replay is recovery of something already late, and a
   * replay-all at interactive priority would push every live request behind a
   * backlog of failures.
   */
  async replayDeadLetter(ctx: UserServiceContext, letterId: string): Promise<DeadLetterReplayResult> {
    const claimed = await this.dataSource.query<DeadLetterRow[]>(
      // CTE-wrapped so the OUTER command is a SELECT. TypeORM's Postgres driver
      // special-cases UPDATE/DELETE and resolves \`[rows, rowCount]\`, so a bare
      // \`UPDATE ... RETURNING\` hands back an array whose FIRST ELEMENT is the rows
      // array — making \`rows.length === 0\` never true and \`rows[0]\` an array
      // rather than a row. Measured against live Postgres:
      //   UPDATE ... RETURNING  ->  [[{...}], 1]
      //   WITH u AS (UPDATE ...) SELECT * FROM u  ->  [{...}]
      // A mock-based spec cannot catch this: the mock returns whatever the test wrote.
      `WITH claimed AS (
         UPDATE ci.pipeline_dead_letters
            SET replayed_at = now()
          WHERE id = $2::uuid
            AND (user_id = $1::uuid OR user_id IS NULL)
            AND replayed_at IS NULL
      RETURNING id, queue, event_name, payload, replayed_at)
       SELECT id, queue, event_name, payload, replayed_at FROM claimed`,
      [ctx.userId, letterId],
    );

    if (claimed.length === 0) {
      await this.explainUnclaimableLetter(ctx, letterId);
    }

    return this.emitClaimedLetter(ctx, claimed[0]);
  }

  /**
   * Replay MANY dead letters in one call — the "replay-all" `replayed_at` was
   * always meant to make safe.
   *
   * ── Why this exists ────────────────────────────────────────────────────────
   *
   * The single-id route is the only statement in the repo that has ever set
   * `replayed_at`, and nothing automatic invokes it. On a live appliance that
   * produced 94 letters and 0 replays: the table was effectively write-only,
   * because clearing a backlog one uuid at a time through curl is not a thing an
   * operator does. This is the bulk form the runbook has been promising.
   *
   * ── Selector, and why there is no "replay everything" ──────────────────────
   *
   * The caller must NAME what to replay: explicit `ids`, and/or an `eventName` /
   * `failedAfter` filter. An empty selector is rejected by the controller rather
   * than read as "all", because a large share of any real backlog is a CONFIG
   * error — 36 of those 94 were one bad model id — and re-emitting those just
   * re-fails them, spends the queue, and writes 36 fresh letters. Replay is a
   * decision about a specific class of failure, so the API makes you express the
   * class.
   *
   * ── Claim semantics, preserved exactly ─────────────────────────────────────
   *
   * One statement claims the whole batch, and it claims the SAME way the
   * single-id path does: `SET replayed_at = now() ... WHERE replayed_at IS NULL`.
   * A double-submit therefore claims nothing the second time and re-emits
   * nothing — the guard is the database's, not the client's. `FOR UPDATE SKIP
   * LOCKED` on the candidate scan adds the concurrent case: two operators
   * pressing the button together partition the batch instead of blocking or
   * double-emitting.
   *
   * ── Partial failure is the normal case ─────────────────────────────────────
   *
   * Emitting happens per letter AFTER the batch claim, so one letter that cannot
   * be re-emitted must not strand the rest. Each failure releases its OWN claim
   * (same release path as the single-id route, so a failed letter goes back on
   * the replay queue) and is reported in {@link DeadLetterBulkReplayResult.failed}
   * with the reason. The call succeeds; the result says what actually happened.
   */
  async replayDeadLetters(
    ctx: UserServiceContext,
    input: BulkReplayDeadLettersInput,
  ): Promise<DeadLetterBulkReplayResult> {
    // Duplicates in `ids` would otherwise inflate `requested` and produce a
    // "skipped" entry for an id that WAS replayed, under its own other copy.
    const ids = input.ids == null ? null : [...new Set(input.ids)];
    // Naming ids IS the selection — the page size is a scan bound for the filter
    // form, not a second, quieter cap on an explicit list. Defaulting to
    // DEFAULT_DEAD_LETTER_PAGE (50) while the controller accepts up to
    // MAX_DEAD_LETTER_PAGE (200) meant a 60-id request replayed 50 and reported
    // the other 10 as `skipped`, which the card renders as "10 already replayed"
    // — the one reading under which a user would never retry them.
    const limit =
      ids == null
        ? pageSize(input.limit, DEFAULT_DEAD_LETTER_PAGE, MAX_DEAD_LETTER_PAGE)
        : pageSize(input.limit ?? ids.length, ids.length, MAX_DEAD_LETTER_PAGE);

    const claimed = await this.dataSource.query<DeadLetterRow[]>(
      // CTE-wrapped for the same reason as the single-id claim: the outer command
      // must be a SELECT or TypeORM resolves `[rows, rowCount]` instead of rows.
      //
      // The candidate scan is a separate CTE so `LIMIT` applies to the SELECTION
      // rather than to the UPDATE (an `UPDATE ... LIMIT` is not Postgres), and so
      // `FOR UPDATE SKIP LOCKED` can hold the rows across the claim. The UPDATE
      // re-checks `replayed_at IS NULL` anyway — under READ COMMITTED the lock is
      // taken on a re-read row, and belt-and-braces here is cheap next to
      // re-emitting somebody's payload twice.
      `WITH candidates AS (
         SELECT id
           FROM ci.pipeline_dead_letters
          WHERE (user_id = $1::uuid OR user_id IS NULL)
            AND replayed_at IS NULL
            AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))
            AND ($3::text IS NULL OR event_name = $3::text)
            AND ($4::timestamptz IS NULL OR failed_at >= $4::timestamptz)
          ORDER BY failed_at, id
          LIMIT $5
            FOR UPDATE SKIP LOCKED
       ), claimed AS (
         UPDATE ci.pipeline_dead_letters d
            SET replayed_at = now()
           FROM candidates c
          WHERE d.id = c.id
            AND d.replayed_at IS NULL
      RETURNING d.id, d.queue, d.event_name, d.payload, d.replayed_at)
       SELECT id, queue, event_name, payload, replayed_at FROM claimed`,
      [ctx.userId, ids, input.eventName ?? null, input.failedAfter ?? null, limit],
    );

    const replayed: DeadLetterReplayResult[] = [];
    const failed: DeadLetterReplayFailure[] = [];

    for (const letter of claimed) {
      try {
        replayed.push(await this.emitClaimedLetter(ctx, letter));
      } catch (err: unknown) {
        // `emitClaimedLetter` has already released this letter's claim, so it is
        // back on the replay queue and a later call can pick it up once the
        // cause is fixed.
        failed.push({
          id: letter.id,
          eventName: letter.event_name,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Only meaningful for the by-id form: with a filter selector, "not claimed"
    // is just "did not match", which is not a per-id fact.
    //
    // `skipped` means "we looked and it was not claimable" — already replayed,
    // not yours, or gone. It must NOT absorb ids the scan never reached, because
    // the two call for opposite responses: one is settled, the other is "ask
    // again". With the limit now derived from ids.length this is unreachable
    // unless a caller passes an explicit smaller limit, and in that case the
    // overflow is reported separately rather than being quietly relabelled.
    const claimedIds = new Set(claimed.map((letter) => letter.id));
    const scanned = ids == null ? null : ids.slice(0, limit);
    const skipped = scanned == null ? [] : scanned.filter((id) => !claimedIds.has(id));
    const notAttempted = ids == null ? [] : ids.slice(limit);

    this.logger.warn('Bulk-replayed pipeline dead letters', {
      userId: ctx.userId,
      requested: ids?.length ?? null,
      eventName: input.eventName ?? null,
      failedAfter: input.failedAfter ?? null,
      claimed: claimed.length,
      replayed: replayed.length,
      failed: failed.length,
      skipped: skipped.length,
      notAttempted: notAttempted.length,
    });

    return {
      requested: ids?.length ?? null,
      claimed: claimed.length,
      limit,
      replayed,
      failed,
      skipped,
      notAttempted,
    };
  }

  /**
   * Re-emit one ALREADY-CLAIMED letter, releasing its claim on every failure.
   *
   * Shared by the single-id and bulk routes so the two cannot drift: routing,
   * the empty-`send()` trap, and the release-on-failure contract are stated once.
   * The caller owns the claim statement; this owns everything after it.
   */
  private async emitClaimedLetter(
    ctx: UserServiceContext,
    letter: DeadLetterRow,
  ): Promise<DeadLetterReplayResult> {
    const letterId = letter.id;
    const eventName = letter.event_name;

    if (eventName.trim().length === 0 || eventName === UNATTRIBUTABLE_EVENT_NAME) {
      await this.releaseReplayClaim(letterId);

      throw new BadRequestException(
        `Dead letter ${letterId} carries no event name (recorded as "${eventName}"), so there is nothing ` +
          `to re-emit it as. Its payload was written by something other than EventService and can only be ` +
          `replayed by hand.`,
      );
    }

    // `dead-letter` is pg-boss's parking queue and has no worker; see the method
    // comment. `undefined` here means "route by listener registration".
    const queue = letter.queue === DEAD_LETTER_QUEUE ? null : letter.queue;

    let jobIds: string[];

    try {
      jobIds = await this.eventService.send(
        eventName,
        // The payload VERBATIM. `send()` stamps `name` over the top, which is
        // the same value it stamped when the job was originally enqueued.
        (letter.payload ?? {}) as Parameters<EventService['send']>[1],
        {
          ...(queue == null ? {} : { queue }),
          priority: BACKFILL_JOB_PRIORITY,
          singletonKey: `${DEAD_LETTER_REPLAY_KEY_PREFIX}${letterId}`,
        },
      );
    } catch (err: unknown) {
      await this.releaseReplayClaim(letterId);

      throw err;
    }

    if (jobIds.length === 0) {
      await this.releaseReplayClaim(letterId);

      // The silent path: `send()` warns and returns [] for an unknown queue, an
      // event with no listener, AND for a job pg-boss refused to insert. Those
      // are different incidents, and an operator reading the wrong one during a
      // backlog goes hunting a module-loading problem that does not exist — so
      // the two are separated here by asking the registry what actually exists.
      const routable =
        queue == null
          ? EventListenerRegistry.getQueuesFor(eventName).size > 0
          : EventListenerRegistry.getListeners().some(([, registration]) => registration.queue === queue);

      throw new ConflictException(
        routable
          ? `Dead letter ${letterId} was not re-emitted: queue ` +
            `${queue == null ? `for event "${eventName}"` : `"${queue}"`} has a listener but accepted no ` +
            `job. pg-boss refuses a send whose singletonKey duplicates a job still in "created" on a queue ` +
            `with a de-duplicating policy, so this letter is most likely already queued from an earlier ` +
            `replay; CI_QUEUE_SUPPRESS covering the queue produces the same empty result. Nothing was ` +
            `enqueued and the claim has been released.`
          : `Dead letter ${letterId} was not re-emitted: nothing in this process listens for event ` +
            `"${eventName}"${queue == null ? ' on any queue' : ` on queue "${queue}"`}, so the send ` +
            `enqueued nothing. The listener's module is probably not loaded in this process.`,
      );
    }

    this.logger.warn('Replayed a pipeline dead letter', {
      letterId,
      eventName,
      queue,
      jobIds,
      userId: ctx.userId,
    });

    return {
      id: letter.id,
      eventName,
      queue,
      jobIds,
      replayedAt: letter.replayed_at as Date,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * The run projection, shared by every run read.
   *
   * The shard tally is a LATERAL aggregate rather than a `GROUP BY` over a join,
   * so a run with no shards still produces a row (it is the runs that are
   * reported, not the shards) and the tally stays one subquery per run instead
   * of collapsing the run's own columns into an aggregate.
   *
   * `jsonb_object_agg` over zero rows yields NULL rather than `{}`, hence the
   * COALESCE — the shape must not change just because a run has not been
   * planned yet.
   */
  private runSelect(): string {
    return `SELECT r.id,
                   r.kind,
                   r.desired_state,
                   r.status,
                   r.started_at,
                   r.finished_at,
                   r.detail,
                   COALESCE(s.total, 0) AS shard_count,
                   COALESCE(s.by_status, '{}'::jsonb) AS shards_by_status
              FROM ci.pipeline_runs r
              LEFT JOIN LATERAL (
                     SELECT count(*)::int AS total,
                            jsonb_object_agg(g.status, g.n) AS by_status
                       FROM (SELECT status, count(*)::int AS n
                               FROM ci.pipeline_shards
                              WHERE run_id = r.id
                              GROUP BY status) g
                   ) s ON TRUE`;
  }

  private async getRunOrNull(ctx: UserServiceContext, runId: string): Promise<PipelineRunSummary | null> {
    const rows = await this.dataSource.query<RunRow[]>(
      `${this.runSelect()}
        WHERE r.id = $2::uuid
          AND r.user_id = $1::uuid`,
      [ctx.userId, runId],
    );

    return rows.length > 0 ? this.toRunSummary(rows[0]) : null;
  }

  /**
   * Why the replay claim matched nothing. Always throws.
   *
   * Split from the caller so the happy path issues exactly one statement: this
   * extra read only happens when the claim already failed.
   */
  private async explainUnclaimableLetter(ctx: UserServiceContext, letterId: string): Promise<never> {
    const rows = await this.dataSource.query<Array<{ replayed_at: Date | null }>>(
      `SELECT d.replayed_at
         FROM ci.pipeline_dead_letters d
        WHERE d.id = $2::uuid
          AND (d.user_id = $1::uuid OR d.user_id IS NULL)`,
      [ctx.userId, letterId],
    );

    if (rows.length === 0) {
      throw new NotFoundException(`Dead letter ${letterId} not found`);
    }

    throw new ConflictException(
      `Dead letter ${letterId} was already replayed at ` +
        `${rows[0].replayed_at?.toISOString() ?? 'an unknown time'}. ` +
        `replayed_at is what keeps a replay-all from looping; clear it in the database to force another.`,
    );
  }

  /**
   * Undo a replay claim after the emit failed.
   *
   * Failures here are logged and swallowed on purpose: the caller is already
   * throwing the error that matters, and replacing it with "could not release
   * the claim" would hide why the replay failed. The cost of a lost release is
   * one letter that reads as replayed and can be re-armed by clearing the
   * column.
   */
  private async releaseReplayClaim(letterId: string): Promise<void> {
    try {
      await this.dataSource.query(
        `UPDATE ci.pipeline_dead_letters SET replayed_at = NULL WHERE id = $1::uuid`,
        [letterId],
      );
    } catch (err: unknown) {
      this.logger.error(
        `Failed to release the replay claim on dead letter ${letterId}; it now reads as replayed but was ` +
          `not re-emitted. Clear replayed_at to retry.`,
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  private toRunSummary(row: RunRow): PipelineRunSummary {
    const shardsByStatus: Record<string, number> = {};

    for (const [status, count] of Object.entries(row.shards_by_status ?? {})) {
      shardsByStatus[status] = Number(count);
    }

    return {
      id: row.id,
      kind: row.kind,
      desiredState: row.desired_state as PipelineRunDesiredState,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      active: row.finished_at == null,
      detail: row.detail ?? {},
      shardCount: Number(row.shard_count ?? 0),
      shardsByStatus,
    };
  }
}
