/**
 * This module is executing search queries against the Companion Intelligence
 * search index and for manipulating entity tags.
 *
 * @module SearchNextModule
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { type EntityTag, EntityTagEntity } from './entities/EntityTagEntity';
import { type Tag, type TimestampedTag, TagEntity } from './entities/TagEntity';
import { TagService } from './services/TagService';

/**
 * @internal
 */
@Module({
  imports: [TypeOrmModule.forFeature([TagEntity, EntityTagEntity])],
  providers: [TagService],
  exports: [TagService],
})
export class SearchNextModule {}

export { TagService };
export type { EntityTag, Tag, TimestampedTag };
export type { EntityIdentifier, IndexableEntity } from './types';
