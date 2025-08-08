import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { UserModule } from '@ci/domains/user';

import { ContactEntity } from './entities/ContactEntity';
import { ContentEntity } from './entities/ContentEntity';
import { EventEntity } from './entities/EventEntity';
import { LocationEntity } from './entities/LocationEntity';
import { PersonEntity } from './entities/PersonEntity';
import { PlaceEntity } from './entities/PlaceEntity';
import { ThingEntity } from './entities/ThingEntity';

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
  providers: [],
  controllers: [],
})
export class MemoryModule {}

// Entities
export { ContactEntity, ContentEntity, EventEntity, LocationEntity, PersonEntity, PlaceEntity, ThingEntity };
