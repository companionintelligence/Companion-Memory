import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { serves } from '@ci/common/roles';
import { Cron } from '@ci/common/schedule';
import { OnEvent } from '@ci/domains/events';

import {
  IMPORT_QUEUE,
  IMPORT_QUEUE_OPTIONS,
  IMPORT_STAGE_QUEUE_BY_KIND,
  IMPORT_STAGE_QUEUE_OPTIONS,
} from '../constants';
import { ImportStageEvent } from '../events';
import { ImportRunService } from '../services/ImportRunService';
import { ImportScratchService } from '../services/ImportScratchService';
import { MediaStage } from '../stages/MediaStage';
import { ParseStage } from '../stages/ParseStage';
import { PushStage } from '../stages/PushStage';
import { UnpackStage } from '../stages/UnpackStage';
import { describeStageFailure, stageFailureContext } from '../telemetry/stageError';
import { importStagePayloadSchema, type ImportStageRunner, type StageRunContext } from '../types';

/** Minimum gap between progress writes, whatever a runner asks for. */
const PROGRESS_THROTTLE_MS = 1_000;

/**
 * How often a running stage's claim is refreshed while a runner is inside it.
 *
 * Progress writes already touch the claim while work moves; the heartbeat is
 * for the silent stretches — a giant archive mid-extract says nothing for
 * minutes — so liveness never depends on how chatty a stage kind happens to
 * be. Well inside the sweep's staleness window.
 */
const STAGE_HEARTBEAT_MS = 30_000;

/**
 * The recovery sweep's cadence — second 30, every fifth minute, offset from
 * the drop purge. Recovery is periodic rather than boot-only so a crashed
 * stage is picked up within staleness-plus-a-tick even when nothing restarts.
 */
const RESUME_SWEEP_CRON = '30 */5 * * * *';

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
 */
@Injectable()
export class ImportStageListener implements OnApplicationBootstrap {
  private readonly runners: Map<string, ImportStageRunner>;

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

  private async sweep(): Promise<void> {
    try {
      await this.runs.resumeInterrupted();
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
  @OnEvent(ImportStageEvent, {
    queue: IMPORT_STAGE_QUEUE_BY_KIND.unpack,
    queueOptions: IMPORT_STAGE_QUEUE_OPTIONS.unpack,
  })
  async handleUnpackStage(payload: unknown): Promise<void> {
    await this.runStage(payload);
  }

  @OnEvent(ImportStageEvent, {
    queue: IMPORT_STAGE_QUEUE_BY_KIND.parse,
    queueOptions: IMPORT_STAGE_QUEUE_OPTIONS.parse,
  })
  async handleParseStage(payload: unknown): Promise<void> {
    await this.runStage(payload);
  }

  @OnEvent(ImportStageEvent, {
    queue: IMPORT_STAGE_QUEUE_BY_KIND.media,
    queueOptions: IMPORT_STAGE_QUEUE_OPTIONS.media,
  })
  async handleMediaStage(payload: unknown): Promise<void> {
    await this.runStage(payload);
  }

  @OnEvent(ImportStageEvent, {
    queue: IMPORT_STAGE_QUEUE_BY_KIND.push,
    queueOptions: IMPORT_STAGE_QUEUE_OPTIONS.push,
  })
  async handlePushStage(payload: unknown): Promise<void> {
    await this.runStage(payload);
  }

  // The pre-split shared queue, kept as a DRAIN: jobs are durable, and a
  // restart across this change must still consume whatever the previous
  // process left queued under the old name. New enqueues never target it
  // (except the deleted-stage fallback in enqueueStage); once a deployment
  // has drained it this handler is removable.
  @OnEvent(ImportStageEvent, { queue: IMPORT_QUEUE, queueOptions: IMPORT_QUEUE_OPTIONS })
  async handleStage(payload: unknown): Promise<void> {
    await this.runStage(payload);
  }

  /**
   * Run one stage.
   *
   * Public so a test can drive a stage without a queue.
   */
  async runStage(rawPayload: unknown): Promise<void> {
    // Parsed, not cast: this came out of `pgboss.job.data`, written by some
    // earlier release of this code or by a replayed dead letter.
    const payload = importStagePayloadSchema.parse(rawPayload);

    const stage = await this.runs.getStage(payload.stageId);

    if (stage == null || stage.runId !== payload.runId) {
      // The run was deleted — which cascades its stages — while this job sat in
      // the queue. Nothing to do and nothing wrong; deleting a run IS the
      // cleanup operation.
      this.logger.debug('Stage no longer exists; dropping the job', payload);

      return;
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

      return;
    }

    if (await this.runs.isFinished(payload.runId)) {
      this.logger.log('Run already finished; not starting its stage', {
        runId: payload.runId,
        stageId: payload.stageId,
        kind: stage.kind,
      });

      return;
    }

    const runner = this.runners.get(stage.kind);

    if (runner == null) {
      await this.runs.failStage(
        stage.id,
        `No runner is registered for the '${stage.kind}' stage in this build`,
      );

      return;
    }

    // The claim. A redelivered job whose stage is already running (or finished)
    // stops here rather than doing the work twice.
    if (!(await this.runs.beginStage(stage.id))) {
      this.logger.log('Stage was already claimed; leaving it to its owner', {
        runId: payload.runId,
        stageId: stage.id,
        status: stage.status,
      });

      return;
    }

    const scratchDir = await this.scratch.ensureDir(payload.userId, payload.runId);

    // The claim's pulse. Progress writes keep the stage fresh while work
    // moves; this covers the silent stretches, so the recovery sweep can read
    // staleness as death. Guarded by status = 'running' server-side, so a beat
    // that fires after completion is a no-op.
    const heartbeat = setInterval(() => {
      this.runs.touchStage(stage.id).catch(() => undefined);
    }, STAGE_HEARTBEAT_MS);

    try {
      const outcome = await runner.run(this.contextFor(payload, stage.id, scratchDir));

      await this.runs.completeStage(stage.id, outcome);

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
    } catch (err) {
      // What the stage was WORKING ON, not just what went wrong. A bare
      // `(err as Error).message` was the whole of a failed import's record: on
      // this corpus a parse failure would have been reported as "ENOENT: no
      // such file or directory" over a 703,956-item, 13-source Takeout, with
      // nothing saying which parser or which file — and the scratch tree that
      // held the answer is reclaimed with the run. See telemetry/stageError.
      const phase = (await this.runs.getStage(stage.id))?.phase ?? undefined;
      const error = describeStageFailure(err, { stage: stage.kind, phase });
      const failure = stageFailureContext(err, { stage: stage.kind, phase });

      await this.runs.failStage(stage.id, error, failure);

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
        failure,
      });

      // Rethrown so pg-boss records it. The retry will find the stage `failed`
      // and no-op — see the class comment.
      throw err;
    } finally {
      clearInterval(heartbeat);
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
   */
  private contextFor(
    payload: { userId: string; runId: string },
    stageId: string,
    scratchDir: string,
  ): StageRunContext {
    let lastWrite = 0;

    return {
      userId: payload.userId,
      runId: payload.runId,
      stageId,
      scratchDir,
      progress: async (update) => {
        const now = Date.now();

        if (now - lastWrite < PROGRESS_THROTTLE_MS) {
          return;
        }

        lastWrite = now;

        await this.runs.recordProgress(stageId, update);
      },
    };
  }
}
