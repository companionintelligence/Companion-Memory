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
import { ProviderConfigEntity } from './entities/ProviderConfigEntity';
import { ApiSpecEntity } from './entities/ApiSpecEntity';
import { TransformMapEntity } from './entities/TransformMapEntity';
import { EtlService } from './services/EtlService';
import { ProviderRegistry } from './services/ProviderRegistry';
import { ApiClient } from './services/ApiClient';
import { TransformEngine } from './services/TransformEngine';
import { SyncEngine } from './services/SyncEngine';
import { RateLimiter } from './services/RateLimiter';

/**
 * @internal
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ApiLogEntity,
      ConnectionEntity,
      ProviderConfigEntity,
      ApiSpecEntity,
      TransformMapEntity,
    ]),
    ConnectionsModule,
    EventsModule,
  ],
  providers: [
    EtlService,
    ProviderRegistry,
    ApiClient,
    TransformEngine,
    SyncEngine,
    RateLimiter,
  ],
  controllers: [EtlController],
  exports: [
    EtlService,
    ProviderRegistry,
    ApiClient,
    TransformEngine,
    SyncEngine,
    RateLimiter,
  ],
})
export class EtlModule {}

// Entities
export { ApiLogEntity };
export { ProviderConfigEntity };
export { ApiSpecEntity };
export { TransformMapEntity };

// Services
export { EtlService };
export { ProviderRegistry };
export { ApiClient };
export { TransformEngine };
export { SyncEngine };
export { RateLimiter };

// Controllers
export { EtlController };

// Transformers
export * from './transformers';

// Types
export type { ApiLog } from './types';

// Legacy sync types (deprecated - use types/sync.ts)
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

// New ETL system types
export type {
  ProviderConfig,
  ProviderSource,
  ProviderTheme,
  OAuthConfig,
  CreateProviderConfigDto,
  UpdateProviderConfigDto,
} from './types/provider';

export type {
  ApiSpec,
  EndpointSpec,
  ParamSpec,
  PaginationConfig,
  RateLimitConfig,
  ApiMetadata,
  CreateApiSpecDto,
  UpdateApiSpecDto,
} from './types/api-spec';

export type {
  TransformMap,
  FieldMapping,
  ComputedField,
  TypeTransform,
  TransformMapMetadata,
  TransformResult,
  CreateTransformMapDto,
  UpdateTransformMapDto,
} from './types/transform';

export type {
  SyncResponse,
  SourceSyncResult,
  ConnectionSyncResult,
  SyncJob,
  SyncJobStatus,
  SyncOptions,
  RateLimiterState,
  ApiRequestMetadata,
} from './types/sync';
