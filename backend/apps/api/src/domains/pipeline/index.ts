/**
 * The pipeline: one durable, versioned ledger and one generic worker, replacing
 * a dozen hand-written enrichment legs that each encoded "has this run?" as a
 * nullability predicate on the column they wrote.
 *
 * ### The defect this module exists to delete
 *
 * `width IS NULL`. `location_coordinates IS NULL`. `LEFT JOIN
 * ci_search.embeddings ... WHERE e.entity_id IS NULL`. In every case the
 * predicate that FINDS work is the predicate that DECLARES it done, so the
 * first — worst — answer an enricher ever produced is permanent, "tried and
 * produced nothing" is indistinguishable from "never tried", and there is no
 * answer to "is my import finished?" because nothing counts anything.
 *
 * `ci.pipeline_state` records, per `(entity_type, entity_id, stage)`, whether a
 * stage ran, what it decided, why, and WHICH VERSION of the stage decided it.
 * Candidate selection becomes `stage_version < $current`, which makes
 * incrementing an integer in `versions.ts` a complete re-enrichment mechanism —
 * no backfill script, no truncate, no `forced` flag.
 *
 * ### Key components
 *
 * - **`PipelineStateService`** — the ledger. The only writer of
 *   `ci.pipeline_state`, and the home of the canonical staleness sweep every
 *   stage shares.
 * - **`StageRegistry`** — explicit static map of stage id → provider token,
 *   with a boot-time guard against drift from `STAGE_VERSIONS`.
 * - **`PipelineDispatchService`** — the keyset sweep, running as a durable
 *   chain of self-requeuing jobs rather than a loop inside a request.
 * - **`PipelineSliceListener`** — ONE generic worker serving every stage.
 * - **`DeadLetterReaperListener`** — finally consumes pg-boss's dead-letter
 *   queue, which nothing has ever read.
 *
 * @module PipelineModule
 */

import { Module, type Provider } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EventsModule } from '@ci/domains/events';

import { PipelineDeadLetterEntity } from './entities/PipelineDeadLetterEntity';
import { PipelineRunEntity } from './entities/PipelineRunEntity';
import { PipelineShardEntity } from './entities/PipelineShardEntity';
import { PipelineStateEntity } from './entities/PipelineStateEntity';
import { RecordRejectionEntity } from './entities/RecordRejectionEntity';
import { DeadLetterReaperListener } from './listeners/DeadLetterReaperListener';
import { PipelineSliceListener } from './listeners/PipelineSliceListener';
import { PipelineDispatchService } from './services/PipelineDispatchService';
import { PipelineStateService } from './services/PipelineStateService';
import { StageRegistry } from './services/StageRegistry';

/**
 * Stage implementations, bound to the tokens declared in `STAGE_REGISTRY`.
 *
 * ADD A STAGE HERE — one entry, alongside its id in `STAGE_IDS`, its version in
 * `STAGE_VERSIONS`, and its token in `STAGE_REGISTRY`. The boot guard in
 * `StageRegistry` names anything you miss in the first three; this array is the
 * fourth, and a stage missing from it fails at its first slice with a message
 * pointing straight back here.
 *
 * ```ts
 * { provide: STAGE_REGISTRY[STAGE_IDS.ENRICH_MEDIA_DIMENSIONS], useClass: MediaDimensionsStage },
 * ```
 *
 * A stage may equally be bound from its own domain module — `StageRegistry`
 * resolves non-strictly — which is the right home for one that needs services
 * that module already wires.
 */
const stageProviders: Provider[] = [];

/**
 * @internal
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      PipelineStateEntity,
      PipelineRunEntity,
      PipelineShardEntity,
      PipelineDeadLetterEntity,
      RecordRejectionEntity,
    ]),
    EventsModule,
  ],
  providers: [
    PipelineStateService,
    StageRegistry,
    PipelineDispatchService,
    PipelineSliceListener,
    DeadLetterReaperListener,
    ...stageProviders,
  ],
  exports: [PipelineStateService, PipelineDispatchService, StageRegistry],
})
export class PipelineModule {}

export {
  PipelineDeadLetterEntity,
  PipelineRunEntity,
  PipelineShardEntity,
  PipelineStateEntity,
  RecordRejectionEntity,
};
export { PipelineStateService } from './services/PipelineStateService';
export type { RetryBackoff } from './services/PipelineStateService';
export { PipelineDispatchService } from './services/PipelineDispatchService';
export type { StartSweepInput, SweepHopResult } from './services/PipelineDispatchService';
export { StageRegistry, STAGE_REGISTRY, assertStageRegistryComplete } from './services/StageRegistry';
export { PipelineSliceListener } from './listeners/PipelineSliceListener';
export { DeadLetterReaperListener } from './listeners/DeadLetterReaperListener';
export {
  DEAD_LETTER_QUEUE,
  DEFAULT_SLICE_SIZE,
  MAX_SLICE_SIZE,
  PIPELINE_QUEUES,
  PIPELINE_QUEUE_NAMES,
  STAGE_ID_LIST,
  STAGE_IDS,
} from './constants';
export type { PipelineQueue, StageId } from './constants';
export { STAGE_VERSIONS, stageVersion } from './versions';
export { PipelineDeadLetterReapEvent, PipelineSliceEvent, PipelineSweepEvent } from './events';
export {
  pipelineDeadLetterReapPayloadSchema,
  pipelineSlicePayloadSchema,
  pipelineSweepPayloadSchema,
} from './types';
export type {
  DeadLetterInput,
  LedgerWriteSummary,
  PipelineDeadLetterReapPayload,
  PipelineSlicePayload,
  PipelineSweepPayload,
  Stage,
  StageCoverage,
  StageOutcome,
  StageRef,
  StageResult,
  StageSource,
} from './types';
