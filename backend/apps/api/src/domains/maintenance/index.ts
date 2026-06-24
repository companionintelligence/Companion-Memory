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
import { EventEntity } from '@ci/domains/memory';

import { MaintenanceController } from './controllers/MaintenanceController';
import { IndexDeferralService } from './services/IndexDeferralService';

/**
 * @internal
 */
@Module({
  imports: [TypeOrmModule.forFeature([EventEntity]), EventsModule],
  controllers: [MaintenanceController],
  providers: [IndexDeferralService],
  exports: [IndexDeferralService],
})
export class MaintenanceModule {}
