import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Brackets,
  IsNull,
  Repository,
  type FindOptionsWhere,
  type ObjectLiteral,
  type SelectQueryBuilder,
  type WhereExpressionBuilder,
} from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type ServiceContext, SYSTEM_USER, type UserServiceContext } from '@ci/common/context';
import {
  type BulkInsertResult,
  bulkInsertIdempotent,
  INGEST_REFRESH_COLUMNS,
  keysetPaginate,
  type KeysetPageArgs,
  type KeysetPage,
} from '@ci/common/persistence';
import { EventService } from '@ci/domains/events';
import { ContentCreatedEvent, ContentRemovedEvent, ContentUpdatedEvent } from '@ci/domains/memory/events';
import type { EntityIdentifier, IndexableEntity } from '@ci/domains/search-next';

import { BaseEntity } from '../entities/BaseEntity';
import { ContentBaseEntity } from '../entities/ContentBaseEntity';
import { Content, ContentEntity } from '../entities/ContentEntity';
import { EventEntity } from '../entities/EventEntity';
import { classifyExternalId } from '../externalIdKind';
import { CreateContentDto, SearchContentDto, UpdateContentDto } from '../types';

import { CtiAggregate } from './CtiAggregate';
import { GraphDeltaWriter } from './GraphDeltaWriter';

/** The provenance triple shared by a content row and the event it auto-links to. */
type Triple = { sourceType: string; sourceSystem: string | null; sourceId: string };

/**
 * Stable string key for a triple, matching the NULL-safe semantics of the lookup
 * below (a null source_system is its own bucket). Used to join input rows to the
 * events fetched in one set-based query.
 */
const tripleKey = (t: Triple): string => `${t.sourceType}\u0000${t.sourceSystem ?? ''}\u0000${t.sourceId}`;

/**
 * Hourly UTC per-user content count. Declared locally so this domain carries
 * no dependency on aggregating consumers; they enforce the shape structurally
 * where they consume it.
 */
export interface HourlyContentCount {
  userId: string;
  bucketStart: Date;
  count: number;
}

/**
 * Spanning-aggregate service for the content CTI split: content is ONE logical
 * entity persisted as a `ci.entities` base row (discriminated 'Content',
 * see {@link ContentBaseEntity}) plus a `ci.content` detail row sharing the same
 * uuid. The base row is the SOLE owner of `title` (stored as `name`); the detail
 * row carries body/url/mimetype. Writes touch both rows in one transaction;
 * reads compose the egress {@link Content} from the pair with one batched
 * base-row fetch.
 */
@Injectable()
export class ContentService {
  private readonly aggregate: CtiAggregate<ContentEntity, ContentBaseEntity>;

  constructor(
    @InjectRepository(ContentEntity)
    private readonly contentRepository: Repository<ContentEntity>,
    @InjectRepository(ContentBaseEntity)
    private readonly contentBaseRepository: Repository<ContentBaseEntity>,
    @InjectRepository(EventEntity)
    private readonly eventRepository: Repository<EventEntity>,
    private readonly eventService: EventService,
    private readonly graphDeltaWriter: GraphDeltaWriter,
  ) {
    this.aggregate = new CtiAggregate({
      detailRepository: this.contentRepository,
      detailEntity: ContentEntity,
      baseEntity: ContentBaseEntity,
      baseRepository: this.contentBaseRepository,
      linkedTable: 'content',
      scopedWhere: (context, id) => ({
        id,
        ...(context.userId !== SYSTEM_USER && {
          user: { id: context.userId },
        }),
      }),
    });
  }

  /**
   * Composes egress content from detail rows plus one batched fetch of their
   * base rows (the owners of title), preserving input order.
   */
  private composeMany(entities: ContentEntity[]): Promise<Content[]> {
    return this.aggregate.composeMany(entities, (entity, base) => ContentEntity.toEgressType(entity, base));
  }

  /**
   * Map a CreateContentDto onto ContentEntity columns (title stays on the base
   * row).
   *
   * `external_id_kind` is stamped HERE, not by the callers, because this is the
   * one choke point every write path funnels through: `create` (GraphQL
   * createContent, ETL transforms) and `createManyDetailed` (the importer's
   * PushStage, the /v1/contents bulk plane, GraphQL createContents) both build
   * their entities from this method. A caller that knows what it is writing
   * still wins — the importer stamps 'file' for an uploaded blob and
   * 'external_uri' for a source URI, and the ETL transforms stamp
   * SOURCE_NATIVE_EXTERNAL_ID_KIND for a bare platform id that no shape test
   * could recognise. Everything else falls back to `classifyExternalId`, so a
   * write path nobody has updated (and any future one) still produces a
   * classified row instead of depending on the next backfill migration.
   */
  private toDetailFields(
    item: CreateContentDto,
    id: string,
    context: UserServiceContext,
    event?: { id: string },
  ): ContentEntity {
    return this.contentRepository.create({
      id,
      type: item.type,
      text: item.text ?? undefined,
      url: item.url ?? undefined,
      mimetype: item.mimetype ?? undefined,
      externalId: item.external_id ?? undefined,
      externalIdKind: item.external_id_kind ?? classifyExternalId(item.external_id) ?? undefined,
      sourceUrl: item.source_url ?? undefined,
      sourceData: item.source_data ?? undefined,
      sourceType: item.source_type ?? undefined,
      sourceSystem: item.source_system ?? undefined,
      sourceId: item.source_id ?? undefined,
      connectionId: item.connection_id ?? undefined,
      event,
      userId: context.userId,
    });
  }

  /**
   * The provenance-triple lookup shared by the find-before-insert check and
   * the race-loss fallback in {@link create} — mirrors
   * EventService.createOne's sourceWhere / CommunicationService's.
   */
  private sourceWhereFor(
    context: UserServiceContext,
    item: Pick<CreateContentDto, 'source_type' | 'source_system' | 'source_id'>,
  ): FindOptionsWhere<ContentEntity> | null {
    return item.source_type && item.source_id
      ? {
          userId: context.userId,
          sourceType: item.source_type,
          sourceSystem: item.source_system ?? IsNull(),
          sourceId: item.source_id,
        }
      : null;
  }

  async create(
    context: UserServiceContext,
    data: CreateContentDto | CreateContentDto[],
    options?: { emitCreated?: boolean },
  ): Promise<Content[]> {
    const isSingle = !Array.isArray(data);
    const dataArray: CreateContentDto[] = isSingle ? [data] : data;
    // Bulk ingest (createMany) passes emitCreated:false: at import volume the
    // per-row ContentCreatedEvent pgboss fan-out was the dominant cost, so search
    // indexing for bulk-loaded rows is deferred to the post-load batch embed
    // (POST /api/maintenance/search-index/backfill). Interactive create() still emits.
    const emitCreated = options?.emitCreated ?? true;

    // TODO: Some of these can fail, we need to return partial success here?
    return Promise.all(
      dataArray.map(async (item) => {
        // Idempotency: re-sending an existing (source_type, source_system,
        // source_id) triple must return the existing row instead of hitting
        // content_source_triple_uniq's unhandled 23505 — this per-row path
        // (GitHub/Reddit ETL transforms, MemoryController) has no ON CONFLICT
        // handling of its own, unlike createMany's set-based upsert.
        const sourceWhere = this.sourceWhereFor(context, item);
        if (sourceWhere) {
          const existing = await this.contentRepository.findOne({ where: sourceWhere });
          if (existing) {
            return this.composeOneExisting(existing);
          }
        }

        const id = item.id ?? uuidv7();

        let contentResult: ContentEntity;
        try {
          contentResult = await this.contentRepository.manager.transaction(async (manager) => {
            await manager.getRepository(ContentBaseEntity).save(
              this.aggregate.createBaseRow(manager, {
                id,
                userId: context.userId,
                name: item.title ?? null,
                description: null,
              }),
            );

            const detail = this.toDetailFields(item, id, context, item.event);
            const saved = await manager.getRepository(ContentEntity).save(detail);

            await this.graphDeltaWriter.entityCreated({
              entityId: id,
              entityType: 'Content',
              name: item.title ?? null,
              ownerUserId: context.userId,
              changeSource: 'ContentService.create',
              changedByUserId: typeof context.userId === 'string' ? context.userId : null,
              manager,
            });

            return saved;
          });
        } catch (err) {
          // Lost a race to a concurrent insert of the same triple — fetch and
          // return the winner rather than surfacing the raw 23505.
          if (sourceWhere && (err as { code?: string })?.code === '23505') {
            const existing = await this.contentRepository.findOne({ where: sourceWhere });
            if (existing) {
              return this.composeOneExisting(existing);
            }
          }

          throw err;
        }

        if (emitCreated) {
          await this.eventService.send(ContentCreatedEvent, {
            contentId: contentResult.id,
          });
        }

        return ContentEntity.toEgressType(contentResult, {
          name: item.title ?? null,
          description: null,
        });
      }),
    );
  }

  /** Composes one existing detail row's egress Content, for the dedup-hit paths in {@link create}. */
  private async composeOneExisting(entity: ContentEntity): Promise<Content> {
    const [content] = await this.composeMany([entity]);

    return content;
  }

  /**
   * Batch, idempotent content ingest for the importer. Dedupes on the provenance
   * triple (user_id, source_type, source_system, source_id) — like
   * EventService.create / ItemService.createMany — via one set-based
   * INSERT ... ON CONFLICT DO NOTHING instead of the old per-row findOne + save
   * loop. The old path did, per row, up to 2 SELECTs (triple dedup + event
   * lookup) and 1 INSERT, fanned out unbounded — ~2M+ round trips at 1M rows.
   * This path is a fixed handful of statements per batch: one event-link SELECT,
   * one existence SELECT, one multi-row INSERT, one hydrate SELECT (see
   * {@link bulkInsertIdempotent}). Paired with the content_source_triple_uniq
   * partial unique index, which also absorbs a lost insert race (23505).
   * No fields are refreshed on a re-sync — INGEST_REFRESH_COLUMNS.content is
   * intentionally empty (find-or-return).
   *
   * Event link: an explicit `event.id` (e.g. the id returned by createEvent)
   * wins. Otherwise, when the item carries a source triple, the matching event in
   * ci.events with the SAME (user_id, source_type, source_system, source_id) is
   * found and content.event_id is set to it, so a content row pushed with the same
   * provenance as its event auto-links. If nothing matches, event_id stays null.
   * This resolution is now a single set-based lookup over the whole batch rather
   * than a per-row findOne, preserving the exact semantics (link only on an exact
   * triple match, scoped to the user; leave NULL otherwise).
   *
   * Bulk ingest does NOT emit a per-row ContentCreatedEvent by default: the
   * per-row pgboss fan-out was the dominant cost at import volume, so search
   * indexing for bulk-loaded rows is deferred to the post-load batch embed
   * (POST /api/maintenance/search-index/backfill). The single-record
   * `createContent` mutation passes `emitCreated: true` so an interactive create
   * still indexes live — but only rows this call actually INSERTED emit (a re-send
   * that finds an existing row is a no-op), mirroring EventService/ItemService.
   *
   * Returns the created-or-existing rows in input order.
   */
  async createMany(
    context: UserServiceContext,
    data: CreateContentDto[],
    options?: { emitCreated?: boolean },
  ): Promise<Content[]> {
    return (await this.createManyDetailed(context, data, options)).map(({ entity }) => entity);
  }

  /**
   * Same ingest as {@link createMany}, reporting which rows this call actually
   * INSERTED rather than found already present.
   *
   * The batch paths upsert, so a re-sent row resolves silently and is
   * indistinguishable in the returned entities from one written for the first
   * time. The importer needs the difference: without it a push of 7,339 content
   * records that collapsed onto 2,354 rows reports 7,339 writes, and its
   * "already saved" count reads zero on an import that was almost entirely
   * repeats.
   */
  async createManyDetailed(
    context: UserServiceContext,
    data: CreateContentDto[],
    options?: { emitCreated?: boolean },
  ): Promise<Array<BulkInsertResult<Content>>> {
    if (data.length === 0) {
      return [];
    }

    const emitCreated = options?.emitCreated ?? false;

    // Set-based event auto-link: resolve every triple-carrying row's event in ONE
    // query up front, so the per-entity `event` relation can be stamped before the
    // bulk insert (replacing the old per-row resolveEventByTriple findOne).
    const eventIdByTriple = await this.resolveEventIdsByTriple(context, data);

    const withIds = data.map((item) => ({ ...item, id: item.id ?? uuidv7() }));

    const entities = withIds.map((item) => {
      // Explicit event wins; otherwise auto-link by the shared provenance triple.
      let event = item.event;
      if (!event && item.source_type && item.source_id) {
        const eventId = eventIdByTriple.get(
          tripleKey({
            sourceType: item.source_type,
            sourceSystem: item.source_system ?? null,
            sourceId: item.source_id,
          }),
        );
        if (eventId) {
          event = { id: eventId };
        }
      }

      return this.toDetailFields(item, item.id, context, event);
    });

    // title is base-row data and never touches the detail table.
    const ingressById = new Map(withIds.map((item) => [item.id, { title: item.title ?? null }]));

    const { detailResults, bases } = await this.contentRepository.manager.transaction(async (manager) => {
      const results = await bulkInsertIdempotent({
        repository: this.contentRepository,
        manager,
        entities,
        primaryKey: 'id',
        getTriple: (entity) => ({
          sourceType: entity.sourceType,
          sourceSystem: entity.sourceSystem,
          sourceId: entity.sourceId,
        }),
        // content_source_triple_uniq is user-scoped (see migration
        // 20260623120300); scope the existence + hydrate reads to the same user.
        scope: { userId: context.userId },
        conflictTarget: '(user_id, source_type, source_system, source_id) WHERE source_id IS NOT NULL',
        tripleColumns: ['source_type', 'source_system', 'source_id'],
        // Centralized refresh contract — currently empty, so conflicts stay
        // DO NOTHING find-or-return.
        conflictUpdateColumns: INGEST_REFRESH_COLUMNS.content,
      });

      const baseRows = results
        .filter(({ inserted }) => inserted)
        .map(({ entity }) => {
          const ingress = ingressById.get(entity.id);
          if (!ingress) {
            throw new Error(`No ingress row for inserted content ${entity.id}`);
          }

          return this.aggregate.createBaseRow(manager, {
            id: entity.id,
            userId: context.userId,
            name: ingress.title,
            description: null,
          });
        });

      await this.aggregate.insertBaseRows(manager, baseRows, '(entity_id) DO NOTHING');

      await this.graphDeltaWriter.recordMany(
        results
          .filter(({ inserted }) => inserted)
          .map(({ entity }) => {
            const ingress = ingressById.get(entity.id);

            return {
              nodeType: 'entity' as const,
              changeType: 'created' as const,
              entityId: entity.id,
              entityType: 'Content',
              ownerUserId: context.userId,
              changeSource: 'ContentService.createMany',
              changedByUserId: typeof context.userId === 'string' ? context.userId : null,
              changedFields: {
                name: { new: ingress?.title ?? null },
                description: { new: null },
                entity_type: { new: 'Content' },
                properties: { new: {} },
              },
            };
          }),
        manager,
      );

      const baseEntities = await this.aggregate.fetchBaseMap(
        results.map(({ entity }) => entity.id),
        manager,
      );

      return { detailResults: results, bases: baseEntities };
    });

    // Interactive single creates ask to index live (emitCreated:true); emit only
    // for rows genuinely inserted by THIS call so a re-send is a no-op. The bulk
    // importer leaves this false — its indexing is deferred to the backfill sweep.
    if (emitCreated) {
      for (const { entity, inserted } of detailResults) {
        if (inserted) {
          await this.eventService.send(ContentCreatedEvent, { contentId: entity.id });
        }
      }
    }

    return detailResults.map(({ entity, inserted }) => ({
      entity: ContentEntity.toEgressType(entity, bases.get(entity.id)),
      inserted,
    }));
  }

  /**
   * Set-based event auto-link resolution: given the whole input batch, run ONE
   * query to find every event in ci.events whose (user_id, source_type,
   * source_system, source_id) triple matches a triple-carrying input row, and
   * return a map from triple-key to event id. Replaces the old per-row
   * resolveEventByTriple findOne. `source_system` is matched NULL-safely (a NULL
   * system equals a NULL system, preserving the prior `sourceSystem ?? IsNull()`
   * semantics) via a two-armed `= :val` / `IS NULL` condition rather than
   * `IS NOT DISTINCT FROM` — Postgres cannot use a btree index (including
   * events_source_triple_uniq, the index this exact lookup is meant to hit) to
   * satisfy an `IS NOT DISTINCT FROM` qual, which turns this into a full scan of
   * the user's events once the table is large (see the identical fix + EXPLAIN
   * ANALYZE writeup in common/persistence/bulkUpsert.ts's tripleBrackets).
   * source_type and source_id are always non-null here (the loop below skips
   * rows missing either), so they can always use plain `=`. Only rows with both
   * source_type and source_id are considered (mirroring the old guard); rows
   * without a triple never auto-link.
   */
  private async resolveEventIdsByTriple(
    context: UserServiceContext,
    data: CreateContentDto[],
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();

    // Only rows with a full (source_type, source_id) pair AND no explicit event
    // need a triple lookup. Dedupe the triples so the OR-list stays compact.
    const triples = new Map<string, Triple>();
    for (const item of data) {
      if (item.event || !item.source_type || !item.source_id) {
        continue;
      }

      const triple: Triple = {
        sourceType: item.source_type,
        sourceSystem: item.source_system ?? null,
        sourceId: item.source_id,
      };
      triples.set(tripleKey(triple), triple);
    }

    if (triples.size === 0) {
      return result;
    }

    const distinctTriples = [...triples.values()];

    const events = await this.eventRepository
      .createQueryBuilder('event')
      .select(['event.id', 'event.sourceType', 'event.sourceSystem', 'event.sourceId'])
      .where('event.userId = :userId', { userId: context.userId })
      .andWhere(
        new Brackets((qb: WhereExpressionBuilder) => {
          distinctTriples.forEach((triple, i) => {
            const systemParam = `evt_system_${i}`;
            const systemCond =
              triple.sourceSystem == null
                ? 'event.sourceSystem IS NULL'
                : `event.sourceSystem = :${systemParam}`;

            qb.orWhere(
              `(event.sourceType = :evt_type_${i}` +
                ` AND ${systemCond}` +
                ` AND event.sourceId = :evt_id_${i})`,
              {
                [`evt_type_${i}`]: triple.sourceType,
                ...(triple.sourceSystem != null ? { [systemParam]: triple.sourceSystem } : {}),
                [`evt_id_${i}`]: triple.sourceId,
              },
            );
          });
        }),
      )
      .getMany();

    for (const event of events) {
      if (event.sourceType == null || event.sourceId == null) {
        continue;
      }

      const key = tripleKey({
        sourceType: event.sourceType,
        sourceSystem: event.sourceSystem,
        sourceId: event.sourceId,
      });
      // First match wins — the triple is unique per user via
      // events_source_triple_uniq, so there is at most one anyway.
      if (!result.has(key)) {
        result.set(key, event.id);
      }
    }

    return result;
  }

  async findAll(context: UserServiceContext): Promise<Content[]> {
    const entities = await this.contentRepository.find({
      where: {
        user: {
          id: context.userId,
        },
      },
    });

    return this.composeMany(entities);
  }

  /**
   * Keyset-paginated page for the GraphQL connection — ordered by (created_at,
   * id) DESC over the (user_id, created_at) index. Reads one page (+1 sentinel)
   * instead of the whole 194k-row table and drops the eager `user` join.
   */
  async findPage(context: UserServiceContext, args: KeysetPageArgs): Promise<KeysetPage<Content>> {
    const page = await keysetPaginate(this.contentRepository, args, {
      alias: 'content',
      timeProp: 'createdAt',
      userId: context.userId,
      // Same rule as findById/findByIds: a deleted event's photo must not resurface
      // in the paginated library (and must not inflate totalCount).
      scope: (qb) => this.excludeDeletedEventMedia(qb, 'content'),
    });

    return {
      ...page,
      entities: await this.composeMany(page.entities),
    };
  }

  /**
   * Hides content that only exists as the media plumbing of a tombstoned event.
   *
   * A photo/video event carries its binary through a `ci.content` row
   * (type='media'), and that row is indexed in its own right. Deleting the event
   * is a soft delete (see {@link EventService.remove}), so the FK never fires
   * and the content row would otherwise keep showing the deleted photo in the
   * explorer. The LEFT JOIN keeps standalone content (`event_id IS NULL`)
   * visible, and restoring the event brings its media back with it.
   */
  private excludeDeletedEventMedia<T extends ObjectLiteral>(
    query: SelectQueryBuilder<T>,
    alias: string,
  ): SelectQueryBuilder<T> {
    return query
      .leftJoin(EventEntity, `${alias}_event`, `${alias}_event.event_id = ${alias}.event_id`)
      .andWhere(`(${alias}.event_id IS NULL OR ${alias}_event.is_deleted = false)`);
  }

  async findById(context: ServiceContext, id: string): Promise<Content | null> {
    let query = this.contentRepository.createQueryBuilder('content').where('content.id = :id', { id });

    if (context.userId !== SYSTEM_USER) {
      query = query.andWhere('content.user_id = :userId', { userId: context.userId });
    }

    const result = await this.excludeDeletedEventMedia(query, 'content').getOne();

    if (result == null) {
      return null;
    }

    const [content] = await this.composeMany([result]);

    return content;
  }

  async findByIds(context: ServiceContext, ids: string[]): Promise<(Content | null)[]> {
    if (ids.length === 0) {
      return [];
    }

    let query = this.contentRepository
      .createQueryBuilder('content')
      .where('content.id IN (:...ids)', { ids });

    if (context.userId !== SYSTEM_USER) {
      query = query.andWhere('content.user_id = :userId', { userId: context.userId });
    }

    const result = await this.excludeDeletedEventMedia(query, 'content').getMany();

    const contents = await this.composeMany(result);
    const map = new Map(contents.map((content) => [content.id, content]));

    return ids.map((id) => map.get(id) ?? null);
  }

  /**
   * Lightweight identifiers for the most-recent content, for the unified
   * search/explorer feed. Full entities are batch-resolved downstream.
   *
   * `excludeEventLinked` drops every row carrying an `event_id`. Such a row is
   * a FACET of an event the same feed already returns, not a separate memory:
   * on the QA appliance all 11,211 event-linked content rows are `type='media'`
   * and each one points at the very binary its event renders, so the browse
   * showed every photo twice — and, because content is ordered by `created_at`,
   * showed both copies ahead of the real timeline (all 11,211 were written after
   * the newest genuinely-dated memory). The event carries a real `start_time`;
   * the content row carries only the import's write time. Keeping the event and
   * dropping the facet loses nothing and un-buries the timeline.
   *
   * Applied only by the chronological browse. Query, tag and type-filtered
   * searches still return these rows — a user who searches for a photo, or
   * filters to Content, must still find it.
   */
  async getEntitiesForContents(
    context: ServiceContext,
    options: {
      limit?: number;
      startTime?: Date;
      endTime?: Date;
      afterTime?: Date;
      afterId?: string;
      order?: 'ASC' | 'DESC';
      /** Drop rows that belong to an event (see the method docstring). */
      excludeEventLinked?: boolean;
    } = {},
  ): Promise<EntityIdentifier<IndexableEntity>[]> {
    let query = this.excludeDeletedEventMedia(
      this.contentRepository
        .createQueryBuilder('content')
        .select('content.id', 'id')
        .where('content.user_id = :userId', { userId: context.userId }),
      'content',
    );

    if (options.excludeEventLinked) {
      query = query.andWhere('content.event_id IS NULL');
    }

    if (options.startTime) {
      query = query.andWhere('content.created_at >= :startTime', { startTime: options.startTime });
    }

    if (options.endTime) {
      query = query.andWhere('content.created_at <= :endTime', { endTime: options.endTime });
    }

    // Composite keyset: page strictly past (afterTime, afterId) in
    // (created_at DESC, id DESC). Without it the search feed re-fetched the same
    // top-N rows every page and dead-ended at `first * FETCH_MULTIPLIER` rows.
    if (options.afterTime && options.afterId) {
      query = query.andWhere(
        '(content.created_at < :afterTime OR (content.created_at = :afterTime AND content.id < :afterId))',
        { afterTime: options.afterTime, afterId: options.afterId },
      );
    }

    // Deterministic tiebreak so same-timestamp rows page consistently.
    query = query.orderBy('content.created_at', options.order ?? 'DESC').addOrderBy('content.id', 'DESC');

    if (options.limit) {
      query = query.limit(options.limit);
    }

    const rows = await query.getRawMany<{ id: string }>();

    return rows.map((row) => ({ id: row.id, type: 'content' as IndexableEntity }));
  }

  /**
   * True total of content matching the same filters {@link getEntitiesForContents} applies
   * (minus the pagination-only `limit`/`order`/`afterTime`/`afterId`) — a real `COUNT(*)`, not
   * the length of one `limit`-bounded page of identifiers. See EventService.countEntitiesForEvents.
   */
  async countEntitiesForContents(
    context: ServiceContext,
    options: { startTime?: Date; endTime?: Date; excludeEventLinked?: boolean },
  ): Promise<number> {
    let query = this.excludeDeletedEventMedia(
      this.contentRepository
        .createQueryBuilder('content')
        .where('content.user_id = :userId', { userId: context.userId }),
      'content',
    );

    if (options.excludeEventLinked) {
      query = query.andWhere('content.event_id IS NULL');
    }

    if (options.startTime) {
      query = query.andWhere('content.created_at >= :startTime', { startTime: options.startTime });
    }

    if (options.endTime) {
      query = query.andWhere('content.created_at <= :endTime', { endTime: options.endTime });
    }

    return query.getCount();
  }

  /**
   * Batch-load content rows linked to each of `eventIds`, oldest first.
   * Returns one `Content[]` per input id (same order), so a GraphQL DataLoader
   * can resolve `Event.contents` in a single query. Ownership is scoped through
   * the event's `user_id` — same rationale as {@link findMediaFilesByEventIds}.
   *
   * Two links are followed, because a content row has ONE `event_id` but may
   * stand for many events: every Audible session of a book, every Netflix
   * viewing of a title, shares the work's single content row, and only the
   * first session's id fits in the column. The rest are reachable through the
   * `Content -DOCUMENTS-> Event` edge the pipeline projects for each of them,
   * so without the second arm a drawer for the third viewing showed nothing.
   */
  async findByEventIds(context: UserServiceContext, eventIds: string[]): Promise<Content[][]> {
    if (eventIds.length === 0) {
      return [];
    }

    const rows = await this.contentRepository.manager.query<Array<{ content_id: string; event_id: string }>>(
      `SELECT DISTINCT l.content_id, l.event_id
         FROM (
           SELECT c.id AS content_id, c.event_id
             FROM ci.content c
            WHERE c.event_id = ANY($1::uuid[])
           UNION ALL
           SELECT r.from_entity_id AS content_id, r.to_entity_id AS event_id
             FROM ci.relationships r
            WHERE r.to_entity_id = ANY($1::uuid[])
              AND r.relationship_type = 'DOCUMENTS'
              AND r.is_active IS DISTINCT FROM false
         ) l
         JOIN ci.events e ON e.event_id = l.event_id AND e.user_id = $2::uuid
         JOIN ci.content c ON c.id = l.content_id AND c.user_id = $2::uuid`,
      [eventIds, context.userId],
    );

    const contentIds = [...new Set(rows.map((row) => row.content_id))];
    if (contentIds.length === 0) {
      return eventIds.map(() => []);
    }

    const entities = await this.contentRepository
      .createQueryBuilder('content')
      .leftJoinAndSelect('content.event', 'event')
      .where('content.id IN (:...contentIds)', { contentIds })
      .orderBy('content.created_at', 'ASC')
      .getMany();

    const contents = await this.composeMany(entities);
    const contentsMap = new Map<string, Content[]>();

    // Preserve created_at order within each event's list.
    for (const content of contents) {
      for (const link of rows) {
        if (link.content_id !== content.id) {
          continue;
        }

        const list = contentsMap.get(link.event_id);
        if (list) {
          if (!list.includes(content)) {
            list.push(content);
          }
        } else {
          contentsMap.set(link.event_id, [content]);
        }
      }
    }

    return eventIds.map((id) => contentsMap.get(id) ?? []);
  }

  /**
   * Batch-resolve the media file linked to each of `eventIds`. Photo/video
   * events carry their binary via a `ci.content` row (type='media',
   * external_id = the ORIGINAL `ci.files` id) written by the importer's media
   * pass — there is no direct events->files FK. Returns one row per link,
   * oldest first, so a GraphQL loader can attach a thumbnail to an event
   * without a per-event query. See {@link EventMediaLoader}.
   *
   * `external_id` is NOT reliably a file id — type='media' also covers a
   * digital-purchase/play content row whose external_id is a source-native URI
   * (e.g. Spotify's spotify:track:<id>, stamped by push/inputs.ts toContentInput
   * when the record carries a URI). Those never carry an event_id today, so the
   * event join above happens to keep them out — but that is scoping by
   * accident, not by contract. `external_id_kind` is the actual contract (see
   * migration 20260818215331_add_content_external_id_kind): excluding rows
   * explicitly marked 'external_uri' means this query stays correct even if a
   * future source starts linking a URI-keyed content row to an event.
   * Unclassified rows (external_id_kind IS NULL — pre-migration or a write path
   * not yet updated) are let through unchanged, matching prior behaviour.
   *
   * Ownership is scoped through the joined event's `user_id` rather than
   * `content.user_id`. New inserts now populate `content.user_id` (see
   * ContentEntity.userId — it used to be mapped `insert: false`, which persisted
   * NULL), but pre-fix rows stay NULL until the backfill migration runs and the
   * dedupe "loser" rows it leaves behind never get an owner, so the event join is
   * the reliable scope here. The linked file is independently re-scoped to the
   * user by `FileService`.
   */
  async findMediaFilesByEventIds(
    context: UserServiceContext,
    eventIds: string[],
  ): Promise<{ eventId: string; fileId: string; mimetype: string | null }[]> {
    if (eventIds.length === 0) {
      return [];
    }

    return this.contentRepository
      .createQueryBuilder('content')
      .innerJoin('content.event', 'event')
      .select('content.event_id', 'eventId')
      .addSelect('content.external_id', 'fileId')
      .addSelect('content.mimetype', 'mimetype')
      .where('event.userId = :userId', { userId: context.userId })
      .andWhere('content.event_id IN (:...eventIds)', { eventIds })
      .andWhere("content.type = 'media'")
      .andWhere('content.external_id IS NOT NULL')
      .andWhere("content.external_id_kind IS DISTINCT FROM 'external_uri'")
      .orderBy('content.created_at', 'ASC')
      .getRawMany<{ eventId: string; fileId: string; mimetype: string | null }>();
  }

  async update(context: ServiceContext, id: string, data: UpdateContentDto): Promise<Content | null> {
    const updateData: Partial<ContentEntity> = {};

    if (data.type !== undefined) {
      updateData.type = data.type;
    }

    if (data.text !== undefined) {
      updateData.text = data.text;
    }

    if (data.url !== undefined) {
      updateData.url = data.url;
    }

    if (data.mimetype !== undefined) {
      updateData.mimetype = data.mimetype;
    }

    if (data.external_id !== undefined) {
      updateData.externalId = data.external_id;
    }

    if (data.connection_id !== undefined) {
      updateData.connectionId = data.connection_id;
    }

    if (data.external_id_kind !== undefined) {
      updateData.externalIdKind = data.external_id_kind;
    } else if (data.external_id !== undefined) {
      // The kind describes the external_id it was derived from, so an update
      // that replaces external_id without saying the kind must re-derive it --
      // carrying the old classification forward would leave a row asserting
      // 'file' about a value that is now a source URI (or the reverse). When the
      // new value fits neither shape the honest answer is NULL (unclassified),
      // not the stale one.
      updateData.externalIdKind = classifyExternalId(data.external_id) ?? null;
    }

    if (data.source_url !== undefined) {
      updateData.sourceUrl = data.source_url;
    }

    // sourceData is declared on UpdateContentDto and passed by ContentResolver's
    // updateContent, but was never mapped here — every write to it was silently
    // dropped. Replaces the whole document rather than merging: the DTO carries
    // no patch semantics, so a merge would make key removal impossible.
    if (data.source_data !== undefined) {
      updateData.sourceData = data.source_data;
    }

    if (data.source_type !== undefined) {
      updateData.sourceType = data.source_type;
    }

    if (data.source_system !== undefined) {
      updateData.sourceSystem = data.source_system;
    }

    if (data.source_id !== undefined) {
      updateData.sourceId = data.source_id;
    }

    const basePatch: Partial<Pick<ContentBaseEntity, 'name'>> = {};
    if (data.title !== undefined) {
      basePatch.name = data.title;
    }

    const after = await this.aggregate.applyUpdate(
      context,
      id,
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        detail: updateData as any,
        base: basePatch,
      },
      {
        withinTx: async ({ manager }) => {
          const base = await manager.getRepository(ContentBaseEntity).findOne({ where: { id } });
          const changedFields: Record<string, { old?: unknown; new?: unknown }> = {};
          if (data.title !== undefined) {
            changedFields.name = { new: data.title };
          }

          if (Object.keys(updateData).length > 0) {
            changedFields.detail_updated = { new: true };
          }

          if (Object.keys(changedFields).length === 0) {
            return;
          }

          await this.graphDeltaWriter.entityUpdated({
            entityId: id,
            entityType: 'Content',
            name: base?.name ?? data.title ?? null,
            changedFields,
            ownerUserId: typeof context.userId === 'string' ? context.userId : null,
            changeSource: 'ContentService.update',
            changedByUserId: typeof context.userId === 'string' ? context.userId : null,
            manager,
          });
        },
      },
    );

    if (!after) {
      return null;
    }

    await this.eventService.send(ContentUpdatedEvent, {
      contentId: id,
    });

    const [content] = await this.composeMany([after]);

    return content;
  }

  async remove(context: ServiceContext, id: string): Promise<boolean> {
    const removed = await this.aggregate.remove(context, id, {
      withinTx: async ({ manager, before }) => {
        const base = await manager.getRepository(ContentBaseEntity).findOne({ where: { id } });
        await this.graphDeltaWriter.entityDeleted({
          entityId: id,
          entityType: 'Content',
          name: base?.name ?? null,
          ownerUserId: context.userId !== SYSTEM_USER ? context.userId : before.user?.id,
          changeSource: 'ContentService.remove',
          changedByUserId: typeof context.userId === 'string' ? context.userId : null,
          manager,
        });
      },
    });

    if (!removed) {
      return false;
    }

    await this.eventService.send(ContentRemovedEvent, {
      contentId: id,
    });

    return true;
  }

  /**
   * The content row a provenance triple already resolves to, if any.
   *
   * The per-row connector transforms cannot use `createMany`'s ON CONFLICT
   * path (it does not emit ContentCreatedEvent, so the row would not be
   * indexed until a manual backfill), and `search()` has no triple filter.
   * This is the read half of their find-then-update, mirroring
   * CommunicationService.findBySource.
   */
  async findBySource(
    context: ServiceContext,
    source: { source_type: string; source_system: string; source_id: string },
  ): Promise<Content | null> {
    const entity = await this.contentRepository.findOne({
      where: {
        ...(context.userId !== SYSTEM_USER && { userId: context.userId }),
        sourceType: source.source_type,
        sourceSystem: source.source_system,
        sourceId: source.source_id,
      },
    });

    if (!entity) {
      return null;
    }

    const [content] = await this.composeMany([entity]);

    return content ?? null;
  }

  async search(context: ServiceContext, filters: SearchContentDto): Promise<Content[]> {
    // title lives on the CTI base row; join ci.entities so title filters and
    // egress composition share one query.
    let executable = this.contentRepository
      .createQueryBuilder('content')
      .innerJoin(BaseEntity, 'base', "base.entity_id = content.id AND base.entity_type = 'Content'")
      .addSelect('base.name', 'base_name')
      .addSelect('base.description', 'base_description');

    if (context.userId !== SYSTEM_USER) {
      executable = executable.andWhere('content.user_id = :userId', { userId: context.userId });
    }

    if (filters.type !== undefined) {
      executable = executable.andWhere('content.type = :type', { type: filters.type });
    }

    if (filters.title !== undefined) {
      executable = executable.andWhere('base.name = :title', { title: filters.title });
    }

    if (filters.text !== undefined) {
      executable = executable.andWhere('content.text = :text', { text: filters.text });
    }

    if (filters.url !== undefined) {
      executable = executable.andWhere('content.url = :url', { url: filters.url });
    }

    if (filters.mimetype !== undefined) {
      executable = executable.andWhere('content.mimetype = :mimetype', { mimetype: filters.mimetype });
    }

    if (filters.external_id !== undefined) {
      executable = executable.andWhere('content.external_id = :externalId', {
        externalId: filters.external_id,
      });
    }

    if (filters.source_url !== undefined) {
      executable = executable.andWhere('content.source_url = :sourceUrl', {
        sourceUrl: filters.source_url,
      });
    }

    const { entities, raw } = await executable.getRawAndEntities<{
      base_name: string | null;
      base_description: string | null;
    }>();

    return entities.map((entity, index) =>
      ContentEntity.toEgressType(entity, {
        name: raw[index]?.base_name ?? null,
        description: raw[index]?.base_description ?? null,
      }),
    );
  }

  /**
   * Hourly UTC activity buckets for the activity rollup: content counted by
   * creation time, per user. Rows without an owner are skipped.
   */
  async aggregateHourlyActivity(): Promise<HourlyContentCount[]> {
    const rows: Array<{ user_id: string; bucket_start: Date; count: number }> = await this.contentRepository
      .createQueryBuilder('content')
      .select('content.userId', 'user_id')
      .addSelect(`date_trunc('hour', content.createdAt, 'UTC')`, 'bucket_start')
      .addSelect('COUNT(*)::int', 'count')
      .where('content.userId IS NOT NULL')
      .groupBy('user_id')
      .addGroupBy('bucket_start')
      .getRawMany();

    return rows.map((row) => ({ userId: row.user_id, bucketStart: row.bucket_start, count: row.count }));
  }
}
