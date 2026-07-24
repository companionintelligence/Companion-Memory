import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Repository, type FindOptionsOrder, type FindOptionsWhere } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type ServiceContext, SYSTEM_USER, type UserServiceContext } from '@ci/common/context';
import { bulkInsertIdempotent, INGEST_REFRESH_COLUMNS } from '@ci/common/persistence';
import { EventService as SignallingEventService } from '@ci/domains/events';
import { EventCreatedEvent, EventUpdatedEvent, EventRemovedEvent } from '@ci/domains/memory/events';
import type { EntityIdentifier, IndexableEntity } from '@ci/domains/search-next';

import { EventEntity, Event } from '../entities/EventEntity';
import { CreateEventDto, UpdateEventDto, SearchEventDto } from '../types';

interface Options {
  limit?: number;
  order?: FindOptionsOrder<EventEntity>;
  startTime?: Date;
  endTime?: Date;
  /**
   * Composite keyset cursor for the timed search path: return only events
   * strictly past (afterTime, afterId) in (start_time DESC, event_id DESC)
   * order, so a cluster of identical start_times can be paged through (the
   * time-only window dead-ended once a cluster exceeded one fetch).
   */
  afterTime?: Date;
  afterId?: string;
  eventTypes?: string[];
  /** "Connector": event.source_system values to include (e.g. 'gmail','imessage'). */
  connectors?: string[];
  /** "Who": person name patterns matched (ILIKE) against linked Person entities. */
  people?: string[];
  /** "Where": place name patterns matched (ILIKE) against the linked Location entity / location_name. */
  places?: string[];
  /** "Where": when true, only events with geographic coordinates are returned. */
  hasLocation?: boolean;
  /** "Where" (viewport): bounding box [minLon, minLat, maxLon, maxLat] (EPSG:4326). */
  bbox?: number[];
}

/**
 * Hourly UTC per-user event count. Declared locally so this domain carries no
 * dependency on aggregating consumers; they enforce the shape structurally
 * where they consume it.
 */
export interface HourlyEventCount {
  userId: string;
  bucketStart: Date;
  count: number;
}

@Injectable()
export class EventService {
  constructor(
    @InjectRepository(EventEntity)
    private readonly eventRepository: Repository<EventEntity>,
    private readonly signallingEventService: SignallingEventService,
    private readonly dataSource: DataSource,
  ) {}

  /** Map a CreateEventDto onto EventEntity columns (shared by the single + bulk paths). */
  private toEntityFields(item: CreateEventDto): Partial<EventEntity> {
    const toCreate = { ...item } as Partial<EventEntity>;

    if (item.start_time) {
      toCreate.startTime = item.start_time;
    }

    if (item.end_time) {
      toCreate.endTime = item.end_time;
    }

    if (item.source_system) {
      toCreate.sourceSystem = item.source_system;
    }

    if (item.event_type) {
      toCreate.eventType = item.event_type;
    }

    if (item.source_type) {
      toCreate.sourceType = item.source_type;
    }

    if (item.participant_entity_ids) {
      toCreate.participantEntityIds = item.participant_entity_ids;
    }

    if (item.organizer_entity_id) {
      toCreate.organizerEntityId = item.organizer_entity_id;
    }

    if (item.location_entity_id) {
      toCreate.locationEntityId = item.location_entity_id;
    }

    if (item.location_coordinates) {
      toCreate.locationCoordinates = item.location_coordinates;
    }

    if (item.location_name) {
      toCreate.locationName = item.location_name;
    }

    if (item.source_id) {
      toCreate.sourceId = item.source_id;
    }

    if (item.sharing_level) {
      toCreate.sharingLevel = item.sharing_level;
    }

    return toCreate;
  }

  /**
   * Find-or-create a single event, idempotent on the provenance triple. Kept as
   * the per-row path (a re-ingest / flaky-client retry returns the existing row);
   * the array path below uses a set-based insert for bulk importer pushes.
   */
  private async createOne(context: UserServiceContext, item: CreateEventDto): Promise<Event> {
    const toCreate = this.toEntityFields(item);

    // Idempotency: (source_type, source_system, source_id) is the stable
    // provenance triple capture sources carry. Re-ingesting the same event
    // — flaky-client retries, a full importer re-sync — must NOT create a
    // duplicate. When the triple is present, return the existing row.
    const sourceWhere: FindOptionsWhere<EventEntity> | null =
      item.source_type && item.source_id
        ? {
            sourceType: item.source_type,
            sourceSystem: item.source_system ?? IsNull(),
            sourceId: item.source_id,
            user: { id: context.userId },
          }
        : null;

    if (sourceWhere) {
      const existing = await this.eventRepository.findOne({ where: sourceWhere });
      if (existing) {
        return EventEntity.toEgressType(existing);
      }
    }

    const id = item.id ?? uuidv7();

    const event = this.eventRepository.create({
      ...toCreate,
      id,
      user: {
        id: context.userId,
      },
    });

    let eventResult: EventEntity;
    try {
      eventResult = await this.eventRepository.save(event);
    } catch (err) {
      // Lost a race to a concurrent insert of the same triple (the partial-
      // unique index raised 23505) — fetch and return the winner.
      if (sourceWhere && (err as { code?: string })?.code === '23505') {
        const existing = await this.eventRepository.findOne({ where: sourceWhere });
        if (existing) {
          return EventEntity.toEgressType(existing);
        }
      }

      throw err;
    }

    await this.signallingEventService.send(EventCreatedEvent, {
      eventId: eventResult.id,
    });

    return EventEntity.toEgressType(eventResult);
  }

  async create(context: UserServiceContext, data: CreateEventDto | CreateEventDto[]): Promise<Event[]> {
    if (!Array.isArray(data)) {
      return [await this.createOne(context, data)];
    }

    return this.createManyBatched(context, data);
  }

  /**
   * Batch, idempotent event ingest for the importer. Dedupes on the provenance
   * triple (source_type, source_system, source_id), scoped to the user, via one
   * set-based INSERT ... ON CONFLICT DO NOTHING instead of a per-row findOne + save
   * loop (the old path was N findOnes + N inserts and throttled the ~1M-row push).
   * Re-syncing the same triple returns the existing row instead of inserting a
   * duplicate. Paired with the events_source_triple_uniq partial unique index,
   * which also absorbs a lost insert race. Bulk ingest does NOT emit a per-row
   * EventCreatedEvent — search indexing is deferred to the post-load batch embed
   * (POST /api/maintenance/search-index/backfill); single-row create() still emits.
   */
  private async createManyBatched(context: UserServiceContext, data: CreateEventDto[]): Promise<Event[]> {
    if (data.length === 0) {
      return [];
    }

    const entities = data.map((item) =>
      this.eventRepository.create({
        ...this.toEntityFields(item),
        id: item.id ?? uuidv7(),
        userId: context.userId,
      }),
    );

    const results = await bulkInsertIdempotent({
      repository: this.eventRepository,
      entities,
      primaryKey: 'id',
      getTriple: (entity) => ({
        sourceType: entity.sourceType,
        sourceSystem: entity.sourceSystem,
        sourceId: entity.sourceId,
      }),
      scope: { userId: context.userId },
      // The events_source_triple_uniq index is NOT user-scoped (see migration
      // 20260620213807); the arbiter must match it exactly.
      conflictTarget: '(source_type, source_system, source_id) WHERE source_id IS NOT NULL',
      tripleColumns: ['source_type', 'source_system', 'source_id'],
      // Centralized refresh contract — currently empty, so conflicts stay
      // DO NOTHING find-or-return.
      conflictUpdateColumns: INGEST_REFRESH_COLUMNS.event,
    });

    // Bulk ingest does NOT emit a per-row EventCreatedEvent: the per-row pgboss
    // fan-out was the dominant cost at import volume. Search indexing for
    // bulk-loaded rows is deferred to the post-load batch embed
    // (POST /api/maintenance/search-index/backfill). Single-row create() still
    // emits, so interactive creates index live.
    return results.map(({ entity }) => EventEntity.toEgressType(entity));
  }

  async findAll(context: ServiceContext): Promise<Event[]> {
    const result = await this.eventRepository.find({
      where: {
        ...(context.userId !== SYSTEM_USER && {
          user: { id: context.userId },
        }),
      },
    });

    return result.map((entity) => EventEntity.toEgressType(entity));
  }

  async findByIds(context: ServiceContext, ids: string[]): Promise<(Event | null)[]> {
    const result = await this.eventRepository.find({
      where: {
        id: In(ids),
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
      },
    });

    const map = new Map(result.map((entity) => [entity.id, EventEntity.toEgressType(entity)]));

    return ids.map((id) => map.get(id) ?? null);
  }

  async findById(context: ServiceContext, id: string): Promise<Event | null> {
    const result = await this.eventRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          user: { id: context.userId },
        }),
      },
    });

    return result ? EventEntity.toEgressType(result) : null;
  }

  async update(context: ServiceContext, id: string, data: UpdateEventDto): Promise<Event | null> {
    const updateData: Partial<EventEntity> = {};

    if (data.title) {
      updateData.title = data.title;
    }

    if (data.description) {
      updateData.description = data.description;
    }

    if (data.event_type) {
      updateData.eventType = data.event_type;
    }

    if (data.category) {
      updateData.category = data.category;
    }

    if (data.start_time) {
      updateData.startTime = data.start_time;
    }

    if (data.end_time) {
      updateData.endTime = data.end_time;
    }

    if (data.duration_minutes) {
      updateData.durationMinutes = data.duration_minutes;
    }

    if (data.location_name) {
      updateData.locationName = data.location_name;
    }

    if (data.event_entity_id) {
      updateData.eventEntityId = data.event_entity_id;
    }

    if (data.location_coordinates) {
      updateData.locationCoordinates = data.location_coordinates;
    }

    if (data.location_entity_id) {
      updateData.locationEntityId = data.location_entity_id;
    }

    if (data.participant_entity_ids) {
      updateData.participantEntityIds = data.participant_entity_ids;
    }

    if (data.organizer_entity_id) {
      updateData.organizerEntityId = data.organizer_entity_id;
    }

    if (data.source_type) {
      updateData.sourceType = data.source_type;
    }

    if (data.source_system) {
      updateData.sourceSystem = data.source_system;
    }

    if (data.source_id) {
      updateData.sourceId = data.source_id;
    }

    if (data.confidence_score) {
      updateData.confidenceScore = data.confidence_score;
    }

    if (data.is_recurring) {
      updateData.isRecurring = data.is_recurring;
    }

    if (data.recurrence_pattern) {
      updateData.recurrencePattern = data.recurrence_pattern;
    }

    if (data.is_all_day) {
      updateData.isAllDay = data.is_all_day;
    }

    if (data.is_private) {
      updateData.isPrivate = data.is_private;
    }

    if (data.priority) {
      updateData.priority = data.priority;
    }

    if (data.metadata) {
      updateData.metadata = data.metadata;
    }

    if (data.is_predicted) {
      updateData.isPredicted = data.is_predicted;
    }

    if (data.is_inferred) {
      updateData.isInferred = data.is_inferred;
    }

    if (data.prediction_model) {
      updateData.predictionModel = data.prediction_model;
    }

    if (data.inference_sources) {
      updateData.inferenceSources = data.inference_sources;
    }

    if (data.tags) {
      updateData.tags = data.tags;
    }

    if (data.sentiment_score) {
      updateData.sentimentScore = data.sentiment_score;
    }

    if (data.energy_level) {
      updateData.energyLevel = data.energy_level;
    }

    if (data.productivity_impact) {
      updateData.productivityImpact = data.productivity_impact;
    }

    if (data.status) {
      updateData.status = data.status;
    }

    if (data.is_deleted) {
      updateData.isDeleted = data.is_deleted;
    }

    if (data.external_sync_status) {
      updateData.externalSyncStatus = data.external_sync_status;
    }

    if (data.last_synced_at) {
      updateData.lastSyncedAt = data.last_synced_at;
    }

    if (data.parent_event_id) {
      updateData.parentEventId = data.parent_event_id;
    }

    if (data.related_event_ids) {
      updateData.relatedEventIds = data.related_event_ids;
    }

    if (data.supersedes_event_id) {
      updateData.supersedesEventId = data.supersedes_event_id;
    }

    if (data.created_by) {
      updateData.createdBy = data.created_by;
    }

    const event = await this.eventRepository.findOne({
      where: {
        id: id,
        ...(context.userId !== SYSTEM_USER && {
          user: { id: context.userId },
        }),
      },
    });

    if (event) {
      Object.assign(event, updateData);
      await this.eventRepository.save(event);

      await this.signallingEventService.send(EventUpdatedEvent, {
        eventId: event.id,
      });
    } else {
      return null;
    }

    return this.findById(context, id);
  }

  async remove(context: ServiceContext, id: string): Promise<boolean> {
    const event = await this.findById(context, id);

    if (!event) {
      return false;
    }

    await this.eventRepository.delete({
      id,
      ...(context.userId !== SYSTEM_USER && {
        user: { id: context.userId },
      }),
    });

    await this.signallingEventService.send(EventRemovedEvent, {
      eventId: id,
    });

    return true;
  }

  async search(context: ServiceContext, query: SearchEventDto): Promise<EventEntity[]> {
    return this.eventRepository.find({
      where: {
        ...query,
        ...(context.userId !== SYSTEM_USER && {
          user: { id: context.userId },
        }),
      },
    });
  }

  async getEntitiesForEvents(
    context: ServiceContext,
    options: Options,
  ): Promise<EntityIdentifier<IndexableEntity>[]> {
    let query = this.dataSource
      .getRepository(EventEntity)
      .createQueryBuilder('event')
      .select(['event.event_id'])
      .where('event.user_id = :userId', { userId: context.userId });

    if (options.limit) {
      query = query.limit(options.limit);
    }

    if (options.order) {
      for (const [field, direction] of Object.entries(options.order)) {
        query = query.orderBy(`event.${field}`, direction as 'ASC' | 'DESC');
      }

      // Deterministic tiebreak so same-timestamp rows have a stable total order
      // that the keyset cursor below can page through.
      query = query.addOrderBy('event.event_id', 'DESC');
    }

    // Composite keyset: page strictly past (afterTime, afterId). Matches the
    // (start_time DESC, event_id DESC) order so a same-timestamp cluster larger
    // than one fetch is walked through instead of re-returning its top rows.
    if (options.afterTime && options.afterId) {
      query = query.andWhere(
        '(event.start_time < :afterTime OR (event.start_time = :afterTime AND event.event_id < :afterId))',
        { afterTime: options.afterTime, afterId: options.afterId },
      );
    }

    if (options.startTime) {
      query = query.andWhere('event.start_time >= :startTime', { startTime: options.startTime });
    }

    if (options.endTime) {
      // Filter on the event's START instant only — "starts within the window".
      // This keeps the SQL timed path consistent with the in-memory post-filter
      // (SearchResolver.getEntityTimestamp, which keys off time ?? startTime) and
      // with the communication/browser-activity services (single `time` instant).
      // An earlier `event.end_time <= :endTime` clause additionally required the
      // event to END in-window, which excluded multi-day events that start in the
      // range but end after it and disagreed with the post-filter path.
      // (Bind under :endTime; binding `{ startTime: ... }` here previously
      // clobbered the lower bound since TypeORM merges all andWhere params.)
      query = query.andWhere('event.start_time <= :endTime', { endTime: options.endTime });
    }

    if (options.eventTypes && options.eventTypes.length > 0) {
      query = query.andWhere('event.event_type IN (:...eventTypes)', {
        eventTypes: options.eventTypes,
      });
    }

    // "Connector": restrict to the selected data sources.
    if (options.connectors && options.connectors.length > 0) {
      query = query.andWhere('event.source_system IN (:...connectors)', {
        connectors: options.connectors,
      });
    }

    // "Where" (located only): the event must carry geographic coordinates.
    if (options.hasLocation) {
      query = query.andWhere('event.location_coordinates IS NOT NULL');
    }

    // "Where" (viewport): the event's coordinates fall inside the bounding box
    // [minLon, minLat, maxLon, maxLat] (EPSG:4326). The geography column is cast
    // to geometry so the planar ST_MakeEnvelope / ST_Within pair applies (and the
    // functional GIST index on the cast can serve it). NULL coordinates are
    // excluded by ST_Within, so this also implies located-only. Ignored unless
    // exactly four finite numbers are supplied.
    if (options.bbox && options.bbox.length === 4 && options.bbox.every((value) => Number.isFinite(value))) {
      const [minLon, minLat, maxLon, maxLat] = options.bbox;

      query = query.andWhere(
        'ST_Within(event.location_coordinates::geometry, ST_MakeEnvelope(:minLon, :minLat, :maxLon, :maxLat, 4326))',
        { minLon, minLat, maxLon, maxLat },
      );
    }

    // "Who": the event's participants/organizer resolve to a Person entity whose
    // name matches any of the given patterns (case-insensitive substring).
    if (options.people && options.people.length > 0) {
      query = query.andWhere(
        `(
          event.participant_entity_ids && ARRAY(
            SELECT entity_id FROM ci.entities
            WHERE owner_user_id = :userId AND entity_type = 'Person' AND name ILIKE ANY(:peoplePatterns)
          )::uuid[]
          OR event.organizer_entity_id IN (
            SELECT entity_id FROM ci.entities
            WHERE owner_user_id = :userId AND entity_type = 'Person' AND name ILIKE ANY(:peoplePatterns)
          )
        )`,
        { userId: context.userId, peoplePatterns: options.people.map((name) => `%${name}%`) },
      );
    }

    // "Where" (by place): the event's Location entity (or denormalised
    // location_name) matches any of the given place patterns.
    if (options.places && options.places.length > 0) {
      query = query.andWhere(
        `(
          event.location_entity_id IN (
            SELECT entity_id FROM ci.entities
            WHERE owner_user_id = :userId AND entity_type = 'Location' AND name ILIKE ANY(:placePatterns)
          )
          OR event.location_name ILIKE ANY(:placePatterns)
        )`,
        { userId: context.userId, placePatterns: options.places.map((name) => `%${name}%`) },
      );
    }

    const results = await query.getRawMany();

    return results.map((row: { event_id: string; type: IndexableEntity }) => ({
      id: row.event_id,
      type: 'event' as IndexableEntity,
    }));
  }

  /**
   * Returns the distinct, non-null data sources / connectors
   * (event.source_system) present for the user — e.g. 'gmail', 'imessage',
   * 'spotify'. Populates the connector filter picker in the memory explorer.
   */
  async getDistinctEventSources(context: ServiceContext): Promise<string[]> {
    const results = await this.dataSource
      .getRepository(EventEntity)
      .createQueryBuilder('event')
      .select('DISTINCT event.source_system', 'source_system')
      .where('event.user_id = :userId', { userId: context.userId })
      .andWhere('event.source_system IS NOT NULL')
      .orderBy('event.source_system', 'ASC')
      .getRawMany();

    return results.map((row: { source_system: string }) => row.source_system);
  }

  /**
   * Returns the distinct, non-null event types present for the user (the "how"
   * dimension: visited, messaged, called, ...). Used to populate the activity
   * filter picker in the memory explorer.
   */
  async getDistinctEventTypes(context: ServiceContext): Promise<string[]> {
    const results = await this.dataSource
      .getRepository(EventEntity)
      .createQueryBuilder('event')
      .select('DISTINCT event.event_type', 'event_type')
      .where('event.user_id = :userId', { userId: context.userId })
      .andWhere('event.event_type IS NOT NULL')
      .orderBy('event.event_type', 'ASC')
      .getRawMany();

    return results.map((row: { event_type: string }) => row.event_type);
  }

  /**
   * Timeline totals for the stats page: how many events the user's timeline
   * holds and the earliest/latest `start_time` across them (the span of
   * remembered history).
   */
  async getTimelineStats(context: ServiceContext): Promise<{
    totalEvents: number;
    earliest: Date | null;
    latest: Date | null;
  }> {
    const row: { total: string; earliest: Date | null; latest: Date | null } | undefined =
      await this.dataSource
        .getRepository(EventEntity)
        .createQueryBuilder('event')
        .select('COUNT(*)', 'total')
        .addSelect('MIN(event.start_time)', 'earliest')
        .addSelect('MAX(event.start_time)', 'latest')
        .where('event.user_id = :userId', { userId: context.userId })
        .getRawOne();

    return {
      totalEvents: row ? parseInt(row.total, 10) : 0,
      earliest: row?.earliest ?? null,
      latest: row?.latest ?? null,
    };
  }

  /**
   * Hourly UTC activity buckets for the activity rollup: events counted by
   * `startTime`, per user.
   */
  async aggregateHourlyActivity(): Promise<HourlyEventCount[]> {
    const rows: Array<{ user_id: string; bucket_start: Date; count: number }> = await this.eventRepository
      .createQueryBuilder('event')
      .select('event.userId', 'user_id')
      .addSelect(`date_trunc('hour', event.startTime, 'UTC')`, 'bucket_start')
      .addSelect('COUNT(*)::int', 'count')
      .groupBy('user_id')
      .addGroupBy('bucket_start')
      .getRawMany();

    return rows.map((row) => ({ userId: row.user_id, bucketStart: row.bucket_start, count: row.count }));
  }
}
