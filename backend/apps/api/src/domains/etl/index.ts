/**
 * This module handles the Extract, Transform, and Load (ETL) processes for syncing
 * data from third-party services. It orchestrates fetching data from external APIs,
 * transforming it into a standardized format, and storing it within the application.
 *
 * ### Key Components:
 * - **ETL Service (`EtlService`)**: Contains the core logic for running synchronization
 *   jobs for various providers (e.g., Google).
 * - **ETL Controller (`EtlController`)**: Exposes API endpoints to trigger and manage
 *   the ETL sync processes.
 * - **API Logging (`ApiLogEntity`)**: Records logs of API calls made to external
 *   services during the ETL process for auditing and debugging.
 * - **Module Integration**: Works closely with the `ConnectionsModule` to manage API
 *   credentials and the `EventsModule` to store synchronized data.
 *
 * @module ETLModule
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ConnectionsModule, ConnectionEntity } from '@ci/domains/connections';
import { EventsModule } from '@ci/domains/events';

import { EtlController } from './controllers/EtlController';
import { ApiLogEntity } from './entities/ApiLogEntity';
import { EtlService } from './services/EtlService';

/**
 * @internal
 */
@Module({
  imports: [TypeOrmModule.forFeature([ApiLogEntity, ConnectionEntity]), ConnectionsModule, EventsModule],
  providers: [EtlService],
  controllers: [EtlController],
  exports: [EtlService],
})
export class EtlModule {}

// Entities
export { ApiLogEntity };

// Services
export { EtlService };

// Controllers
export { EtlController };

// Types
export type { ApiLog } from './types';
export type {
  CalendarSyncState,
  GmailSyncState,
  DriveSyncState,
  ContactsSyncState,
  YouTubeSyncState,
  GoogleSyncState,
  OutlookMailSyncState,
  OutlookCalendarsSyncState,
  OutlookCalendarSyncState,
  OneDriveSyncState,
  FacebookSyncState,
  SyncResult,
  CalendarSyncResult,
  GmailSyncResult,
} from './types/syncTypes';
