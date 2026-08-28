import { Injectable } from '@nestjs/common';

import { SYSTEM_USER, type ServiceContext } from '@ci/common/context';
import { EmbeddingGenerationService, shouldEmbedType } from '@ci/common/embeddings';
import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';
import { type Person, PersonService } from '@ci/domains/memory';
import {
  PersonCreatedEvent,
  PersonUpdatedEvent,
  PersonRemovedEvent,
  type PersonCreatedPayload,
  type PersonUpdatedPayload,
  type PersonDeletedPayload,
} from '@ci/domains/memory/events';
import { personSearchDocument, personWeightedTexts } from '@ci/domains/search-ingress/searchTexts';

import { EmbeddingService } from '../services/EmbeddingService';
import { IndexSkipService } from '../services/IndexSkipService';
import { VectorService } from '../services/VectorService';
import { type WeightedText } from '../types';

@Injectable()
export class PersonSearchIndexListener {
  constructor(
    private readonly personService: PersonService,
    private readonly embeddingGenerationService: EmbeddingGenerationService,
    private readonly embeddingService: EmbeddingService,
    private readonly indexSkipService: IndexSkipService,
    private readonly vectorService: VectorService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PersonSearchIndexListener.name);
  }

  @OnEvent(PersonCreatedEvent, { queue: 'search-index' })
  async indexPerson(payload: PersonCreatedPayload | PersonUpdatedPayload) {
    this.logger.log('Adding new person to search index', {
      personId: payload.personId,
    });

    await this.upsertPerson(payload);
  }

  @OnEvent(PersonUpdatedEvent, { queue: 'search-index' })
  async updatePerson(payload: PersonCreatedPayload | PersonUpdatedPayload) {
    this.logger.log('Updating person in search index', {
      personId: payload.personId,
    });

    await this.upsertPerson(payload);
  }

  @OnEvent(PersonRemovedEvent, { queue: 'search-index' })
  async unindexPerson(payload: PersonDeletedPayload) {
    this.logger.log('Removing person in search index', {
      personId: payload.personId,
    });

    const context = {
      userId: SYSTEM_USER,
    } satisfies ServiceContext;

    await this.embeddingService.remove(context, {
      entityType: 'person',
      entityId: payload.personId,
    });

    this.logger.log('Removed embedding for person');

    await this.vectorService.remove(context, {
      entityType: 'person',
      entityId: payload.personId,
    });

    this.logger.log('Removed tsvector for person');
  }

  private async upsertPerson(payload: PersonCreatedPayload | PersonUpdatedPayload) {
    const context = {
      userId: SYSTEM_USER,
    } satisfies ServiceContext;

    const person = await this.personService.findById(context, payload.personId);

    if (person == null) {
      this.logger.warn('Person not found, skipping indexing');

      return;
    }

    // Merge tombstones must never (re-)enter the search index — the merge
    // deleted their embedding + vector rows on purpose. Remove any stale rows
    // defensively in case an update event raced the merge.
    if (person.mergedIntoEntityId != null) {
      this.logger.log('Person is a merge tombstone, removing from search index', {
        personId: person.id,
      });

      await this.embeddingService.remove(context, { entityType: 'person', entityId: person.id });
      await this.vectorService.remove(context, { entityType: 'person', entityId: person.id });

      return;
    }

    if (person.userId == null) {
      this.logger.warn('Person has no associated user, cannot index');

      return;
    }

    const searchDocument = this.getSearchDocument(person);

    if (!shouldEmbedType('person')) {
      this.logger.log('Person type not in embed allowlist, skipping embedding');
    } else if (searchDocument == null) {
      this.logger.log('Person has no search document, skipping embedding');

      // Persist the skip so the backfill sweep (LEFT JOIN on ci_search.embeddings)
      // stops re-finding this person on every run. Persons only skip on 'empty' —
      // the message-tuned embedSkipReason heuristics (too-short/trivial) don't
      // apply, because a bare short name is exactly what a person doc looks like.
      await this.indexSkipService.recordSkip({
        entityType: 'person',
        entityId: person.id,
        reason: 'empty',
      });
    } else {
      const embedding = await this.embeddingGenerationService.generateEmbedding(searchDocument);

      await this.embeddingService.upsert(
        {
          userId: person.userId,
        },
        {
          entityType: 'person',
          entityId: person.id,
          embedding,
        },
      );

      // An updated person that gained a name/description is no longer skipped.
      await this.indexSkipService.clearSkip({
        entityType: 'person',
        entityId: person.id,
      });

      this.logger.log('Generated embedding for person');
    }

    const searchContent = this.getSearchContent(person);

    if (searchContent.length === 0) {
      this.logger.log('Person has no search content, skipping vectorization');
    } else {
      await this.vectorService.upsert(
        {
          userId: person.userId,
        },
        {
          entityType: 'person',
          entityId: person.id,
          searchableText: searchContent,
        },
      );

      this.logger.log('Generated tsvector for person');
    }
  }

  private getSearchContent(person: Person): WeightedText[] {
    return personWeightedTexts(person);
  }

  private getSearchDocument(person: Person): string | null {
    return personSearchDocument(person);
  }
}
