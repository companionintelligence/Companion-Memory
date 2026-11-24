/**
 * Operator-facing maintenance endpoints (backfills, one-off jobs). Currently
 * exposes POST /api/maintenance/geocode-locations, which enqueues the
 * forward-geocode backfill consumed by the geocode domain's batch listener.
 *
 * @module MaintenanceModule
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EventsModule } from '@ci/domains/events';
import { GeocodeModule } from '@ci/domains/geocode';
import { GraphModule } from '@ci/domains/graph';
import { IntelligenceModule } from '@ci/domains/intelligence';
import { LLMModule } from '@ci/domains/llm';
import { EventEntity, MemoryModule } from '@ci/domains/memory';
import { PersonalizationModule } from '@ci/domains/personalization';
import { PythonFunctionsModule } from '@ci/domains/python-functions';
import { SearchIngressModule } from '@ci/domains/search-ingress';
import { SearchNextModule } from '@ci/domains/search-next';

import { MaintenanceController } from './controllers/MaintenanceController';
import { DerivationCron } from './cron/DerivationCron';
import { EntityTypeAuditCron } from './cron/EntityTypeAuditCron';
import { MobileSearchDocumentDetailCron } from './cron/MobileSearchDocumentDetailCron';
import { OrphanCleanupCron } from './cron/OrphanCleanupCron';
import { RecallProbeCron } from './cron/RecallProbeCron';
import { RetrievalHealthCron } from './cron/RetrievalHealthCron';
import { EntityTypeProposalEntity } from './entities/EntityTypeProposalEntity';
import { GraphEnrichmentProposalEntity } from './entities/GraphEnrichmentProposalEntity';
import { RecallProbeResultEntity } from './entities/RecallProbeResultEntity';
import { RetrievalHealthSnapshotEntity } from './entities/RetrievalHealthSnapshotEntity';
import { RetrievalQueryLogEntity } from './entities/RetrievalQueryLogEntity';
import { CommunicationParticipantLinkListener } from './listeners/CommunicationParticipantLinkListener';
import { DerivationRunListener } from './listeners/DerivationRunListener';
import { EstimateLocationBatchListener } from './listeners/EstimateLocationBatchListener';
import { PersonStubBackfillRequestListener } from './listeners/PersonStubBackfillRequestListener';
import { RetrievalQueryLogListener } from './listeners/RetrievalQueryLogListener';
import { CommunicationLinkBackfillService } from './services/CommunicationLinkBackfillService';
import { DerivedRelationshipService } from './services/DerivedRelationshipService';
import { DeterministicEdgeBackfillService } from './services/DeterministicEdgeBackfillService';
import { EmbedCoverageTelemetryService } from './services/EmbedCoverageTelemetryService';
import { EntityIdentifierBackfillService } from './services/EntityIdentifierBackfillService';
import { EntityTypeAuditService } from './services/EntityTypeAuditService';
import { EventParticipantBackfillService } from './services/EventParticipantBackfillService';
import { ExternalIdKindIntegrityService } from './services/ExternalIdKindIntegrityService';
import { GraphEnrichmentReviewService } from './services/GraphEnrichmentReviewService';
import { GraphEnrichmentService } from './services/GraphEnrichmentService';
import { HealSelfCollationService } from './services/HealSelfCollationService';
import { IngestResetService } from './services/IngestResetService';
import { LocationEstimateService } from './services/LocationEstimateService';
import { MaintenanceOrchestratorService } from './services/MaintenanceOrchestratorService';
import { NoteContentFoldService } from './services/NoteContentFoldService';
import { ObjectReverseService } from './services/ObjectReverseService';
import { PersonStubBackfillService } from './services/PersonStubBackfillService';
import { RecallProbeService } from './services/RecallProbeService';
import { RelationshipNormalizeService } from './services/RelationshipNormalizeService';
import { RetrievalHealthService } from './services/RetrievalHealthService';
import { RetrievalQueryLogService } from './services/RetrievalQueryLogService';
import { SearchIndexBackfillService } from './services/SearchIndexBackfillService';
import { SummaryBackfillService } from './services/SummaryBackfillService';

/**
 * @internal
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      EventEntity,
      EntityTypeProposalEntity,
      GraphEnrichmentProposalEntity,
      RecallProbeResultEntity,
      RetrievalHealthSnapshotEntity,
      RetrievalQueryLogEntity,
    ]),
    EventsModule,
    SearchIngressModule,
    // RecallProbeService measures the statement SearchService itself builds,
    // rather than a copy of it — see buildSemanticSearchPlan.
    SearchNextModule,
    GraphModule,
    GeocodeModule,
    // RetrievalHealthCron raises its alerts as ci.actions rows (ActionService).
    // Not through the trust dial: an index COUNT is a fact about the appliance,
    // not an inference about the user, so there is no confidence to rate. The
    // dial still decides placement one hop downstream, in personalization's
    // FeedQueuePopulationListener. PersonalizationModule below is imported for
    // the providers here that DO inject PersonalizationService (GraphEnrichment,
    // PersonStubBackfill, HealSelfCollation and the two listeners).
    IntelligenceModule,
    // GraphEnrichmentService needs the local Ollama client (LLMModule) and the
    // Person-resolution read path (GraphQueryService, exported by MemoryModule).
    LLMModule,
    MemoryModule,
    PersonalizationModule,
    // SummaryBackfillService dispatches through PythonFunctionService, the
    // sanctioned way to run summary-sidecar work (see PythonFunctionsModule).
    PythonFunctionsModule,
  ],
  controllers: [MaintenanceController],
  providers: [
    ExternalIdKindIntegrityService,
    IngestResetService,
    CommunicationLinkBackfillService,
    EntityIdentifierBackfillService,
    PersonStubBackfillService,
    EventParticipantBackfillService,
    DeterministicEdgeBackfillService,
    RelationshipNormalizeService,
    DerivedRelationshipService,
    NoteContentFoldService,
    GraphEnrichmentService,
    GraphEnrichmentReviewService,
    HealSelfCollationService,
    SearchIndexBackfillService,
    SummaryBackfillService,
    EmbedCoverageTelemetryService,
    RetrievalHealthService,
    RetrievalQueryLogService,
    RetrievalQueryLogListener,
    RetrievalHealthCron,
    RecallProbeService,
    RecallProbeCron,
    EntityTypeAuditService,
    EntityTypeAuditCron,
    LocationEstimateService,
    MaintenanceOrchestratorService,
    ObjectReverseService,
    EstimateLocationBatchListener,
    CommunicationParticipantLinkListener,
    // The post-push people pass (PersonStubBackfillRequestEvent, emitted by the
    // import domain's PushStage after it bulk-writes communications).
    PersonStubBackfillRequestListener,
    OrphanCleanupCron,
    // Brings device records (ci_search.mobile_search_documents related_id /
    // detail) up to the current DEVICE_RECORD_VERSION.
    MobileSearchDocumentDetailCron,
    DerivationRunListener,
    DerivationCron,
  ],
  exports: [
    ExternalIdKindIntegrityService,
    CommunicationLinkBackfillService,
    EntityIdentifierBackfillService,
    PersonStubBackfillService,
    EventParticipantBackfillService,
    DeterministicEdgeBackfillService,
    RelationshipNormalizeService,
    DerivedRelationshipService,
    NoteContentFoldService,
    GraphEnrichmentService,
    GraphEnrichmentReviewService,
    HealSelfCollationService,
    SearchIndexBackfillService,
    SummaryBackfillService,
    EmbedCoverageTelemetryService,
    RetrievalHealthService,
    RetrievalQueryLogService,
    RecallProbeService,
    EntityTypeAuditService,
    LocationEstimateService,
    MaintenanceOrchestratorService,
    ObjectReverseService,
  ],
})
export class MaintenanceModule {}

// Public surface for other domains (e.g. the /v1 bulk-ingest lifecycle
// endpoints, which delegate finish/status to these services).
export {
  MaintenanceOrchestratorService,
  ORCHESTRATE_STAGES,
  type OrchestrateStage,
  type OrchestrateSummary,
} from './services/MaintenanceOrchestratorService';
export { GraphEnrichmentService, type GraphEnrichmentOptions } from './services/GraphEnrichmentService';
export {
  EntityIdentifierBackfillService,
  type EntityIdentifierBackfillOptions,
  type EntityIdentifierBackfillResult,
} from './services/EntityIdentifierBackfillService';
export {
  GraphEnrichmentReviewService,
  type GraphEnrichmentProposalPage,
  type RecordProposalInput,
} from './services/GraphEnrichmentReviewService';
export { GraphEnrichmentProposalEntity } from './entities/GraphEnrichmentProposalEntity';
export type {
  GraphEnrichmentProposalCategory,
  GraphEnrichmentProposalStatus,
} from './entities/GraphEnrichmentProposalEntity';
export {
  DeterministicEdgeBackfillService,
  type DeterministicEdgeBackfillOptions,
  type DeterministicEdgeBackfillResult,
} from './services/DeterministicEdgeBackfillService';
export {
  ExternalIdKindIntegrityService,
  VIOLATION_SAMPLE_LIMIT,
  type ExternalIdKindIntegrityReport,
  type ExternalIdKindViolation,
} from './services/ExternalIdKindIntegrityService';
export { RelationshipNormalizeService } from './services/RelationshipNormalizeService';
export {
  DerivedRelationshipService,
  type DerivedRelationshipOptions,
  type DerivedRelationshipResult,
} from './services/DerivedRelationshipService';
export { NoteContentFoldService } from './services/NoteContentFoldService';
export {
  DETERMINISTIC_EDGE_RULES,
  DETERMINISTIC_EDGE_RULE_IDS,
  type DeterministicEdgeRule,
  type DeterministicEdgeSource,
} from './services/deterministicEdgeMatrix';
// The contract a linkage writer here re-opens the edge projection through;
// PipelineModule binds the token (see the file for why it is a token).
export {
  EDGE_PROJECTION_REOPENER,
  resolveEdgeProjectionReopener,
  type EdgeProjectionReopener,
} from './edgeProjectionReopener';
// The two linkage writers that re-open through it.
export {
  CommunicationLinkBackfillService,
  type CommunicationLinkBackfillResult,
} from './services/CommunicationLinkBackfillService';
export {
  EventParticipantBackfillService,
  type EventParticipantBackfillResult,
} from './services/EventParticipantBackfillService';
export {
  SearchIndexBackfillService,
  BACKFILLABLE_ENTITIES,
  PIPELINE_COVERED_STAGES,
  normalizeBackfillEntityTypes,
  type BackfillableEntity,
  type SearchIndexBackfillResult,
} from './services/SearchIndexBackfillService';
export {
  SummaryBackfillService,
  type SummaryBackfillOptions,
  type SummaryBackfillProgressEvent,
  type SummaryBackfillResult,
} from './services/SummaryBackfillService';
export { RetrievalHealthSnapshotEntity } from './entities/RetrievalHealthSnapshotEntity';
export {
  RetrievalHealthService,
  buildRetrievalHealthAlerts,
  alertKey,
  BASELINE_LOOKBACK_DAYS,
  BASELINE_MAX_AGE_DAYS,
  MAX_ALERTS_PER_RUN,
  REGRESSION_DROP,
  RETENTION_DAYS,
  type RetrievalHealthAlert,
  type RetrievalHealthAlertReason,
  type RetrievalHealthBaseline,
  type RetrievalHealthRun,
} from './services/RetrievalHealthService';
export { RetrievalHealthCron, RETRIEVAL_HEALTH_CRON, ALERT_REPEAT_DAYS } from './cron/RetrievalHealthCron';
export { EntityTypeProposalEntity } from './entities/EntityTypeProposalEntity';
export type {
  ProposalAutonomy,
  ProposalStatus,
  SearchIndexAction,
} from './entities/EntityTypeProposalEntity';
export {
  EntityTypeAuditService,
  classifyShortCodePerson,
  withCoordinateConflict,
  AUDITED_ENTITY_TYPE,
  AUDIT_WINDOW_SIZE,
  ENTITY_TYPE_AUDIT_DETECTOR,
  ENTITY_TYPE_AUDIT_GENERATION,
  KEYED_AS_CONTACT_SCORE,
  PHONE_SHAPED_SQL,
  UNPROVEN_KEY_SCORE,
  type EntityTypeAuditCandidate,
  type EntityTypeAuditResult,
  type EntityTypeFinding,
  type EntityTypeProposalRecord,
} from './services/EntityTypeAuditService';
export { EntityTypeAuditCron, ENTITY_TYPE_AUDIT_CRON } from './cron/EntityTypeAuditCron';
export { RecallProbeResultEntity } from './entities/RecallProbeResultEntity';
export {
  RecallProbeService,
  recallAt,
  selectProbeTypes,
  summarizeLeg,
  pickProbeUser,
  weekIndex,
  EF_SEARCH_VARIANTS,
  MAX_RUN_MS,
  MIN_POPULATION,
  PROBE_K,
  PROBED_TYPES,
  RETENTION_DAYS as RECALL_PROBE_RETENTION_DAYS,
  SAMPLES_PER_TYPE,
  TYPES_PER_RUN,
  type LegSample,
  type LegSummary,
  type RecallProbeRun,
  type TypePopulation,
} from './services/RecallProbeService';
export { RecallProbeCron, RECALL_PROBE_CRON } from './cron/RecallProbeCron';
export {
  SearchIndexBackfillRequestEvent,
  SEARCH_INDEX_BACKFILL_QUEUE,
  type SearchIndexBackfillRequestPayload,
  GraphEdgeBackfillRequestEvent,
  GRAPH_EDGE_BACKFILL_QUEUE,
  type GraphEdgeBackfillRequestPayload,
  DerivationRunRequestEvent,
  DERIVATION_RUN_QUEUE,
  type DerivationRunRequestPayload,
} from './events';
export { DerivationCron, DERIVATION_CRON } from './cron/DerivationCron';
