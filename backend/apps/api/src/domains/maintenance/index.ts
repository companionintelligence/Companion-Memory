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
import { EventEntity } from '@ci/domains/memory';
import { SearchIngressModule } from '@ci/domains/search-ingress';

import { MaintenanceController } from './controllers/MaintenanceController';
import { CommunicationLinkBackfillService } from './services/CommunicationLinkBackfillService';
import { IndexDeferralService } from './services/IndexDeferralService';

/**
 * @internal
 */
@Module({
  imports: [TypeOrmModule.forFeature([EventEntity]), EventsModule, SearchIngressModule, GraphModule],
  controllers: [MaintenanceController],
  providers: [IndexDeferralService, CommunicationLinkBackfillService],
  exports: [IndexDeferralService, CommunicationLinkBackfillService],
})
export class MaintenanceModule {}
