import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { BrowserActivityCreatedEvent } from '@ci/domains/browser-activity/events';
import { EventService as SignallingEventService } from '@ci/domains/events';
import {
  CommunicationCreatedEvent,
  ContentCreatedEvent,
  EventCreatedEvent,
  ItemCreatedEvent,
} from '@ci/domains/memory/events';
import { ENTITY_SOURCE_MAP } from '@ci/domains/search-ingress';

/**
 * The search-index pgboss queue the *SearchIndexListeners consume. Re-emitting a
 * `*CreatedEvent` scoped to THIS queue (EventService.send(..., { queue })) re-drives
 * the same embedding + tsvector indexing the live path used, WITHOUT the per-row
 * fan-out to every other queue.
 */
const SEARCH_INDEX_QUEUE = 'search-index';

/**
 * Entity types this backfill re-indexes — the bulk-ingest tables whose
 * createMany() no longer emits a per-row `*CreatedEvent` (the per-row pgboss
 * fan-out was the dominant cost at import volume). Search indexing for
 * bulk-loaded rows is recovered here instead, as a post-load sweep.
 */
export const BACKFILLABLE_ENTITIES = [
  'communication',
  'event',
  'content',
  'item',
  'browser-activity',
] as const;

export type BackfillableEntity = (typeof BACKFILLABLE_ENTITIES)[number];

export interface SearchIndexBackfillOptions {
  /** Restrict the sweep to these entity types (default: all backfillable types). */
  entityTypes?: BackfillableEntity[];
  /** Source rows scanned + re-emitted per page (default 1000). */
  batchSize?: number;
  /** Hard cap on rows re-emitted PER entity type (default: unbounded). */
  limitPerType?: number;
}

export interface SearchIndexBackfillResult {
  /** Total rows re-emitted onto the search-index queue across all types. */
  enqueued: number;
  /** Rows re-emitted per entity type. */
  perType: Record<string, number>;
}

/**
 * Post-load batch (re)index of bulk-ingested rows.
 *
 * Bulk ingest writes directly to `ci.<table>` and no longer emits a per-row
 * `*CreatedEvent`, so freshly bulk-loaded rows have no `ci_search.embeddings`
 * row yet. This service finds those un-indexed rows (LEFT JOIN against
 * `ci_search.embeddings`) and re-emits the matching `*CreatedEvent` onto the
 * `search-index` queue ONLY — so the existing `*SearchIndexListener` does the
 * embedding + tsvector upsert (idempotent), the batched-Ollama coalescing buffer
 * amortises the embed calls, and no other enrichment queue is touched.
 *
 * It is re-runnable and incremental: a row already carrying an embedding is
 * skipped by the LEFT JOIN, so a second run only picks up what is still missing.
 */
@Injectable()
export class SearchIndexBackfillService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly events: SignallingEventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(SearchIndexBackfillService.name);
  }

  async backfill(options: SearchIndexBackfillOptions = {}): Promise<SearchIndexBackfillResult> {
    const batchSize = options.batchSize ?? 1000;
    const types = options.entityTypes ?? [...BACKFILLABLE_ENTITIES];

    const perType: Record<string, number> = {};
    let enqueued = 0;

    for (const entityType of types) {
      const count = await this.backfillType(entityType, batchSize, options.limitPerType);
      perType[entityType] = count;
      enqueued += count;
      this.logger.log('Search-index backfill: type complete', { entityType, enqueued: count });
    }

    return { enqueued, perType };
  }

  /**
   * Keyset-page over the source table's rows that have no embedding yet, re-emitting
   * each id's create event onto the search-index queue. Paging on the id column keeps
   * the working set bounded over a multi-million-row table.
   */
  private async backfillType(
    entityType: BackfillableEntity,
    batchSize: number,
    limitPerType: number | undefined,
  ): Promise<number> {
    let after: string | null = null;
    let enqueued = 0;

    for (;;) {
      const ids = await this.missingIds(entityType, batchSize, after);
      if (ids.length === 0) {
        break;
      }

      for (const id of ids) {
        await this.emit(entityType, id);
        enqueued += 1;
        if (limitPerType != null && enqueued >= limitPerType) {
          return enqueued;
        }
      }

      after = ids[ids.length - 1];
    }

    return enqueued;
  }

  /**
   * Ids of source rows with no matching `ci_search.embeddings` row, after the
   * keyset cursor. Table / id column come from the authoritative ENTITY_SOURCE_MAP
   * (trusted constants, not request input), so interpolating them is safe.
   */
  private async missingIds(
    entityType: BackfillableEntity,
    batchSize: number,
    after: string | null,
  ): Promise<string[]> {
    const source = ENTITY_SOURCE_MAP[entityType];
    const discriminator = source.discriminator
      ? `AND s."${source.discriminator.column}" = '${source.discriminator.value}'`
      : '';

    const rows: Array<{ id: string }> = await this.dataSource.query(
      `SELECT s."${source.idColumn}"::text AS id
         FROM "${source.schema}"."${source.table}" s
         LEFT JOIN ci_search.embeddings e
           ON e.entity_type = $1 AND e.entity_id = s."${source.idColumn}"
        WHERE e.entity_id IS NULL
          ${discriminator}
          AND ($2::text IS NULL OR s."${source.idColumn}"::text > $2)
        ORDER BY s."${source.idColumn}"::text
        LIMIT $3`,
      [entityType, after, batchSize],
    );

    return rows.map((row) => row.id);
  }

  /** Re-emit the entity's create event onto the search-index queue only. */
  private emit(entityType: BackfillableEntity, id: string): Promise<string[]> {
    const opts = { queue: SEARCH_INDEX_QUEUE } as const;

    switch (entityType) {
      case 'communication':
        return this.events.send(CommunicationCreatedEvent, { communicationId: id }, opts);
      case 'event':
        return this.events.send(EventCreatedEvent, { eventId: id }, opts);
      case 'content':
        return this.events.send(ContentCreatedEvent, { contentId: id }, opts);
      case 'item':
        return this.events.send(ItemCreatedEvent, { itemId: id }, opts);
      case 'browser-activity':
        return this.events.send(BrowserActivityCreatedEvent, { browserActivityId: id }, opts);
    }
  }
}
