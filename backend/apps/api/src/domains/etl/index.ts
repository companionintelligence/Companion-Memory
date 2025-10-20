import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ConnectionsModule, ConnectionEntity } from '@ci/domains/connections';
import { EventsModule } from '@ci/domains/events';

import { EtlController } from './controllers/EtlController';
import { ApiLogEntity } from './entities/ApiLogEntity';
import { EtlService } from './services/EtlService';

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
  SyncResult,
  CalendarSyncResult,
  GmailSyncResult,
} from './types/syncTypes';
