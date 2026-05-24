import { Injectable } from '@nestjs/common';

import { ServiceContext, SYSTEM_USER } from '@ci/common/context';
import { EmbeddingGenerationService } from '@ci/common/embeddings';
import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';
import { type Place, PlaceService } from '@ci/domains/memory';
import {
  PlaceCreatedEvent,
  PlaceRemovedEvent,
  PlaceUpdatedEvent,
  type PlaceCreatedPayload,
  type PlaceDeletedPayload,
  type PlaceUpdatedPayload,
} from '@ci/domains/memory/events';
import { EmbeddingService } from '@ci/domains/search-ingress/services/EmbeddingService';
import { VectorService } from '@ci/domains/search-ingress/services/VectorService';
import { type WeightedText } from '@ci/domains/search-ingress/types';

@Injectable()
export class PlaceSearchIndexListener {
  constructor(
    private readonly placeService: PlaceService,
    private readonly embeddingGenerationService: EmbeddingGenerationService,
    private readonly embeddingService: EmbeddingService,
    private readonly vectorService: VectorService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PlaceSearchIndexListener.name);
  }

  @OnEvent(PlaceCreatedEvent, { queue: 'search-index' })
  async indexPlace(payload: PlaceCreatedPayload | PlaceUpdatedPayload) {
    this.logger.log('Adding new place to search index', {
      placeId: payload.placeId,
    });

    await this.upsertPlace(payload);
  }

  @OnEvent(PlaceUpdatedEvent, { queue: 'search-index' })
  async updatePlace(payload: PlaceCreatedPayload | PlaceUpdatedPayload) {
    this.logger.log('Updating place in search index', {
      placeId: payload.placeId,
    });

    await this.upsertPlace(payload);
  }

  @OnEvent(PlaceRemovedEvent, { queue: 'search-index' })
  async unindexPlace(payload: PlaceDeletedPayload) {
    this.logger.log('Removing place in search index', {
      placeId: payload.placeId,
    });

    const context = {
      userId: SYSTEM_USER,
    } satisfies ServiceContext;

    await this.embeddingService.remove(context, {
      entityType: 'place',
      entityId: payload.placeId,
    });

    this.logger.log('Removed embedding for place');

    await this.vectorService.remove(context, {
      entityType: 'place',
      entityId: payload.placeId,
    });

    this.logger.log('Removed tsvector for place');
  }

  private async upsertPlace(payload: PlaceCreatedPayload | PlaceUpdatedPayload) {
    const context = {
      userId: SYSTEM_USER,
    } satisfies ServiceContext;

    const place = await this.placeService.findById(context, payload.placeId);

    if (place == null) {
      this.logger.warn('Place not found, skipping indexing');

      return;
    }

    if (place.user?.id == null) {
      this.logger.warn('Place has no associated user, cannot index');

      return;
    }

    const searchDocument = this.getSearchDocument(place);

    if (searchDocument == null) {
      this.logger.log('Place has no search document, skipping embedding');
    } else {
      const embedding = await this.embeddingGenerationService.generateEmbedding(searchDocument);

      await this.embeddingService.upsert(
        {
          userId: place.user.id,
        },
        {
          entityType: 'place',
          entityId: place.id,
          embedding,
        },
      );

      this.logger.log('Generated embedding for place');
    }

    const searchPlace = this.getSearchPlace(place);

    if (searchPlace.length === 0) {
      this.logger.log('Place has no search place, skipping vectorization');
    } else {
      await this.vectorService.upsert(
        {
          userId: place.user.id,
        },
        {
          entityType: 'place',
          entityId: place.id,
          searchableText: searchPlace,
        },
      );

      this.logger.log('Generated tsvector for place');
    }
  }

  private getSearchPlace(place: Place): WeightedText[] {
    const parts: WeightedText[] = [];

    if (place.name) {
      parts.push({ text: place.name, weight: 10 });
    }

    if (place.description) {
      parts.push({ text: place.description, weight: 5 });
    }

    const placeType = place.properties?.type;
    if (typeof placeType === 'string' && placeType.length > 0) {
      parts.push({ text: placeType, weight: 3 });
    }

    return parts;
  }

  private getSearchDocument(place: Place): string | null {
    const parts = new Set<string>();

    const push = (value: unknown) => {
      if (typeof value !== 'string') {
        return;
      }

      const normalized = value.trim();

      if (normalized.length === 0) {
        return;
      }

      parts.add(normalized);
    };

    push(place.name ?? null);
    push(place.description ?? null);
    push(place.properties?.type ?? null);

    const result = Array.from(parts).join(' ');

    return result.length > 0 ? result : null;
  }
}
