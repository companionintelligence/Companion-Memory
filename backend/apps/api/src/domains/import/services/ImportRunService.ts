import { basename } from 'node:path';

import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In, type EntityManager } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { EventService } from '@ci/domains/events';

import {
  IMPORT_QUEUE,
  IMPORT_STAGE_KINDS,
  IMPORT_STAGE_WEIGHTS,
  type ImportStageKindName,
} from '../constants';
import { ImportRunEntity, type ImportRun, type ImportRunSource } from '../entities/ImportRunEntity';
import { ImportStageEntity, type ImportStage } from '../entities/ImportStageEntity';
import { ImportStageEvent } from '../events';
import type { StageOutcome } from '../types';

import { StagedSourceService } from './StagedSourceService';

/**
 * An inbox unit this run will consume in place of an uploaded drop. The path
 * must already be resolved through `resolveWithinInbox` — this service trusts
 * its callers on containment because the batch surface is the only code that
 * constructs one, and re-validation happens again at the move.
 */
export interface StartRunLocalSource {
  /** Realpath of the unit, inside the inbox. */
  path: string;
  kind: 'file' | 'directory';
  /** Aggregate bytes (advisory; feeds the copy-fallback disk preflight). */
  sizeBytes: number | null;
}

export interface StartRunInput {
  /**
   * The staged upload this run consumes. Claimed as part of starting.
   * Exactly one of `dropId` and `localSource` must be present.
   */
  dropId?: string;

  /**
   * The inbox unit this run consumes instead of a drop. The claim is an
   * INSERT into `ci_import.staged_sources`, whose partial unique index is the
   * race guard the drop claim's constrained UPDATE is — one live run per path.
   */
  localSource?: StartRunLocalSource;

  /** Display label for the run list. Defaults to the drop's original filename. */
  label?: string | null;

  source?: ImportRunSource;

  /**
   * Stage kinds to execute, in order. Defaults to {@link DEFAULT_STAGES}.
   * Naming them explicitly is how a re-run of a failed push will skip
   * re-reading a 40GB tree.
   */
  stages?: readonly ImportStageKindName[];
}

export interface StartRunResult {
  run: ImportRun;
  stages: ImportStage[];
}

export interface StartPushInput {
  /** Restrict the push to these runs. Absent means every eligible run. */
  runIds?: readonly string[];
}

/** One run whose parsed rows are waiting for a push — the Sync card's unit. */
export interface UnpushedRun {
  run: ImportRun;
  pendingItems: number;
  pendingEntities: number;
}

/**
 * What a run does when the caller does not say: the whole import.
 *
 * Taken from {@link IMPORT_STAGE_KINDS} rather than restated. A stage kind
 * joins this list with its runner — until then a run listing a stage nothing
 * can execute would either strand there or "skip" it and report a complete
 * import over data that never reached `ci.*`, and the second is worse, since it
 * looks like success. Restating the list is how that guarantee silently breaks
 * in the other direction: `media` was added to the kinds, the CHECK constraint
 * and the weights, and every new run went on being created without it because
 * this copy had not heard.
 */
const DEFAULT_STAGES: readonly ImportStageKindName[] = IMPORT_STAGE_KINDS;

/**
 * How silent a stage must go before the recovery sweep treats its claim as
 * dead. A live stage never gets close: progress writes land up to once a
 * second while work moves, and the listener heartbeats every thirty seconds
 * while it merely holds the claim. Ten minutes of silence therefore means the
 * process is gone — crashed, killed, or restarted out from under the work.
 */
const STALE_STAGE_MINUTES = 10;

/**
 * A run whose staged rows have never been pushed. `$1` = user id, `$2` =
 * optional uuid[] filter (NULL means every run). One constant shared VERBATIM
 * by {@link ImportRunService.listUnpushed} and
 * {@link ImportRunService.startPush}, so what the Sync card shows is exactly
 * what Sync acts on — two copies of this predicate would drift, and the drift
 * would be a card that lists a run the button then skips.
 *
 * Why each clause:
 * - `finished_at IS NOT NULL` — nothing in flight. This excludes a run still
 *   parsing, and it is also what makes the reopen double as the concurrency
 *   guard: the loser of two racing Sync clicks re-evaluates this predicate
 *   against the winner's reopened row and finds `finished_at` NULL.
 * - `status <> 'cancelled'` — a cancelled run is a decision, not a backlog.
 *   `partial` runs stay ELIGIBLE: a partially-parsed archive still staged real
 *   rows, and pushing them is the point.
 * - completed parse — the staging actually happened.
 * - no push stage AT ANY STATUS — a failed or cancelled push means this run
 *   already left the Sync surface; its recovery path is `retryStage`, not a
 *   second appended stage.
 * - pending rows in EITHER lane — PushStage pushes entities as well as items,
 *   and a parse that staged nothing would otherwise sit in the Sync card
 *   forever showing "0 items".
 */
const PUSH_ELIGIBLE_WHERE = `
      r.user_id = $1::uuid
  AND r.finished_at IS NOT NULL
  AND r.status <> 'cancelled'
  AND ($2::uuid[] IS NULL OR r.id = ANY($2::uuid[]))
  AND EXISTS (
        SELECT 1 FROM ci_import.import_stages ps
         WHERE ps.run_id = r.id AND ps.kind = 'parse' AND ps.status = 'completed')
  AND NOT EXISTS (
        SELECT 1 FROM ci_import.import_stages xs
         WHERE xs.run_id = r.id AND xs.kind = 'push')
  AND (EXISTS (
        SELECT 1 FROM ci_import.staged_items i
         WHERE i.run_id = r.id AND i.push_status = 'pending')
    OR EXISTS (
        SELECT 1 FROM ci_import.staged_entities e
         WHERE e.run_id = r.id AND e.push_status = 'pending'))`;

/**
 * The run/stage spine: what a person sees while their export imports.
 *
 * Two rules shape everything here.
 *
 * **The stage rows are the truth; the run row is a cache.** `import_runs.status`
 * and `.percent` are derived from the run's stages and recomputed on every
 * transition, because the run list renders dozens of rows per poll and joining
 * every stage of every run to answer "how far along?" is the query that makes a
 * progress bar expensive to look at. Nothing ever reads the cache to decide
 * whether work remains.
 *
 * **A stage that half-worked is not a failure.** A Takeout holding six sources
 * where one parser chokes has imported five of them; rolling that up as `failed`
 * is what teaches people to re-run the whole archive. Such a run ends `partial`,
 * which is terminal and success-ish, and the stage's `detail` carries what was
 * missed.
 */
@Injectable()
export class ImportRunService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly eventService: EventService,
    private readonly stagedSources: StagedSourceService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ImportRunService.name);
  }

  // -------------------------------------------------------------------------
  // Starting
  // -------------------------------------------------------------------------

  /**
   * Create a run, materialize its stages, claim the drop, and enqueue the first
   * stage.
   *
   * All of it in ONE transaction. The claim is what makes two clicks on
   * "import" produce one run instead of two runs racing for the same bytes, and
   * it can only do that if a lost claim takes the run row with it — otherwise
   * the loser leaves an orphan run pointing at a drop it does not own. The claim
   * cannot come first, because `staged_sources.run_id` is a foreign key into the
   * run that does not exist yet.
   *
   * The enqueue happens AFTER the transaction commits. A job enqueued inside it
   * can be picked up by a worker before the commit lands, and that worker would
   * read no run at all.
   */
  async startRun(ctx: UserServiceContext, input: StartRunInput): Promise<StartRunResult> {
    const kinds = input.stages ?? DEFAULT_STAGES;

    if (kinds.length === 0) {
      throw new ConflictException('A run needs at least one stage');
    }

    if ((input.dropId == null) === (input.localSource == null)) {
      throw new ConflictException('A run consumes exactly one source: a dropId or a localSource');
    }

    const result = await this.dataSource.transaction(async (manager) => {
      let defaultLabel: string | null = null;

      if (input.dropId != null) {
        const uploads = await manager.query<Array<{ original_filename: string | null; status: string }>>(
          `SELECT original_filename, status
             FROM ci_import.staged_sources
            WHERE user_id = $1::uuid AND drop_id = $2`,
          [ctx.userId, input.dropId],
        );

        if (uploads.length === 0) {
          throw new NotFoundException(`No staged upload ${input.dropId}`);
        }

        // Refusals must tell the truth: an expired upload's bytes are GONE
        // (the purge took them), which is a different answer from "another
        // run beat you to it" — the first means re-upload, the second means
        // look at your runs.
        if (uploads[0].status === 'expired') {
          throw new ConflictException(
            `Upload ${input.dropId} expired before it was imported. Upload the archive again.`,
          );
        }

        defaultLabel = uploads[0].original_filename;
      } else {
        defaultLabel = basename(input.localSource!.path);
      }

      const runRows = await manager.query<Array<{ id: string }>>(
        `INSERT INTO ci_import.import_runs (user_id, label, source, status, requested_stages)
              VALUES ($1::uuid, $2, $3, 'queued', $4::text[])
           RETURNING id`,
        [ctx.userId, input.label ?? defaultLabel, input.source ?? 'wizard', kinds],
      );

      const runId = runRows[0].id;

      if (input.dropId != null) {
        // Constrained to `staged`, so the UPDATE is the race guard: the second
        // caller affects no rows and this transaction rolls back, taking its run
        // with it.
        // CTE-wrapped so the OUTER command is a SELECT. TypeORM's Postgres driver
        // special-cases UPDATE/DELETE and resolves `[rows, rowCount]`, so a bare
        // `UPDATE ... RETURNING` hands back an array whose FIRST element is the
        // rows array — making `length === 0` never true. Same trap, and same fix,
        // as `PipelineRunService.finishRun`.
        const claim = await manager.query<unknown[]>(
          `WITH claimed AS (
             UPDATE ci_import.staged_sources
                SET status = 'claimed', run_id = $1::uuid, claimed_at = now(), updated_at = now()
              WHERE user_id = $2::uuid AND drop_id = $3 AND status = 'staged'
          RETURNING id)
           SELECT id FROM claimed`,
          [runId, ctx.userId, input.dropId],
        );

        if (claim.length === 0) {
          throw new ConflictException(
            `Upload ${input.dropId} has already been claimed by another import run`,
          );
        }
      } else {
        // The inbox claim is the INSERT itself: the partial unique index on
        // (user_id, source_path) WHERE status IN ('claimed','moved') plays
        // the role the upload claim's constrained UPDATE plays. The loser's
        // unique violation rolls this transaction back, run row and all, so a
        // row never exists without its run.
        try {
          await manager.query(
            `INSERT INTO ci_import.staged_sources
                    (user_id, origin, run_id, source_path, kind, size_bytes, status, claimed_at)
             VALUES ($1::uuid, 'inbox', $2::uuid, $3, $4, $5::bigint, 'claimed', now())`,
            [
              ctx.userId,
              runId,
              input.localSource!.path,
              input.localSource!.kind,
              input.localSource!.sizeBytes,
            ],
          );
        } catch (err: unknown) {
          if ((err as { driverError?: { code?: string } }).driverError?.code === '23505') {
            throw new ConflictException(
              `${input.localSource!.path} is already being imported by another run`,
            );
          }

          throw err;
        }
      }

      const stages = await this.materializeStages(manager, runId, kinds);

      const run = await manager.findOneOrFail(ImportRunEntity, { where: { id: runId } });

      return { run, stages };
    });

    await this.enqueueStage(ctx.userId, result.run.id, result.stages[0]);

    this.logger.log('Started import run', {
      runId: result.run.id,
      userId: ctx.userId,
      dropId: input.dropId ?? null,
      localSource: input.localSource?.path ?? null,
      stages: kinds,
    });

    return result;
  }

  /**
   * Write one `import_stages` row per requested kind.
   *
   * `ON CONFLICT (run_id, seq) DO NOTHING` so materializing is idempotent: a
   * restart between the run insert and this one re-runs it harmlessly rather
   * than duplicating the stage bar.
   */
  private async materializeStages(
    manager: EntityManager,
    runId: string,
    kinds: readonly ImportStageKindName[],
  ): Promise<ImportStage[]> {
    for (const [index, kind] of kinds.entries()) {
      await manager.query(
        `INSERT INTO ci_import.import_stages (run_id, seq, kind, status, weight)
              VALUES ($1::uuid, $2, $3, 'queued', $4)
         ON CONFLICT (run_id, seq) DO NOTHING`,
        [runId, index, kind, IMPORT_STAGE_WEIGHTS[kind]],
      );
    }

    return manager.find(ImportStageEntity, { where: { runId }, order: { seq: 'ASC' } });
  }

  /**
   * Pick every abandoned run back up.
   *
   * The stages are durable jobs precisely so an import survives the process
   * that was running it — but three crash windows would otherwise strand one
   * forever, because every recovery path shares one guard:
   * {@link beginStage} only claims a `queued` stage.
   *
   *  1. **Killed mid-stage.** The stage sits at `running` with no worker, and
   *     even pg-boss's own redelivery no-ops against the claim.
   *  2. **Killed between completing a stage and enqueueing the next.** The next
   *     stage is `queued` but no job carries it.
   *  3. **Killed between the last stage completing and {@link finishRun}.** The
   *     run can never close.
   *
   * Every gate here is a STALENESS test on `updated_at`, never an assumption
   * about who else is running. The first version of this sweep assumed
   * "at bootstrap, any running stage is orphaned" — and a dev restart that
   * leaked the old process promptly disproved it: the old worker's push loop
   * was alive and pushing while the new boot requeued its stage, and the two
   * (then three) executors interleaved progress writes with different totals.
   * A live stage is never silent for {@link STALE_STAGE_MINUTES} — progress
   * writes touch it up to once a second and the listener heartbeats it while
   * it merely holds the claim — so silence IS death, whoever the worker was.
   * The price is recovery latency: a crash is picked up by the periodic sweep
   * within staleness-plus-a-tick rather than instantly at reboot.
   *
   * Re-enqueueing a stage whose original job still sits in the queue is
   * harmless — the extra delivery loses the `beginStage` claim, the same no-op
   * a redelivery already gets. Nothing is lost by a requeue: every stage
   * resumes from durable state (the run-keyed scratch tree, the within-run
   * dedupe on staged rows, the per-row push ledger).
   */
  async resumeInterrupted(): Promise<void> {
    // CTE-wrapped — see the note on the claim in `startRun`. The reclaim
    // deliberately does NOT touch `updated_at`: the requeued stage must still
    // read as stale so the enqueue pass below picks it up in the same sweep.
    const reclaimed = await this.dataSource.query<Array<{ stageId: string; runId: string }>>(
      `WITH reclaimed AS (
         UPDATE ci_import.import_stages s
            SET status = 'queued', error = NULL, started_at = NULL, finished_at = NULL,
                processed = 0, duration_ms = NULL
          WHERE s.status = 'running'
            AND s.updated_at < now() - make_interval(mins => $1::int)
            AND EXISTS (
              SELECT 1 FROM ci_import.import_runs r
               WHERE r.id = s.run_id AND r.finished_at IS NULL
            )
      RETURNING s.id, s.run_id)
       SELECT id AS "stageId", run_id AS "runId" FROM reclaimed`,
      [STALE_STAGE_MINUTES],
    );

    const unfinished = await this.dataSource.query<
      Array<{
        runId: string;
        userId: string;
        stageId: string | null;
        stageStale: boolean | null;
        hasLive: boolean;
        allStale: boolean;
      }>
    >(
      `SELECT r.id AS "runId",
              r.user_id AS "userId",
              q.id AS "stageId",
              q.updated_at < now() - make_interval(mins => $1::int) AS "stageStale",
              EXISTS (SELECT 1 FROM ci_import.import_stages x
                       WHERE x.run_id = r.id AND x.status IN ('queued', 'running')) AS "hasLive",
              COALESCE((SELECT bool_and(x.updated_at < now() - make_interval(mins => $1::int))
                          FROM ci_import.import_stages x
                         WHERE x.run_id = r.id), true) AS "allStale"
         FROM ci_import.import_runs r
         LEFT JOIN LATERAL (
           SELECT s.id, s.updated_at
             FROM ci_import.import_stages s
            WHERE s.run_id = r.id AND s.status = 'queued'
            ORDER BY s.seq
            LIMIT 1
         ) q ON true
        WHERE r.finished_at IS NULL`,
      [STALE_STAGE_MINUTES],
    );

    let enqueued = 0;
    let finished = 0;

    for (const run of unfinished) {
      if (run.stageId != null && run.stageStale === true) {
        // A queued stage nobody has touched in the staleness window is a stage
        // whose job was lost — a FRESH queued stage is just waiting its turn in
        // the queue and must not collect a duplicate job every sweep.
        await this.enqueueStage(run.userId, run.runId, { id: run.stageId } as ImportStage);
        enqueued += 1;
      } else if (!run.hasLive && run.allStale) {
        // Every stage is terminal, none freshly so — the crash landed after
        // the last completeStage. Close the run the way advance() would have.
        // The staleness half of the gate is what keeps a PERIODIC sweep out of
        // the milliseconds between a live worker's completeStage and its
        // advance(), where the run momentarily has nothing queued or running.
        await this.finishRun(run.runId);
        finished += 1;
      }
    }

    if (reclaimed.length > 0 || enqueued > 0 || finished > 0) {
      this.logger.log('Resumed interrupted import runs', {
        reclaimedStages: reclaimed.length,
        enqueuedStages: enqueued,
        finishedRuns: finished,
      });
    }
  }

  /**
   * Refresh a running stage's claim.
   *
   * The listener calls this on a timer for as long as a runner is inside the
   * stage, so a stage that is alive but quiet — a giant archive mid-extract
   * says nothing for minutes — never reads as abandoned to the sweep.
   */
  async touchStage(stageId: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE ci_import.import_stages
          SET updated_at = now()
        WHERE id = $1::uuid AND status = 'running'`,
      [stageId],
    );
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async getRun(ctx: UserServiceContext, runId: string): Promise<ImportRun | null> {
    return this.dataSource.getRepository(ImportRunEntity).findOne({
      where: { id: runId, userId: ctx.userId },
    });
  }

  async getStage(stageId: string): Promise<ImportStage | null> {
    return this.dataSource.getRepository(ImportStageEntity).findOne({ where: { id: stageId } });
  }

  async stagesFor(runId: string): Promise<ImportStage[]> {
    return this.dataSource.getRepository(ImportStageEntity).find({ where: { runId }, order: { seq: 'ASC' } });
  }

  /**
   * A user's runs, newest first.
   *
   * Reads the cached `status`/`percent` off the run row rather than joining the
   * stages — that cache exists precisely so this list is cheap, because it is
   * polled while an import is in flight.
   */
  async listRuns(ctx: UserServiceContext, options: { limit?: number } = {}): Promise<ImportRun[]> {
    return this.dataSource.getRepository(ImportRunEntity).find({
      where: { userId: ctx.userId },
      order: { createdAt: 'DESC' },
      take: Math.min(options.limit ?? 50, 200),
    });
  }

  /** One run with its stage bar, or null when it is not this user's. */
  async getRunDetail(
    ctx: UserServiceContext,
    runId: string,
  ): Promise<{ run: ImportRun; stages: ImportStage[] } | null> {
    const run = await this.getRun(ctx, runId);

    if (run == null) {
      return null;
    }

    return { run, stages: await this.stagesFor(runId) };
  }

  /**
   * Re-queue a stage that failed.
   *
   * This is the user action the worker's retry deliberately is not: a pg-boss
   * redelivery no-ops because `beginStage` only moves a `queued` stage, so
   * nothing re-runs a 40GB unpack on its own. Someone asking for it explicitly is
   * a different matter, and putting the stage back to `queued` is what makes the
   * next job a real attempt rather than another no-op.
   *
   * The run is reopened alongside it — a finished run with a queued stage would
   * be a row that contradicts itself, and the rollup would never move again.
   */
  async retryStage(ctx: UserServiceContext, runId: string, stageId: string): Promise<boolean> {
    const rows = await this.dataSource.query<Array<{ id: string; seq: number }>>(
      `WITH requeued AS (
         UPDATE ci_import.import_stages s
            SET status = 'queued', error = NULL, started_at = NULL, finished_at = NULL,
                processed = 0, duration_ms = NULL
          WHERE s.id = $1::uuid
            AND s.run_id = $2::uuid
            AND s.status IN ('failed', 'cancelled')
            AND EXISTS (
              SELECT 1 FROM ci_import.import_runs r
               WHERE r.id = s.run_id AND r.user_id = $3::uuid
            )
      RETURNING s.id, s.seq)
       SELECT id, seq FROM requeued`,
      [stageId, runId, ctx.userId],
    );

    if (rows.length === 0) {
      return false;
    }

    await this.dataSource.query(
      `UPDATE ci_import.import_runs
          SET status = 'queued', error = NULL, finished_at = NULL
        WHERE id = $1::uuid`,
      [runId],
    );

    await this.enqueueStage(ctx.userId, runId, { id: rows[0].id } as ImportStage);

    this.logger.log('Re-queued a failed import stage', { runId, stageId, userId: ctx.userId });

    return true;
  }

  // -------------------------------------------------------------------------
  // Deferred push — the wizard's Sync step
  // -------------------------------------------------------------------------

  /**
   * The runs the Sync card offers: parse finished, nothing pushed yet.
   *
   * Counts come from one raw query (aliased camelCase, `::int` so the driver
   * hands back numbers); the runs themselves are re-read through the
   * repository so the entity's column transforms are reused instead of
   * re-implemented here.
   */
  async listUnpushed(ctx: UserServiceContext): Promise<UnpushedRun[]> {
    const rows = await this.dataSource.query<
      Array<{ id: string; pendingItems: number; pendingEntities: number }>
    >(
      `SELECT r.id,
              (SELECT count(*)::int FROM ci_import.staged_items i
                WHERE i.run_id = r.id AND i.push_status = 'pending') AS "pendingItems",
              (SELECT count(*)::int FROM ci_import.staged_entities e
                WHERE e.run_id = r.id AND e.push_status = 'pending') AS "pendingEntities"
         FROM ci_import.import_runs r
        WHERE ${PUSH_ELIGIBLE_WHERE}
        ORDER BY r.created_at DESC`,
      [ctx.userId, null],
    );

    if (rows.length === 0) {
      return [];
    }

    const runs = await this.dataSource.getRepository(ImportRunEntity).find({
      where: { id: In(rows.map((row) => row.id)) },
    });
    const byId = new Map(runs.map((run) => [run.id, run]));

    // The query's order is the answer's order; the repository read is just
    // hydration and must not reorder it.
    return rows
      .map((row) => {
        const run = byId.get(row.id);

        return run == null
          ? null
          : { run, pendingItems: row.pendingItems, pendingEntities: row.pendingEntities };
      })
      .filter((entry): entry is UnpushedRun => entry != null);
  }

  /**
   * Append a `push` stage to every eligible run and set it running.
   *
   * The append-and-reopen is ONE statement, so there is no gap for a run to
   * change state in: eligibility, the stage insert, and the reopen share a
   * snapshot, and `FOR UPDATE` makes the loser of two racing Sync clicks
   * re-evaluate against the winner's reopened row (`finished_at` now NULL) and
   * come away with nothing. Belt-and-braces beneath that: `UNIQUE (run_id,
   * seq)` + `ON CONFLICT DO NOTHING` swallows a duplicate insert, and because
   * the reopen joins FROM the insert's returned rows, a swallowed insert also
   * skips the reopen and the `requested_stages` append — a complete no-op.
   *
   * The outer command is a SELECT for the same TypeORM reason as everywhere
   * else in this file; the enqueue happens after the statement (which is its
   * own transaction), honoring startRun's enqueue-after-commit rule.
   */
  async startPush(
    ctx: UserServiceContext,
    input: StartPushInput = {},
  ): Promise<Array<{ run: ImportRun; stage: ImportStage }>> {
    const appended = await this.dataSource.query<Array<{ stageId: string; runId: string }>>(
      `WITH eligible AS (
         SELECT r.id
           FROM ci_import.import_runs r
          WHERE ${PUSH_ELIGIBLE_WHERE}
            FOR UPDATE OF r
       ),
       appended AS (
         INSERT INTO ci_import.import_stages (run_id, seq, kind, status, weight)
         SELECT e.id,
                (SELECT COALESCE(MAX(s.seq), -1) + 1
                   FROM ci_import.import_stages s
                  WHERE s.run_id = e.id),
                'push', 'queued', $3::int
           FROM eligible e
         ON CONFLICT (run_id, seq) DO NOTHING
         RETURNING id, run_id
       ),
       reopened AS (
         UPDATE ci_import.import_runs r
            SET status = 'queued', error = NULL, finished_at = NULL,
                requested_stages = array_append(r.requested_stages, 'push')
           FROM appended a
          WHERE r.id = a.run_id
         RETURNING r.id
       )
       SELECT a.id AS "stageId", a.run_id AS "runId" FROM appended a`,
      [ctx.userId, input.runIds == null ? null : [...input.runIds], IMPORT_STAGE_WEIGHTS.push],
    );

    if (appended.length === 0) {
      return [];
    }

    // Before anything is enqueued: the run finished at percent = 100, and the
    // reopen alone would leave that stale — a poll must never see a queued push
    // under a full bar. With `finished_at` NULL again the rollup's guard passes
    // and percent lands at the honest weighted value (80 for unpack+parse+push).
    for (const row of appended) {
      await this.refreshRunRollup(row.stageId);
    }

    const runs = await this.dataSource.getRepository(ImportRunEntity).find({
      where: { id: In(appended.map((row) => row.runId)) },
    });
    const stages = await this.dataSource.getRepository(ImportStageEntity).find({
      where: { id: In(appended.map((row) => row.stageId)) },
    });
    const runById = new Map(runs.map((run) => [run.id, run]));
    const stageById = new Map(stages.map((stage) => [stage.id, stage]));

    const results: Array<{ run: ImportRun; stage: ImportStage }> = [];

    for (const row of appended) {
      const run = runById.get(row.runId);
      const stage = stageById.get(row.stageId);

      if (run == null || stage == null) {
        continue;
      }

      await this.enqueueStage(ctx.userId, run.id, stage);
      results.push({ run, stage });
    }

    this.logger.log('Appended deferred push stages', {
      userId: ctx.userId,
      runIds: results.map(({ run }) => run.id),
    });

    // Newest first, matching listUnpushed and the run list.
    return results.sort((a, b) => new Date(b.run.createdAt).getTime() - new Date(a.run.createdAt).getTime());
  }

  // -------------------------------------------------------------------------
  // Transitions
  // -------------------------------------------------------------------------

  /**
   * Mark a stage running.
   *
   * Constrained to `queued`, so a redelivered pg-boss job cannot restart a stage
   * another worker already owns, and the caller learns it lost by getting
   * `false` rather than by trampling a run in flight.
   */
  async beginStage(stageId: string): Promise<boolean> {
    // CTE-wrapped — see the note on the claim in `startRun`. Without it this
    // returns `[[], 0]`, whose length is 2, and every redelivered job would
    // "win" the claim and unpack the same 40GB archive again.
    const rows = await this.dataSource.query<unknown[]>(
      `WITH claimed AS (
         UPDATE ci_import.import_stages
            SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now()
          WHERE id = $1::uuid AND status = 'queued'
      RETURNING id)
       SELECT id FROM claimed`,
      [stageId],
    );

    if (rows.length === 0) {
      return false;
    }

    await this.dataSource.query(
      `UPDATE ci_import.import_runs
          SET status = 'running', started_at = COALESCE(started_at, now())
        WHERE id = (SELECT run_id FROM ci_import.import_stages WHERE id = $1::uuid)
          AND finished_at IS NULL`,
      [stageId],
    );

    return true;
  }

  /** Update a running stage's counters. Also refreshes the run's percent cache. */
  async recordProgress(
    stageId: string,
    update: { processed: number; total?: number | null; phase?: string },
  ): Promise<void> {
    await this.dataSource.query(
      // Every parameter cast, and `$2` cast at BOTH sites. It feeds `processed`
      // (bigint) and a division (double precision), and Postgres will not deduce
      // one type for a parameter used two ways — it raises "inconsistent types
      // deduced for parameter $2" on the first tick, which killed the unpack
      // stage the moment it reported progress. Same fault as `completeStage`;
      // this statement was simply never exercised.
      `UPDATE ci_import.import_stages
          SET processed = $2::bigint,
              total = COALESCE($3::bigint, total),
              phase = COALESCE($4::text, phase),
              updated_at = now(),
              items_per_sec = CASE
                WHEN started_at IS NULL THEN items_per_sec
                WHEN EXTRACT(EPOCH FROM (now() - started_at)) <= 0 THEN items_per_sec
                ELSE $2::double precision / EXTRACT(EPOCH FROM (now() - started_at))
              END
        WHERE id = $1::uuid`,
      [stageId, update.processed, update.total ?? null, update.phase ?? null],
    );

    await this.refreshRunRollup(stageId);
  }

  /** Finish a stage that did its work, wholly or partly. */
  async completeStage(stageId: string, outcome: StageOutcome): Promise<void> {
    await this.dataSource.query(
      // Every parameter cast explicitly: `$2` feeds both `processed` and the
      // COALESCE for `total`, and Postgres refuses to deduce one type for a
      // parameter used in two positions ("inconsistent types deduced").
      `UPDATE ci_import.import_stages
          SET status = 'completed',
              updated_at = now(),
              processed = $2::bigint,
              total = COALESCE($3::bigint, $2::bigint),
              detail = $4::jsonb,
              finished_at = now(),
              duration_ms = CASE
                WHEN started_at IS NULL THEN duration_ms
                ELSE (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::bigint
              END
        WHERE id = $1::uuid`,
      [stageId, outcome.processed, outcome.total, JSON.stringify(outcome.detail ?? {})],
    );

    await this.refreshRunRollup(stageId);
  }

  /** Fail a stage, and with it the run. */
  async failStage(stageId: string, error: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE ci_import.import_stages
          SET status = 'failed', error = $2, finished_at = now(), updated_at = now()
        WHERE id = $1::uuid`,
      [stageId, error],
    );

    await this.dataSource.query(
      `UPDATE ci_import.import_runs
          SET status = 'failed', error = $2, finished_at = now()
        WHERE id = (SELECT run_id FROM ci_import.import_stages WHERE id = $1::uuid)
          AND finished_at IS NULL`,
      [stageId, error],
    );

    // A failed run must never consume its inbox unit. Release frees the path
    // for a fresh claim when the unit never left the inbox; once it is
    // `moved`, release is a no-op and the bytes wait in scratch for retryStage.
    const runRows = await this.dataSource.query<Array<{ run_id: string }>>(
      `SELECT run_id FROM ci_import.import_stages WHERE id = $1::uuid`,
      [stageId],
    );

    if (runRows.length > 0) {
      await this.stagedSources.release(runRows[0].run_id);
    }

    await this.refreshRunRollup(stageId);
  }

  /**
   * Enqueue the stage after `seq`, or finish the run when there is none.
   *
   * Returns the stage that was enqueued, so a caller (or a test) can tell
   * "moved on" from "that was the last one" without re-reading the run.
   */
  async advance(userId: string, runId: string, afterSeq: number): Promise<ImportStage | null> {
    const next = await this.dataSource.getRepository(ImportStageEntity).findOne({
      where: { runId, status: 'queued' },
      order: { seq: 'ASC' },
    });

    if (next == null || next.seq <= afterSeq) {
      await this.finishRun(runId);

      return null;
    }

    await this.enqueueStage(userId, runId, next);

    return next;
  }

  /**
   * Did this run actually pull a record out of its source?
   *
   * The question every destructive close-out step turns on. A run can reach
   * `completed`/`partial` having staged nothing at all — `ParseStage` returns
   * `partial: true, reason: 'no recognized data sources'` for a tree this
   * appliance has no parser for, and calls that an honest report rather than a
   * failure. Treating that as "consumed" is what made a zero-record run delete
   * the user's only copy: `UnpackStage` acquires by rename, so the move IS the
   * consume, and `retryStage` only accepts `failed`/`cancelled`, leaving no way
   * back.
   *
   * Asked of the staging tables rather than of the parse stage's `processed`
   * count, because that is the durable record of what was actually pulled and
   * it stays true across a stage retry or a resumed run.
   */
  async pulledRecords(runId: string): Promise<boolean> {
    const [row] = (await this.dataSource.query(
      `SELECT EXISTS (SELECT 1 FROM ci_import.staged_items WHERE run_id = $1::uuid)
           OR EXISTS (SELECT 1 FROM ci_import.staged_entities WHERE run_id = $1::uuid) AS pulled`,
      [runId],
    )) as Array<{ pulled: boolean }>;

    return row?.pulled === true;
  }

  /**
   * Close a run whose stages are all done, choosing between `completed` and
   * `partial` from what the stages recorded.
   */
  async finishRun(runId: string): Promise<void> {
    const stages = await this.stagesFor(runId);
    const anyPartial = stages.some((stage) => stage.detail?.partial === true);
    const anyFailed = stages.some((stage) => stage.status === 'failed');

    const status = anyFailed ? 'failed' : anyPartial ? 'partial' : 'completed';

    await this.dataSource.query(
      `UPDATE ci_import.import_runs
          SET status = $2, percent = 100, finished_at = now()
        WHERE id = $1::uuid AND finished_at IS NULL`,
      [runId, status],
    );

    // A completed-or-partial run has consumed its inbox unit — but ONLY if some
    // import actually pulled a record out of it. A run that staged nothing has
    // taken nothing, so stamping `consumed` would record an ingest that never
    // happened and hand the bytes to the scratch reclaim. Left `moved` instead:
    // the tree stays on disk (see ImportStageListener) and the row still says
    // where it went. Placed here rather than in the listener because finishRun
    // is reached by the listener AND the recovery sweep, so a crash between the
    // last stage and close-out still consumes on resume. Idempotent; no-op for
    // drop runs.
    const pulled = await this.pulledRecords(runId);

    if ((status === 'completed' || status === 'partial') && pulled) {
      await this.stagedSources.markConsumed(runId);
    } else {
      await this.stagedSources.release(runId);
    }

    this.logger.log('Finished import run', { runId, status, pulledRecords: pulled });
  }

  /**
   * Stop a run the user no longer wants.
   *
   * Only `queued` stages are cancelled. A stage already running owns a worker
   * and a scratch directory, and marking its row `cancelled` underneath it would
   * make the row lie while the work continued — the worker notices the run is
   * cancelled at its next transition and stops there.
   */
  async cancel(ctx: UserServiceContext, runId: string): Promise<boolean> {
    const rows = await this.dataSource.query<unknown[]>(
      `WITH cancelled AS (
         UPDATE ci_import.import_runs
            SET status = 'cancelled', finished_at = now()
          WHERE id = $1::uuid AND user_id = $2::uuid AND finished_at IS NULL
      RETURNING id)
       SELECT id FROM cancelled`,
      [runId, ctx.userId],
    );

    if (rows.length === 0) {
      return false;
    }

    await this.dataSource.query(
      `UPDATE ci_import.import_stages
          SET status = 'cancelled', finished_at = now()
        WHERE run_id = $1::uuid AND status = 'queued'`,
      [runId],
    );

    // Cancelled runs never consume. If the unit never left the inbox the path
    // is freed for a new claim; a moved unit stays in scratch (release no-ops).
    await this.stagedSources.release(runId);

    this.logger.log('Cancelled import run', { runId, userId: ctx.userId });

    return true;
  }

  /** True once the run has been cancelled or otherwise closed out. */
  async isFinished(runId: string): Promise<boolean> {
    const rows = await this.dataSource.query<Array<{ finished: boolean }>>(
      `SELECT finished_at IS NOT NULL AS finished FROM ci_import.import_runs WHERE id = $1::uuid`,
      [runId],
    );

    return rows.length === 0 || rows[0].finished;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async enqueueStage(userId: string, runId: string, stage: ImportStage): Promise<void> {
    await this.eventService.send(
      ImportStageEvent,
      { runId, stageId: stage.id, userId },
      { queue: IMPORT_QUEUE },
    );
  }

  /**
   * Recompute `import_runs.percent` from the run's stages.
   *
   * Weighted by stage, and a stage with no known total contributes its weight
   * only once it completes — an indeterminate stage that guessed at a fraction
   * is how a bar ends up moving backwards when the real total arrives.
   */
  private async refreshRunRollup(stageId: string): Promise<void> {
    await this.dataSource.query(
      `WITH stage AS (
         SELECT run_id FROM ci_import.import_stages WHERE id = $1::uuid
       ),
       rollup AS (
         SELECT s.run_id,
                SUM(s.weight) AS total_weight,
                SUM(
                  s.weight * CASE
                    WHEN s.status IN ('completed', 'skipped') THEN 1.0
                    WHEN s.total IS NULL OR s.total = 0 THEN 0.0
                    ELSE LEAST(s.processed::float / s.total::float, 1.0)
                  END
                ) AS done_weight
           FROM ci_import.import_stages s
          WHERE s.run_id = (SELECT run_id FROM stage)
          GROUP BY s.run_id
       )
       UPDATE ci_import.import_runs r
          SET percent = LEAST(100, GREATEST(0, ROUND(100 * rollup.done_weight / NULLIF(rollup.total_weight, 0))))
         FROM rollup
        WHERE r.id = rollup.run_id
          AND r.finished_at IS NULL`,
      [stageId],
    );
  }
}
