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
import { SearchIngressModule } from '@ci/domains/search-ingress';

import { MaintenanceController } from './controllers/MaintenanceController';
import { EstimateLocationBatchListener } from './listeners/EstimateLocationBatchListener';
import { CommunicationLinkBackfillService } from './services/CommunicationLinkBackfillService';
import { EventParticipantBackfillService } from './services/EventParticipantBackfillService';
import { GraphEnrichmentService } from './services/GraphEnrichmentService';
import { IndexDeferralService } from './services/IndexDeferralService';
import { LocationEstimateService } from './services/LocationEstimateService';
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
  ],
  controllers: [MaintenanceController],
  providers: [
    IndexDeferralService,
    CommunicationLinkBackfillService,
    EventParticipantBackfillService,
    GraphEnrichmentService,
    SearchIndexBackfillService,
    LocationEstimateService,
    EstimateLocationBatchListener,
  ],
  exports: [
    IndexDeferralService,
    CommunicationLinkBackfillService,
    EventParticipantBackfillService,
    GraphEnrichmentService,
    SearchIndexBackfillService,
    LocationEstimateService,
  ],
})
export class MaintenanceModule {}
