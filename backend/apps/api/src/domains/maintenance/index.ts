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
import { GraphModule } from '@ci/domains/graph';
import { LLMModule } from '@ci/domains/llm';
import { EventEntity, MemoryModule } from '@ci/domains/memory';
import { PersonalizationModule } from '@ci/domains/personalization';
import { SearchIngressModule } from '@ci/domains/search-ingress';

import { MaintenanceController } from './controllers/MaintenanceController';
import { CommunicationParticipantLinkListener } from './listeners/CommunicationParticipantLinkListener';
import { EstimateLocationBatchListener } from './listeners/EstimateLocationBatchListener';
import { CommunicationLinkBackfillService } from './services/CommunicationLinkBackfillService';
import { DerivedRelationshipService } from './services/DerivedRelationshipService';
import { DeterministicEdgeBackfillService } from './services/DeterministicEdgeBackfillService';
import { EmbedCoverageTelemetryService } from './services/EmbedCoverageTelemetryService';
import { EventParticipantBackfillService } from './services/EventParticipantBackfillService';
import { GraphEnrichmentService } from './services/GraphEnrichmentService';
import { IndexDeferralService } from './services/IndexDeferralService';
import { IngestResetService } from './services/IngestResetService';
import { LocationEstimateService } from './services/LocationEstimateService';
import { MaintenanceOrchestratorService } from './services/MaintenanceOrchestratorService';
import { NoteContentFoldService } from './services/NoteContentFoldService';
import { PersonStubBackfillService } from './services/PersonStubBackfillService';
import { RelationshipNormalizeService } from './services/RelationshipNormalizeService';
import { SearchIndexBackfillService } from './services/SearchIndexBackfillService';

/**
 * @internal
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([EventEntity]),
    EventsModule,
    SearchIngressModule,
    GraphModule,
    // GraphEnrichmentService needs the local Ollama client (LLMModule) and the
    // Person-resolution read path (GraphQueryService, exported by MemoryModule).
    LLMModule,
    MemoryModule,
    PersonalizationModule,
  ],
  controllers: [MaintenanceController],
  providers: [
    IndexDeferralService,
    IngestResetService,
    CommunicationLinkBackfillService,
    PersonStubBackfillService,
    EventParticipantBackfillService,
    DeterministicEdgeBackfillService,
    RelationshipNormalizeService,
    DerivedRelationshipService,
    NoteContentFoldService,
    GraphEnrichmentService,
    SearchIndexBackfillService,
    EmbedCoverageTelemetryService,
    LocationEstimateService,
    MaintenanceOrchestratorService,
    EstimateLocationBatchListener,
    CommunicationParticipantLinkListener,
  ],
  exports: [
    IndexDeferralService,
    CommunicationLinkBackfillService,
    PersonStubBackfillService,
    EventParticipantBackfillService,
    DeterministicEdgeBackfillService,
    RelationshipNormalizeService,
    DerivedRelationshipService,
    NoteContentFoldService,
    GraphEnrichmentService,
    SearchIndexBackfillService,
    EmbedCoverageTelemetryService,
    LocationEstimateService,
    MaintenanceOrchestratorService,
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
  DeterministicEdgeBackfillService,
  type DeterministicEdgeBackfillOptions,
  type DeterministicEdgeBackfillResult,
} from './services/DeterministicEdgeBackfillService';
export { RelationshipNormalizeService } from './services/RelationshipNormalizeService';
export { DerivedRelationshipService } from './services/DerivedRelationshipService';
export { NoteContentFoldService } from './services/NoteContentFoldService';
export {
  DETERMINISTIC_EDGE_RULES,
  DETERMINISTIC_EDGE_RULE_IDS,
  type DeterministicEdgeRule,
  type DeterministicEdgeSource,
} from './services/deterministicEdgeMatrix';
export {
  SearchIndexBackfillService,
  BACKFILLABLE_ENTITIES,
  expandBackfillEntityTypes,
  type BackfillableEntity,
  type SearchIndexBackfillResult,
} from './services/SearchIndexBackfillService';
