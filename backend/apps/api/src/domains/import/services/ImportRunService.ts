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
  IMPORT_STAGE_ORPHAN_SECONDS,
  IMPORT_STAGE_QUEUE_BY_KIND,
  IMPORT_STAGE_STALLED_SECONDS,
  IMPORT_STAGE_WEIGHTS,
  type ImportStageKindName,
} from '../constants';
import { ImportRunEntity, type ImportRun, type ImportRunSource } from '../entities/ImportRunEntity';
import { ImportStageEntity, type ImportStage } from '../entities/ImportStageEntity';
import { ImportStageEvent } from '../events';
import { FILE_CLASSIFICATIONS } from '../push/canonical';
import type { StageFailureContext } from '../telemetry/stageSummary';
import type { StageOutcome } from '../types';

import { StagedSourceService } from './StagedSourceService';

/**
 * Unfinished runs the active snapshot will report on.
 *
 * A ceiling rather than a page: the snapshot is polled every two seconds while
 * an import runs, and one Takeout session has produced ~150 runs (oversized
 * media exports arrive as loose files, one run each). Sixty covers every batch
 * import the appliance actually performs — 13 top-level sources is the big one
 * — while capping what a pathological account can make the poll fetch.
 */
const ACTIVE_RUN_LIMIT = 60;

/**
 * Finished runs of the same batch carried alongside, so the header can say
 * "3 of 13 done" instead of watching its own denominator shrink as runs finish.
 * Beyond this the tail is dropped and `truncated` says so; History has them all.
 */
const FINISHED_SIBLING_LIMIT = 40;

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
   * The importer(s) the user's intent stood for — a wizard service card, or
   * the inbox service folder the unit was dropped in. The controller validates
   * caller-supplied lists against the registry; the inbox derives its own from
   * the catalog (`sources/inboxFolders.ts`). Stored verbatim; NULL means
   * undeclared.
   */
  declaredSources?: readonly string[];

  /**
   * The platform a connection fetched this run's bytes from ('dropbox',
   * 'google_drive'), when one did. Stamped on what the catch-all importer
   * produces, so a photo that lives in Dropbox is ledgered as arriving from
   * Dropbox rather than from "generic". See migration 20261005230949.
   */
  originPlatform?: string | null;

  /**
   * The connection that fetched this run's bytes, when one did. Stamped as
   * `connection_id` on every record the run produces, so disconnecting it
   * removes them — unless something else also delivered the same record. See
   * migration 20261005231545.
   */
  originConnectionId?: string | null;

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
 * The pg-boss delivery making a claim — recorded by
 * {@link ImportRunService.claimStage} so that, if the stage goes silent, the
 * orphan reaper can fail THAT job and let pg-boss retry it. Absent for
 * in-process runs, which have no job.
 */
export interface StageDelivery {
  jobId: string;
  queue: string;
}

/**
 * What became of one stage {@link ImportRunService.reclaimOrphanedStages} took back.
 *
 *  - `retried` — the dead worker's job was failed through pg-boss, which queued
 *    its retry in place.
 *  - `awaiting` — a delivery for the stage was already waiting (`created` /
 *    `retry`); re-queuing the stage was all it needed.
 *  - `reenqueued` — no job could carry the stage any more, so a fresh one was
 *    enqueued.
 *  - `deadLettered` — the job had no retries left: the stage failed, and
 *    pg-boss dead-lettered the job.
 */
export type OrphanOutcome = 'retried' | 'awaiting' | 'reenqueued' | 'deadLettered';

export interface ReclaimedStage {
  stageId: string;
  runId: string;
  kind: ImportStageKindName;
  outcome: OrphanOutcome;
}

/** A silent stage, as the reaper's candidate query reads it. */
interface OrphanCandidate {
  stageId: string;
  runId: string;
  userId: string;
  kind: ImportStageKindName;
  phase: string | null;
  claimToken: string;
  jobId: string;
  queue: string;
  heartbeatAt: Date;
  /** bigint, so the driver hands it back as a string. */
  processed: string | number;
}

/** What {@link ImportRunService.retryFailedPush} reads under the run's row lock. */
interface RetryPushState {
  /** The first stage still in flight, if any — the reason to refuse. */
  liveKind: string | null;
  liveStatus: string | null;
  /**
   * The first stage AHEAD of the push that did not finish — the other reason
   * to refuse. `upstreamAbandoned` when it is `running` in a finished run with
   * nobody touching it: a worker that died after the run was closed.
   */
  upstreamId: string | null;
  upstreamKind: string | null;
  upstreamStatus: string | null;
  upstreamAbandoned: boolean | null;
  /** The run's last push stage, the one a retry re-queues. */
  pushStageId: string | null;
  pushStatus: string | null;
  /**
   * Whether that push stage ever RAN: `completed`, or `failed`/`running` with a
   * `started_at` from `beginStage`. A push that was cancelled or failed before
   * a worker claimed it did not, and there is nothing of it to retry.
   */
  pushRan: boolean | null;
  /** Rows already `pending` before this retry reset anything. */
  hadPending: boolean;
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
 * The 409 for a push retry whose run did not finish staging: which stage is
 * ahead of the push, how it ended, and the way forward for it.
 */
function describeUnfinishedUpstream(
  runId: string,
  state: {
    upstreamId: string | null;
    upstreamKind: string | null;
    upstreamStatus: string | null;
    upstreamAbandoned: boolean | null;
  },
): string {
  const how =
    state.upstreamAbandoned === true
      ? `was left '${state.upstreamStatus}' by a worker that is gone (the run was closed around it)`
      : `is ${state.upstreamStatus}`;
  const next =
    state.upstreamStatus === 'failed' || state.upstreamStatus === 'cancelled'
      ? `Retry that stage first (POST /import/runs/${runId}/stages/${state.upstreamId}/retry, or History → Retry), ` +
        'then its push.'
      : 'Its push cannot be retried until that stage completes.';

  return (
    `Import run ${runId} did not finish staging: its ${state.upstreamKind} stage ${how}, so its rows ` +
    `are not all staged and a push now would close the run over a partial import. ${next}`
  );
}

/**
 * How silent a stage must go before the recovery sweep treats its claim as
 * dead. A live stage never gets close: progress writes land up to once a
 * second while work moves, and the listener heartbeats every thirty seconds
 * while it merely holds the claim. Ten minutes of silence therefore means the
 * process is gone — crashed, killed, or restarted out from under the work.
 */
const STALE_STAGE_MINUTES = 10;

/**
 * "This run's staged payload is still PUSHABLE" — everything about the run
 * itself that makes the Sync card offer it, with no user or id scoping.
 *
 * THREE callers, deliberately sharing one expression: {@link PUSH_ELIGIBLE_WHERE}
 * (both Sync surfaces), and — negated — `ImportRetentionService`, whose history
 * sweep must never destroy a payload this predicate is still offering to push.
 * That pairing is the whole point of the extraction: the offer and the deletion
 * are two halves of one decision, and a second copy of these clauses would drift
 * into a Sync card that promises a push over rows retention already deleted.
 * **Editing this changes what retention refuses to collect.**
 *
 * Why each clause:
 * - `status <> 'cancelled'` — a cancelled run is a decision, not a backlog.
 *   `partial` runs stay ELIGIBLE: a partially-parsed archive still staged real
 *   rows, and pushing them is the point.
 * - completed parse — the staging actually happened.
 * - no push stage AT ANY STATUS — a failed or cancelled push means this run
 *   already left the Sync surface; its recovery path is `retryStage` (for the
 *   stage) or {@link ImportRunService.retryFailedPush} (for individual rows the
 *   push could not write), not a second appended stage.
 * - pending rows in EITHER lane — PushStage pushes entities as well as items,
 *   and a parse that staged nothing would otherwise sit in the Sync card
 *   forever showing "0 items".
 *
 * @param runRef  Alias of the `import_runs` row in the outer query.
 */
export function pushableRunSql(runRef: string): string {
  return `(
      ${runRef}.status <> 'cancelled'
  AND EXISTS (
        SELECT 1 FROM ci_import.import_stages ps
         WHERE ps.run_id = ${runRef}.id AND ps.kind = 'parse' AND ps.status = 'completed')
  AND NOT EXISTS (
        SELECT 1 FROM ci_import.import_stages xs
         WHERE xs.run_id = ${runRef}.id AND xs.kind = 'push')
  AND (EXISTS (
        SELECT 1 FROM ci_import.staged_items i
         WHERE i.run_id = ${runRef}.id AND i.push_status = 'pending')
    OR EXISTS (
        SELECT 1 FROM ci_import.staged_entities e
         WHERE e.run_id = ${runRef}.id AND e.push_status = 'pending')))`;
}

/**
 * A run whose staged rows have never been pushed. `$1` = user id, `$2` =
 * optional uuid[] filter (NULL means every run). One constant shared VERBATIM
 * by {@link ImportRunService.listUnpushed} and
 * {@link ImportRunService.startPush}, so what the Sync card shows is exactly
 * what Sync acts on — two copies of this predicate would drift, and the drift
 * would be a card that lists a run the button then skips.
 *
 * The scoping half only. What makes a payload pushable lives in
 * {@link pushableRunSql}, because retention needs the same answer.
 *
 * `finished_at IS NOT NULL` — nothing in flight. This excludes a run still
 * parsing, and it is also what makes the reopen double as the concurrency
 * guard: the loser of two racing Sync clicks re-evaluates this predicate
 * against the winner's reopened row and finds `finished_at` NULL.
 */
const PUSH_ELIGIBLE_WHERE = `
      r.user_id = $1::uuid
  AND r.finished_at IS NOT NULL
  AND ($2::uuid[] IS NULL OR r.id = ANY($2::uuid[]))
  AND ${pushableRunSql('r')}`;

/**
 * "This run still holds staged media whose bytes nothing has stored."
 *
 * One predicate, two callers, deliberately shared VERBATIM: the reclaim-time
 * check in {@link ImportRunService.hasUnstoredMedia}, and the retention sweep's
 * candidate query, which has to exclude such runs BEFORE its `LIMIT` or one
 * stuck run at the head of the queue eats the whole night's budget. Two copies
 * of this would drift, and the drift would be a sweep that deletes the row
 * proving a photo is only on disk.
 *
 * @param runRef  SQL expression for the run id — a bound parameter, or the
 *                outer query's correlated column.
 * @param classificationsParam  Bound parameter holding {@link FILE_CLASSIFICATIONS}.
 */
export function unstoredMediaExistsSql(runRef: string, classificationsParam: string): string {
  return `EXISTS (
            SELECT 1 FROM ci_import.staged_items
             WHERE run_id = ${runRef}
               AND (media_type ~ '^(image|video|audio)/'
                    OR classification = ANY(${classificationsParam}::text[]))
               AND COALESCE(intermediate_location, original_location) IS NOT NULL
               AND metadata->>'FileId' IS NULL
               AND metadata->>'FileMediaError' IS NULL
          )`;
}

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
        `INSERT INTO ci_import.import_runs
                (user_id, label, source, status, requested_stages, declared_sources,
                 origin_platform, origin_connection_id)
              VALUES ($1::uuid, $2, $3, 'queued', $4::text[], $5::text[], $6, $7::uuid)
           RETURNING id`,
        [
          ctx.userId,
          input.label ?? defaultLabel,
          input.source ?? 'wizard',
          kinds,
          input.declaredSources ?? null,
          input.originPlatform ?? null,
          input.originConnectionId ?? null,
        ],
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
   * Create a run whose stages the CALLER executes, in-process.
   *
   * The connector path (`BlueBubblesSyncService`) — a handful of REST calls
   * rather than a 40GB tree — deliberately does not go through {@link startRun}:
   * there is no drop or inbox unit to claim, and nothing to enqueue, because it
   * runs its own stages synchronously. What it DOES need is identical: a run
   * row, and one correctly-weighted stage row per kind.
   *
   * It exists so that stage materialization has ONE implementation. The
   * connector hand-rolled its own inserts and restated its own stage list, and
   * that is the precise failure {@link DEFAULT_STAGES} is documented to
   * prevent: its copy said `['parse', 'push']`, so `media` never ran, and every
   * BlueBubbles attachment was downloaded, written to disk, and then never
   * uploaded or catalogued. A caller may still choose a subset — that is what
   * `stages` is for — but it now chooses from the same list, with the same
   * weights, through the same idempotent insert.
   *
   * No claim and no enqueue, unlike `startRun`. Both belong to a run whose work
   * is dispatched to a worker; this run's work is already in the caller's hand.
   */
  async createInProcessRun(input: {
    userId: string;
    label: string;
    source: ImportRunSource;
    stages: readonly ImportStageKindName[];
    declaredSources?: readonly string[];
  }): Promise<{ runId: string; stages: ImportStage[] }> {
    if (input.stages.length === 0) {
      throw new ConflictException('A run needs at least one stage');
    }

    return this.dataSource.transaction(async (manager) => {
      const runRows = await manager.query<Array<{ id: string }>>(
        `INSERT INTO ci_import.import_runs (user_id, label, source, status, requested_stages, declared_sources)
              VALUES ($1::uuid, $2, $3, 'queued', $4::text[], $5::text[])
           RETURNING id`,
        [input.userId, input.label, input.source, [...input.stages], input.declaredSources ?? null],
      );

      const runId = runRows[0].id;

      return { runId, stages: await this.materializeStages(manager, runId, input.stages) };
    });
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
   *
   * **The ten-minute reclaim below is now the BACKSTOP, not the first
   * responder.** A stage claimed through a pg-boss delivery is taken back by
   * {@link reclaimOrphanedStages} — run first, here and every minute on its own
   * — within {@link IMPORT_STAGE_ORPHAN_SECONDS}, with its job handed back to
   * pg-boss. What reaches the ten-minute rule is a claim no job holds (the
   * in-process connector runs, and claims from before claim ownership was
   * recorded), or one the fast path failed to handle. Stages in `liveStageIds`
   * — the ones the calling process is running this minute — are exempt from
   * both, because a process knows for certain that its own work is alive,
   * however long its event loop was blocked or its database away.
   */
  async resumeInterrupted(options: { liveStageIds?: Iterable<string> } = {}): Promise<void> {
    const liveStageIds = [...(options.liveStageIds ?? [])];

    await this.reclaimOrphanedStages({ liveStageIds });

    // CTE-wrapped — see the note on the claim in `startRun`. The reclaim
    // deliberately does NOT touch `updated_at`: the requeued stage must still
    // read as stale so the enqueue pass below picks it up in the same sweep.
    // The claim columns ARE cleared, so a worker that was only slow is fenced
    // out of the stage from here on (see `claimStage`).
    const reclaimed = await this.dataSource.query<Array<{ stageId: string; runId: string }>>(
      `WITH reclaimed AS (
         UPDATE ci_import.import_stages s
            SET status = 'queued', error = NULL, started_at = NULL, finished_at = NULL,
                processed = 0, duration_ms = NULL,
                claim_token = NULL, claim_job_id = NULL, claim_queue = NULL
          WHERE s.status = 'running'
            AND s.updated_at < now() - make_interval(mins => $1::int)
            AND NOT (s.id = ANY($2::uuid[]))
            AND EXISTS (
              SELECT 1 FROM ci_import.import_runs r
               WHERE r.id = s.run_id AND r.finished_at IS NULL
            )
      RETURNING s.id, s.run_id)
       SELECT id AS "stageId", run_id AS "runId" FROM reclaimed`,
      [STALE_STAGE_MINUTES, liveStageIds],
    );

    const unfinished = await this.dataSource.query<
      Array<{
        runId: string;
        userId: string;
        stageId: string | null;
        stageStale: boolean | null;
        hasLive: boolean;
        hasRunning: boolean;
        allStale: boolean;
      }>
    >(
      `SELECT r.id AS "runId",
              r.user_id AS "userId",
              q.id AS "stageId",
              q.updated_at < now() - make_interval(mins => $1::int) AS "stageStale",
              EXISTS (SELECT 1 FROM ci_import.import_stages x
                       WHERE x.run_id = r.id AND x.status IN ('queued', 'running')) AS "hasLive",
              -- A stage of this run is EXECUTING right now. The queued stage
              -- below is therefore waiting for it BY DESIGN, however long it has
              -- sat there, and enqueuing it would run the pipeline out of order.
              EXISTS (SELECT 1 FROM ci_import.import_stages x
                       WHERE x.run_id = r.id AND x.status = 'running') AS "hasRunning",
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
      if (run.stageId != null && run.stageStale === true && !run.hasRunning) {
        // A queued stage nobody has touched in the staleness window is a stage
        // whose job was lost — a FRESH queued stage is just waiting its turn in
        // the queue and must not collect a duplicate job every sweep.
        //
        // `!hasRunning` is the ORDERING guard, and it is not defensive: without
        // it this sweep runs the pipeline past a stage that is still working.
        // Observed on a real 13-source import — unpack finished 03:34:53, parse
        // waited for its queue and only started 03:45:08, by which time `media`
        // and `push` had been queued for ten minutes and were "stale" by this
        // rule. The moment parse went RUNNING it stopped being the first queued
        // stage, so the next sweep enqueued `media` instead. media completed
        // 0/0, advance() enqueued push, push completed 0/0, advance() found
        // nothing queued and called finishRun — while parse was still parsing.
        // The Google Takeout run reported `completed`, percent 100, and landed
        // ZERO of its 703,956 items.
        //
        // Staleness cannot distinguish "my job was lost" from "I am waiting for
        // the stage in front of me", because nothing touches a waiting stage.
        // Whether a sibling is executing can be asked directly, so it is.
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
   * Take back every stage whose pg-boss worker has gone silent, and hand its
   * job back to pg-boss.
   *
   * ## What this replaced
   *
   * A worker restarted mid-parse (reproduced 2026-09-29) left its stage
   * `running` with `processed` frozen and no error, and its pg-boss job
   * `active` with a twelve-hour lease (`IMPORT_STAGE_EXPIRE_SECONDS`).
   * Recovery was the ten-minute rule in {@link resumeInterrupted}'s
   * five-minute sweep — twelve minutes, in the reproduction — which re-queued
   * the stage behind a FRESH job, at the back of its kind's queue (on a
   * thirteen-run batch, behind every parse that queued after it), and left the
   * orphan `active` until its lease expired, when its retry no-oped against
   * the claim. Nothing surfaced any of it: `ci runs` said `running` throughout.
   *
   * ## What this does instead
   *
   * A candidate is a `running` stage of an unfinished run whose claim a pg-boss
   * delivery made (`claim_job_id`), silent for {@link IMPORT_STAGE_ORPHAN_SECONDS},
   * and not in `liveStageIds`. For each, what pg-boss says about that job
   * decides the remedy:
   *
   *  - **`active` with retries left** — the common case, a worker that died
   *    holding the lease. The stage goes back to `queued` and the job is
   *    FAILED through pg-boss, whose policy re-inserts it as `retry` with the
   *    same id and `created_on`: it keeps its place at the head of the queue
   *    and runs after the first backoff (10–20 s), where a fresh job would
   *    have queued behind everything else. Hand-writing `pgboss.job.state`
   *    would skip pg-boss's retry accounting; asking it to fail the job keeps
   *    the dead-letter bound doing its job.
   *  - **`active` with no retries left** — the same worker death, for the
   *    fourth time. pg-boss will dead-letter this job, so the STAGE fails to
   *    match, with a message saying what kept happening. Re-queuing it instead
   *    would have the ten-minute sweep enqueue a brand-new job with a brand-new
   *    retry budget, and a stage that kills its worker would do so forever.
   *  - **`created` / `retry`** — a delivery is already on its way; re-queuing
   *    the stage is all it needs to be able to claim it.
   *  - **finished, or gone** — nothing will carry the stage, so a fresh job is
   *    enqueued (the old behaviour, now the rare fallback).
   *
   * ## Why a short window is safe
   *
   * See {@link IMPORT_STAGE_ORPHAN_SECONDS}. In brief: the caller passes the
   * stages its own process is running as `liveStageIds`, and those are never
   * candidates — so the owner's own event-loop stalls and database blips,
   * the usual reasons a live stage misses beats, cannot reach this. Every take
   * is also fenced (see {@link claimStage}): the reclaim only lands if the
   * claim token is still the one read AND the stage is still silent, so a
   * worker that beats in between keeps its stage; and one that beats after
   * finds its token gone, and stops.
   *
   * Idempotent and safe to run concurrently with itself and with
   * {@link resumeInterrupted}: every decision is a conditional UPDATE, and only
   * its winner touches the job.
   */
  async reclaimOrphanedStages(options: { liveStageIds?: Iterable<string> } = {}): Promise<ReclaimedStage[]> {
    const liveStageIds = [...(options.liveStageIds ?? [])];
    const reclaimed: ReclaimedStage[] = [];

    const candidates = await this.dataSource.query<OrphanCandidate[]>(
      `SELECT s.id AS "stageId", s.run_id AS "runId", r.user_id AS "userId", s.kind, s.phase,
              s.claim_token AS "claimToken", s.claim_job_id AS "jobId", s.claim_queue AS "queue",
              s.updated_at AS "heartbeatAt", s.processed
         FROM ci_import.import_stages s
         JOIN ci_import.import_runs r ON r.id = s.run_id
        WHERE s.status = 'running'
          AND s.claim_token IS NOT NULL
          AND s.claim_job_id IS NOT NULL
          AND s.claim_queue IS NOT NULL
          AND s.updated_at < now() - make_interval(secs => $1::int)
          AND r.finished_at IS NULL
          AND NOT (s.id = ANY($2::uuid[]))
        ORDER BY s.updated_at`,
      [IMPORT_STAGE_ORPHAN_SECONDS, liveStageIds],
    );

    for (const candidate of candidates) {
      try {
        const outcome = await this.reclaimOrphan(candidate);

        if (outcome != null) {
          reclaimed.push({
            stageId: candidate.stageId,
            runId: candidate.runId,
            kind: candidate.kind,
            outcome,
          });
        }
      } catch (err) {
        // One stage's failure must not strand the others behind it. It is
        // still `running` and still silent, so the next tick meets it again.
        this.logger.error('Could not reclaim an orphaned import stage; the next sweep will try again', {
          err,
          runId: candidate.runId,
          stageId: candidate.stageId,
          kind: candidate.kind,
          jobId: candidate.jobId,
        });
      }
    }

    return reclaimed;
  }

  /**
   * Reclaim one candidate. Returns what became of it, or null when the stage
   * turned out not to be orphaned after all — its worker beat, completed or
   * failed it between the candidate query and the fenced UPDATE.
   */
  private async reclaimOrphan(candidate: OrphanCandidate): Promise<OrphanOutcome | null> {
    const job = await this.eventService.getJob(candidate.queue, candidate.jobId);
    const heartbeatAt = new Date(candidate.heartbeatAt);
    const silentForMs = Date.now() - heartbeatAt.getTime();
    const context = {
      runId: candidate.runId,
      stageId: candidate.stageId,
      kind: candidate.kind,
      jobId: candidate.jobId,
      queue: candidate.queue,
      jobState: job?.state ?? 'missing',
      lastHeartbeatAt: heartbeatAt.toISOString(),
      silentForMs,
    };
    const jobOutput = {
      message:
        `import ${candidate.kind} stage ${candidate.stageId} stopped heartbeating ` +
        `(last beat ${heartbeatAt.toISOString()}); its worker is gone`,
      reason: 'import-stage-worker-lost',
      runId: candidate.runId,
      stageId: candidate.stageId,
      lastHeartbeatAt: heartbeatAt.toISOString(),
      reclaimedAt: new Date().toISOString(),
    };

    if (job?.state === 'active' && job.retryCount >= job.retryLimit) {
      // Seize the claim first, so the decision is made exactly once and a
      // worker that beats in between keeps its stage; then fail the stage under
      // the seized token, then let pg-boss dead-letter the job to match.
      const seized = await this.seizeOrphanedClaim(candidate);

      if (seized == null) {
        return null;
      }

      const attempts = job.retryLimit + 1;
      const message =
        `${candidate.kind} stopped: the worker running it went silent ${attempts} times ` +
        `(last heartbeat ${heartbeatAt.toISOString()}, ${Number(candidate.processed)} processed), ` +
        `and its job was dead-lettered after ${job.retryLimit} retries. Something is killing the ` +
        `worker on this stage — check its log for a crash or an out-of-memory kill, then retry the ` +
        `stage (History → Retry, or POST /import/runs/${candidate.runId}/stages/${candidate.stageId}/retry).`;

      await this.failStage(
        candidate.stageId,
        message,
        {
          stage: candidate.kind,
          ...(candidate.phase != null ? { phase: candidate.phase } : {}),
          message,
          name: 'ImportStageWorkerLostError',
        },
        seized,
      );
      await this.eventService.failJob(candidate.queue, candidate.jobId, jobOutput);

      this.logger.error(
        'An import stage lost its worker once too often; failed it and dead-lettered its job',
        {
          ...context,
          attempts,
        },
      );

      return 'deadLettered';
    }

    const retry = job?.state === 'active' ? job.retryCount + 1 : null;
    const requeued = await this.requeueOrphanedStage(candidate, {
      jobState: job?.state ?? null,
      retry,
      retryLimit: job?.retryLimit ?? null,
    });

    if (!requeued) {
      return null;
    }

    // The stage's own counters were just zeroed; the run's percent is a cache
    // over them and would otherwise go on claiming the dead attempt's progress.
    await this.refreshRunRollup(candidate.stageId);

    let outcome: OrphanOutcome;

    if (
      job?.state === 'active' &&
      (await this.eventService.failJob(candidate.queue, candidate.jobId, jobOutput))
    ) {
      outcome = 'retried';
    } else if (job?.state === 'created' || job?.state === 'retry') {
      outcome = 'awaiting';
    } else {
      // No job will carry the stage: it finished or vanished — or it was
      // `active` and finished between the read above and the fail, which
      // `failJob`'s false says. Either way a fresh delivery is the only way on.
      await this.enqueueStage(candidate.userId, candidate.runId, {
        id: candidate.stageId,
        kind: candidate.kind,
      });
      outcome = 'reenqueued';
    }

    this.logger.warn('An import stage stopped heartbeating; reclaimed it for a retry', {
      ...context,
      outcome,
      retry,
      retryLimit: job?.retryLimit ?? null,
    });

    return outcome;
  }

  /**
   * Put an orphaned stage back to `queued`, recording what happened on it.
   *
   * Fenced twice, in one statement: the claim token must still be the one the
   * candidate query read, and the stage must still be silent. The first stops
   * a reclaim racing another; the second stops one racing the owner's own
   * heartbeat, which does not change the token.
   *
   * `updated_at` is bumped, unlike the ten-minute backstop's reclaim: this path
   * arranges its own delivery, so the queued stage must read as FRESH — not as
   * a lost job for `resumeInterrupted` to enqueue a duplicate of.
   *
   * `detail.interrupted` is what a person or `ci runs` reads to learn why the
   * stage went back to the queue with its counters at zero. It lives until the
   * stage next completes, whose outcome replaces `detail`.
   */
  private async requeueOrphanedStage(
    candidate: OrphanCandidate,
    retry: { jobState: string | null; retry: number | null; retryLimit: number | null },
  ): Promise<boolean> {
    const rows = await this.dataSource.query<unknown[]>(
      `WITH requeued AS (
         UPDATE ci_import.import_stages s
            SET status = 'queued', error = NULL, started_at = NULL, finished_at = NULL,
                processed = 0, duration_ms = NULL, updated_at = now(),
                claim_token = NULL, claim_job_id = NULL, claim_queue = NULL,
                detail = COALESCE(s.detail, '{}'::jsonb) || jsonb_build_object('interrupted', jsonb_build_object(
                  'at', now(),
                  'reason', 'worker stopped heartbeating',
                  'lastHeartbeatAt', s.updated_at,
                  'processed', s.processed,
                  'phase', s.phase,
                  'jobId', s.claim_job_id,
                  'queue', s.claim_queue,
                  'jobState', $3::text,
                  'retry', $4::int,
                  'retryLimit', $5::int))
          WHERE s.id = $1::uuid
            AND s.status = 'running'
            AND s.claim_token = $2::uuid
            AND s.updated_at < now() - make_interval(secs => $6::int)
      RETURNING s.id)
       SELECT id FROM requeued`,
      [
        candidate.stageId,
        candidate.claimToken,
        retry.jobState,
        retry.retry,
        retry.retryLimit,
        IMPORT_STAGE_ORPHAN_SECONDS,
      ],
    );

    return rows.length > 0;
  }

  /**
   * Replace a silent stage's claim token with a fresh one, and return it — the
   * dead-letter path's way of taking the stage atomically before failing it.
   * Null when the claim moved or the stage beat in the meantime.
   */
  private async seizeOrphanedClaim(candidate: OrphanCandidate): Promise<string | null> {
    const rows = await this.dataSource.query<Array<{ claimToken: string }>>(
      `WITH seized AS (
         UPDATE ci_import.import_stages
            SET claim_token = gen_random_uuid()
          WHERE id = $1::uuid
            AND status = 'running'
            AND claim_token = $2::uuid
            AND updated_at < now() - make_interval(secs => $3::int)
      RETURNING claim_token)
       SELECT claim_token AS "claimToken" FROM seized`,
      [candidate.stageId, candidate.claimToken, IMPORT_STAGE_ORPHAN_SECONDS],
    );

    return rows[0]?.claimToken ?? null;
  }

  /**
   * Refresh a running stage's claim.
   *
   * The listener calls this on a timer for as long as a runner is inside the
   * stage, so a stage that is alive but quiet — a giant archive mid-extract
   * says nothing for minutes — never reads as abandoned to the sweep.
   *
   * With `claimToken` the beat is fenced (see {@link claimStage}), and false
   * is how a worker learns its stage was taken back: the one signal that
   * reaches it even while its runner is deep in a parser and reporting nothing.
   */
  async touchStage(stageId: string, claimToken?: string): Promise<boolean> {
    // CTE-wrapped so the fence can be read back — see the note on the claim in
    // `startRun`.
    const rows = await this.dataSource.query<unknown[]>(
      `WITH touched AS (
         UPDATE ci_import.import_stages
            SET updated_at = now()
          WHERE id = $1::uuid
            AND status = 'running'
            AND ($2::uuid IS NULL OR claim_token = $2::uuid)
      RETURNING id)
       SELECT id FROM touched`,
      [stageId, claimToken ?? null],
    );

    return rows.length > 0;
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

  /**
   * Is this run this user's?
   *
   * The check the worker makes before it executes a stage. Every row a stage
   * writes is stamped with the payload's `userId`, so a payload that disagrees
   * with the run row would file one account's export under another's — see
   * {@link ImportStageListener.runStage}, which fails the stage rather than
   * reconciling the two.
   */
  async runBelongsTo(runId: string, userId: string): Promise<boolean> {
    return this.dataSource.getRepository(ImportRunEntity).exist({ where: { id: runId, userId } });
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
  async listRuns(
    ctx: UserServiceContext,
    options: {
      limit?: number;
      /**
       * Keyset cursor: return runs strictly OLDER than this `(createdAt, id)`
       * — the last row of the previous page. Keyset rather than offset because
       * this list is paged while imports are still being created: an offset
       * page shifts under a new row and either repeats or skips one, where a
       * "strictly older than what I've seen" cursor cannot.
       */
      before?: { createdAt: Date; id: string };
    } = {},
  ): Promise<(ImportRun & { records: number; stalled: boolean })[]> {
    const query = this.dataSource
      .getRepository(ImportRunEntity)
      .createQueryBuilder('run')
      .where('run.user_id = :userId', { userId: ctx.userId })
      // `id DESC` tiebreak makes the order total, which keyset paging requires:
      // two runs sharing a createdAt would otherwise straddle a page boundary
      // in an order the cursor cannot express.
      .orderBy('run.created_at', 'DESC')
      .addOrderBy('run.id', 'DESC')
      .take(Math.min(options.limit ?? 50, 200));

    if (options.before != null) {
      query.andWhere('(run.created_at, run.id) < (:beforeCreatedAt, :beforeId::uuid)', {
        beforeCreatedAt: options.before.createdAt,
        beforeId: options.before.id,
      });
    }

    const runs = await query.getMany();

    if (runs.length === 0) {
      return [];
    }

    // How many records the run actually landed, so a caller can say what an
    // import produced without fetching every run's stages one at a time. The
    // PUSH stage is the one that answers it: unpack counts archive members and
    // parse counts rows staged, but push is what reaches ci.*.
    //
    // `detail.pushed`, NOT the stage's `processed`. `processed` is deliberately
    // a PROGRESS number — `entitiesProcessed + pushed + deduped + failed`, all
    // of it counted because examining a row is the stage's work whatever the
    // outcome (see PushStage). Reporting that as "records imported" credits an
    // import with rows that already existed, rows that failed to send, and
    // entity resolutions that are not records at all. `detail.pushed` is the
    // count of rows this run actually wrote.
    //
    // One extra query for the whole page, not one per run. Extracted to
    // `recordsFor` so the active snapshot reports the same number by the same
    // rule rather than growing a second, subtly different definition of
    // "records imported".
    const runIds = runs.map((run) => run.id);
    const [recordsByRun, stalledRuns] = await Promise.all([
      this.recordsFor(runIds),
      this.stalledRunsFor(runIds),
    ]);

    return runs.map((run) => ({
      ...run,
      records: recordsByRun.get(run.id) ?? 0,
      stalled: stalledRuns.has(run.id),
    }));
  }

  /**
   * Which of these runs has a `running` stage that has stopped heartbeating —
   * silent past {@link IMPORT_STAGE_STALLED_SECONDS}.
   *
   * For the run LIST, which reads the cached `status` off the run row and so
   * would otherwise say `running` for as long as recovery takes. One query for
   * the page, like {@link recordsFor}; the stage-level answer, for a run whose
   * stages are already loaded, is `isStageStalled` (`stageLiveness.ts`), over
   * the same threshold.
   */
  async stalledRunsFor(runIds: readonly string[]): Promise<Set<string>> {
    if (runIds.length === 0) {
      return new Set();
    }

    const rows = await this.dataSource.query<Array<{ run_id: string }>>(
      `SELECT DISTINCT run_id
         FROM ci_import.import_stages
        WHERE run_id = ANY($1::uuid[])
          AND status = 'running'
          AND updated_at < now() - make_interval(secs => $2::int)`,
      [[...runIds], IMPORT_STAGE_STALLED_SECONDS],
    );

    return new Set(rows.map((row) => row.run_id));
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
   * Everything this user has in flight, with its stages, in one round trip.
   *
   * ## Why an endpoint of its own
   *
   * The alternative — the surfaces poll `GET /import/runs/:id` per run — is what
   * the wizard did, and it is unusable on the shape people actually run. A batch
   * import of an inbox is one run per top-level folder: the 13-source corpus
   * this was built against meant 13 detail requests every two seconds, each with
   * its own re-render clock. `useRunsProgress` already fixed the same problem
   * for the wizard's summary cards by collapsing many polls into one list call;
   * this does it for the DETAILED view, which the list endpoint cannot serve
   * because it carries no stages.
   *
   * ## What counts as "in flight"
   *
   * Every unfinished run, plus the runs finished since the OLDEST unfinished one
   * was created. The second half is what lets a caller say "1 of 13 done" — a
   * finished run is no longer in flight, but it is still part of the batch a
   * person is watching, and dropping it would make the counter read "1 of 12"
   * and then "1 of 11" as the batch drains, which is worse than useless.
   *
   * ## Cost
   *
   * Four queries, and only while something is unfinished — the first one returns
   * empty on an idle appliance and the rest are skipped, so a page left open
   * overnight costs one indexed lookup per idle poll. The unfinished lookup
   * rides `import_runs_active_idx` (partial, `WHERE finished_at IS NULL`); the
   * finished tail rides `import_runs_user_created_idx`.
   */
  async activeBatch(
    ctx: UserServiceContext,
    options: { finishedLimit?: number } = {},
  ): Promise<{
    runs: ImportRun[];
    stages: ImportStage[];
    units: Map<string, string>;
    records: Map<string, number>;
    truncated: boolean;
  } | null> {
    const repository = this.dataSource.getRepository(ImportRunEntity);

    // Oldest first: under a single execution slot that is also the order they
    // will finish, so it is the order to show them in.
    const unfinished = await repository
      .createQueryBuilder('run')
      .where('run.user_id = :userId', { userId: ctx.userId })
      .andWhere('run.finished_at IS NULL')
      .orderBy('run.created_at', 'ASC')
      .take(ACTIVE_RUN_LIMIT)
      .getMany();

    if (unfinished.length === 0) {
      return null;
    }

    // The batch's floor. `createdAt`, not `startedAt`: a run that is still
    // `queued` has no start, and it is unambiguously part of the batch.
    const since = unfinished[0].createdAt;
    const finishedLimit = options.finishedLimit ?? FINISHED_SIBLING_LIMIT;
    const finished = await repository
      .createQueryBuilder('run')
      .where('run.user_id = :userId', { userId: ctx.userId })
      .andWhere('run.finished_at IS NOT NULL')
      .andWhere('run.created_at >= :since', { since })
      // Newest first for the CAP — if a batch overflows, the recently-finished
      // runs are the ones somebody is still looking at. Re-sorted into
      // execution order by the snapshot builder.
      .orderBy('run.created_at', 'DESC')
      .take(finishedLimit + 1)
      .getMany();

    const truncated = finished.length > finishedLimit;
    const runs = [...unfinished, ...finished.slice(0, finishedLimit)];
    const runIds = runs.map((run) => run.id);

    const [stages, units, records] = await Promise.all([
      this.dataSource.getRepository(ImportStageEntity).find({ where: { runId: In(runIds) } }),
      this.unitsFor(runIds),
      this.recordsFor(runIds),
    ]);

    return { runs, stages, units, records, truncated };
  }

  /**
   * Run id → the staged upload or inbox folder it is importing.
   *
   * The name that tells thirteen runs of one batch apart. Every one of them
   * carries the same `label` (the batch name the caller passed) and an empty
   * `dataSources` until its parse finishes, so before this the run list showed
   * thirteen rows reading "qa-full-corpus" with no way to tell which was the
   * 700k-item Takeout and which was the 298-item Lyft export.
   *
   * `original_filename` first (an upload knows what the user called it),
   * falling back to the source path, which the caller reduces to a basename —
   * inbox units have no `original_filename` and their path IS their name.
   *
   * DISTINCT ON because a run consumes exactly one staged source today, and a
   * future one consuming several should still get a stable answer rather than
   * whichever row the planner happened to emit first.
   */
  async unitsFor(runIds: readonly string[]): Promise<Map<string, string>> {
    if (runIds.length === 0) {
      return new Map();
    }

    const rows = await this.dataSource.query<Array<{ run_id: string; unit: string | null }>>(
      `SELECT DISTINCT ON (run_id) run_id, COALESCE(original_filename, source_path) AS unit
         FROM ci_import.staged_sources
        WHERE run_id = ANY($1::uuid[])
        ORDER BY run_id, created_at ASC`,
      [[...runIds]],
    );

    return new Map(
      rows
        .filter((row): row is { run_id: string; unit: string } => row.unit != null)
        .map((row) => [row.run_id, row.unit]),
    );
  }

  /**
   * Run id → rows actually written into `ci.*`.
   *
   * `detail.pushed`, NOT the push stage's `processed` — see the long note in
   * {@link listRuns}, which this was lifted out of so the active snapshot could
   * report the same number by the same rule instead of inventing a second one.
   */
  async recordsFor(runIds: readonly string[]): Promise<Map<string, number>> {
    if (runIds.length === 0) {
      return new Map();
    }

    const rows = await this.dataSource.query<Array<{ run_id: string; records: string | null }>>(
      `SELECT run_id, SUM((detail->>'pushed')::bigint)::bigint AS records
         FROM ci_import.import_stages
        WHERE run_id = ANY($1::uuid[]) AND kind = 'push'
          AND detail ? 'pushed'
        GROUP BY run_id`,
      [[...runIds]],
    );

    return new Map(rows.map((row) => [row.run_id, Number(row.records ?? 0)]));
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
   *
   * In the SAME statement, so the two commit together. `ImportRetentionService`
   * reads a `queued` stage in a finished run as a leftover nothing will reach,
   * which is only true if no instant exists where this stage is already
   * `queued` and the run is still closed. Two statements opened exactly that
   * instant, and a discard or a sweep landing in it would take the run this
   * retry is about to hand a worker.
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
      RETURNING s.id, s.seq, s.run_id),
       reopened AS (
         UPDATE ci_import.import_runs r
            SET status = 'queued', error = NULL, finished_at = NULL
           FROM requeued q
          WHERE r.id = q.run_id
      RETURNING r.id)
       SELECT id, seq FROM requeued`,
      [stageId, runId, ctx.userId],
    );

    if (rows.length === 0) {
      return false;
    }

    await this.enqueueStage(ctx.userId, runId, { id: rows[0].id } as ImportStage);

    this.logger.log('Re-queued a failed import stage', { runId, stageId, userId: ctx.userId });

    return true;
  }

  /**
   * Put a run's individually-failed staged rows back in the push queue.
   *
   * THE recovery path for a row that `PushStage` marked `failed`, which until
   * now had none. Every other route is closed to it: the push reads only
   * `push_status = 'pending'`, so it never reconsiders the row;
   * {@link PUSH_ELIGIBLE_WHERE} excludes a run that already has a push stage at
   * any status, so Sync will not offer it; and `retryStage` moves STAGES, not
   * rows, and refuses one that completed. A push that wrote 461,000 records and
   * failed 297 therefore stranded those 297 forever — invisible except as a
   * count in the stage detail, and unreachable by anything the UI could click.
   *
   * The rows go back to `pending` and the run's push stage is re-queued, which
   * is what makes the next attempt real rather than a no-op: `beginStage` only
   * claims a `queued` stage. A run that somehow has no push stage at all takes
   * the ordinary {@link startPush} route instead, which now finds pending rows
   * and appends one.
   *
   * It also re-drives a push that RAN and FAILED — with rows still `pending`
   * and none marked `failed`, which is how a push now ends when the database
   * stays away past `PushStage`'s wait or crashes under one of its statements
   * (`DatabaseCrashedDuringPushError`), or with every row settled, when it
   * died after the last batch. One command therefore recovers every shape of
   * "this run's push did not finish", and the operator does not need to know
   * which one the run is in.
   *
   * Refused (409), each with a message saying why and what to do instead:
   *
   *  - while any stage of the run is still working. Resetting rows under a push
   *    that is running would hand the same rows to two writers, and re-queuing
   *    a stage a worker holds would let a second worker claim it. A stage left
   *    `running` in a FINISHED run and silent past STALE_STAGE_MINUTES is not
   *    working — `cancel()` closed the run while its worker died, and nothing
   *    else will ever move it — so it does not block forever.
   *  - while a stage AHEAD of the push did not complete. A run cancelled mid-
   *    parse has half its rows staged; pushing them would close the run over an
   *    import that never finished parsing. That stage's own retry comes first.
   *  - when the push never ran — cancelled, or failed before a worker claimed
   *    it. There is nothing of it to retry, and starting it here would undo a
   *    cancellation behind the user's back; the stage retry is the explicit way.
   *
   * The check and the reset happen under the run's row lock, in one transaction
   * — the same lock `startPush` takes — so a push cannot start in between. The
   * reopen itself is guarded on the status that was read, because `retryStage`
   * and a claiming worker move a stage WITHOUT that lock: if the push stage
   * moved in the meantime, nothing is reset and the caller gets a 409.
   *
   * The run's status is recomputed when the re-driven push finishes, by the
   * ordinary `advance` → {@link finishRun}: the run is reopened here
   * (`finished_at` NULL) precisely so that close-out runs again, and a push
   * that writes every reset row completes with `partial: false`.
   *
   * Re-running the push over these rows is safe by the same argument the stage
   * itself rests on: every destination upserts on its provenance triple, so a
   * row whose failure was transient writes, and one whose failure was the
   * record itself fails again and lands back where it was.
   */
  async retryFailedPush(
    ctx: UserServiceContext,
    runId: string,
  ): Promise<{ items: number; entities: number; requeued: boolean } | null> {
    const plan = await this.dataSource.transaction(async (manager) => {
      const [locked] = await manager.query<Array<{ id: string }>>(
        `SELECT r.id
           FROM ci_import.import_runs r
          WHERE r.id = $1::uuid AND r.user_id = $2::uuid
            FOR UPDATE OF r`,
        [runId, ctx.userId],
      );

      if (locked == null) {
        return null;
      }

      // A second statement, with the lock already held, so it reads a snapshot
      // taken AFTER any push that committed while this waited on the lock —
      // see ImportRetentionService.claimForDiscard for the READ COMMITTED
      // detail that makes the split necessary.
      const [state] = await manager.query<RetryPushState[]>(
        `SELECT live.kind AS "liveKind", live.status AS "liveStatus",
                up.id AS "upstreamId", up.kind AS "upstreamKind", up.status AS "upstreamStatus",
                up.abandoned AS "upstreamAbandoned",
                push.id AS "pushStageId", push.status AS "pushStatus",
                (push.status = 'completed'
                  OR (push.status IN ('failed', 'running') AND push.started_at IS NOT NULL)) AS "pushRan",
                EXISTS (SELECT 1 FROM ci_import.staged_items i
                         WHERE i.run_id = r.id AND i.push_status = 'pending')
                  OR EXISTS (SELECT 1 FROM ci_import.staged_entities e
                              WHERE e.run_id = r.id AND e.push_status = 'pending') AS "hadPending"
           FROM ci_import.import_runs r
           -- In flight: a stage that is running, or one that is queued in a run
           -- that has not finished (a finished run can hold a queued stage the
           -- worker never reached, after an earlier stage failed — that is a
           -- leftover, not work in progress). A RUNNING stage in a finished run
           -- is in flight only while something still touches it: cancel()
           -- closes the run without touching a running stage, so a worker that
           -- died after it leaves the stage 'running' for good, and the
           -- recovery sweep only reclaims stages of UNFINISHED runs.
           LEFT JOIN LATERAL (
             SELECT s.kind, s.status
               FROM ci_import.import_stages s
              WHERE s.run_id = r.id
                AND ((s.status = 'running'
                      AND (r.finished_at IS NULL
                           OR s.updated_at >= now() - make_interval(mins => $2::int)))
                     OR (s.status = 'queued' AND r.finished_at IS NULL))
              ORDER BY s.seq
              LIMIT 1
           ) live ON true
           LEFT JOIN LATERAL (
             SELECT x.id, x.seq, x.status, x.started_at
               FROM ci_import.import_stages x
              WHERE x.run_id = r.id AND x.kind = 'push'
              ORDER BY x.seq DESC
              LIMIT 1
           ) push ON true
           -- Ahead of the push: every stage before it in the pipeline (all of
           -- them when there is no push stage yet). 'skipped' counts as done,
           -- as it does in the percent rollup.
           LEFT JOIN LATERAL (
             SELECT u.id, u.kind, u.status, (u.status = 'running') AS abandoned
               FROM ci_import.import_stages u
              WHERE u.run_id = r.id
                AND u.kind <> 'push'
                AND (push.seq IS NULL OR u.seq < push.seq)
                AND u.status NOT IN ('completed', 'skipped')
              ORDER BY u.seq
              LIMIT 1
           ) up ON true
          WHERE r.id = $1::uuid`,
        [runId, STALE_STAGE_MINUTES],
      );

      if (state.liveKind != null) {
        throw new ConflictException(
          state.liveKind === 'push'
            ? `Import run ${runId} is still pushing (its push stage is ${state.liveStatus}). ` +
                'Wait for it to finish, then retry the rows it could not write.'
            : `Import run ${runId} is still working (its ${state.liveKind} stage is ${state.liveStatus}). ` +
                'Wait for it to finish, then retry its failed push rows.',
        );
      }

      if (state.upstreamKind != null) {
        throw new ConflictException(describeUnfinishedUpstream(runId, state));
      }

      if (state.pushStageId != null && state.pushRan !== true) {
        throw new ConflictException(
          `Import run ${runId}'s push stage is ${state.pushStatus} and never ran, so there is nothing ` +
            'of it to retry.' +
            (state.pushStatus === 'failed' || state.pushStatus === 'cancelled'
              ? ` To run it anyway, re-queue the stage itself: ` +
                `POST /import/runs/${runId}/stages/${state.pushStageId}/retry (History → Retry).`
              : ''),
        );
      }

      // Both lanes: `pushEntities` marks a staged entity `failed` the same way,
      // and an unresolved person costs every record that names them.
      const items = await this.resetFailedRows(manager, 'staged_items', runId);
      const entities = await this.resetFailedRows(manager, 'staged_entities', runId);

      // A push that RAN and left something undone is re-driven even when no row
      // was marked failed: rows still `pending` (the database stayed away past
      // PushStage's wait, or crashed under it, and the stage failed), or a
      // stage that failed after every row settled (it died in the close-out).
      // Leaving the second alone answered "nothing to retry" about a run that
      // stayed `failed`.
      const unfinishedPush =
        state.pushStageId != null && (state.hadPending || state.pushStatus !== 'completed');

      if (items + entities === 0 && !unfinishedPush) {
        return { items, entities, stageId: null, append: false };
      }

      if (state.pushStageId == null) {
        // Appended after commit: `startPush` takes this same row lock itself.
        return { items, entities, stageId: null, append: true };
      }

      if (!(await this.reopenPushStage(manager, runId, state.pushStageId))) {
        // Moved between the read above and now — `retryStage` re-queued it, or
        // a worker claimed what that re-queued. Throwing rolls the row reset
        // back with it: a push that is about to run needs no help from here.
        throw new ConflictException(
          `Import run ${runId}'s push stage changed while this retry was running ` +
            '(another retry, or a worker picking it up). Nothing was reset; look at the run again.',
        );
      }

      return { items, entities, stageId: state.pushStageId, append: false };
    });

    if (plan == null) {
      return null;
    }

    let requeued = false;

    if (plan.stageId != null) {
      // The run finished at percent = 100 and the reopen alone would leave that
      // stale — the same reason startPush refreshes before enqueueing.
      await this.refreshRunRollup(plan.stageId);
      await this.enqueueStage(ctx.userId, runId, { id: plan.stageId, kind: 'push' });
      requeued = true;
    } else if (plan.append) {
      requeued = (await this.startPush(ctx, { runIds: [runId] })).length > 0;
    }

    if (requeued || plan.items + plan.entities > 0) {
      this.logger.log('Re-queued failed push rows', {
        runId,
        userId: ctx.userId,
        items: plan.items,
        entities: plan.entities,
        requeued,
      });
    }

    return { items: plan.items, entities: plan.entities, requeued };
  }

  /**
   * Move one staging table's `failed` rows back to `pending`, clearing the
   * error so a second failure records its own reason rather than the first's.
   *
   * The table name is interpolated because it is a literal from this method's
   * two call sites and Postgres takes no parameter in that position; the run id
   * — the only caller-influenced value — is bound.
   */
  private async resetFailedRows(
    manager: EntityManager,
    table: 'staged_items' | 'staged_entities',
    runId: string,
  ): Promise<number> {
    // CTE-wrapped so the outer command is a SELECT — see the note on the claim
    // in `startRun`; a bare UPDATE resolves as `[rows, rowCount]` here.
    const rows = await manager.query<Array<{ id: string }>>(
      `WITH reset AS (
         UPDATE ci_import.${table}
            SET push_status = 'pending', push_error = NULL, pushed_at = NULL
          WHERE run_id = $1::uuid AND push_status = 'failed'
      RETURNING id)
       SELECT id FROM reset`,
      [runId],
    );

    return rows.length;
  }

  /**
   * Make the run's push stage runnable again and reopen the run around it —
   * provided the stage is still in a state `retryFailedPush` re-drives (ended,
   * or abandoned `running`). Returns false, having changed nothing, when it is
   * not.
   *
   * The LAST push stage by seq, because a run can accumulate more than one —
   * the deferred Sync appends its own. Re-queued rather than appended: a second
   * stage row for the same work would double the weight the rollup divides by
   * and leave the bar reading half done over a finished import.
   *
   * Reopening the run (`finished_at` NULL) is what makes {@link finishRun}
   * close it again when the push completes, recomputing `completed` /
   * `partial` from what the new attempt recorded.
   */
  private async reopenPushStage(manager: EntityManager, runId: string, stageId: string): Promise<boolean> {
    // Guarded on the stages retryFailedPush agreed to re-drive — ended, or
    // abandoned `running` in a finished run — because `retryStage` and a
    // claiming worker do not take the run lock this runs under, and without
    // the guard this could flip a stage a worker had JUST claimed back to
    // `queued` for a second worker to claim. `updated_at` is bumped so the
    // recovery sweep reads the re-queued stage as fresh, not as a job lost ten
    // minutes ago that needs another enqueue. The claim is cleared, so a worker
    // still holding an abandoned `running` push is fenced out (see claimStage).
    const requeued = await manager.query<Array<{ id: string }>>(
      `WITH requeued AS (
         UPDATE ci_import.import_stages
            SET status = 'queued', error = NULL, started_at = NULL, finished_at = NULL,
                processed = 0, duration_ms = NULL, updated_at = now(),
                claim_token = NULL, claim_job_id = NULL, claim_queue = NULL
          WHERE id = $1::uuid
            AND (status IN ('completed', 'failed')
                 OR (status = 'running' AND updated_at < now() - make_interval(mins => $2::int)))
      RETURNING id)
       SELECT id FROM requeued`,
      [stageId, STALE_STAGE_MINUTES],
    );

    if (requeued.length === 0) {
      return false;
    }

    await manager.query(
      `WITH reopened AS (
         UPDATE ci_import.import_runs
            SET status = 'queued', error = NULL, finished_at = NULL
          WHERE id = $1::uuid
      RETURNING id)
       SELECT id FROM reopened`,
      [runId],
    );

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
   *
   * The boolean face of {@link claimStage}, for callers that run a stage
   * in-process and have no delivery to record or token to carry.
   */
  async beginStage(stageId: string): Promise<boolean> {
    return (await this.claimStage(stageId)) != null;
  }

  /**
   * Claim a queued stage, returning the token that proves the claim — or null
   * when the stage is not `queued` (someone else runs it, or it has finished).
   *
   * The token is minted fresh on every claim and is what FENCES the claim: pass
   * it to {@link touchStage}, {@link recordProgress}, {@link completeStage} and
   * {@link failStage}, and each of them lands only while it still matches. That
   * is what makes it safe for {@link reclaimOrphanedStages} to take a silent
   * stage back — a worker that was merely slow finds its token gone, and can no
   * longer write progress into the attempt that replaced it, complete it, fail
   * the run, or advance the pipeline behind it.
   *
   * `delivery` names the pg-boss job making the claim. Recorded so that if the
   * stage goes quiet, the reaper can fail THAT job — pg-boss then retries it in
   * place, or dead-letters it — instead of leaving it `active` for the rest of
   * a twelve-hour lease while a duplicate queues behind everything else.
   */
  async claimStage(stageId: string, delivery?: StageDelivery): Promise<string | null> {
    // CTE-wrapped — see the note on the claim in `startRun`. Without it this
    // returns `[[], 0]`, whose length is 2, and every redelivered job would
    // "win" the claim and unpack the same 40GB archive again.
    const rows = await this.dataSource.query<Array<{ claimToken: string }>>(
      `WITH claimed AS (
         UPDATE ci_import.import_stages
            SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now(),
                claim_token = gen_random_uuid(), claim_job_id = $2::uuid, claim_queue = $3::text
          WHERE id = $1::uuid AND status = 'queued'
      RETURNING claim_token)
       SELECT claim_token AS "claimToken" FROM claimed`,
      [stageId, delivery?.jobId ?? null, delivery?.queue ?? null],
    );

    if (rows.length === 0) {
      return null;
    }

    await this.dataSource.query(
      `UPDATE ci_import.import_runs
          SET status = 'running', started_at = COALESCE(started_at, now())
        WHERE id = (SELECT run_id FROM ci_import.import_stages WHERE id = $1::uuid)
          AND finished_at IS NULL`,
      [stageId],
    );

    return rows[0].claimToken;
  }

  /**
   * Update a running stage's counters. Also refreshes the run's percent cache.
   *
   * With `claimToken`, the write is fenced (see {@link claimStage}) and the
   * return value says whether it landed: false means the claim is gone and the
   * caller no longer owns this stage. Without one — the in-process connector
   * path — it writes unconditionally, as it always has.
   */
  async recordProgress(
    stageId: string,
    update: { processed: number; total?: number | null; phase?: string },
    claimToken?: string,
  ): Promise<boolean> {
    // CTE-wrapped so the fence can be read back — see the note on the claim in
    // `startRun`.
    const rows = await this.dataSource.query<unknown[]>(
      // Every parameter cast, and `$2` cast at BOTH sites. It feeds `processed`
      // (bigint) and a division (double precision), and Postgres will not deduce
      // one type for a parameter used two ways — it raises "inconsistent types
      // deduced for parameter $2" on the first tick, which killed the unpack
      // stage the moment it reported progress. Same fault as `completeStage`;
      // this statement was simply never exercised.
      `WITH progressed AS (
         UPDATE ci_import.import_stages
            SET processed = $2::bigint,
                total = COALESCE($3::bigint, total),
                phase = COALESCE($4::text, phase),
                updated_at = now(),
                items_per_sec = CASE
                  WHEN started_at IS NULL THEN items_per_sec
                  WHEN EXTRACT(EPOCH FROM (now() - started_at)) <= 0 THEN items_per_sec
                  ELSE $2::double precision / EXTRACT(EPOCH FROM (now() - started_at))
                END
          WHERE id = $1::uuid
            AND ($5::uuid IS NULL OR claim_token = $5::uuid)
      RETURNING id)
       SELECT id FROM progressed`,
      [stageId, update.processed, update.total ?? null, update.phase ?? null, claimToken ?? null],
    );

    if (rows.length === 0) {
      return false;
    }

    await this.refreshRunRollup(stageId);

    return true;
  }

  /**
   * Finish a stage that did its work, wholly or partly.
   *
   * Fenced by `claimToken` when one is given (see {@link claimStage}); false
   * means the claim was taken back before the work finished, so this result is
   * not the stage's and the caller must not advance the run on it.
   */
  async completeStage(stageId: string, outcome: StageOutcome, claimToken?: string): Promise<boolean> {
    // `outcome.partial` is a SIBLING of `detail` on `StageOutcome` (see
    // types.ts) — but `detail` is the only part of the outcome that survives
    // past this call, and `finishRun` rolls a run up to `partial` by reading
    // `detail.partial` off the persisted stage row. Folded in here, once,
    // rather than asking every stage runner to nest it inside its own
    // `detail` object — which is what let this drift silently: nothing wired
    // the sibling field to the nested key `finishRun` actually reads, so no
    // stage's `partial: true` ever reached it.
    const detail = { ...(outcome.detail ?? {}), partial: outcome.partial === true };

    const rows = await this.dataSource.query<unknown[]>(
      // Every parameter cast explicitly: `$2` feeds both `processed` and the
      // COALESCE for `total`, and Postgres refuses to deduce one type for a
      // parameter used in two positions ("inconsistent types deduced").
      //
      // The claim ends here, so its token goes with it: a heartbeat or a
      // throttled progress tick that fires after completion is fenced out
      // rather than rewriting a finished stage's counters.
      `WITH completed AS (
         UPDATE ci_import.import_stages
            SET status = 'completed',
                updated_at = now(),
                processed = $2::bigint,
                total = COALESCE($3::bigint, $2::bigint),
                detail = $4::jsonb,
                finished_at = now(),
                claim_token = NULL,
                duration_ms = CASE
                  WHEN started_at IS NULL THEN duration_ms
                  ELSE (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::bigint
                END
          WHERE id = $1::uuid
            AND ($5::uuid IS NULL OR claim_token = $5::uuid)
      RETURNING id)
       SELECT id FROM completed`,
      [stageId, outcome.processed, outcome.total, JSON.stringify(detail), claimToken ?? null],
    );

    if (rows.length === 0) {
      return false;
    }

    await this.refreshRunRollup(stageId);

    return true;
  }

  /**
   * Fail a stage, and with it the run.
   *
   * `failure` is the same facts as `error`, as FIELDS. The message is what a
   * person reads in a list and greps a log for; the structured half is what an
   * agent reads without regexing prose, and it survives being copied out of the
   * row. Merged into the stage's existing `detail` under
   * `summary.failure` — the same key {@link StageSummary} uses — so a reader
   * has one place to look whether the stage completed or died. jsonb_set with
   * `create_missing` builds the path on a stage whose detail is still `{}`,
   * which is every stage that failed before producing anything.
   *
   * The failure's `phase` also becomes the stage's own, so the row says where
   * the stage stopped and agrees with the `phase=` the error line carries. An
   * unpack that failed while extracting used to read "acquiring" next to an
   * error saying `phase=extracting`, because the listener's progress throttle
   * had dropped the `extracting` write (it no longer drops phase changes). No
   * failure, or one whose phase is missing or empty, leaves the column as it
   * was.
   *
   * Fenced by `claimToken` when one is given (see {@link claimStage}). False
   * means the claim was taken back first: the failure belongs to an attempt
   * that no longer owns the stage, so neither the stage nor the run is failed
   * on its account — the attempt that replaced it decides how this ends.
   */
  async failStage(
    stageId: string,
    error: string,
    failure?: StageFailureContext,
    claimToken?: string,
  ): Promise<boolean> {
    // CTE-wrapped so the fence can be read back — see the note on the claim in
    // `startRun`. The claim ends here, so its token is cleared with it.
    const failed = await this.dataSource.query<unknown[]>(
      `WITH failed AS (
         UPDATE ci_import.import_stages
            SET status = 'failed', error = $2, finished_at = now(), updated_at = now(),
                claim_token = NULL,
                phase = COALESCE(NULLIF($3::jsonb->>'phase', ''), phase),
                detail = CASE
                  WHEN $3::jsonb IS NULL THEN detail
                  ELSE jsonb_set(
                    jsonb_set(COALESCE(detail, '{}'::jsonb), '{summary}',
                              COALESCE(detail->'summary', '{}'::jsonb), true),
                    '{summary,failure}', $3::jsonb, true)
                END
          WHERE id = $1::uuid
            AND ($4::uuid IS NULL OR claim_token = $4::uuid)
      RETURNING id)
       SELECT id FROM failed`,
      [stageId, error, failure == null ? null : JSON.stringify(failure), claimToken ?? null],
    );

    if (claimToken != null && failed.length === 0) {
      return false;
    }

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

    return true;
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
   * Does this run still hold bytes on disk that nothing has stored?
   *
   * The invariant that makes losing an archive's media impossible rather than
   * merely unlikely. `MediaStage` is what stamps `FileId` (or `FileMediaError`)
   * onto a staged row; until one of those is present, the row's bytes exist
   * ONLY inside the run's scratch tree. Reclaiming that tree while any such row
   * remains destroys them with no way back — which is exactly what happened to
   * every wizard import, because the wizard requested `[unpack, parse]` and the
   * deferred push appended a bare `push`, so `media` never ran.
   *
   * Asked at reclaim time rather than trusted from the stage list, because the
   * stage list is configuration and this is the thing configuration must not be
   * able to get wrong. Mirrors `MediaStage.mediaPredicate()`.
   */
  async hasUnstoredMedia(runId: string): Promise<boolean> {
    const [row] = (await this.dataSource.query(
      `SELECT ${unstoredMediaExistsSql('$1::uuid', '$2')} AS pending`,
      [runId, [...FILE_CLASSIFICATIONS]],
    )) as Array<{ pending: boolean }>;

    return row?.pending === true;
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

  /**
   * Put one stage job on ITS KIND's queue, at most once while a job for it is
   * still pending.
   *
   * TWO independent properties, both required:
   *
   * ROUTING (IMPORT_STAGE_QUEUE_BY_KIND). Stage kinds get their own queues so
   * they overlap across runs. Several callers hold only the stage id, so the
   * kind is looked up rather than demanded — routing a job to the wrong kind's
   * queue would let one kind's long job block another's slot, the exact
   * head-of-line problem the split exists to remove.
   *
   * DEDUPE (singletonKey). Within a kind's queue a stage still waits its turn,
   * and `resumeInterrupted` re-enqueues a queued stage it judges stale — judging
   * staleness from `import_stages.updated_at`, which nothing advances while a
   * stage waits. So every waiting stage crossed STALE_STAGE_MINUTES and
   * collected a fresh job on EVERY sweep, every 5 minutes, for as long as the
   * import ran: 16 distinct stages holding 107 pending jobs after 47 minutes on
   * a real 13-source import, growing linearly. The duplicates were harmless per
   * job (`beginStage` is a claim, so a redelivered job no-ops) but the growth is
   * unbounded, and it is the NORMAL case for the longest imports.
   *
   * Splitting the queues narrows the window; it does not close it, because a
   * kind's queue is still ordered and a big parse still makes its siblings wait.
   * CORRECTION: the key alone did nothing. pg-boss 10 makes de-duplication a
   * QUEUE property, and its unique index on (name, singleton_key) is partial —
   * `WHERE state='created' AND policy='short'` — while every queue here is
   * created with the default `standard` policy, under which a singletonKey is
   * stored and never enforced. `SyncOrchestrator.ts:299` already said so, and
   * `select policy from pgboss.queue` on a live appliance returned `standard`
   * for all 32. The four per-kind stage queues are now declared
   * `policy: 'short'` (ImportStageListener), which is what makes this key bite.
   * The legacy shared drain queue stays `standard`, because the deleted-stage
   * fallback below targets it without a key.
   *
   * Keying on the stage id lets pg-boss refuse the duplicate at insert time.
   * Crash recovery is unaffected: the key only suppresses a job while one is
   * pending, so once a lost job has left the queue the sweep enqueues again.
   */
  private async enqueueStage(
    userId: string,
    runId: string,
    stage: Pick<ImportStage, 'id'> & { kind?: ImportStageKindName },
  ): Promise<void> {
    let kind = stage.kind;

    if (kind == null) {
      const rows = await this.dataSource.query<Array<{ kind: ImportStageKindName }>>(
        `SELECT kind FROM ci_import.import_stages WHERE id = $1::uuid`,
        [stage.id],
      );

      kind = rows[0]?.kind;
    }

    await this.eventService.send(
      ImportStageEvent,
      { runId, stageId: stage.id, userId },
      // An unknown kind (a deleted stage racing the enqueue) falls back to the
      // legacy shared queue, which still drains — never dropped on the floor.
      {
        queue: kind != null ? IMPORT_STAGE_QUEUE_BY_KIND[kind] : IMPORT_QUEUE,
        singletonKey: stage.id,
      },
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
