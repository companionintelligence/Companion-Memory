import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { retryOnTransientDatabaseError, type TransientRetryPolicy } from '@ci/common/persistence';
import { serves } from '@ci/common/roles';
import { Cron } from '@ci/common/schedule';
import { OnEvent, type Acknowledgement } from '@ci/domains/events';

import {
  IMPORT_QUEUE,
  IMPORT_QUEUE_OPTIONS,
  IMPORT_STAGE_HEARTBEAT_SECONDS,
  IMPORT_STAGE_QUEUE_BY_KIND,
  IMPORT_STAGE_QUEUE_OPTIONS,
} from '../constants';
import type { ImportStage } from '../entities/ImportStageEntity';
import { ImportStageEvent } from '../events';
import { ImportRunService, type StageDelivery } from '../services/ImportRunService';
import { ImportScratchService } from '../services/ImportScratchService';
import { MediaStage } from '../stages/MediaStage';
import { ParseStage } from '../stages/ParseStage';
import { PushStage } from '../stages/PushStage';
import { UnpackStage } from '../stages/UnpackStage';
import { describeStageFailure, stageFailureContext } from '../telemetry/stageError';
import type { StageFailureContext } from '../telemetry/stageSummary';
import { importStagePayloadSchema, type ImportStageRunner, type StageRunContext } from '../types';

/** Minimum gap between progress writes, whatever a runner asks for. */
const PROGRESS_THROTTLE_MS = 1_000;

/**
 * How often a running stage's claim is refreshed while a runner is inside it —
 * see {@link IMPORT_STAGE_HEARTBEAT_SECONDS}, which the stalled and orphan
 * thresholds are multiples of.
 */
const STAGE_HEARTBEAT_MS = IMPORT_STAGE_HEARTBEAT_SECONDS * 1_000;

/**
 * The recovery sweep's cadence — second 30, every fifth minute, offset from
 * the drop purge. Recovery is periodic rather than boot-only so a crashed
 * stage is picked up within staleness-plus-a-tick even when nothing restarts.
 */
const RESUME_SWEEP_CRON = '30 */5 * * * *';

/**
 * The orphan reaper's cadence — second 15 of every minute, clear of the sweep
 * above (second 30) and of the crons that pile up on second 0. Every minute
 * because it bounds how long a dead worker's stage waits past the orphan
 * window; the query behind it reads a partial index of the handful of running
 * stages, so the tick costs next to nothing when there is nothing to find.
 */
const ORPHAN_REAP_CRON = '15 * * * * *';

/**
 * How one delivery of a stage job ended, as far as its queue is concerned.
 *
 *  - `ran` — this delivery owned the stage and saw it through. (A failure
 *    throws instead, so pg-boss records it.)
 *  - `skipped` — nothing to do: the stage was gone, its run finished, someone
 *    else owned it, or it was refused. The job is done.
 *  - `superseded` — this delivery owned the stage and LOST it: the orphan
 *    reaper took it back from a worker it judged dead, and handed the job back
 *    to pg-boss. Neither completing nor failing the job is this delivery's
 *    call any more — pg-boss re-uses the job id for its retry, so an ack from
 *    here would land on the attempt that replaced this one.
 */
export type StageDeliveryOutcome = 'ran' | 'skipped' | 'superseded';

/**
 * Thrown out of a runner's `progress` callback once its claim is gone, so the
 * runner stops at its next report instead of finishing work that is no longer
 * its to finish. A runner that swallows it is still harmless: its completion
 * is fenced by the same claim token, and cannot land.
 */
export class StageClaimLostError extends Error {
  constructor(readonly stageId: string) {
    super(`Import stage ${stageId} was reclaimed from this worker; stopping`);
    this.name = 'StageClaimLostError';
  }
}

/**
 * How long the worker waits for the database to come back so it can RECORD a
 * stage failure.
 *
 * A failure that is not recorded leaves the stage `running`, and the recovery
 * sweep reclaims a `running` stage once it has been silent for
 * `STALE_STAGE_MINUTES` and runs it again — the very automatic retry
 * "failure is recorded, not retried" rules out. The failure most likely to meet
 * a database that is away is the one the database caused: a push stage fails
 * with `DatabaseCrashedDuringPushError` the moment Postgres crashes under it,
 * and the first thing that happens next is this write, against a server in
 * crash recovery. Left unrecorded, a push whose write crashes the database
 * would crash it again every sweep, forever.
 *
 * So the record waits — longer than the push's own three minutes, because
 * holding a worker slot costs nothing while the database is away and giving up
 * costs a re-run — and through a crash as well as a not-ready server: it is
 * bookkeeping on the run's own rows (UPDATEs by id, the claim release, the
 * percent rollup), which cannot be what crashed anything and
 * lands the same however often it is repeated. The heartbeat keeps
 * touching the stage meanwhile, so the sweep does not reclaim it under the
 * wait. Past the budget the failure is logged unrecorded and the sweep's
 * staleness rule applies as before.
 */
const STAGE_FAILURE_RECORD_RETRY: TransientRetryPolicy = {
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  budgetMs: 10 * 60_000,
  resendAfterCrash: true,
};

/**
 * THE worker. One class runs every stage kind that will ever exist.
 *
 * A stage kind supplies `run(context) -> StageOutcome` and nothing else. Claiming
 * the row, the scratch directory, progress bookkeeping, advancing the run and
 * recording failure are handled here, once — the same shape
 * `PipelineSliceListener` uses, and for the same reason: the alternative is a
 * listener per kind, and they drift because nothing forces them to agree.
 *
 * ## Failure is recorded, not retried
 *
 * A throw fails the stage and the run, and is then rethrown so pg-boss's retry
 * and dead-letter machinery still applies. The retry is deliberately a no-op:
 * {@link ImportRunService.beginStage} only moves a `queued` stage, so a
 * redelivered job for a stage now marked `failed` logs and returns. That is the
 * intended behaviour, not an oversight — silently re-running a 40GB unpack
 * because object storage blipped is expensive and surprising, and the operator
 * still gets the dead letter. Re-running a failed stage is a user action, which
 * the import API surfaces.
 *
 * It holds only if the failure is actually RECORDED: a stage left `running`
 * is what the recovery sweep re-runs. So recording it waits out a database
 * that is away — see {@link STAGE_FAILURE_RECORD_RETRY} — which matters most
 * for a push that failed because the database crashed under it, and would
 * otherwise crash it again on every sweep.
 *
 * ## A worker that dies is retried, not waited out
 *
 * The one retry that IS real is a stage whose worker vanished mid-run — a
 * restart, a crash, an OOM kill. Its claim goes silent, and within
 * `IMPORT_STAGE_ORPHAN_SECONDS` the orphan reaper (every minute, and at boot)
 * takes the stage back and fails its job through pg-boss, which retries it in
 * place — see `ImportRunService.reclaimOrphanedStages`. This class's part in
 * that is threefold:
 *
 *  - it records WHICH delivery claimed the stage ({@link runStage} passes the
 *    job id and queue to `claimStage`), which is what the reaper fails;
 *  - it tells the reaper which stages THIS process is running
 *    ({@link liveClaims}), and those are never taken back — a process knows
 *    its own work is alive, however long a parser blocked its event loop;
 *  - and it honours the claim token. Heartbeats and progress writes are fenced
 *    on it, so a worker that was only slow learns it lost the stage, stops at
 *    its next progress report, and acknowledges its delivery with `defer`
 *    rather than completing a job pg-boss has already re-issued.
 */
@Injectable()
export class ImportStageListener implements OnApplicationBootstrap {
  private readonly runners: Map<string, ImportStageRunner>;

  /**
   * Stage id → claim token, for every stage this process is running right now.
   *
   * Handed to the reaper and the sweep as the stages they must not touch. Keyed
   * by stage rather than by delivery, and only ever cleared by the claim that
   * set it: after a takeover a retried delivery can land in this same process
   * while the superseded runner is still winding down, and the loser's cleanup
   * must not erase the winner's entry.
   */
  private readonly liveClaims = new Map<string, string>();

  /**
   * How long to wait out an absent database to record a failure — see
   * {@link STAGE_FAILURE_RECORD_RETRY}. A property so a test can hand it a
   * clock that does not really sleep.
   */
  failureRecordRetry: TransientRetryPolicy = STAGE_FAILURE_RECORD_RETRY;

  constructor(
    private readonly runs: ImportRunService,
    private readonly scratch: ImportScratchService,
    unpackStage: UnpackStage,
    parseStage: ParseStage,
    mediaStage: MediaStage,
    pushStage: PushStage,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ImportStageListener.name);
    this.runners = new Map([
      [unpackStage.kind, unpackStage as ImportStageRunner],
      [parseStage.kind, parseStage as ImportStageRunner],
      [mediaStage.kind, mediaStage as ImportStageRunner],
      [pushStage.kind, pushStage as ImportStageRunner],
    ]);
  }

  /**
   * Crash recovery at boot — the common case: the appliance restarted, and
   * whatever was running when it went down is long stale by the time it is
   * back. Anything more recent (or a claim some still-living process holds —
   * a dev restart can leak one) is left for the periodic sweep, which applies
   * the same staleness gates. See {@link ImportRunService.resumeInterrupted}.
   *
   * A recovery failure is logged, never thrown — a boot that dies because it
   * could not resume yesterday's import would turn one stuck run into an
   * appliance that cannot start.
   */
  async onApplicationBootstrap(): Promise<void> {
    // Only the process that RUNS stages recovers them: two processes racing
    // resumeInterrupted() over the same runs is the split topology's one
    // actively harmful duplicate.
    if (!serves('worker')) {
      return;
    }

    await this.sweep();
  }

  /** The same sweep, on a clock, so recovery does not depend on a reboot. */
  @Cron(RESUME_SWEEP_CRON, { name: 'ImportStageListener.sweepOnSchedule', role: 'worker' })
  async sweepOnSchedule(): Promise<void> {
    await this.sweep();
  }

  /**
   * The orphan reaper alone, every minute: a stage whose pg-boss worker went
   * silent is taken back and its job failed, so pg-boss retries it in place —
   * about four minutes after the worker died, where the five-minute sweep's
   * ten-minute rule took twelve and re-ran the stage behind a new job. The full
   * sweep above runs the same pass first thing, so boot gets it too.
   *
   * `exclusive`: a tick landing on one still in progress would only re-read
   * the same candidates, and every take is fenced anyway.
   */
  @Cron(ORPHAN_REAP_CRON, {
    name: 'ImportStageListener.reapOrphansOnSchedule',
    role: 'worker',
    exclusive: true,
  })
  async reapOrphansOnSchedule(): Promise<void> {
    try {
      await this.runs.reclaimOrphanedStages({ liveStageIds: [...this.liveClaims.keys()] });
    } catch (err) {
      // Sentence first, error second — see `sweep`.
      this.logger.error('Could not reclaim orphaned import stages', err as Error);
    }
  }

  private async sweep(): Promise<void> {
    try {
      await this.runs.resumeInterrupted({ liveStageIds: [...this.liveClaims.keys()] });
    } catch (err) {
      // Sentence first, error second. `LoggerService.resolveArgs` takes a
      // leading Error as the message and pushes the second argument under
      // `data`, so the reversed shape logs the raw error text as `msg` and
      // buries the sentence in `data.message` — which is a recovery failure
      // that greps differently from every other failure in this domain.
      this.logger.error('Could not resume interrupted import runs', err as Error);
    }
  }

  // One queue PER STAGE KIND, each with its own slot count (see
  // IMPORT_STAGE_CONCURRENCY for why each kind has the number it has), so the
  // pipeline overlaps across runs: a 350GB unpack holding its slot for an
  // hour no longer head-of-line-blocks twenty-one small runs' parses and
  // pushes. A run's own stages still execute strictly in order — each stage
  // enqueues its successor on completion.
  //
  // Within a kind the discipline is unchanged: parse remains ONE at a time,
  // appliance-wide, because a parse is long stretches of synchronous parser
  // work plus a firehose of staged-row writes — six abreast (the global
  // per-queue default) starved the event loop and the connection pool until
  // Skip on an onboarding page hung.
  // `role: 'worker'`: stage jobs run in the headless worker process (when a
  // deployment splits roles), so a parser's synchronous stretches cannot
  // stutter the web process serving buttons.
  //
  // `autoAcknowledge: false` because a stage delivery can end three ways, not
  // two — see StageDeliveryOutcome and `deliver`.
  @OnEvent(ImportStageEvent, {
    queue: IMPORT_STAGE_QUEUE_BY_KIND.unpack,
    queueOptions: IMPORT_STAGE_QUEUE_OPTIONS.unpack,
    autoAcknowledge: false,
  })
  async handleUnpackStage(payload: unknown, ack?: Acknowledgement): Promise<void> {
    await this.deliver(IMPORT_STAGE_QUEUE_BY_KIND.unpack, payload, ack);
  }

  @OnEvent(ImportStageEvent, {
    queue: IMPORT_STAGE_QUEUE_BY_KIND.parse,
    queueOptions: IMPORT_STAGE_QUEUE_OPTIONS.parse,
    autoAcknowledge: false,
  })
  async handleParseStage(payload: unknown, ack?: Acknowledgement): Promise<void> {
    await this.deliver(IMPORT_STAGE_QUEUE_BY_KIND.parse, payload, ack);
  }

  @OnEvent(ImportStageEvent, {
    queue: IMPORT_STAGE_QUEUE_BY_KIND.media,
    queueOptions: IMPORT_STAGE_QUEUE_OPTIONS.media,
    autoAcknowledge: false,
  })
  async handleMediaStage(payload: unknown, ack?: Acknowledgement): Promise<void> {
    await this.deliver(IMPORT_STAGE_QUEUE_BY_KIND.media, payload, ack);
  }

  @OnEvent(ImportStageEvent, {
    queue: IMPORT_STAGE_QUEUE_BY_KIND.push,
    queueOptions: IMPORT_STAGE_QUEUE_OPTIONS.push,
    autoAcknowledge: false,
  })
  async handlePushStage(payload: unknown, ack?: Acknowledgement): Promise<void> {
    await this.deliver(IMPORT_STAGE_QUEUE_BY_KIND.push, payload, ack);
  }

  // The pre-split shared queue, kept as a DRAIN: jobs are durable, and a
  // restart across this change must still consume whatever the previous
  // process left queued under the old name. New enqueues never target it
  // (except the deleted-stage fallback in enqueueStage); once a deployment
  // has drained it this handler is removable.
  @OnEvent(ImportStageEvent, {
    queue: IMPORT_QUEUE,
    queueOptions: IMPORT_QUEUE_OPTIONS,
    autoAcknowledge: false,
  })
  async handleStage(payload: unknown, ack?: Acknowledgement): Promise<void> {
    await this.deliver(IMPORT_QUEUE, payload, ack);
  }

  /**
   * Run one delivery and tell its queue how it ended.
   *
   * `ran`/`skipped` complete the job and a throw fails it — what the automatic
   * acknowledgement did for these handlers until now. The third ending is why
   * they acknowledge by hand: a `superseded` delivery DEFERS, which releases its
   * worker slot and leaves the job alone. The reaper already failed that job
   * through pg-boss, which re-issues it under the SAME id; completing it from
   * here would mark the replacement attempt done while it is still running.
   *
   * With no `ack` (a direct call) the outcome is simply returned, and a
   * failure rethrown — the same contract the automatic wrapper keeps.
   */
  private async deliver(queue: string, payload: unknown, ack?: Acknowledgement): Promise<void> {
    let outcome: StageDeliveryOutcome;

    try {
      outcome = await this.runStage(payload, ack == null ? undefined : { jobId: ack.jobId, queue });
    } catch (err) {
      if (ack == null) {
        throw err;
      }

      ack.fail(err);

      return;
    }

    if (outcome === 'superseded') {
      ack?.defer();
    } else {
      ack?.done();
    }
  }

  /**
   * Run one stage.
   *
   * Public so a test can drive a stage without a queue. `delivery` is the job
   * carrying it, recorded on the claim so the orphan reaper can hand that job
   * back to pg-boss if this worker goes silent; absent in a direct call.
   */
  async runStage(rawPayload: unknown, delivery?: StageDelivery): Promise<StageDeliveryOutcome> {
    // Parsed, not cast: this came out of `pgboss.job.data`, written by some
    // earlier release of this code or by a replayed dead letter.
    const payload = importStagePayloadSchema.parse(rawPayload);

    const stage = await this.runs.getStage(payload.stageId);

    if (stage == null || stage.runId !== payload.runId) {
      // The run was deleted — which cascades its stages — while this job sat in
      // the queue. Nothing to do and nothing wrong; deleting a run IS the
      // cleanup operation.
      this.logger.debug('Stage no longer exists; dropping the job', payload);

      return 'skipped';
    }

    // The stage row is the authority on whose import this is; the payload is a
    // convenience copy written when the job was enqueued. A disagreement means
    // a hand-edited or replayed job, and running it would stage one account's
    // archive under another's user id — every row this pipeline writes carries
    // `payload.userId`. Refused rather than corrected, because there is no
    // reading of a mismatch under which the work should proceed.
    if (!(await this.runs.runBelongsTo(payload.runId, payload.userId))) {
      await this.runs.failStage(
        stage.id,
        'The stage job names a different user than the run it points at; refusing to run it',
      );

      this.logger.error(new Error('Import stage payload user does not match its run'), {
        runId: payload.runId,
        stageId: stage.id,
        payloadUserId: payload.userId,
      });

      return 'skipped';
    }

    if (await this.runs.isFinished(payload.runId)) {
      this.logger.log('Run already finished; not starting its stage', {
        runId: payload.runId,
        stageId: payload.stageId,
        kind: stage.kind,
      });

      return 'skipped';
    }

    const runner = this.runners.get(stage.kind);

    if (runner == null) {
      await this.runs.failStage(
        stage.id,
        `No runner is registered for the '${stage.kind}' stage in this build`,
      );

      return 'skipped';
    }

    // The claim. A redelivered job whose stage is already running (or finished)
    // stops here rather than doing the work twice. The token it returns fences
    // every write below — see ImportRunService.claimStage.
    const claimToken = await this.runs.claimStage(stage.id, delivery);

    if (claimToken == null) {
      this.logger.log('Stage was already claimed; leaving it to its owner', {
        runId: payload.runId,
        stageId: stage.id,
        status: stage.status,
      });

      return 'skipped';
    }

    this.liveClaims.set(stage.id, claimToken);

    // Whether this worker still owns the stage. Flipped by a fenced heartbeat or
    // progress write that finds the token gone — the orphan reaper decided this
    // worker was dead and handed the stage to a retry. Logged once, when it is
    // first noticed, because it is the line that explains everything after it.
    let claimLost = false;
    let claimEnded = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    const loseClaim = () => {
      if (claimLost || claimEnded) {
        return;
      }

      claimLost = true;
      this.logger.warn(
        'This worker lost its import stage to the orphan reaper; stopping at the next checkpoint',
        { runId: payload.runId, stageId: stage.id, kind: stage.kind },
      );
    };

    // The claim is OVER: completed under this token, which the completion
    // cleared. A beat landing after that — during `advance`, or a scratch
    // reclaim of tens of gigabytes — would miss the fence and read as a
    // takeover that never happened, so the pulse stops here and nothing this
    // worker observes afterwards can mean it lost the stage.
    const endClaim = () => {
      claimEnded = true;
      clearInterval(heartbeat);
    };

    try {
      const scratchDir = await this.scratch.ensureDir(payload.userId, payload.runId);

      // The claim's pulse. Progress writes keep the stage fresh while work
      // moves; this covers the silent stretches, so the reaper and the sweep can
      // read staleness as death. Fenced by the claim token, so a beat that
      // fires after completion is a no-op — and a beat that finds the token
      // gone is how this worker learns the stage was taken back from it, even
      // while its runner is deep in a parser and reporting nothing.
      heartbeat = setInterval(() => {
        this.runs
          .touchStage(stage.id, claimToken)
          .then((held) => {
            if (!held) {
              loseClaim();
            }
          })
          .catch(() => undefined);
      }, STAGE_HEARTBEAT_MS);

      return await this.runClaimed(payload, stage, runner, scratchDir, claimToken, {
        isLost: () => claimLost,
        lose: loseClaim,
        end: endClaim,
      });
    } finally {
      clearInterval(heartbeat);

      // Only the claim that set the entry clears it — see `liveClaims`.
      if (this.liveClaims.get(stage.id) === claimToken) {
        this.liveClaims.delete(stage.id);
      }
    }
  }

  /**
   * The claimed half of {@link runStage}: run it, then complete and advance —
   * or record the failure — all under the claim token.
   */
  private async runClaimed(
    payload: { userId: string; runId: string },
    stage: ImportStage,
    runner: ImportStageRunner,
    scratchDir: string,
    claimToken: string,
    claim: { isLost: () => boolean; lose: () => void; end: () => void },
  ): Promise<StageDeliveryOutcome> {
    let completed = false;

    try {
      const outcome = await runner.run(this.contextFor(payload, stage.id, scratchDir, claimToken, claim));

      // Fenced: a result from an attempt that was taken back is not the
      // stage's result, and must not advance the run — the attempt that
      // replaced it is running the same stage, and advancing here would start
      // the NEXT stage on top of it.
      if (!(await this.runs.completeStage(stage.id, outcome, claimToken))) {
        claim.lose();

        return this.endSuperseded(payload, stage, 'completion');
      }

      completed = true;
      claim.end();

      const next = await this.runs.advance(payload.userId, payload.runId, stage.seq);

      if (next == null) {
        // Last stage: the tree has done its job. Reclaimed here rather than on a
        // sweep because these directories hold tens of gigabytes and nothing
        // else knows the run is over.
        //
        // Unless nothing was pulled out of it. `UnpackStage` acquires by rename,
        // so for an inbox unit this tree is not a copy — it is the user's only
        // one. A run that recognized no data source still closes as `partial`
        // (ParseStage calls that an honest report, not a failure), and deleting
        // here on that path is an unrecoverable loss of data the appliance was
        // handed. Keeping tens of gigabytes costs disk; the alternative costs
        // the archive.
        //
        // And not while any staged row's bytes are still only here. A media row
        // that never reached MediaStage has its photo/video/voicemail in this
        // tree and nowhere else; deleting it leaves a content row pointing at a
        // file that does not exist, unrecoverably. Checked against the rows
        // rather than the run's stage list, because a run whose stages omit
        // `media` is precisely the case that lost the bytes.
        const unstoredMedia = await this.runs.hasUnstoredMedia(payload.runId);

        if (!(await this.runs.pulledRecords(payload.runId))) {
          this.logger.warn('Import staged no records; keeping its scratch tree rather than reclaiming it', {
            runId: payload.runId,
            userId: payload.userId,
            scratchDir,
          });
        } else if (unstoredMedia) {
          this.logger.warn(
            'Import still holds media whose bytes were never stored; keeping its scratch tree. ' +
              'Run the media stage for this run before the tree is reclaimed.',
            { runId: payload.runId, userId: payload.userId, scratchDir },
          );
        } else {
          await this.scratch.reclaim(payload.userId, payload.runId);
        }
      }

      this.logger.log('Completed import stage', {
        runId: payload.runId,
        stageId: stage.id,
        kind: stage.kind,
        processed: outcome.processed,
        next: next?.kind ?? null,
      });

      return 'ran';
    } catch (err) {
      // A worker that lost its stage stopped because it was told to (or failed
      // on the way out). Neither is the stage's failure: recording it would
      // fail the run under the attempt that replaced this one.
      if (!completed && (claim.isLost() || err instanceof StageClaimLostError)) {
        return this.endSuperseded(payload, stage, 'runner');
      }

      // A failure AFTER the completion landed — in `advance`, or reclaiming the
      // scratch tree — is recorded unfenced, exactly as it always was. The
      // completion ended this claim, and a completed stage is one nobody else
      // can claim, so there is no other attempt for the record to land on.
      const recorded = await this.recordFailure(payload, stage, err, completed ? undefined : claimToken);

      if (recorded === 'superseded') {
        claim.lose();

        return this.endSuperseded(payload, stage, 'failure');
      }

      // Sentence first, error under `err` beside the context it is about —
      // `LoggerService` hoists that key so pino still serializes the stack.
      // Passing the Error first instead would put its raw text in `msg` and the
      // sentence in `data.message`, which is the shape every sibling cron was
      // just moved off.
      this.logger.error('Import stage failed', {
        err,
        runId: payload.runId,
        stageId: stage.id,
        kind: stage.kind,
        failure: recorded,
      });

      // Rethrown so pg-boss records it. The retry will find the stage `failed`
      // and no-op — see the class comment.
      throw err;
    }
  }

  /**
   * Wind down an attempt whose claim is gone, and say which way it ended.
   *
   * Almost always the orphan reaper took the stage back and pg-boss re-issued
   * the job, so the delivery defers (`superseded`). The one other way a fenced
   * write can miss is the stage row itself disappearing — its run deleted,
   * which cascades. Nobody re-issued anything then, and deferring would leave
   * this job `active` for the rest of its twelve-hour lease: the very phantom
   * the reaper exists to remove. So a vanished stage completes the job like any
   * other delivery with nothing left to do. A read that fails defers, which is
   * the answer that can never land on somebody else's attempt.
   */
  private async endSuperseded(
    payload: { runId: string },
    stage: Pick<ImportStage, 'id' | 'kind'>,
    at: 'runner' | 'completion' | 'failure',
  ): Promise<StageDeliveryOutcome> {
    const current = await this.runs.getStage(stage.id).catch(() => undefined);

    if (current === null) {
      this.logger.log('Import stage vanished under its worker (its run was deleted); dropping the job', {
        runId: payload.runId,
        stageId: stage.id,
        kind: stage.kind,
      });

      return 'skipped';
    }

    this.logger.warn(
      'Import stage attempt was superseded; its result is discarded and its job left to the retry',
      {
        runId: payload.runId,
        stageId: stage.id,
        kind: stage.kind,
        at,
      },
    );

    return 'superseded';
  }

  /**
   * Record a stage failure, waiting out a database that is away — see
   * {@link STAGE_FAILURE_RECORD_RETRY}. Returns what was recorded; null when
   * the database never came back inside the wait (logged; the stage stays
   * `running` for the sweep's staleness rule); or `superseded` when the claim
   * was taken back first, so the failure was not this attempt's to record.
   *
   * Never throws: the caller rethrows the STAGE's error, which is the one
   * pg-boss and the log should carry, not whatever the bookkeeping met.
   */
  private async recordFailure(
    payload: { runId: string },
    stage: Pick<ImportStage, 'id' | 'kind'>,
    err: unknown,
    claimToken?: string,
  ): Promise<StageFailureContext | null | 'superseded'> {
    try {
      return await retryOnTransientDatabaseError(
        'recording an import stage failure',
        async () => {
          // What the stage was WORKING ON, not just what went wrong. A bare
          // `(err as Error).message` was the whole of a failed import's record:
          // on this corpus a parse failure would have been reported as "ENOENT:
          // no such file or directory" over a 703,956-item, 13-source Takeout,
          // with nothing saying which parser or which file — and the scratch
          // tree that held the answer is reclaimed with the run. See
          // telemetry/stageError.
          const phase = (await this.runs.getStage(stage.id))?.phase ?? undefined;
          const error = describeStageFailure(err, { stage: stage.kind, phase });
          const failure = stageFailureContext(err, { stage: stage.kind, phase });

          if (!(await this.runs.failStage(stage.id, error, failure, claimToken))) {
            return 'superseded' as const;
          }

          return failure;
        },
        this.failureRecordRetry,
        (notice) => {
          this.logger.warn('The database is away; waiting to record the import stage failure', {
            runId: payload.runId,
            stageId: stage.id,
            kind: stage.kind,
            attempt: notice.attempt,
            delayMs: notice.delayMs,
            waitedMs: notice.waitedMs,
            error: notice.error instanceof Error ? notice.error.message : String(notice.error),
          });
        },
      );
    } catch (recordErr) {
      this.logger.error(
        'Could not record the import stage failure; the stage stays running until the recovery sweep reclaims it',
        { err: recordErr, runId: payload.runId, stageId: stage.id, kind: stage.kind },
      );

      return null;
    }
  }

  /**
   * What a runner is handed.
   *
   * The progress callback is throttled here rather than in each runner: a parse
   * reporting per record would write a row per record for the length of a 40GB
   * import, which costs more than the parse it is describing. The final counts
   * come from `completeStage`, so a throttled-away tick loses nothing that
   * survives the stage.
   *
   * It is also where a superseded runner is STOPPED. Every write is fenced by
   * the claim token, and once the claim is gone — seen here, or by the
   * heartbeat — the callback throws {@link StageClaimLostError}, which a runner
   * that reports progress between units of work propagates out of `run()`.
   */
  private contextFor(
    payload: { userId: string; runId: string },
    stageId: string,
    scratchDir: string,
    claimToken: string,
    claim: { isLost: () => boolean; lose: () => void },
  ): StageRunContext {
    let lastWrite = 0;

    return {
      userId: payload.userId,
      runId: payload.runId,
      stageId,
      scratchDir,
      progress: async (update) => {
        if (claim.isLost()) {
          throw new StageClaimLostError(stageId);
        }

        const now = Date.now();

        if (now - lastWrite < PROGRESS_THROTTLE_MS) {
          return;
        }

        lastWrite = now;

        if (!(await this.runs.recordProgress(stageId, update, claimToken))) {
          claim.lose();

          throw new StageClaimLostError(stageId);
        }
      },
    };
  }
}
