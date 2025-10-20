import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ConnectionsModule, ConnectionEntity } from '@ci/domains/connections';
import { EtlModule, ApiLogEntity } from '@ci/domains/etl';
import { EventsModule } from '@ci/domains/events';
import { FilesModule } from '@ci/domains/files';
import { GraphModule, GraphNodeEntity, RelationshipEntity } from '@ci/domains/graph';
import { MemoryModule } from '@ci/domains/memory';
import { OutlookCalendarPromotionService } from '@ci/domains/promote/services/microsoft/OutlookCalendarPromotionService';
import { UserModule, UserEntity } from '@ci/domains/user';

import { PromoteController as MicrosoftPromoteController } from './controllers/microsoft/PromoteController';
import { PromoteController } from './controllers/PromoteController';
import { GoogleCalendarEventPromotionService } from './services/google/CalendarPromotionService';
import { ContactsPromotionService } from './services/google/ContactsPromotionService';
import { DrivePromotionService } from './services/google/DrivePromotionService';
import { GmailPromotionService } from './services/google/GmailPromotionService';
import { YouTubePromotionService } from './services/google/YouTubePromotionService';
import { OutlookMailPromotionService } from './services/microsoft/OutlookMailPromotionService';
import { PersonPromotionService } from './services/PersonPromotionService';
import { PromoteService } from './services/PromoteService';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ApiLogEntity,
      ConnectionEntity,
      GraphNodeEntity,
      RelationshipEntity,
      UserEntity,
    ]),
    ConnectionsModule,
    FilesModule,
    EtlModule,
    EventsModule,
    MemoryModule,
    GraphModule,
    UserModule,
  ],
  providers: [
    PromoteService,
    GmailPromotionService,
    GoogleCalendarEventPromotionService,
    YouTubePromotionService,
    DrivePromotionService,
    ContactsPromotionService,
    PersonPromotionService,
    OutlookMailPromotionService,
    OutlookCalendarPromotionService,
  ],
  controllers: [PromoteController, MicrosoftPromoteController],
  exports: [
    PromoteService,
    GmailPromotionService,
    GoogleCalendarEventPromotionService,
    YouTubePromotionService,
    DrivePromotionService,
    ContactsPromotionService,
    PersonPromotionService,
  ],
})
export class PromoteModule {}
