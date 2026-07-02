import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { BrowserActivityCreatedEvent } from '@ci/domains/browser-activity/events';
import { EventService as SignallingEventService } from '@ci/domains/events';
import { FileCreatedEvent } from '@ci/domains/files/events';
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
  'file',
] as const;

export type BackfillableEntity = (typeof BACKFILLABLE_ENTITIES)[number];

/**
 * Per-entity-type re-emit descriptor: the `*CreatedEvent` name to fire and the
 * payload field its listener reads the id from. Drives the bulk enqueue so a
 * page of ids becomes one `sendMany` call instead of N awaited `send`s.
 */
const EVENT_BY_TYPE: Record<BackfillableEntity, { event: string; idField: string }> = {
  communication: { event: CommunicationCreatedEvent, idField: 'communicationId' },
  event: { event: EventCreatedEvent, idField: 'eventId' },
  content: { event: ContentCreatedEvent, idField: 'contentId' },
  item: { event: ItemCreatedEvent, idField: 'itemId' },
  'browser-activity': { event: BrowserActivityCreatedEvent, idField: 'browserActivityId' },
  file: { event: FileCreatedEvent, idField: 'fileId' },
};

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
   * Keyset-page over the source table's rows that have no embedding yet,
   * bulk-re-emitting each PAGE's create events onto the search-index queue in a
   * single `sendMany` call. Paging on the id column keeps the working set bounded
   * over a multi-million-row table, and the per-page bulk enqueue keeps the whole
   * sweep to O(pages) round trips instead of O(rows) — the difference between the
   * endpoint returning in seconds vs. blocking the request for minutes.
   */
  private async backfillType(
    entityType: BackfillableEntity,
    batchSize: number,
    limitPerType: number | undefined,
  ): Promise<number> {
    const { event, idField } = EVENT_BY_TYPE[entityType];
    let after: string | null = null;
    let enqueued = 0;

    for (;;) {
      const ids = await this.missingIds(entityType, batchSize, after);
      if (ids.length === 0) {
        break;
      }

      // Trim the final page so we never exceed limitPerType.
      const room = limitPerType != null ? Math.max(limitPerType - enqueued, 0) : ids.length;
      const page = ids.slice(0, room);

      if (page.length > 0) {
        await this.events.sendMany(
          SEARCH_INDEX_QUEUE,
          page.map((id) => ({ name: event, data: { [idField]: id } })),
        );
        enqueued += page.length;
      }

      if (limitPerType != null && enqueued >= limitPerType) {
        break;
      }

      after = ids[ids.length - 1];
    }

    return enqueued;
  }

  /**
   * Ids of source rows with no matching `ci_search.embeddings` row, after the
   * keyset cursor. Table / id column come from the authoritative ENTITY_SOURCE_MAP
   * (trusted constants, not request input), so interpolating them is safe.
   *
   * The cursor compares and orders on the NATIVE `uuid` id column (casting only
   * the bound cursor param to `::uuid`), NOT `id::text`. Every BACKFILLABLE_ENTITIES
   * id column is a `uuid`, and a `uuid`-typed keyset lets Postgres serve the page
   * straight from the primary-key index — whereas the old `id::text` cast forced a
   * full sort of the source table on every page, which dominated the sweep time at
   * import scale. `id::text` remains only in the SELECT list (a cheap per-row
   * projection that returns the id as a string for the caller).
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
          AND ($2::uuid IS NULL OR s."${source.idColumn}" > $2::uuid)
        ORDER BY s."${source.idColumn}"
        LIMIT $3`,
      [entityType, after, batchSize],
    );

    return rows.map((row) => row.id);
  }
}
