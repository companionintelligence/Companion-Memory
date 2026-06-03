/**
 * GraphNodeSearchIndexListener
 *
 * Bridges the generic `GRAPH_NODE_UPSERTED` event into the search index for
 * entity types whose per-type domain service does not own the row.
 *
 * Most types (Person, Concept, Place) map their TypeORM entity to `ci.entities`
 * — the same table the generic graph writer uses — so the per-type
 * `*SearchIndexListener`s (PersonSearchIndexListener, etc.) can find and index
 * them.  But Item, Content, and Event map to dedicated tables
 * (`ci.inventory`, `ci.content`, `ci.events`).  When `MemoryCompactionService`
 * extracts one of those and writes through `graphEvents.upsertNode`, the row
 * lands in `ci.entities` only — `itemService.findById` / `contentService.findById`
 * / `eventService.findById` return null and their per-type listeners log
 * "not found, skipping indexing" and exit.  The entity is then invisible to
 * `/api/memory/recall`.
 *
 * This listener closes that gap by indexing directly from the event payload
 * (which already carries `name`, `description`, and `properties`) — no
 * domain-service lookup required.  `EmbeddingService.upsert` and
 * `VectorService.upsert` are both idempotent on `(entityType, entityId, userId)`,
 * so running alongside the per-type listeners for Person/Concept/Place is
 * harmless overlap, not duplication.
 */

import { Injectable } from '@nestjs/common';

import { EmbeddingGenerationService } from '@ci/common/embeddings';
import { LoggerService } from '@ci/common/logging';
import { type EventPayloads, Events, OnEvent } from '@ci/domains/events';

import { EmbeddingService } from '../services/EmbeddingService';
import { VectorService } from '../services/VectorService';
import { type WeightedText } from '../types';

@Injectable()
export class GraphNodeSearchIndexListener {
  constructor(
    private readonly embeddingGenerationService: EmbeddingGenerationService,
    private readonly embeddingService: EmbeddingService,
    private readonly vectorService: VectorService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(GraphNodeSearchIndexListener.name);
  }

  /**
   * Entity types the compaction pipeline produces.  Other graph types
   * (RPC, File, etc.) flow through their own dedicated listeners and we
   * don't want to shadow them.
   *
   * `person` / `concept` / `place` map their TypeORM entity to `ci.entities`,
   * so RecallService's `EntityResolutionService` finds them by id and they
   * round-trip cleanly under their own tag.
   *
   * `item` / `content` / `event` map to dedicated tables (`ci.inventory`,
   * `ci.content`, `ci.events`) — the row we wrote lives in `ci.entities` and
   * itemService/contentService/eventService.findByIds returns null for it.
   * As a workaround we index those vectors under the `concept` tag so the
   * resolver's conceptService.findByIds (which queries `ci.entities` by id
   * with no type filter) hydrates the row.  The serializer formats by
   * name+description regardless of tag, so the recall block reads correctly
   * (e.g. "Mochi — Greyhound rescued about a year ago").  This is a
   * pragmatic shortcut; the structural fix is to teach the resolver to fall
   * back to `ci.entities` when the dedicated table comes up empty.
   */
  private static readonly NATIVE_GRAPH_TYPES = new Set(['person', 'concept', 'place']);

  private static readonly DEDICATED_TABLE_TYPES = new Set(['item', 'content', 'event']);

  @OnEvent(Events.GRAPH_NODE_UPSERTED, { queue: 'search-index' })
  async indexGraphNode(payload: EventPayloads[Events.GRAPH_NODE_UPSERTED]) {
    const node = payload.node;
    const rawType = node.entityType?.toLowerCase() ?? '';

    if (!node.entityId) {
      return;
    }

    let entityType: 'person' | 'concept' | 'place';
    if (GraphNodeSearchIndexListener.NATIVE_GRAPH_TYPES.has(rawType)) {
      entityType = rawType as 'person' | 'concept' | 'place';
    } else if (GraphNodeSearchIndexListener.DEDICATED_TABLE_TYPES.has(rawType)) {
      entityType = 'concept';
    } else {
      return;
    }

    const name = (node.name ?? '').trim();
    const description = (node.description ?? '').trim();
    const searchDocument = [name, description].filter(Boolean).join(' ').trim();

    if (!searchDocument) {
      return;
    }

    const searchableText: WeightedText[] = [];
    if (name) {
      searchableText.push({ text: name, weight: 10 });
    }

    if (description) {
      searchableText.push({ text: description, weight: 5 });
    }

    try {
      const embedding = await this.embeddingGenerationService.generateEmbedding(searchDocument);

      await this.embeddingService.upsert(
        { userId: payload.ownerId },
        {
          entityType,
          entityId: node.entityId,
          embedding,
        },
      );

      await this.vectorService.upsert(
        { userId: payload.ownerId },
        {
          entityType,
          entityId: node.entityId,
          searchableText,
        },
      );
    } catch (error) {
      this.logger.warn('Failed to index graph node into search', {
        ownerId: payload.ownerId,
        entityId: node.entityId,
        entityType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
