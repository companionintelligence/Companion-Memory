import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Repository, type FindOptionsOrder, type FindOptionsWhere } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type ServiceContext, SYSTEM_USER, type UserServiceContext } from '@ci/common/context';
import { bulkInsertIdempotent, INGEST_REFRESH_COLUMNS } from '@ci/common/persistence';
import { EventService as SignallingEventService } from '@ci/domains/events';
import { EventCreatedEvent, EventUpdatedEvent, EventRemovedEvent } from '@ci/domains/memory/events';
import type { EntityIdentifier, IndexableEntity } from '@ci/domains/search-next';

import { EventBaseEntity } from '../entities/EventBaseEntity';
import { EventEntity, Event } from '../entities/EventEntity';
import { CreateEventDto, UpdateEventDto, SearchEventDto } from '../types';

import { CtiAggregate } from './CtiAggregate';

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

/**
 * How far before `from` an event may have started and still be returned by the
 * calendar range read.
 *
 * The overlap predicate `COALESCE(end_time, start_time) >= :from` is an
 * expression no index covers, and the only applicable index —
 * events_user_time_idx (user_id, start_time DESC) — can serve the `< :to` upper
 * bound but has nothing to stop at underneath, so the scan costs O(every event
 * the user owns before `to`) regardless of how narrow the window is. On a 200k
 * row table a 7-day window measured as a 2273-buffer seq scan (24.9ms); adding a
 * lower bound on start_time turns it into a 190-buffer bitmap index scan (2.4ms).
 * ci.events also holds photo/video rows, so this grows with every day of use.
 *
 * The bound is a bounded-lookback trade, not a free win: an event that started
 * more than this long before the window and is *still* running is dropped. A
 * quarter is the same span MAX_RANGE_DAYS lets a caller request in one go, and
 * nothing this appliance ingests — calendar entries, photos, visits, trips —
 * occupies a single unbroken span that long.
 */
const MAX_EVENT_LOOKBACK_DAYS = 92;

const DAY_MS = 86_400_000;

/**
 * Hard row cap for one calendar range read. The resolver's MAX_RANGE_DAYS bounds
 * the *span* a caller may ask for but not the row count, and a quarter-wide
 * request over a photo-heavy library can run to six figures of serialised nodes.
 * This is a backstop against that, not a pagination scheme: results are ordered
 * start_time ASC, so a truncated response is the earliest prefix of the window.
 */
const MAX_RANGE_EVENTS = 2000;

/**
 * Spanning-aggregate service for the events CTI split: an event is ONE logical
 * entity persisted as a `ci.entities` base row (discriminated 'Event', the
 * SOLE owner of title/description — see {@link EventBaseEntity}) plus a
 * `ci.events` detail row sharing the same uuid. Writes touch both rows in one
 * transaction; reads compose the egress {@link Event} from the pair with one
 * batched base-row fetch.
 */
@Injectable()
export class EventService {
  private readonly aggregate: CtiAggregate<EventEntity, EventBaseEntity>;

  constructor(
    @InjectRepository(EventEntity)
    private readonly eventRepository: Repository<EventEntity>,
    @InjectRepository(EventBaseEntity)
    private readonly eventBaseRepository: Repository<EventBaseEntity>,
    private readonly signallingEventService: SignallingEventService,
    private readonly dataSource: DataSource,
  ) {
    this.aggregate = new CtiAggregate({
      detailRepository: this.eventRepository,
      detailEntity: EventEntity,
      baseEntity: EventBaseEntity,
      baseRepository: this.eventBaseRepository,
      linkedTable: 'events',
      scopedWhere: (context, id) => ({
        id,
        ...(context.userId !== SYSTEM_USER && {
          user: { id: context.userId },
        }),
      }),
    });
  }

  /**
   * Composes egress events from detail rows plus one batched fetch of their
   * base rows (the owners of title/description), preserving input order.
   */
  private composeMany(entities: EventEntity[]): Promise<Event[]> {
    return this.aggregate.composeMany(entities, (entity, base) => EventEntity.toEgressType(entity, base));
  }

  private async composeOne(entity: EventEntity): Promise<Event> {
    const [event] = await this.composeMany([entity]);

    return event;
  }

  /** Map a CreateEventDto onto EventEntity columns (shared by the single + bulk paths). */
  private toEntityFields(item: CreateEventDto): Partial<EventEntity> {
    const toCreate = { ...item } as Partial<EventEntity>;

    // title/description are base-row data (ci.entities); never let them near
    // the detail table.
    delete (toCreate as Record<string, unknown>).title;
    delete (toCreate as Record<string, unknown>).description;

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

    // Provenance: who minted this event and from what. `repository.create()`
    // reads columns by propertyName and silently drops any key it does not
    // recognise, so a snake_case DTO key that is not renamed here is not a
    // no-op — it is a lost write. These four are the trail an event promoted
    // from a schedule candidate carries; without them a suggested event is
    // indistinguishable from a hand-created one.
    //
    // Compared against `undefined` rather than truthiness: `is_predicted: false`
    // is the meaningful assertion "the user committed to this, HBPE may train on
    // it", and 0 is a legal energy_level.
    if (item.is_predicted !== undefined) {
      toCreate.isPredicted = item.is_predicted;
    }

    if (item.inference_sources) {
      toCreate.inferenceSources = item.inference_sources;
    }

    if (item.created_by) {
      toCreate.createdBy = item.created_by;
    }

    if (item.energy_level !== undefined) {
      toCreate.energyLevel = item.energy_level;
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
        return this.composeOne(existing);
      }
    }

    const id = item.id ?? uuidv7();

    let eventResult: EventEntity;
    try {
      // One transaction across both halves of the aggregate: the base row (the
      // owner of title/description) first, then the detail.
      eventResult = await this.eventRepository.manager.transaction(async (manager) => {
        await manager.getRepository(EventBaseEntity).save(
          this.aggregate.createBaseRow(manager, {
            id,
            userId: context.userId,
            name: item.title,
            description: item.description ?? null,
          }),
        );

        const event = manager.getRepository(EventEntity).create({
          ...toCreate,
          id,
          user: {
            id: context.userId,
          },
        });

        return manager.getRepository(EventEntity).save(event);
      });
    } catch (err) {
      // Lost a race to a concurrent insert of the same triple (the partial-
      // unique index raised 23505) — fetch and return the winner. The failed
      // transaction rolled back the base row too.
      if (sourceWhere && (err as { code?: string })?.code === '23505') {
        const existing = await this.eventRepository.findOne({ where: sourceWhere });
        if (existing) {
          return this.composeOne(existing);
        }
      }

      throw err;
    }

    await this.signallingEventService.send(EventCreatedEvent, {
      eventId: eventResult.id,
    });

    return EventEntity.toEgressType(eventResult, {
      name: item.title,
      description: item.description ?? null,
    });
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

    const withIds = data.map((item) => ({ ...item, id: item.id ?? uuidv7() }));

    const entities = withIds.map((item) =>
      this.eventRepository.create({
        ...this.toEntityFields(item),
        id: item.id,
        userId: context.userId,
      }),
    );

    // title/description are base-row data and never touch the detail table.
    const ingressById = new Map(
      withIds.map((item) => [item.id, { title: item.title, description: item.description ?? null }]),
    );

    // One transaction spans both halves of the CTI aggregate: the detail rows
    // land first (the triple arbiter decides which actually insert), then a
    // base row is written for exactly the inserted set. The deferred FK
    // (events_event_id_entities_fk) tolerates the detail-before-base order.
    const { results, bases } = await this.eventRepository.manager.transaction(async (manager) => {
      const detailResults = await bulkInsertIdempotent({
        repository: this.eventRepository,
        manager,
        entities,
        primaryKey: 'id',
        getTriple: (entity) => ({
          sourceType: entity.sourceType,
          sourceSystem: entity.sourceSystem,
          sourceId: entity.sourceId,
        }),
        scope: { userId: context.userId },
        // Must match events_source_triple_uniq (user-scoped as of 20260808150100).
        conflictTarget: '(user_id, source_type, source_system, source_id) WHERE source_id IS NOT NULL',
        tripleColumns: ['source_type', 'source_system', 'source_id'],
        // Centralized refresh contract — currently empty, so conflicts stay
        // DO NOTHING find-or-return.
        conflictUpdateColumns: INGEST_REFRESH_COLUMNS.event,
      });

      const baseRows = detailResults
        .filter(({ inserted }) => inserted)
        .map(({ entity }) => {
          const ingress = ingressById.get(entity.id);
          if (!ingress) {
            // Every inserted id came from withIds — the exact array ingressById
            // was built from — so a miss means the id mapping broke. Fail
            // loudly rather than writing a null-labeled base row.
            throw new Error(`No ingress row for inserted event ${entity.id}`);
          }

          return this.aggregate.createBaseRow(manager, {
            id: entity.id,
            userId: context.userId,
            name: ingress.title,
            description: ingress.description,
          });
        });

      // ON CONFLICT (entity_id) DO NOTHING guards the theoretical case of a
      // base row already present for this uuid.
      await this.aggregate.insertBaseRows(manager, baseRows, '(entity_id) DO NOTHING');

      // One read covers egress composition for inserted AND pre-existing rows
      // (a deduped triple resolves to a row whose base values this batch never
      // carried).
      const baseEntities = await this.aggregate.fetchBaseMap(
        detailResults.map(({ entity }) => entity.id),
        manager,
      );

      return { results: detailResults, bases: baseEntities };
    });

    // Bulk ingest does NOT emit a per-row EventCreatedEvent: the per-row pgboss
    // fan-out was the dominant cost at import volume. Search indexing for
    // bulk-loaded rows is deferred to the post-load batch embed
    // (POST /api/maintenance/search-index/backfill). Single-row create() still
    // emits, so interactive creates index live.
    return results.map(({ entity }) => EventEntity.toEgressType(entity, bases.get(entity.id)));
  }

  /**
   * Events overlapping [from, to) — the calendar read path.
   *
   * Deliberately NOT the "starts within the window" filter used by
   * getEntitiesForEvents (the search path). A calendar must show an event that
   * began before the window and runs into it: a Sunday-night flight still
   * occupies Monday morning. So the predicate is interval overlap, with an
   * open-ended event (no end_time) treated as an instant at start_time.
   *
   * Cancelled and no-show rows are excluded — they are not occupied time — but
   * `tentative` is kept, because a maybe on the calendar is still a claim on the
   * slot and the schedule surface renders it as such.
   *
   * Bounded on both sides and capped: see MAX_EVENT_LOOKBACK_DAYS for why the
   * overlap predicate alone cannot use an index, and MAX_RANGE_EVENTS for the
   * row cap.
   *
   * STOPGAP: browser extension page views dual-write into ci.events with
   * source_type='browser_activity'. Excluded here until we define which event
   * kinds belong on the schedule calendar and wire pg-boss accordingly.
   */
  async findInRange(context: ServiceContext, from: Date, to: Date): Promise<Event[]> {
    // Sargable floor for events_user_time_idx: the planner can now range-scan
    // (user_id, start_time) instead of walking the user's whole history.
    const lowerBound = new Date(from.getTime() - MAX_EVENT_LOOKBACK_DAYS * DAY_MS);

    const query = this.dataSource
      .getRepository(EventEntity)
      .createQueryBuilder('event')
      .where('event.is_deleted = false')
      .andWhere("event.status NOT IN ('cancelled', 'no_show')")
      .andWhere('event.start_time >= :lowerBound', { lowerBound })
      .andWhere('event.start_time < :to', { to })
      .andWhere('COALESCE(event.end_time, event.start_time) >= :from', { from })
      .andWhere("event.source_type IS DISTINCT FROM 'browser_activity'")
      .orderBy('event.start_time', 'ASC')
      .addOrderBy('event.event_id', 'ASC')
      .take(MAX_RANGE_EVENTS);

    if (context.userId !== SYSTEM_USER) {
      query.andWhere('event.user_id = :userId', { userId: context.userId });
    }

    const result = await query.getMany();

    return this.composeMany(result);
  }

  /**
   * Move an event to a new time, preserving its duration.
   *
   * Separate from `update` because a move carries a consequence a generic field
   * write does not: an event mirrored from an external calendar
   * (`source_system` set) is only a local copy, and moving it here does NOT
   * reach the source. Marking it `pending` records that the local row has drifted
   * ahead of the calendar it came from, so a future sync-back has something to
   * find (CI-Server-aan) and the UI can say so honestly.
   *
   * All-day events ignore the time component: their "when" is a date.
   */
  async reschedule(
    context: ServiceContext,
    id: string,
    startTime: Date,
    endTime?: Date,
  ): Promise<Event | null> {
    const event = await this.eventRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && { user: { id: context.userId } }),
      },
    });

    if (!event) {
      return null;
    }

    // Duration is the thing being preserved: a 90-minute meeting dragged to
    // Thursday is still 90 minutes, even though the caller only names a start.
    const priorSpanMs =
      event.endTime && event.startTime ? event.endTime.getTime() - event.startTime.getTime() : 0;

    event.startTime = startTime;
    event.endTime = endTime ?? (priorSpanMs > 0 ? new Date(startTime.getTime() + priorSpanMs) : null);

    if (event.sourceSystem) {
      event.externalSyncStatus = 'pending';
    }

    await this.eventRepository.save(event);

    await this.signallingEventService.send(EventUpdatedEvent, { eventId: event.id });

    return this.findById(context, id);
  }

  async findAll(context: ServiceContext): Promise<Event[]> {
    const result = await this.eventRepository.find({
      where: {
        ...(context.userId !== SYSTEM_USER && {
          user: { id: context.userId },
        }),
      },
    });

    return this.composeMany(result);
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

    const events = await this.composeMany(result);
    const map = new Map(events.map((event) => [event.id, event]));

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

    return result ? this.composeOne(result) : null;
  }

  async update(context: ServiceContext, id: string, data: UpdateEventDto): Promise<Event | null> {
    const updateData: Partial<EventEntity> = {};

    // title/description are base-row data (ci.entities); patched separately
    // below, in the same transaction.
    const basePatch: Partial<Pick<EventBaseEntity, 'name' | 'description'>> = {};
    if (data.title) {
      basePatch.name = data.title;
    }

    if (data.description) {
      basePatch.description = data.description;
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

    if (data.status) {
      updateData.status = data.status;
    }

    if (data.is_deleted) {
      updateData.isDeleted = data.is_deleted;
    }

    if (data.external_sync_status) {
      updateData.externalSyncStatus = data.external_sync_status;
    }

    if (data.parent_event_id) {
      updateData.parentEventId = data.parent_event_id;
    }

    if (data.created_by) {
      updateData.createdBy = data.created_by;
    }

    // One transaction across both halves of the aggregate (see CtiAggregate).
    // A title/description-only patch still bumps ci.events.updated_at so
    // detail-side incremental consumers see the change.
    const updated = await this.aggregate.applyUpdate(context, id, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      detail: updateData as any, // TypeORM will handle JSON serialization
      base: basePatch,
    });

    if (!updated) {
      return null;
    }

    await this.signallingEventService.send(EventUpdatedEvent, {
      eventId: updated.id,
    });

    // The transaction already reloaded the detail row; one base fetch
    // completes the egress composition.
    const [event] = await this.composeMany([updated]);

    return event;
  }

  async remove(context: ServiceContext, id: string): Promise<boolean> {
    // Authorized load + base-row delete — the events_event_id_entities_fk
    // ON DELETE CASCADE removes the detail in the same statement. Downstream
    // FK semantics are unchanged (capture_events/observations/receipts SET
    // NULL; hbpe.l1_event_cluster still RESTRICTs a clustered event).
    const removed = await this.aggregate.remove(context, id);

    if (!removed) {
      return false;
    }

    await this.signallingEventService.send(EventRemovedEvent, {
      eventId: id,
    });

    return true;
  }

  async search(context: ServiceContext, query: SearchEventDto): Promise<Event[]> {
    const { title, description, ...detailQuery } = query;

    // title/description live on the CTI base row; the FK guarantees every
    // detail row has one, so the base is joined unconditionally and its
    // columns are hydrated in the SAME query — no second composition fetch.
    let qb = this.eventRepository
      .createQueryBuilder('event')
      .innerJoin('ci.entities', 'base', 'base.entity_id = event.event_id')
      .addSelect('base.name', 'base_name')
      .addSelect('base.description', 'base_description');

    if (context.userId !== SYSTEM_USER) {
      qb = qb.andWhere('event.user_id = :userId', { userId: context.userId });
    }

    if (title) {
      qb = qb.andWhere('base.name = :title', { title });
    }

    if (description) {
      qb = qb.andWhere('base.description = :description', { description });
    }

    for (const [key, value] of Object.entries(detailQuery)) {
      if (value !== undefined) {
        qb = qb.andWhere(`event.${key} = :${key}`, { [key]: value });
      }
    }

    // The 1:1 join yields exactly one raw row per entity, in the same order,
    // so the base columns compose positionally.
    const { entities, raw } = await qb.getRawAndEntities<{
      base_name: string | null;
      base_description: string | null;
    }>();

    return entities.map((entity, index) =>
      EventEntity.toEgressType(entity, {
        name: raw[index]?.base_name ?? null,
        description: raw[index]?.base_description ?? null,
      }),
    );
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
