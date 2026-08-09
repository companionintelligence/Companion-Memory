import { Injectable } from '@nestjs/common';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';

import { PIPELINE_QUEUES } from '../constants';
import { PipelineSliceEvent } from '../events';
import { PipelineStateService } from '../services/PipelineStateService';
import { StageRegistry } from '../services/StageRegistry';
import { pipelineSlicePayloadSchema, type Stage, type StageResult } from '../types';

/**
 * THE generic worker. One class processes every stage that will ever exist.
 *
 * The bus today carries a listener per enrichment leg — fourteen of them, each
 * with its own candidate query, its own batching, its own cursor handling, its
 * own idea of what a failure means and its own (usually absent) idea of what to
 * record when it skips something. They drifted, individually and inevitably,
 * because nothing forced them to agree. This listener is the thing that forces
 * them to agree: a stage supplies `run(ctx, ids) -> Map<id, StageResult>` and
 * nothing else, and every concern that is not "process these entities" —
 * claiming, bookkeeping, retries, dead letters, ordering — is handled here,
 * once.
 *
 * The lifecycle of a slice:
 *
 *  1. **Parse** the payload. It came from `pgboss.job.data`, so it is untrusted
 *     JSON, not a typed object.
 *  2. **Claim** the ids. Returns the subset this worker actually owns, which
 *     de-duplicates a slice that overlaps one already in flight.
 *  3. **Run** the stage over the claimed ids.
 *  4. **Record** every claimed id's outcome in one bulk upsert. Ids the stage
 *     said nothing about are recorded as failures — silence is never success.
 *  5. **On throw**, fail the claimed ids in the ledger (so they carry a reason,
 *     a retry gate and an attempt count instead of being stranded `running`),
 *     write `ci.pipeline_dead_letters`, and rethrow so pg-boss's own retry and
 *     dead-letter machinery still applies.
 */
@Injectable()
export class PipelineSliceListener {
  constructor(
    private readonly stageRegistry: StageRegistry,
    private readonly stateService: PipelineStateService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PipelineSliceListener.name);
  }

  // -------------------------------------------------------------------------
  // Queue bindings
  //
  // `EventListenerRegistry` keys handlers on `${eventName}:${queue}` and allows
  // exactly one per pair, so "one generic worker" still needs one binding per
  // queue. These three methods are the entire per-queue surface; the work is
  // identical and lives in `handleSlice`. Adding a queue is a constant plus a
  // three-line method here — deliberately more visible than a loop would be,
  // because each queue is a standing commitment of worker slots.
  // -------------------------------------------------------------------------

  @OnEvent(PipelineSliceEvent, { queue: PIPELINE_QUEUES.INDEX })
  async handleIndexSlice(payload: unknown): Promise<void> {
    await this.handleSlice(PIPELINE_QUEUES.INDEX, payload);
  }

  @OnEvent(PipelineSliceEvent, { queue: PIPELINE_QUEUES.ENRICH })
  async handleEnrichSlice(payload: unknown): Promise<void> {
    await this.handleSlice(PIPELINE_QUEUES.ENRICH, payload);
  }

  @OnEvent(PipelineSliceEvent, { queue: PIPELINE_QUEUES.EMBED })
  async handleEmbedSlice(payload: unknown): Promise<void> {
    await this.handleSlice(PIPELINE_QUEUES.EMBED, payload);
  }

  /**
   * Process one slice.
   *
   * Public so a test can run a slice without a queue.
   */
  async handleSlice(queue: string, rawPayload: unknown): Promise<void> {
    // Parsed, not cast: this came out of `pgboss.job.data`, written by some
    // earlier release of this code or by a replayed dead letter.
    //
    // Deliberately OUTSIDE the try/catch that writes `ci.pipeline_dead_letters`.
    // A payload that will not parse has no `stage` and no `entityType` to
    // record, so the row would be a shape this table cannot usefully hold. The
    // throw still reaches pg-boss, which retries and then dead-letters the job
    // with its data intact, and `DeadLetterReaperListener` copies it into the
    // same table from there — with the raw payload, which is the only version
    // worth keeping for a parse failure.
    const payload = pipelineSlicePayloadSchema.parse(rawPayload);

    // Held outside the try so the catch can fail exactly the rows this worker
    // took responsibility for — no more (they belong to someone else) and no
    // less (they would be stranded `running` until the lease expired).
    let claimedStage: Stage | null = null;
    let claimedIds: string[] = [];

    try {
      const stage = this.stageRegistry.get(payload.stage);

      // A slice that arrives on a queue its stage does not ride means the
      // dispatcher and the registry disagree. Processing it anyway would work,
      // and that is precisely the problem: the resource isolation the queue
      // split exists to provide would silently stop holding — embedding work
      // would run on the enrich queue's slots and nobody would find out until
      // chat latency moved.
      if (stage.queue !== queue) {
        throw new Error(
          `Slice for stage "${stage.id}" arrived on queue "${queue}" but the stage declares ` +
            `"${stage.queue}". Refusing to process it on the wrong resource pool.`,
        );
      }

      if (!stage.entityTypes.includes(payload.entityType)) {
        throw new Error(
          `Slice for stage "${stage.id}" carries entity type "${payload.entityType}", which the stage ` +
            `does not declare (declares: ${stage.entityTypes.join(', ')}).`,
        );
      }

      const claimed = await this.stateService.claim(stage, payload.entityType, payload.ids, payload.userId);

      if (claimed.length === 0) {
        // Every id is already being worked by a live claim. Normal under
        // overlapping sweeps, and the correct response is to do nothing: the
        // other worker owns the outcome.
        this.logger.debug('Slice fully claimed elsewhere; nothing to do', {
          stage: stage.id,
          queue,
          ids: payload.ids.length,
        });

        return;
      }

      claimedStage = stage;
      claimedIds = claimed;

      const context: UserServiceContext = { userId: payload.userId };
      const results = await stage.run(context, claimed);

      // Reconcile what the stage returned against what this worker claimed.
      //
      // Two failure modes, both silent without this step. An id the stage said
      // NOTHING about would stay `running` until its claim lease expired, then
      // be re-swept, re-run, and forgotten again — an infinite retry loop that
      // reports no failures. And a result for an id this worker did not claim
      // would overwrite a state row another worker legitimately owns.
      const reconciled = new Map<string, StageResult>();

      for (const entityId of claimed) {
        const result = results.get(entityId);

        reconciled.set(
          entityId,
          result ?? {
            outcome: 'failed',
            reason: 'stage_returned_no_result',
            detail: { stage: stage.id },
          },
        );
      }

      const unexpected = [...results.keys()].filter((id) => !reconciled.has(id));

      if (unexpected.length > 0) {
        this.logger.warn('Stage returned results for entities it was not given; ignoring them', {
          stage: stage.id,
          count: unexpected.length,
          sample: unexpected.slice(0, 5),
        });
      }

      const summary = await this.stateService.complete(stage, payload.entityType, reconciled);

      this.logger.log('Processed pipeline slice', {
        stage: stage.id,
        queue,
        entityType: payload.entityType,
        userId: payload.userId,
        requested: payload.ids.length,
        claimed: claimed.length,
        ...summary,
      });
    } catch (err: unknown) {
      // The payload is persisted VERBATIM (the parsed object, which is the
      // payload minus the envelope keys the bus adds), because a dead letter is
      // only worth having if it is replayable, and a trimmed payload is not.
      //
      // Written on EVERY throw, not only the last one. pg-boss retries three
      // times before dead-lettering, and the informative error is frequently
      // the first attempt's — by the third the upstream dependency may simply
      // be refusing connections, and the recorded cause would be a symptom of
      // the earlier failure rather than the failure. The rows are
      // distinguishable by `failed_at`; the reaper's terminal row for the same
      // job carries `queue = 'dead-letter'`.
      //
      // Recorded BEFORE the rethrow so pg-boss's own retry / DLQ handling still
      // runs. This is a durable copy, not a replacement for it.
      const error = err instanceof Error ? err : new Error(String(err));

      // Fail the claimed rows in the ledger BEFORE anything else.
      //
      // Without this every claimed row stays `running` at its old version. It
      // is still stale (claim never advances `stage_version`), so the next
      // sweep re-selects it, the next worker re-runs it and it throws again —
      // forever, because `attempts` only becomes visible as failure through
      // complete()/fail(), and only those can eventually quarantine. Silence
      // here would turn a broken dependency into a permanent, invisible,
      // self-renewing workload.
      //
      // The reason carries the error text: this is the slice-level counterpart
      // of a per-entity `failed` result, and a failure with no recorded reason
      // is the defect the ledger exists to remove.
      if (claimedStage != null && claimedIds.length > 0) {
        try {
          await this.stateService.fail(
            claimedStage,
            payload.entityType,
            claimedIds,
            `stage_threw: ${error.message}`,
          );
        } catch (failErr: unknown) {
          this.logger.error(
            'Failed to record slice failure in the ledger',
            failErr instanceof Error ? failErr : new Error(String(failErr)),
          );
        }
      }

      try {
        await this.stateService.recordDeadLetter({
          queue,
          eventName: PipelineSliceEvent,
          stage: payload.stage,
          entityType: payload.entityType,
          // Null: a slice covers many entities, and attributing the failure to
          // one of them would be a guess. The ids are in `payload`.
          entityId: null,
          payload: { ...payload },
          error: `${error.message}${error.stack != null ? `\n${error.stack}` : ''}`,
        });
      } catch (recordErr: unknown) {
        // Never let the bookkeeping failure replace the real one. The original
        // error is what the caller — and pg-boss — must see.
        this.logger.error(
          'Failed to record pipeline dead letter',
          recordErr instanceof Error ? recordErr : new Error(String(recordErr)),
        );
      }

      this.logger.error(`Pipeline slice failed for stage ${payload.stage} on queue ${queue}`, error);

      throw error;
    }
  }
}
