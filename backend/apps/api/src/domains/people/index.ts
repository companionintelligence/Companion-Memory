/**
 * The rebuilt people system (issue #1810): source profiles + a canonical
 * Person, transitive identity chaining on strong identifiers (email/phone),
 * a real person-merge with tombstones, sticky user corrections, and one
 * promotion service every people-creation path funnels through.
 *
 * - {@link PeoplePromotionService.observeProfile} — the single entry point:
 *   upsert profile, index identifiers, create / attach / transitive-merge.
 * - {@link PersonMergeService} — transactional merge with repointing +
 *   tombstones; `resolveCanonicalEntityId` follows them so old ids never 404.
 * - {@link PeopleService} — the read surface every API plane (GraphQL, agent
 *   tools, REST) delegates to.
 * - {@link PersonDuplicateSuggestionService} — weak-signal (name-only)
 *   duplicate suggestions; never auto-merges.
 * - {@link PeopleBackfillService} — retrofit profiles onto an existing corpus
 *   and run the one-time dedupe pass.
 *
 * @module PeopleModule
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EventsModule } from '@ci/domains/events';
import { MemoryModule } from '@ci/domains/memory';

import { PersonDistinctionEntity } from './entities/PersonDistinctionEntity';
import { PersonDuplicateSuggestionEntity } from './entities/PersonDuplicateSuggestionEntity';
import { PersonProfileEntity } from './entities/PersonProfileEntity';
import { PeopleBackfillService } from './services/PeopleBackfillService';
import { PeoplePromotionService } from './services/PeoplePromotionService';
import { PeopleService } from './services/PeopleService';
import { PersonDuplicateSuggestionService } from './services/PersonDuplicateSuggestionService';
import { PersonMergeService } from './services/PersonMergeService';

/**
 * @internal
 *
 * NOTE: deliberately does NOT import GraphModule (graph imports people so
 * GraphIngestService can funnel through observeProfile); identifier reads and
 * writes here go straight at ci.entity_identifiers with the shared
 * normalization utils, imported from their leaf file to avoid the cycle.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      PersonProfileEntity,
      PersonDistinctionEntity,
      PersonDuplicateSuggestionEntity,
    ]),
    EventsModule,
    MemoryModule,
  ],
  providers: [
    PersonMergeService,
    PeoplePromotionService,
    PeopleService,
    PersonDuplicateSuggestionService,
    PeopleBackfillService,
  ],
  exports: [
    PersonMergeService,
    PeoplePromotionService,
    PeopleService,
    PersonDuplicateSuggestionService,
    PeopleBackfillService,
  ],
})
export class PeopleModule {}

export {
  PersonMergeService,
  PeoplePromotionService,
  PeopleService,
  PersonDuplicateSuggestionService,
  PeopleBackfillService,
};
export { PersonProfileEntity, PersonDistinctionEntity, PersonDuplicateSuggestionEntity };
export type { PersonProfile } from './entities/PersonProfileEntity';
export type { PersonDistinction } from './entities/PersonDistinctionEntity';
export type {
  PersonDuplicateSuggestion,
  SuggestionStatus,
} from './entities/PersonDuplicateSuggestionEntity';
export type { MergeOptions, MergeResult } from './services/PersonMergeService';
export { mergePersonProperties, USER_EDITED_FIELDS_KEY } from './services/PersonMergeService';
export type {
  ObservedProfileInput,
  ObserveProfileResult,
} from './services/PeoplePromotionService';
export type { PersonLookupHit, LookupMatchKind } from './services/PeopleService';
export type { PeopleDedupeOptions, PeopleDedupeResult } from './services/PeopleBackfillService';
export type { GenerateSuggestionsResult } from './services/PersonDuplicateSuggestionService';
