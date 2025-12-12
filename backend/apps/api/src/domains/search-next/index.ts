/**
 * This module is executing search queries against the Companion Intelligence
 * search index and for manipulating entity tags.
 *
 * @module SearchNextModule
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EmbeddingModule } from '@ci/common/embeddings';

import { EmbeddingEntity } from './entities/EmbeddingEntity';
import { type EntityTag, EntityTagEntity } from './entities/EntityTagEntity';
import { type Tag, type TimestampedTag, TagEntity } from './entities/TagEntity';
import { VectorEntity } from './entities/VectorEntity';
import { SearchService } from './services/SearchService';
import { TagService } from './services/TagService';

/**
 * @internal
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([EmbeddingEntity, EntityTagEntity, TagEntity, VectorEntity]),
    EmbeddingModule,
  ],
  providers: [SearchService, TagService],
  exports: [SearchService, TagService],
})
export class SearchNextModule {}

export { SearchService, TagService };
export type { EntityTag, Tag, TimestampedTag };
export type { EntityIdentifier, IndexableEntity, TaggableEntity } from './types';
