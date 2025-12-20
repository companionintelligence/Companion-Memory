/**
 * This module is responsible for "promoting" raw data synced from external sources
 * into the application's structured knowledge graph (managed by the `MemoryModule`).
 * It acts as a transformation layer, taking data from ETL processes and converting it
 * into meaningful, interconnected entities like people, events, and content within
 * the user's memory.
 *
 * ### Key Components:
 * - **`PromoteService`**: A central service that orchestrates the overall promotion process.
 * - **Specialized Promotion Services**: A suite of services, such as `GmailPromotionService`
 *   and `ContactsPromotionService`, each tailored to handle the transformation logic for a
 *   specific type of data from a specific provider (e.g., Google).
 * - **`PromoteController`**: Exposes API endpoints to trigger and manage data promotion tasks.
 *
 * ### Module Integration:
 * - **`EtlModule`**: Consumes the output of ETL sync jobs as the source for promotion.
 * - **`MemoryModule`**: The destination for the transformed data, where it is stored as
 *   nodes and relationships in the knowledge graph.
 * - **`EventsModule`**: Listens for events (e.g., `sync.connection.success`) to trigger
 *   promotion tasks asynchronously.
 * - **`ConnectionsModule` & `UserModule`**: To access connection details and associate
 *   promoted data with the correct user.
 *
 * @module PromoteModule
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ConnectionsModule, ConnectionEntity } from '@ci/domains/connections';
import { EtlModule, ApiLogEntity } from '@ci/domains/etl';
import { EventsModule } from '@ci/domains/events';
import { FilesModule, FileEntity } from '@ci/domains/files';
import { GraphModule } from '@ci/domains/graph';
import { MemoryModule, GraphNodeEntity, RelationshipEntity, ContentEntity } from '@ci/domains/memory';
import { OneDrivePromotionService } from '@ci/domains/promote/services/microsoft/OneDrivePromotionService';
import { OutlookCalendarPromotionService } from '@ci/domains/promote/services/microsoft/OutlookCalendarPromotionService';
import { SearchNextModule } from '@ci/domains/search-next';
import { UserModule } from '@ci/domains/user';

import { PromoteController as FacebookPromoteController } from './controllers/facebook/PromoteController';
import { PromoteController } from './controllers/google/PromoteController';
import { PromoteController as MicrosoftPromoteController } from './controllers/microsoft/PromoteController';
import { FacebookFriendsPromotionService } from './services/facebook/FacebookFriendsPromotionService';
import { FacebookLikesPromotionService } from './services/facebook/FacebookLikesPromotionService';
import { FacebookPhotosPromotionService } from './services/facebook/FacebookPhotosPromotionService';
import { FacebookPostsPromotionService } from './services/facebook/FacebookPostsPromotionService';
import { FacebookProfilePromotionService } from './services/facebook/FacebookProfilePromotionService';
import { FacebookPromotionUtils } from './services/facebook/FacebookPromotionUtils';
import { FacebookVideosPromotionService } from './services/facebook/FacebookVideosPromotionService';
import { GoogleCalendarEventPromotionService } from './services/google/CalendarPromotionService';
import { ContactsPromotionService } from './services/google/ContactsPromotionService';
import { DrivePromotionService } from './services/google/DrivePromotionService';
import { GmailPromotionService } from './services/google/GmailPromotionService';
import { YouTubePromotionService } from './services/google/YouTubePromotionService';
import { OutlookMailPromotionService } from './services/microsoft/OutlookMailPromotionService';
import { PromoteService } from './services/PromoteService';

/**
 * @internal
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ApiLogEntity,
      ConnectionEntity,
      GraphNodeEntity,
      RelationshipEntity,
      FileEntity,
      ContentEntity,
    ]),
    ConnectionsModule,
    EtlModule,
    EventsModule,
    FilesModule,
    GraphModule,
    MemoryModule,
    SearchNextModule,
    UserModule,
  ],
  providers: [
    PromoteService,
    GmailPromotionService,
    GoogleCalendarEventPromotionService,
    YouTubePromotionService,
    DrivePromotionService,
    ContactsPromotionService,
    OutlookMailPromotionService,
    OutlookCalendarPromotionService,
    OneDrivePromotionService,
    FacebookPromotionUtils,
    FacebookProfilePromotionService,
    FacebookPostsPromotionService,
    FacebookPhotosPromotionService,
    FacebookVideosPromotionService,
    FacebookFriendsPromotionService,
    FacebookLikesPromotionService,
  ],
  controllers: [PromoteController, MicrosoftPromoteController, FacebookPromoteController],
  exports: [
    PromoteService,
    GmailPromotionService,
    GoogleCalendarEventPromotionService,
    YouTubePromotionService,
    DrivePromotionService,
    ContactsPromotionService,
  ],
})
export class PromoteModule {}
