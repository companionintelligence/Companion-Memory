/**
 * This module is executing search queries against the Companion Intelligence
 * search index and for manipulating entity tags.
 *
 * @module SearchNextModule
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EmbeddingModule } from '@ci/common/embeddings';
import { EventsModule } from '@ci/domains/events';
import { RetrievalPolicyModule } from '@ci/domains/retrieval-policy';

import { CategoryDirectionOptoutEntity } from './entities/CategoryDirectionOptoutEntity';
import { type EntityCategory, EntityCategoryEntity } from './entities/EntityCategoryEntity';
import { type EntityTag, EntityTagEntity } from './entities/EntityTagEntity';
import { TagCategoryEntity } from './entities/TagCategoryEntity';
import { TagDirectionEntity } from './entities/TagDirectionEntity';
import { type Tag, type TimestampedTag, TagEntity } from './entities/TagEntity';
import { SearchService } from './services/SearchService';
import { type RemoveTagResult, TagService, type UpdateTagResult } from './services/TagService';

/**
 * @internal
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      EntityTagEntity,
      TagEntity,
      TagDirectionEntity,
      TagCategoryEntity,
      CategoryDirectionOptoutEntity,
      EntityCategoryEntity,
    ]),
    EmbeddingModule,
    RetrievalPolicyModule,
    // SearchService emits `retrieval.query` onto the `telemetry` queue — the
    // only record of what a REAL query returned. See domains/search-next/events.ts.
    EventsModule,
  ],
  providers: [SearchService, TagService],
  exports: [SearchService, TagService],
})
export class SearchNextModule {}

export { SearchService, TagService };
export {
  type AnchoredSearchOptions,
  RRF_DEFAULT_K,
  reciprocalRankFusion,
  SEMANTIC_DISTANCE_THRESHOLD,
  SEMANTIC_MAX_RESULTS,
  type SearchModeTaken,
  type SearchPage,
  type SemanticSearchPlan,
  type SemanticSearchScope,
} from './services/SearchService';
export type { EntityCategory, EntityTag, RemoveTagResult, Tag, TimestampedTag, UpdateTagResult };
export { DEVICE_INDEXED_ENTITIES, INDEXABLE_ENTITIES, TAG_KINDS, TAGGABLE_ENTITIES } from './types';
export type {
  DeviceIndexedEntity,
  EntityIdentifier,
  IndexableEntity,
  PromptSearchResult,
  TagKind,
  TaggableEntity,
} from './types';
export { entityTimeSql } from './entityTime';
export {
  CONVERSATION_NAMESPACE,
  DEVICE_PARTICIPANTS_MAX_CHARS,
  DEVICE_RECORD_VERSION,
  entityDeviceRecordSql,
} from './entityDeviceRecord';
export { buildPromptQuery, hasNameSubjectFrame, promptAsksForPhotos } from './promptQuery';
export { resolveAutoMode } from './services/SearchService';
export {
  queryTokenCount,
  type RetrievalCaller,
  RetrievalQueryEvent,
  type RetrievalQueryPayload,
} from './events';
export type { BuildPromptQueryOptions, PromptQueryGroup } from './promptQuery';
