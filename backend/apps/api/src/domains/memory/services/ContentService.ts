import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository, type WhereExpressionBuilder } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type ServiceContext, SYSTEM_USER, type UserServiceContext } from '@ci/common/context';
import {
  bulkInsertIdempotent,
  INGEST_REFRESH_COLUMNS,
  keysetPaginate,
  type KeysetPageArgs,
  type KeysetPage,
} from '@ci/common/persistence';
import { EventService } from '@ci/domains/events';
import { ContentCreatedEvent, ContentRemovedEvent, ContentUpdatedEvent } from '@ci/domains/memory/events';
import type { EntityIdentifier, IndexableEntity } from '@ci/domains/search-next';

import { Content, ContentEntity } from '../entities/ContentEntity';
import { EventEntity } from '../entities/EventEntity';
import { CreateContentDto, SearchContentDto, UpdateContentDto } from '../types';

/** The provenance triple shared by a content row and the event it auto-links to. */
type Triple = { sourceType: string; sourceSystem: string | null; sourceId: string };

/**
 * Stable string key for a triple, matching the `IS NOT DISTINCT FROM` semantics
 * of the lookup (a null source_system is its own bucket). Used to join input rows
 * to the events fetched in one set-based query.
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

@Injectable()
export class ContentService {
  constructor(
    @InjectRepository(ContentEntity)
    private readonly contentRepository: Repository<ContentEntity>,
    @InjectRepository(EventEntity)
    private readonly eventRepository: Repository<EventEntity>,
    private readonly eventService: EventService,
  ) {}

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
        const id = item.id ?? uuidv7();

        const content = await this.contentRepository.create({
          ...item,
          id,
          externalId: item.external_id ?? undefined,
          sourceUrl: item.source_url ?? undefined,
          sourceData: item.source_data ?? undefined,
          sourceType: item.source_type ?? undefined,
          sourceSystem: item.source_system ?? undefined,
          sourceId: item.source_id ?? undefined,
          // Write the owner via the scalar FK column, not the `user` relation:
          // ci.content.user_id and the relation map to the same DB column, and a
          // relation-only write was being shadowed to NULL (see ContentEntity.userId).
          // Mirrors EventService.createManyBatched.
          userId: context.userId,
        });

        const contentResult = await this.contentRepository.save(content);

        if (emitCreated) {
          await this.eventService.send(ContentCreatedEvent, {
            contentId: contentResult.id,
          });
        }

        return ContentEntity.toEgressType(contentResult);
      }),
    );
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
    if (data.length === 0) {
      return [];
    }

    const emitCreated = options?.emitCreated ?? false;

    // Set-based event auto-link: resolve every triple-carrying row's event in ONE
    // query up front, so the per-entity `event` relation can be stamped before the
    // bulk insert (replacing the old per-row resolveEventByTriple findOne).
    const eventIdByTriple = await this.resolveEventIdsByTriple(context, data);

    const entities = data.map((item) => {
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

      return this.contentRepository.create({
        ...item,
        id: item.id ?? uuidv7(),
        externalId: item.external_id ?? undefined,
        sourceUrl: item.source_url ?? undefined,
        sourceData: item.source_data ?? undefined,
        sourceType: item.source_type ?? undefined,
        sourceSystem: item.source_system ?? undefined,
        sourceId: item.source_id ?? undefined,
        event,
        // Owner via the scalar FK column, not the `user` relation (see
        // ContentEntity.userId — a relation-only write shadowed it to NULL).
        userId: context.userId,
      });
    });

    const results = await bulkInsertIdempotent({
      repository: this.contentRepository,
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

    // Interactive single creates ask to index live (emitCreated:true); emit only
    // for rows genuinely inserted by THIS call so a re-send is a no-op. The bulk
    // importer leaves this false — its indexing is deferred to the backfill sweep.
    if (emitCreated) {
      for (const { entity, inserted } of results) {
        if (inserted) {
          await this.eventService.send(ContentCreatedEvent, { contentId: entity.id });
        }
      }
    }

    return results.map(({ entity }) => ContentEntity.toEgressType(entity));
  }

  /**
   * Set-based event auto-link resolution: given the whole input batch, run ONE
   * query to find every event in ci.events whose (user_id, source_type,
   * source_system, source_id) triple matches a triple-carrying input row, and
   * return a map from triple-key to event id. Replaces the old per-row
   * resolveEventByTriple findOne. `source_system` is matched with
   * `IS NOT DISTINCT FROM` so a NULL system equals a NULL system, preserving the
   * prior `sourceSystem ?? IsNull()` semantics. Only rows with both source_type
   * and source_id are considered (mirroring the old guard); rows without a triple
   * never auto-link.
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
            qb.orWhere(
              `(event.sourceType = :evt_type_${i}` +
                ` AND event.sourceSystem IS NOT DISTINCT FROM :evt_system_${i}` +
                ` AND event.sourceId = :evt_id_${i})`,
              {
                [`evt_type_${i}`]: triple.sourceType,
                [`evt_system_${i}`]: triple.sourceSystem,
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
    const result = await this.contentRepository.find({
      where: {
        user: {
          id: context.userId,
        },
      },
      relations: ['user'],
    });

    return result.map((entity) => ContentEntity.toEgressType(entity));
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
    });

    return {
      ...page,
      entities: page.entities.map((entity) => ContentEntity.toEgressType(entity)),
    };
  }

  async findById(context: ServiceContext, id: string): Promise<Content | null> {
    const result = await this.contentRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
      },
      relations: ['user'],
    });

    return result ? ContentEntity.toEgressType(result) : null;
  }

  async findByIds(context: ServiceContext, ids: string[]): Promise<(Content | null)[]> {
    const result = await this.contentRepository.find({
      where: {
        id: In(ids),
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
      },
      relations: ['user'],
    });

    const map = new Map(result.map((content) => [content.id, ContentEntity.toEgressType(content)]));

    return ids.map((id) => map.get(id) ?? null);
  }

  /**
   * Lightweight identifiers for the most-recent content, for the unified
   * search/explorer feed. Full entities are batch-resolved downstream.
   */
  async getEntitiesForContents(
    context: ServiceContext,
    options: { limit?: number; startTime?: Date; endTime?: Date; order?: 'ASC' | 'DESC' } = {},
  ): Promise<EntityIdentifier<IndexableEntity>[]> {
    let query = this.contentRepository
      .createQueryBuilder('content')
      .select('content.id', 'id')
      .where('content.user_id = :userId', { userId: context.userId });

    if (options.startTime) {
      query = query.andWhere('content.created_at >= :startTime', { startTime: options.startTime });
    }

    if (options.endTime) {
      query = query.andWhere('content.created_at <= :endTime', { endTime: options.endTime });
    }

    query = query.orderBy('content.created_at', options.order ?? 'DESC');

    if (options.limit) {
      query = query.limit(options.limit);
    }

    const rows = await query.getRawMany<{ id: string }>();

    return rows.map((row) => ({ id: row.id, type: 'content' as IndexableEntity }));
  }

  /**
   * Batch-resolve the media file linked to each of `eventIds`. Photo/video
   * events carry their binary via a `ci.content` row (type='media',
   * external_id = the ORIGINAL `ci.files` id) written by the importer's media
   * pass — there is no direct events->files FK. Returns one row per link,
   * oldest first, so a GraphQL loader can attach a thumbnail to an event
   * without a per-event query. See {@link EventMediaLoader}.
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
      .orderBy('content.created_at', 'ASC')
      .getRawMany<{ eventId: string; fileId: string; mimetype: string | null }>();
  }

  async update(context: ServiceContext, id: string, data: UpdateContentDto): Promise<Content | null> {
    const updateData: Partial<ContentEntity> = {};

    if (data.type !== undefined) {
      updateData.type = data.type;
    }

    if (data.title !== undefined) {
      updateData.title = data.title;
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

    const content = await this.contentRepository.findOne({
      where: {
        id: id,
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
      },
    });

    if (content) {
      Object.assign(content, updateData);
      await this.contentRepository.save(content);
    } else {
      return null;
    }

    await this.eventService.send(ContentUpdatedEvent, {
      contentId: id,
    });

    return this.findById(context, id);
  }

  async remove(context: ServiceContext, id: string): Promise<boolean> {
    const content = await this.contentRepository.findOne({
      where: {
        id: id,
        ...(context.userId !== SYSTEM_USER && {
          user: { id: context.userId },
        }),
      },
    });

    if (!content) {
      return false;
    }

    await this.contentRepository.delete({
      id,
      ...(context.userId !== SYSTEM_USER && {
        user: { id: context.userId },
      }),
    });

    await this.eventService.send(ContentRemovedEvent, {
      contentId: id,
    });

    return true;
  }

  async search(context: ServiceContext, filters: SearchContentDto): Promise<Content[]> {
    const whereClause: Record<string, unknown> = {
      ...(context.userId !== SYSTEM_USER && {
        user: {
          id: context.userId,
        },
      }),
    };

    if (filters.type !== undefined) {
      whereClause.type = filters.type;
    }

    if (filters.title !== undefined) {
      whereClause.title = filters.title;
    }

    if (filters.text !== undefined) {
      whereClause.text = filters.text;
    }

    if (filters.url !== undefined) {
      whereClause.url = filters.url;
    }

    if (filters.mimetype !== undefined) {
      whereClause.mimetype = filters.mimetype;
    }

    if (filters.external_id !== undefined) {
      whereClause.externalId = filters.external_id;
    }

    if (filters.source_url !== undefined) {
      whereClause.sourceUrl = filters.source_url;
    }

    const entities = await this.contentRepository.find({
      where: whereClause,
      relations: ['user'],
    });

    return entities.map((entity) => ContentEntity.toEgressType(entity));
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
