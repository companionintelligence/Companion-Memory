import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { BrowserActivityCreatedEvent } from '@ci/domains/browser-activity/events';
import { ThreadCreatedEvent } from '@ci/domains/conversations/events';
import { EventService as SignallingEventService } from '@ci/domains/events';
import { FileCreatedEvent } from '@ci/domains/files/events';
import {
  CommunicationCreatedEvent,
  ConceptCreatedEvent,
  ContentCreatedEvent,
  EventCreatedEvent,
  ItemCreatedEvent,
  PersonCreatedEvent,
  PlaceCreatedEvent,
  ProductCreatedEvent,
  ReceiptCreatedEvent,
} from '@ci/domains/memory/events';
import { NoteCreatedEvent } from '@ci/domains/notes/events';
import { TaskCreatedEvent } from '@ci/domains/planning/events';
import { PositionCreatedEvent } from '@ci/domains/position/events';
import { ENTITY_SOURCE_MAP } from '@ci/domains/search-ingress';
import { DEVICE_INDEXED_ENTITIES } from '@ci/domains/search-next';

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
 * fan-out was the dominant cost at import volume), plus `person` and
 * `concept`: both are stub `ci.entities` rows GraphIngestService's set-based
 * bulk path raw-upserts directly — the same no-per-row-event path
 * `extract_people` uses for Person — so people AND concepts extracted from
 * communications were never searchable until this sweep picked them up.
 * Search indexing for all of these rows is recovered here, as a post-load sweep.
 */
export const BACKFILLABLE_ENTITIES = [
  'communication',
  'event',
  'content',
  'item',
  'browser-activity',
  'file',
  'person',
  'concept',
  'position',
  // The object tables. Both are written by bulk paths that emit nothing per row
  // (`ProductModelService.createMany`, `ReceiptService.upsertFromExtraction`),
  // so like `person` they are only ever indexed by this sweep.
  'product',
  'receipt',
  // Indexed live, by a listener on every create/update — but with no pipeline
  // stage and, until 2026-10-21, no lane here either, so a row written before
  // its device document existed (ci_search.mobile_search_documents, 2026-10-19)
  // never got one: the phone could not find a single note or chat thread.
  // These lanes re-drive the same listener for exactly those rows; on a
  // converged install they find nothing. `task` events carry the owner (the
  // task listener scopes its read by it), hence `ownerColumn` below.
  'note',
  'thread',
  'task',
  'place',
] as const;

export type BackfillableEntity = (typeof BACKFILLABLE_ENTITIES)[number];

/**
 * Entity types the pipeline domain also indexes, mapped to the `ci.pipeline_state`
 * stage id that owns them. The sweep skips any row that stage has ALREADY
 * recorded an outcome for — the ledger row, not the embedding, is the ownership
 * marker:
 *
 *  - `done` rows also have an embedding, so the LEFT JOIN on
 *    `ci_search.embeddings` would exclude them anyway — but only until a stage
 *    version bump (e.g. a `CI_EMBED_MODEL` change) makes them stale. The pipeline
 *    re-embeds stale rows itself; this sweep re-enqueueing them would write a
 *    second, possibly different-model vector for work already scheduled.
 *  - `skipped` rows are the ones this mapping exists for: the pipeline records
 *    its examined-and-declined verdict in the ledger, NOT in
 *    `ci_search.index_skips`, so without this anti-join every sweep re-enqueued
 *    them as no-op jobs forever.
 *  - `failed` / `quarantined` rows are owned by the pipeline's retry gate and a
 *    human respectively; re-enqueueing either duplicates (or overrides) that
 *    policy.
 *
 * Rows the pipeline has never seen (no ledger row) are fair game, which keeps
 * this sweep an honest safety net for the manual surfaces that still call it
 * (`/v1/ingest/finish {searchIndexOnly}`, the orchestrate leg, the CLI) —
 * though with EVERY backfillable type now pipeline-covered and the ledger
 * pre-filled from the existing index, a manual run finds work only where the
 * pipeline has genuinely never been.
 *
 * Stage ids are string literals rather than an import of the pipeline domain's
 * `STAGE_IDS`: the pipeline module already imports this module, and ids are
 * permanent by that domain's own contract. A spec pins each entry to the
 * declared stage list, so a drift fails the build rather than silently sweeping.
 */
export const PIPELINE_COVERED_STAGES: Partial<Record<BackfillableEntity, string>> = {
  content: 'index.embed',
  communication: 'index.embed_communication',
  event: 'index.embed_event',
  item: 'index.embed_item',
  person: 'index.embed_person',
  file: 'index.embed_file',
  'browser-activity': 'index.embed_browser_activity',
};

/**
 * Canonicalise a scoped request: dedupe it and order it by
 * {@link BACKFILLABLE_ENTITIES}, so the sweep runs the same types in the same
 * order however the caller happened to list them. The zod schemas on the REST
 * surfaces validate membership but not uniqueness, and a repeated type would
 * sweep — and re-enqueue — the same rows twice.
 *
 * It deliberately does NOT widen the scope. It used to: Wave D dual-wrote
 * `/v1/browser-activity` into `ci.events` (`view`) + `ci.content` (`web-page`),
 * so a `browser-activity`-scoped request had to index those mirrors too. That
 * fold was reverted (`20260812144811_revert_browser_activity_event_fold`) and
 * `BrowserActivityService` no longer dual-writes, which left the widening
 * meaning only that a caller asking to reindex browsing rows silently swept the
 * entire events and content corpora. A scoped request is now honoured as
 * scoped — the same rule `SearchIndexSweepRequestListener` follows.
 */
export function normalizeBackfillEntityTypes(types: readonly BackfillableEntity[]): BackfillableEntity[] {
  const set = new Set<BackfillableEntity>(types);

  return BACKFILLABLE_ENTITIES.filter((t) => set.has(t));
}

/**
 * Per-entity-type re-emit descriptor: the `*CreatedEvent` name to fire and the
 * payload field its listener reads the id from. Drives the bulk enqueue so a
 * page of ids becomes one `sendMany` call instead of N awaited `send`s.
 */
const EVENT_BY_TYPE: Record<
  BackfillableEntity,
  {
    event: string;
    idField: string;
    /**
     * Set when the listener reads the row's owner from the payload too
     * (`TaskSearchIndexListener` scopes its read by `payload.userId`; a
     * SYSTEM_USER read returns nothing). The source column the sweep selects it
     * from.
     */
    owner?: { field: string; column: string };
  }
> = {
  communication: { event: CommunicationCreatedEvent, idField: 'communicationId' },
  event: { event: EventCreatedEvent, idField: 'eventId' },
  content: { event: ContentCreatedEvent, idField: 'contentId' },
  item: { event: ItemCreatedEvent, idField: 'itemId' },
  'browser-activity': { event: BrowserActivityCreatedEvent, idField: 'browserActivityId' },
  file: { event: FileCreatedEvent, idField: 'fileId' },
  person: { event: PersonCreatedEvent, idField: 'personId' },
  concept: { event: ConceptCreatedEvent, idField: 'conceptId' },
  position: { event: PositionCreatedEvent, idField: 'positionId' },
  product: { event: ProductCreatedEvent, idField: 'productId' },
  receipt: { event: ReceiptCreatedEvent, idField: 'receiptId' },
  note: { event: NoteCreatedEvent, idField: 'noteId' },
  thread: { event: ThreadCreatedEvent, idField: 'threadId' },
  task: { event: TaskCreatedEvent, idField: 'taskId', owner: { field: 'userId', column: 'user_id' } },
  place: { event: PlaceCreatedEvent, idField: 'placeId' },
};

/**
 * Types whose source table is a TimescaleDB hypertable partitioned on a time
 * column (→ the column to page by). A bare-id keyset can't use the PK there —
 * the PK leads with `time` — so every page forced a full sort of all chunks
 * (~1s/page on 881k comms). Paging on `(timeColumn, id)` matches the PK order,
 * letting ChunkAppend stream pages in partition order: measured 961ms → 86ms
 * per 1000-row page. Types not listed here page on their plain uuid PK.
 */
const TIME_PAGED_TYPES: Partial<Record<BackfillableEntity, string>> = {
  communication: 'time',
  position: 'time',
};

/** Keyset cursor: the last row of the previous page. `ts` only for time-paged types. */
interface PageCursor {
  id: string;
  ts: string | null;
}

export interface SearchIndexBackfillOptions {
  /** Restrict the sweep to these entity types (default: all backfillable types). */
  entityTypes?: BackfillableEntity[];
  /** Source rows scanned + re-emitted per page (default 1000). */
  batchSize?: number;
  /** Hard cap on rows re-emitted PER entity type (default: unbounded). */
  limitPerType?: number;
  /**
   * Skip the sweep entirely when the search-index queue already holds more than
   * this many undrained jobs (default 5000; 0 disables the guard). The LEFT
   * JOINs exclude rows that finished indexing, NOT rows merely sitting in the
   * queue — so re-sweeping before a drain re-enqueues the whole missing set as
   * duplicates. A 1M-row import that got kicked 4 ways (push kick ×3 retries +
   * the orchestrate leg) piled up 5.1M jobs this way.
   */
  pendingThreshold?: number;
}

export interface SearchIndexBackfillResult {
  /** Total rows re-emitted onto the search-index queue across all types. */
  enqueued: number;
  /** Rows re-emitted per entity type. */
  perType: Record<string, number>;
  /**
   * Total rows ALREADY indexed (an `ci_search.embeddings` row exists) across the
   * swept types, sampled after the enqueue. This is the drain progress signal:
   * `enqueued` says how much work was queued, `embedded` says how much has
   * actually been embedded. A caller that polls the backfill and sees `enqueued`
   * fall to 0 while `embedded` stops climbing (with a non-empty queue) can tell a
   * stalled Ollama drain apart from a completed one — the gap the old
   * enqueued-only response hid. Always present, including on a skip, so a skipped
   * trigger still reports drain state.
   */
  embedded: number;
  /** Rows already indexed per entity type (same sampling as `embedded`). */
  embeddedPerType: Record<string, number>;
  /**
   * Present only when one or more types failed partway: entity type → error
   * message. Counts in `perType` reflect what WAS enqueued before the failure,
   * and the sweep continues with the remaining types — so a transient failure on
   * one table doesn't abort the whole backfill, and a re-run (idempotent via the
   * LEFT JOIN) picks up exactly what's still missing.
   */
  errors?: Record<string, string>;
  /**
   * Present when the sweep enqueued NOTHING by design: another sweep is already
   * running in-process, or the queue backlog exceeds pendingThreshold. Callers
   * treat this as success — the pending work already covers the missing rows.
   * The `embedded` count is still populated on a skip so a stalled drain stays
   * visible even when no new work is enqueued.
   */
  skipped?: 'already_running' | 'queue_backlog';
  /** Queue depth observed when skipped === 'queue_backlog'. */
  pending?: number;
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
 * It is re-runnable and incremental: a row already carrying an embedding — or a
 * `ci_search.index_skips` marker (examined and intentionally not embedded) — is
 * skipped by the LEFT JOINs, so a second run only picks up what is still missing.
 */
@Injectable()
export class SearchIndexBackfillService {
  /**
   * In-process sweep lock. Every trigger converges on this service (the REST
   * endpoint, the importer's post-push kick, the orchestrate leg), and a sweep
   * that runs while another is mid-flight re-enqueues the same missing rows —
   * the client-side dogpile that turned one 1.27M-row sweep into 3.85M jobs
   * when a timed-out kick was retried against a still-running sweep.
   */
  private running = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly events: SignallingEventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(SearchIndexBackfillService.name);
  }

  async backfill(options: SearchIndexBackfillOptions = {}): Promise<SearchIndexBackfillResult> {
    const types = options.entityTypes
      ? normalizeBackfillEntityTypes(options.entityTypes)
      : [...BACKFILLABLE_ENTITIES];

    if (this.running) {
      this.logger.warn('Search-index backfill: sweep already running, skipping this trigger');

      // Still report drain state so an overlapping trigger isn't blind to progress.
      const { embedded, embeddedPerType } = await this.embeddedCounts(types);

      return { enqueued: 0, perType: {}, embedded, embeddedPerType, skipped: 'already_running' };
    }

    this.running = true;
    try {
      return await this.sweep(options, types);
    } finally {
      this.running = false;
    }
  }

  private async sweep(
    options: SearchIndexBackfillOptions,
    types: BackfillableEntity[],
  ): Promise<SearchIndexBackfillResult> {
    const batchSize = options.batchSize ?? 1000;

    const pendingThreshold = options.pendingThreshold ?? 5000;
    if (pendingThreshold > 0) {
      const pending = await this.pendingQueueDepth();
      if (pending > pendingThreshold) {
        this.logger.warn('Search-index backfill: queue backlog exceeds threshold, skipping sweep', {
          pending,
          pendingThreshold,
        });

        const { embedded, embeddedPerType } = await this.embeddedCounts(types);

        return { enqueued: 0, perType: {}, embedded, embeddedPerType, skipped: 'queue_backlog', pending };
      }
    }

    const perType: Record<string, number> = {};
    const errors: Record<string, string> = {};
    let enqueued = 0;

    for (const entityType of types) {
      const { count, error } = await this.backfillType(entityType, batchSize, options.limitPerType);
      perType[entityType] = count;
      enqueued += count;

      if (error != null) {
        errors[entityType] = error;
        this.logger.error(
          'Search-index backfill: type failed partway, continuing with remaining types',
          new Error(error),
        );
      } else {
        this.logger.log('Search-index backfill: type complete', { entityType, enqueued: count });
      }
    }

    // Sample drain progress AFTER the enqueue so `embedded` reflects what has
    // actually been indexed by the time the response is built.
    const { embedded, embeddedPerType } = await this.embeddedCounts(types);
    this.logger.log('Search-index backfill: sweep complete', { enqueued, embedded });

    const base: SearchIndexBackfillResult = { enqueued, perType, embedded, embeddedPerType };

    return Object.keys(errors).length > 0 ? { ...base, errors } : base;
  }

  /**
   * Count already-indexed rows (an `ci_search.embeddings` row exists) per swept
   * type, plus the total. This is the drain-progress counterpart to `enqueued`:
   * it lets a poller distinguish a stalled Ollama drain (embedded flat while the
   * queue is non-empty) from a completed one. Discriminated types (Person/Place/
   * File-in-`entities`) count only their own `entity_type` in `ci_search.embeddings`.
   */
  private async embeddedCounts(
    types: BackfillableEntity[],
  ): Promise<{ embedded: number; embeddedPerType: Record<string, number> }> {
    const embeddedPerType: Record<string, number> = {};
    let embedded = 0;

    for (const entityType of types) {
      const rows: Array<{ count: string }> = await this.dataSource.query(
        `SELECT count(*)::bigint AS count
           FROM ci_search.embeddings
          WHERE entity_type = $1`,
        [entityType],
      );
      const count = Number(rows[0]?.count ?? 0);
      embeddedPerType[entityType] = count;
      embedded += count;
    }

    return { embedded, embeddedPerType };
  }

  /** Undrained (created/retry) jobs currently sitting on the search-index queue. */
  private async pendingQueueDepth(): Promise<number> {
    const rows: Array<{ count: string }> = await this.dataSource.query(
      `SELECT count(*)::bigint AS count
         FROM pgboss.job
        WHERE name = 'search-index' AND state IN ('created', 'retry')`,
    );

    return Number(rows[0]?.count ?? 0);
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
  ): Promise<{ count: number; error?: string }> {
    const { event, idField, owner } = EVENT_BY_TYPE[entityType];
    let after: PageCursor | null = null;
    let enqueued = 0;

    // Fail-soft per type: a mid-sweep failure (connection drop, constraint issue
    // in a pg-boss insert chunk) keeps the pages already enqueued — they are real
    // jobs — and reports the error instead of throwing a 500 that hides them.
    // The idempotent LEFT JOIN makes a re-run resume from what's still missing.
    try {
      for (;;) {
        const rows = await this.missingIds(entityType, batchSize, after);
        if (rows.length === 0) {
          break;
        }

        // Trim the final page so we never exceed limitPerType.
        const room = limitPerType != null ? Math.max(limitPerType - enqueued, 0) : rows.length;
        const page = rows.slice(0, room);

        if (page.length > 0) {
          await this.events.sendMany(
            SEARCH_INDEX_QUEUE,
            page.map((row) => ({
              name: event,
              data: owner ? { [idField]: row.id, [owner.field]: row.owner } : { [idField]: row.id },
            })),
          );
          enqueued += page.length;
        }

        if (limitPerType != null && enqueued >= limitPerType) {
          break;
        }

        const last = rows[rows.length - 1];
        after = { id: last.id, ts: last.ts ?? null };
      }
    } catch (err) {
      return { count: enqueued, error: err instanceof Error ? err.message : String(err) };
    }

    return { count: enqueued };
  }

  /**
   * Rows (id + optional page-order timestamp) with no matching
   * `ci_search.embeddings` row, no `ci_search.index_skips` marker, and — for
   * types in {@link PIPELINE_COVERED_STAGES} — no `ci.pipeline_state` ledger row
   * from the covering stage, after the keyset cursor.
   * The skips anti-join is what makes the sweep CONVERGE: the
   * listeners intentionally never write an embedding for low-value rows, so
   * without it every backfill run re-enqueued the same skipped rows as no-op
   * jobs forever. Table / id / time columns come from the authoritative
   * ENTITY_SOURCE_MAP + TIME_PAGED_TYPES (trusted constants, not request
   * input), so interpolating them is safe.
   *
   * Plain tables: the cursor compares and orders on the NATIVE `uuid` id column
   * (casting only the bound cursor param to `::uuid`), NOT `id::text` — a
   * `uuid`-typed keyset serves the page straight from the primary-key index,
   * whereas an `id::text` cast forces a full sort of the source table per page.
   *
   * Hypertables (TIME_PAGED_TYPES): the cursor is the composite
   * `(timeColumn, id)` matching the hypertable PK's leading order, so
   * ChunkAppend streams pages in partition order instead of sorting every
   * chunk per page. The timestamp round-trips through text (`::text` out,
   * `::timestamptz` back) losslessly.
   */
  private async missingIds(
    entityType: BackfillableEntity,
    batchSize: number,
    after: PageCursor | null,
  ): Promise<Array<{ id: string; ts?: string | null; owner?: string }>> {
    const source = ENTITY_SOURCE_MAP[entityType];
    // The owner column, for listeners that read it from the payload (see EVENT_BY_TYPE).
    const ownerColumn = EVENT_BY_TYPE[entityType].owner?.column;
    const ownerSelect = ownerColumn ? `, s."${ownerColumn}"::text AS owner` : '';
    const discriminator = source.discriminator
      ? `AND s."${source.discriminator.column}" = '${source.discriminator.value}'`
      : '';
    // Rows the sweep must never treat as missing (e.g. merge tombstones, whose
    // index rows were deliberately deleted).
    const excluded = source.backfillPredicate ? `AND ${source.backfillPredicate}` : '';
    // Rows the pipeline domain has already recorded an outcome for (any status
    // — see PIPELINE_COVERED_STAGES for why skipped/failed matter). The join is
    // an index-only lookup on the ledger's (entity_type, entity_id, stage) PK.
    const pipelineStage = PIPELINE_COVERED_STAGES[entityType];
    const pipelineJoin = pipelineStage
      ? `LEFT JOIN ci.pipeline_state ps
             ON ps.entity_type = $1 AND ps.entity_id = s."${source.idColumn}" AND ps.stage = '${pipelineStage}'`
      : '';
    const pipelineExcluded = pipelineStage ? 'AND ps.entity_id IS NULL' : '';
    // A device-indexed type is also "missing" when its index row has no
    // plain-text document (ci_search.mobile_search_documents, added 2026-10-19 beside an
    // index that already existed). Re-emitting the row's event rewrites both
    // halves through the one shared statement. Types the pipeline covers are
    // still excluded above by their ledger row — the pipeline's own stage
    // version bump re-runs those.
    const deviceIndexed = (DEVICE_INDEXED_ENTITIES as readonly string[]).includes(entityType);
    const documentJoin = deviceIndexed
      ? `LEFT JOIN ci_search.mobile_search_documents d
             ON d.entity_type = $1 AND d.entity_id = s."${source.idColumn}"`
      : '';
    const documentMissing = deviceIndexed ? 'OR d.entity_id IS NULL' : '';
    const timeColumn = TIME_PAGED_TYPES[entityType];

    if (timeColumn != null) {
      return this.dataSource.query(
        `SELECT s."${source.idColumn}"::text AS id, s."${timeColumn}"::text AS ts${ownerSelect}
           FROM "${source.schema}"."${source.table}" s
           LEFT JOIN ci_search.embeddings e
             ON e.entity_type = $1 AND e.entity_id = s."${source.idColumn}"
           LEFT JOIN ci_search.index_skips k
             ON k.entity_type = $1 AND k.entity_id = s."${source.idColumn}"
           ${documentJoin}
           ${pipelineJoin}
          WHERE (e.entity_id IS NULL ${documentMissing})
            AND k.entity_id IS NULL
            ${pipelineExcluded}
            ${discriminator}
            ${excluded}
            AND ($2::timestamptz IS NULL
                 OR (s."${timeColumn}", s."${source.idColumn}") > ($2::timestamptz, $3::uuid))
          ORDER BY s."${timeColumn}", s."${source.idColumn}"
          LIMIT $4`,
        [entityType, after?.ts ?? null, after?.id ?? null, batchSize],
      );
    }

    return this.dataSource.query(
      `SELECT s."${source.idColumn}"::text AS id${ownerSelect}
         FROM "${source.schema}"."${source.table}" s
         LEFT JOIN ci_search.embeddings e
           ON e.entity_type = $1 AND e.entity_id = s."${source.idColumn}"
         LEFT JOIN ci_search.index_skips k
           ON k.entity_type = $1 AND k.entity_id = s."${source.idColumn}"
         ${documentJoin}
         ${pipelineJoin}
        WHERE (e.entity_id IS NULL ${documentMissing})
          AND k.entity_id IS NULL
          ${pipelineExcluded}
          ${discriminator}
          ${excluded}
          AND ($2::uuid IS NULL OR s."${source.idColumn}" > $2::uuid)
        ORDER BY s."${source.idColumn}"
        LIMIT $3`,
      [entityType, after?.id ?? null, batchSize],
    );
  }
}
