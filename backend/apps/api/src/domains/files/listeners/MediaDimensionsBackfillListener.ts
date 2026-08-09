import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { EventService, OnEvent } from '@ci/domains/events';
import { PipelineSweepEvent } from '@ci/domains/pipeline/events';

import { MediaDimensionsBackfillRequestEvent, type MediaDimensionsBackfillRequestPayload } from '../events';

/** Dedicated PGBoss queue so the dimensions backfill doesn't block the default queue. */
export const MEDIA_DIMENSIONS_QUEUE = 'media-dimensions';

/**
 * The stage this shim hands off to, and the queue its sweep rides.
 *
 * DUPLICATED from `STAGE_IDS.ENRICH_MEDIA_DIMENSIONS` and
 * `PIPELINE_QUEUES.ENRICH`, and the duplication is deliberate rather than
 * careless. Importing them would mean importing `domains/pipeline/constants.ts`,
 * which `no-cross-domain-internals` forbids; importing the pipeline BARREL
 * instead is allowed, but it would close a cycle the moment `PipelineModule`
 * registers `MediaDimensionsStage` — that stage imports `@ci/domains/files`,
 * which imports this file. `domains/pipeline/events.ts` is the one pipeline
 * module a foreign domain may import (the rule allows `index.ts` and
 * `events.ts`) and it reaches nothing that leads back here, so the handoff goes
 * through the event and these two strings stay local.
 *
 * They are held honest by the accompanying test, which imports the real
 * constants through the pipeline's public barrel and asserts these match. A test
 * edge cannot close a runtime cycle, so the check costs nothing.
 */
const MEDIA_DIMENSIONS_STAGE_ID = 'enrich.media_dimensions';
const MEDIA_DIMENSIONS_STAGE_QUEUE = 'pipeline-enrich';

/**
 * @deprecated Superseded by the `enrich.media_dimensions` pipeline stage —
 * `domains/pipeline/stages/enrich/MediaDimensionsStage.ts`. This class survives
 * only as a compatibility shim for the two callers that still emit
 * {@link MediaDimensionsBackfillRequestEvent} (`MaintenanceController`'s
 * `/maintenance/media-dimensions` endpoint and `MaintenanceOrchestratorService`'s
 * nightly leg). New callers should start a sweep directly:
 *
 * ```ts
 * await pipelineDispatchService.startSweep({ stage: STAGE_IDS.ENRICH_MEDIA_DIMENSIONS, userId });
 * ```
 *
 * ── What moved, and why it had to ──────────────────────────────────────────
 *
 * This listener used to own the whole leg: a keyset page over
 * `file.width IS NULL`, a bounded-concurrency probe loop, and four local
 * counters. Every part of that is now somebody else's, permanently:
 *
 *  - the candidate query became THE ONE RULE in `PipelineStateService.selectStale`,
 *  - the page loop became a durable chain of sweep jobs in `PipelineDispatchService`
 *    (the old `while` loop lived inside a single pg-boss job, so an API restart
 *    at row 199 of 200 lost the batch and its counters with it),
 *  - the probe is `MediaDimensionsStage.run`,
 *  - and the counters became rows in `ci.pipeline_state`.
 *
 * The reason it had to move is one clause: `file.width IS NULL`. The predicate
 * that FOUND work was the predicate that DECLARED it done, so a file whose
 * header could not be decoded stayed NULL and was re-fetched from object storage
 * and re-decoded on every run forever, while a file that succeeded left the
 * candidate set permanently and could never be re-probed by a better decoder.
 * The stage records `skipped: probe_failed` for the first and re-opens both on a
 * `STAGE_VERSIONS` bump. See `MEDIA_DIMENSIONS_SOURCE` in the stage for the full
 * comparison.
 *
 * ── Behaviour change callers should know about ─────────────────────────────
 *
 * `handleBatch` now RETURNS AS SOON AS THE SWEEP IS ENQUEUED instead of blocking
 * until the batch is probed. That is the point of making progress durable — the
 * work outlives the request — but it means the old "the response came back, so
 * the files are done" reading no longer holds. Progress is read from
 * `ci.pipeline_state` (coverage for `enrich.media_dimensions`), not from the
 * absence of an error here.
 *
 * `payload.limit` is accepted and IGNORED. It capped how many files one batch
 * probed, which only existed because the loop was synchronous and unbounded; a
 * sweep is paced by its own backpressure (each hop rides the same queue as the
 * slices it enqueued, so it cannot outrun the workers) and runs to completion
 * across as many jobs as it takes. Honouring a cap by truncating the sweep would
 * silently leave a corpus half-processed with nothing recording where it stopped
 * — exactly the ambiguity the ledger removes.
 */
@Injectable()
export class MediaDimensionsBackfillListener {
  constructor(
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(MediaDimensionsBackfillListener.name);
  }

  @OnEvent(MediaDimensionsBackfillRequestEvent, { queue: MEDIA_DIMENSIONS_QUEUE })
  async handleBatch(payload: MediaDimensionsBackfillRequestPayload): Promise<void> {
    const { userId } = payload;

    this.logger.warn(
      'MediaDimensionsBackfillRequestEvent is deprecated; delegating to the enrich.media_dimensions ' +
        'pipeline stage. Call PipelineDispatchService.startSweep directly instead.',
      { userId, ignoredLimit: payload.limit ?? null },
    );

    // The first hop of a keyset sweep. `sliceSize`, `hop` and `dispatched` are
    // omitted on purpose: `pipelineSweepPayloadSchema` supplies their defaults
    // when `PipelineDispatchService` parses the payload, so this shim does not
    // pin a slice size the pipeline may later want to change.
    //
    // Emitting the event rather than calling `PipelineDispatchService.startSweep`
    // costs one thing worth naming: `startSweep` resolves the stage through
    // `StageRegistry` at the CALL SITE, so a bad stage id fails on the request.
    // Here an unknown id instead fails inside the first sweep hop, as a dead
    // letter. That is an acceptable trade for a deprecated shim whose two
    // callers should be calling `startSweep` themselves — and the stage id is
    // pinned to the real constant by this file's test.
    await this.eventService.send(
      PipelineSweepEvent,
      {
        stage: MEDIA_DIMENSIONS_STAGE_ID,
        userId,
        cursor: null,
      },
      { queue: MEDIA_DIMENSIONS_STAGE_QUEUE },
    );
  }
}
