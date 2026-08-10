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

import { EmbeddingModule } from '@ci/common/embeddings';
import { EventsModule } from '@ci/domains/events';
import { FileEntity, FilesModule } from '@ci/domains/files';
import { GeocodeModule } from '@ci/domains/geocode';
import { MemoryModule } from '@ci/domains/memory';

import { STAGE_IDS } from './constants';
import { PipelineController } from './controllers/PipelineController';
import { IdentifierClaimEntity } from './entities/IdentifierClaimEntity';
import { PipelineDeadLetterEntity } from './entities/PipelineDeadLetterEntity';
import { PipelineRunEntity } from './entities/PipelineRunEntity';
import { PipelineShardEntity } from './entities/PipelineShardEntity';
import { PipelineStateEntity } from './entities/PipelineStateEntity';
import { RecordRejectionEntity } from './entities/RecordRejectionEntity';
import { DeadLetterReaperListener } from './listeners/DeadLetterReaperListener';
import { PipelineSliceListener } from './listeners/PipelineSliceListener';
import { PIPELINE_TICK, PipelineTickCron } from './listeners/PipelineTickCron';
import { StageArrivalListener } from './listeners/StageArrivalListener';
import { BackpressureService } from './services/BackpressureService';
import { EnrichmentWindowService } from './services/EnrichmentWindowService';
import { PipelineControlService } from './services/PipelineControlService';
import { PipelineDispatchService } from './services/PipelineDispatchService';
import { PipelineRunService } from './services/PipelineRunService';
import { PipelineStateService } from './services/PipelineStateService';
import { STAGE_REGISTRY, StageRegistry } from './services/StageRegistry';
import { DuplicateDetectStage } from './stages/clean/DuplicateDetectStage';
import { IdentifierNormalizeStage } from './stages/clean/IdentifierNormalizeStage';
import { TemporalRepairStage } from './stages/clean/TemporalRepairStage';
import { EstimateLocationStage } from './stages/enrich/EstimateLocationStage';
import { GeocodeStage } from './stages/enrich/GeocodeStage';
import { MediaDimensionsStage } from './stages/enrich/MediaDimensionsStage';
import { EventPersonLinkStage, PersonLinkStage } from './stages/enrich/PersonLinkStage';
import { PositionReverseStage } from './stages/enrich/PositionReverseStage';
import { EmbedStage } from './stages/index/EmbedStage';
import { ObjectPromoteStage } from './stages/promote/ObjectPromoteStage';
import { PlacePromoteStage } from './stages/promote/PlacePromoteStage';

/**
 * Stage implementations, bound to the tokens declared in `STAGE_REGISTRY`.
 *
 * ADD A STAGE HERE — one entry, alongside its id in `STAGE_IDS`, its version in
 * `STAGE_VERSIONS`, and its token in `STAGE_REGISTRY`. The boot guard in
 * `StageRegistry` names anything you miss in the first three; THIS ARRAY IS THE
 * FOURTH, and it is the one the boot guard structurally cannot see — it compares
 * two declaration maps to each other, and a stage absent from both looks
 * consistent. That gap is not hypothetical: `EmbedStage` and
 * `PositionReverseStage` shipped, tested, with local ids and derived versions,
 * and were unreachable at runtime for exactly this reason.
 * `__tests__/stageWiring.spec.ts` closes it by discovering stage classes from
 * disk and failing on any that this array does not bind.
 *
 * A stage may equally be bound from its own domain module — `StageRegistry`
 * resolves non-strictly — which is the right home for one that needs services
 * that module already wires. All three live here today because the dependencies
 * they need (below) are exported by modules this one can simply import, and
 * keeping the bindings in one place keeps the wiring reviewable in one diff.
 *
 * Nest instantiates every provider in this array when the module initialises, so
 * a stage whose constructor cannot be satisfied fails the BOOT with the missing
 * token named — not the first slice that stage is dispatched, on whichever
 * appliance reaches it first, hours after the deploy.
 */
const stageProviders: Provider[] = [
  { provide: STAGE_REGISTRY[STAGE_IDS.ENRICH_MEDIA_DIMENSIONS], useClass: MediaDimensionsStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.INDEX_EMBED], useClass: EmbedStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.ENRICH_POSITION_REVERSE], useClass: PositionReverseStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.ENRICH_GEOCODE], useClass: GeocodeStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.ENRICH_ESTIMATE_LOCATION], useClass: EstimateLocationStage },
  // Two ids, one implementation. `PersonLinkStage.ts` carries the argument: a
  // Stage has exactly one `source`, and the three backfills these replace read
  // two tables.
  { provide: STAGE_REGISTRY[STAGE_IDS.ENRICH_PERSON_LINK], useClass: PersonLinkStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.ENRICH_EVENT_PERSON_LINK], useClass: EventPersonLinkStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.CLEAN_TEMPORAL_REPAIR], useClass: TemporalRepairStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.CLEAN_DUPLICATE_DETECT], useClass: DuplicateDetectStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.CLEAN_IDENTIFIER_NORMALIZE], useClass: IdentifierNormalizeStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.PROMOTE_PLACE], useClass: PlacePromoteStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.PROMOTE_OBJECT], useClass: ObjectPromoteStage },
];

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
      // NOT a control-plane table: `ci.identifier_claims` is user data (it has
      // the FK to `ci.users` the control plane deliberately refuses) and it is
      // read by the graph, not the dispatcher. Registered here because
      // `enrich.person_link` is its only writer. The stage itself speaks raw
      // SQL — one `unnest` upsert per slice — so this registration exists to
      // make the repository injectable for a read path, not because the stage
      // needs it.
      IdentifierClaimEntity,
      // `MediaDimensionsStage` injects the `ci.files` repository directly. The
      // files domain registers the same entity for its own module, but
      // `forFeature` registrations are per-module, so this line is what makes
      // `@InjectRepository(FileEntity)` resolvable HERE. Registering an entity
      // twice is normal and costs nothing — TypeORM's metadata is global; only
      // the repository provider is module-scoped.
      FileEntity,
    ]),
    EventsModule,
    // One import per stage dependency, and each is the other module's PUBLIC
    // barrel — `no-cross-domain-internals` allows nothing else, and the stages
    // themselves already import through it.
    //
    //  - `FilesModule`     → FileService (object storage) + MediaDimensionsService
    //                        (sharp / ffprobe) for `enrich.media_dimensions`.
    //  - `EmbeddingModule` → EmbeddingGenerationService (Ollama) for `index.embed`.
    //  - `GeocodeModule`   → GeocodeService (cache-aware reverse geocode) for
    //                        `enrich.position_reverse`.
    //
    // None of the three imports PipelineModule, so no `forwardRef` is needed;
    // `MediaDimensionsBackfillListener` reaches the pipeline through
    // `@ci/domains/pipeline/events`, which is a leaf.
    FilesModule,
    EmbeddingModule,
    GeocodeModule,
    //  - `MemoryModule`    -> PlaceService (find-or-create place identity + the
    //                        city/region/country hierarchy fold) for `promote.place`.
    MemoryModule,
  ],
  providers: [
    PipelineStateService,
    StageRegistry,
    PipelineDispatchService,
    PipelineRunService,
    BackpressureService,
    // WHEN the appliance is willing to spend, which the control tick hands to
    // `stageDueness` for every leg it judges. Declared and specced before
    // anything consumed it; the dueness gate is its first caller.
    EnrichmentWindowService,
    PipelineControlService,
    PipelineSliceListener,
    // Rows are enriched AS THEY ARRIVE; the tick is the backstop, not the
    // primary path. Shedding under backpressure is safe here precisely because
    // the ledger is the source of truth — a shed row simply stays stale and the
    // next sweep re-derives it, so there is no deferral queue to leak.
    StageArrivalListener,
    PipelineTickCron,
    // The cron owns the schedule and the cluster-safe advisory lock; the control
    // service owns what a tick DOES. Binding by token rather than importing the
    // service into the cron keeps the timer swappable — a worker process split
    // (Phase 5) replaces the cron, not the tick.
    { provide: PIPELINE_TICK, useExisting: PipelineControlService },
    DeadLetterReaperListener,
    ...stageProviders,
  ],
  controllers: [PipelineController],
  exports: [
    PipelineStateService,
    PipelineDispatchService,
    PipelineRunService,
    PipelineControlService,
    BackpressureService,
    EnrichmentWindowService,
    StageRegistry,
  ],
})
export class PipelineModule {}

export {
  IdentifierClaimEntity,
  PipelineDeadLetterEntity,
  PipelineRunEntity,
  PipelineShardEntity,
  PipelineStateEntity,
  RecordRejectionEntity,
};
export type { IdentifierClaim } from './entities/IdentifierClaimEntity';
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
export type { StageVersion } from './versions';
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
