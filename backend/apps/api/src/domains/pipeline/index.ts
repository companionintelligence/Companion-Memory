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
import { EmbedModule } from '@ci/domains/embed';
import { EventsModule } from '@ci/domains/events';
import { FileEntity, FilesModule } from '@ci/domains/files';
import { GeocodeModule } from '@ci/domains/geocode';
import { IntelligenceModule } from '@ci/domains/intelligence';
import { MaintenanceModule } from '@ci/domains/maintenance';
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
import { FilePreviewSweepRequestListener } from './listeners/FilePreviewSweepRequestListener';
import { GraphEdgeSweepRequestListener } from './listeners/GraphEdgeSweepRequestListener';
import { PipelineSliceListener } from './listeners/PipelineSliceListener';
import { PIPELINE_TICK, PipelineTickCron } from './listeners/PipelineTickCron';
import { SearchIndexSweepRequestListener } from './listeners/SearchIndexSweepRequestListener';
import { StageArrivalListener } from './listeners/StageArrivalListener';
import { UnfurlSweepRequestListener } from './listeners/UnfurlSweepRequestListener';
import { BackpressureService } from './services/BackpressureService';
import { EnrichmentWindowService } from './services/EnrichmentWindowService';
import { IdentifierArrivalService } from './services/IdentifierArrivalService';
import { PipelineControlService } from './services/PipelineControlService';
import { PipelineDispatchService } from './services/PipelineDispatchService';
import { PipelineRunService } from './services/PipelineRunService';
import { PipelineStateService } from './services/PipelineStateService';
import { STAGE_REGISTRY, StageRegistry } from './services/StageRegistry';
import { DuplicateDetectStage } from './stages/clean/DuplicateDetectStage';
import { IdentifierNormalizeStage } from './stages/clean/IdentifierNormalizeStage';
import { ObjectDuplicateDetectStage } from './stages/clean/ObjectDuplicateDetectStage';
import { SingleValuedEdgeAuditStage } from './stages/clean/SingleValuedEdgeAuditStage';
import { TemporalRepairStage } from './stages/clean/TemporalRepairStage';
import { EstimateLocationStage } from './stages/enrich/EstimateLocationStage';
import { EventReverseStage } from './stages/enrich/EventReverseStage';
import { FilePreviewStage } from './stages/enrich/FilePreviewStage';
import { GeocodeStage } from './stages/enrich/GeocodeStage';
import { MediaDimensionsStage } from './stages/enrich/MediaDimensionsStage';
import { EventPersonLinkStage, PersonLinkStage } from './stages/enrich/PersonLinkStage';
import { PersonSelfClaimStage } from './stages/enrich/PersonSelfClaimStage';
import { PositionReverseStage } from './stages/enrich/PositionReverseStage';
import { UnfurlStage } from './stages/enrich/UnfurlStage';
import { EmbedStage } from './stages/index/EmbedStage';
import {
  BrowserActivityEmbedStage,
  CommunicationEmbedStage,
  EventEmbedStage,
  FileEmbedStage,
  ItemEmbedStage,
  PersonEmbedStage,
} from './stages/index/entityEmbedStages';
import {
  BrowserActivityVectorStage,
  CommunicationVectorStage,
  ContentVectorStage,
  EventVectorStage,
  FileVectorStage,
  ItemVectorStage,
  PersonVectorStage,
} from './stages/index/vectorStages';
import {
  CommunicationEdgePromoteStage,
  ContentEdgePromoteStage,
  DeviceEdgePromoteStage,
  EventEdgePromoteStage,
  FileEdgePromoteStage,
  ObjectEdgePromoteStage,
  ObservationEdgePromoteStage,
  PlaceEdgePromoteStage,
  PositionEdgePromoteStage,
  ReceiptEdgePromoteStage,
} from './stages/promote/EdgePromoteStage';
import { ObjectPromoteStage } from './stages/promote/ObjectPromoteStage';
import { ObservationPromoteStage } from './stages/promote/ObservationPromoteStage';
import { PlacePromoteStage } from './stages/promote/PlacePromoteStage';
import { PositionPlacePromoteStage } from './stages/promote/PositionPlacePromoteStage';

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
  { provide: STAGE_REGISTRY[STAGE_IDS.ENRICH_FILE_PREVIEW], useClass: FilePreviewStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.ENRICH_UNFURL], useClass: UnfurlStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.INDEX_EMBED], useClass: EmbedStage },
  // The rest of the dense-embed family — one id per source table, one shared
  // implementation (DenseEmbedStageBase), all at the model-derived version.
  { provide: STAGE_REGISTRY[STAGE_IDS.INDEX_EMBED_COMMUNICATION], useClass: CommunicationEmbedStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.INDEX_EMBED_EVENT], useClass: EventEmbedStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.INDEX_EMBED_ITEM], useClass: ItemEmbedStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.INDEX_EMBED_PERSON], useClass: PersonEmbedStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.INDEX_EMBED_FILE], useClass: FileEmbedStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.INDEX_EMBED_BROWSER_ACTIVITY], useClass: BrowserActivityEmbedStage },
  // The keyword-search (tsvector) family — same sources, local Postgres work.
  { provide: STAGE_REGISTRY[STAGE_IDS.INDEX_VECTOR], useClass: ContentVectorStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.INDEX_VECTOR_COMMUNICATION], useClass: CommunicationVectorStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.INDEX_VECTOR_EVENT], useClass: EventVectorStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.INDEX_VECTOR_ITEM], useClass: ItemVectorStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.INDEX_VECTOR_PERSON], useClass: PersonVectorStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.INDEX_VECTOR_FILE], useClass: FileVectorStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.INDEX_VECTOR_BROWSER_ACTIVITY], useClass: BrowserActivityVectorStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.ENRICH_POSITION_REVERSE], useClass: PositionReverseStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.ENRICH_GEOCODE], useClass: GeocodeStage },
  // The other direction over the same table. A second id rather than a second
  // mode on `enrich.geocode`, because one integer could not then re-open the
  // forward corpus without re-billing the reverse one — and vice versa.
  { provide: STAGE_REGISTRY[STAGE_IDS.ENRICH_EVENT_REVERSE], useClass: EventReverseStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.ENRICH_ESTIMATE_LOCATION], useClass: EstimateLocationStage },
  // Two ids, one implementation. `PersonLinkStage.ts` carries the argument: a
  // Stage has exactly one `source`, and the three backfills these replace read
  // two tables.
  { provide: STAGE_REGISTRY[STAGE_IDS.ENRICH_PERSON_LINK], useClass: PersonLinkStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.ENRICH_EVENT_PERSON_LINK], useClass: EventPersonLinkStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.ENRICH_PERSON_SELF_CLAIM], useClass: PersonSelfClaimStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.CLEAN_TEMPORAL_REPAIR], useClass: TemporalRepairStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.CLEAN_DUPLICATE_DETECT], useClass: DuplicateDetectStage },
  {
    provide: STAGE_REGISTRY[STAGE_IDS.CLEAN_OBJECT_DUPLICATE_DETECT],
    useClass: ObjectDuplicateDetectStage,
  },
  { provide: STAGE_REGISTRY[STAGE_IDS.CLEAN_IDENTIFIER_NORMALIZE], useClass: IdentifierNormalizeStage },
  // A DETECTOR, not a repairer: it counts subjects holding more than one active
  // edge of a single-valued type and writes nothing to `ci.relationships`. See
  // the file for why the count has to come before any supersession work.
  {
    provide: STAGE_REGISTRY[STAGE_IDS.CLEAN_SINGLE_VALUED_EDGE_AUDIT],
    useClass: SingleValuedEdgeAuditStage,
  },
  { provide: STAGE_REGISTRY[STAGE_IDS.PROMOTE_PLACE], useClass: PlacePromoteStage },
  // The same promotion over `ci.position` — a second id because a Stage has
  // exactly one `source` and this is a different table. It is the only writer
  // `ci.position.location_entity_id` has ever had.
  { provide: STAGE_REGISTRY[STAGE_IDS.PROMOTE_PLACE_POSITION], useClass: PositionPlacePromoteStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.PROMOTE_OBJECT], useClass: ObjectPromoteStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.PROMOTE_OBSERVATION], useClass: ObservationPromoteStage },
  // Two ids, one implementation family — see `EdgePromoteStage.ts`. Both
  // delegate the projection to DeterministicEdgeBackfillService, exported by
  // MaintenanceModule (imported below).
  { provide: STAGE_REGISTRY[STAGE_IDS.PROMOTE_EDGE_COMMUNICATION], useClass: CommunicationEdgePromoteStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.PROMOTE_EDGE_EVENT], useClass: EventEdgePromoteStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.PROMOTE_EDGE_CONTENT], useClass: ContentEdgePromoteStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.PROMOTE_EDGE_OBJECT], useClass: ObjectEdgePromoteStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.PROMOTE_EDGE_RECEIPT], useClass: ReceiptEdgePromoteStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.PROMOTE_EDGE_OBSERVATION], useClass: ObservationEdgePromoteStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.PROMOTE_EDGE_POSITION], useClass: PositionEdgePromoteStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.PROMOTE_EDGE_DEVICE], useClass: DeviceEdgePromoteStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.PROMOTE_EDGE_FILE], useClass: FileEdgePromoteStage },
  { provide: STAGE_REGISTRY[STAGE_IDS.PROMOTE_EDGE_PLACE], useClass: PlaceEdgePromoteStage },
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
    //  - `EmbedModule`     -> UnfurlService (ci.unfurls cache + resolvers + SSRF
    //                        fetcher) for `enrich.unfurl`.
    EmbedModule,
    //  - `MemoryModule`    -> PlaceService (find-or-create place identity + the
    //                        city/region/country hierarchy fold) for `promote.place`.
    MemoryModule,
    //  - `MaintenanceModule` -> DeterministicEdgeBackfillService (the edge-matrix
    //                        projection + graph deltas) for both `promote.edge_*`
    //                        legs. The projection is shared with the operator
    //                        backfill endpoint rather than re-implemented here.
    MaintenanceModule,
    //  - `IntelligenceModule` -> ActionService, for the one card
    //                        `clean.single_valued_edge_audit` raises when it
    //                        finds a contradiction. It imports only
    //                        TypeOrmModule.forFeature + EventsModule, so nothing
    //                        in its graph reaches back here and no `forwardRef`
    //                        is needed.
    IntelligenceModule,
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
    // New evidence re-opens old person-link decisions. Consulted by the control
    // tick per user, before the candidates are counted.
    IdentifierArrivalService,
    PipelineControlService,
    PipelineSliceListener,
    // Rows are enriched AS THEY ARRIVE; the tick is the backstop, not the
    // primary path. Shedding under backpressure is safe here precisely because
    // the ledger is the source of truth — a shed row simply stays stale and the
    // next sweep re-derives it, so there is no deferral queue to leak.
    StageArrivalListener,
    SearchIndexSweepRequestListener,
    // Its graph-side twin. An import used to kick only the index legs, so
    // pushed rows were searchable in seconds and unreachable in the graph
    // until a scheduled sweep — `ci.relationships` is the only table a
    // traversal reads, and nothing was telling it a corpus had landed.
    GraphEdgeSweepRequestListener,
    UnfurlSweepRequestListener,
    FilePreviewSweepRequestListener,
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
export type {
  ReleaseQuarantinedInput,
  ReleaseQuarantinedResult,
  RetryBackoff,
} from './services/PipelineStateService';
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
  TRANSIENT_FAILURE_REASONS,
  isTransientFailureReason,
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

/**
 * The public vocabulary for "where did this record's timestamp come from" —
 * `TemporalRepairStage`'s own constants, not a domain-boundary copy. A caller
 * outside this domain that needs to reference or assert against them (e.g. a
 * mirrored-constant test in another domain checking its own copy has not
 * drifted) does so through here rather than reaching into the stage file
 * directly, which is what `no-cross-domain-internals` exists to catch.
 */
export { TIME_PRECISIONS, TIME_SOURCES } from './stages/clean/TemporalRepairStage';
export type { TimePrecision, TimeSource } from './stages/clean/TemporalRepairStage';
