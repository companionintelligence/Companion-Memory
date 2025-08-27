import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ContentEntity } from '@ci/domains/memory/entities/ContentEntity';
import { UserModule } from '@ci/domains/user';

import { ContentController } from './controllers/ContentController';
import { EventController } from './controllers/EventController';
import { MemoryController } from './controllers/MemoryController';
import { ContactEntity } from './entities/ContactEntity';
import { EventEntity } from './entities/EventEntity';
import { LocationEntity } from './entities/LocationEntity';
import { PersonEntity } from './entities/PersonEntity';
import { PlaceEntity } from './entities/PlaceEntity';
import { ThingEntity } from './entities/ThingEntity';
import { ContentService } from './services/ContentService';
import { EventService } from './services/EventService';
import { MemoryService } from './services/MemoryService';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ContactEntity,
      ContentEntity,
      EventEntity,
      LocationEntity,
      PersonEntity,
      PlaceEntity,
      ThingEntity,
    ]),
    UserModule,
  ],
  providers: [MemoryService, ContentService, EventService],
  controllers: [MemoryController, ContentController, EventController],
  exports: [MemoryService, ContentService, EventService],
})
export class MemoryModule {}

// Entities
export { ContactEntity, ContentEntity, EventEntity, LocationEntity, PersonEntity, PlaceEntity, ThingEntity };

// Services
export { MemoryService };

// Types
export type { Memory, MemoryLocation, MemoryResponse, MemorySearchParams } from './types';
