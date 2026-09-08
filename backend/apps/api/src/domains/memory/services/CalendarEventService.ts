import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  In,
  IsNull,
  Repository,
  type FindOptionsOrder,
  type FindOptionsWhere,
  type ObjectLiteral,
  type SelectQueryBuilder,
} from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type ServiceContext, SYSTEM_USER, type UserServiceContext } from '@ci/common/context';
import { HbpeNotifyService } from '@ci/common/hbpe';
import {
  type BulkInsertResult,
  type KeysetPage,
  type KeysetPageArgs,
  appendRecordSources,
  bulkInsertIdempotent,
  keysetPaginate,
  INGEST_REFRESH_COLUMNS,
} from '@ci/common/persistence';
import { EventService } from '@ci/domains/events';
import { EventCreatedEvent, EventUpdatedEvent, EventRemovedEvent } from '@ci/domains/memory/events';
import type { EntityIdentifier, IndexableEntity } from '@ci/domains/search-next';

import { BaseEntity } from '../entities/BaseEntity';
import { EventBaseEntity } from '../entities/EventBaseEntity';
import { EventEntity, Event } from '../entities/EventEntity';
import { PlaceEntity } from '../entities/PlaceEntity';
import { ledgerPlatform } from '../identity';
import { expandAll } from '../recurrence/expandAll';
import { dropExistingOverrides, resolveExpansionZone } from '../recurrence/queries';
import type { OccurrenceSpec } from '../recurrence/types';
import { CreateEventDto, UpdateEventDto, SearchEventDto } from '../types';

import { CtiAggregate } from './CtiAggregate';
import { GraphDeltaWriter } from './GraphDeltaWriter';

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
  /**
   * Restrict to this explicit set of event ids, ANDed with every other filter.
   * The map's pin read uses it to intersect a text-query / tag candidate set
   * (resolved by the search + tag services, which know nothing about SQL
   * filters) with the located-event predicates below, so the map honours the
   * explorer's query and tag filters without a second filter implementation.
   * An empty array matches nothing.
   */
  ids?: string[];
}

/** Filter subset of {@link Options} that {@link CalendarEventService.countEntitiesForEvents} accepts —
 * everything `getEntitiesForEvents` filters *by*, minus the pagination-only fields
 * (`limit`, `order`, `afterTime`, `afterId`), which a total count must not depend on. */
type CountOptions = Omit<Options, 'limit' | 'order' | 'afterTime' | 'afterId'>;

/** Options for {@link CalendarEventService.findMapPins}: the shared filter set plus a hard row cap. */
type MapPinOptions = CountOptions & { limit: number };

/**
 * One located event reduced to what a map marker draws — a point, a label, and
 * enough timestamp to order and caption it. Deliberately NOT an {@link Event}:
 * the map plots tens of thousands of these at once, and hydrating full events
 * (media urls, participants, metadata) to draw a 48px pin is what forced the
 * old 30-pins-per-request paging.
 */
export interface MapPin {
  id: string;
  title: string | null;
  startTime: Date | null;
  endTime: Date | null;
  eventType: string | null;
  locationName: string | null;
  latitude: number;
  longitude: number;
  /**
   * `EventEntity.timeSource` — `'ingest'` means `startTime` is only the import
   * wall clock (a Google Maps saved place, an undated Reddit affiliation, …),
   * not evidence of anything. The client needs this to caption a pin "Date
   * unknown" instead of the fabricated moment it was parsed, the same rule
   * {@link getEntityTimestamp} already applies on the timeline/explorer side.
   */
  timeSource: string | null;
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
 * Series masters the recurring leg of {@link CalendarEventService.findInRange}
 * may load. That leg deliberately has NO lookback floor — a weekly standup
 * whose DTSTART is in 2023 is exactly the row that has to be reached — so this
 * cap and `events_user_recurring_idx` are what keep it from degenerating into
 * the whole-history scan MAX_EVENT_LOOKBACK_DAYS was added to eliminate.
 */
export const MAX_RECURRING_MASTERS = 500;

/**
 * Synthetic occurrences one range read may add.
 *
 * Applied to the spec list BEFORE anything is materialized, so an over-eager
 * expansion cannot crowd real rows out of MAX_RANGE_EVENTS. A quarter of a
 * daily series is 92 occurrences; a thousand is roughly ten such series, which
 * is well past the point where the grid is unreadable anyway.
 */
export const MAX_EXPANDED_OCCURRENCES = 1000;

/**
 * Event types the schedule calendar renders, as an allowlist.
 *
 * `ci.events` is the timeline for everything an ETL connector can flatten, not
 * just calendar entries: Spotify writes `favorite` and `played_music`, Steam
 * writes `friend_added` and `game_played`, GitHub writes a `github_*` type per
 * repo action. None of those are occupied time on a calendar, and a denylist
 * put the burden on whoever adds the next connector to remember the schedule
 * surface exists. An allowlist fails closed instead: a new event type is
 * invisible here until someone adds it deliberately.
 *
 * This replaces the `source_type <> 'browser_activity'` stopgap from 6078c06f6,
 * which only covered the browser fold (itself reverted in 20260812144811).
 */
const SCHEDULE_EVENT_TYPES = ['calendar_event', 'meeting', 'appointment', 'planned_block'] as const;

/**
 * "This event did not happen" — the one status vocabulary the calendar and the
 * planner share.
 *
 * It is exported because it used to be duplicated, and the copies drifted:
 * `findInRange` excluded ('cancelled', 'no_show') while the planner's own
 * LIVE_BLOCK_SQL excluded ('cancelled', 'no_show', 'skipped'). A `skipped`
 * block was therefore invisible to every planned-block read while still
 * occupying its slot in the gap solver's occupancy set — the solver refused to
 * place into a window that nothing would ever draw.
 *
 * Always compare through COALESCE: `ci.events.status` was nullable until
 * 20260908000139 and `NULL NOT IN (...)` is UNKNOWN, not TRUE, so a bare
 * `NOT IN` silently drops null-status rows.
 */
export const DEAD_EVENT_STATUSES = ['cancelled', 'no_show', 'skipped'] as const;

/** SQL fragment for "this event still counts", for `event`-aliased builders. */
export const LIVE_EVENT_SQL = `COALESCE(event.status, 'confirmed') NOT IN (${DEAD_EVENT_STATUSES.map(
  (s) => `'${s}'`,
).join(', ')})`;

/**
 * Whether a planned block is still one the calendar would draw.
 *
 * A block dies two ways and BOTH have to be recognised here, because the
 * planning identity (`task:<uuid>`) is derived and therefore single-use:
 * `unschedule` tombstones it, while an accepted `event_revise` confirmation
 * leaves `is_deleted = false` and writes `status = 'cancelled'`. Matching only
 * the tombstone meant a cancelled block was handed back verbatim by the dedup
 * below — so the task reported itself placed, nothing rendered, and every retry
 * re-matched the same dead row. That is the same permanent failure the
 * tombstone branch was written for, reached through the status door.
 */
function isLivePlannedBlock(row: EventEntity): boolean {
  if (row.isDeleted) {
    return false;
  }

  const status = row.status ?? 'confirmed';

  return !(DEAD_EVENT_STATUSES as readonly string[]).includes(status);
}

/**
 * Spanning-aggregate service for the events CTI split: an event is ONE logical
 * entity persisted as a `ci.entities` base row (discriminated 'Event', the
 * SOLE owner of title/description — see {@link EventBaseEntity}) plus a
 * `ci.events` detail row sharing the same uuid. Writes touch both rows in one
 * transaction; reads compose the egress {@link Event} from the pair with one
 * batched base-row fetch.
 */
@Injectable()
export class CalendarEventService {
  private readonly aggregate: CtiAggregate<EventEntity, EventBaseEntity>;

  constructor(
    @InjectRepository(EventEntity)
    private readonly eventRepository: Repository<EventEntity>,
    @InjectRepository(EventBaseEntity)
    private readonly eventBaseRepository: Repository<EventBaseEntity>,
    private readonly signallingEventService: EventService,
    private readonly dataSource: DataSource,
    private readonly graphDeltaWriter: GraphDeltaWriter,
    @Optional() private readonly hbpeNotify?: HbpeNotifyService,
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
      // Events are tombstoned, not destroyed: deleting one is a user-facing
      // action on irreplaceable imported history, and `ci.events.is_deleted`
      // already exists for exactly this. `remove` flips the flag, `restore`
      // clears it, and the read paths below skip flagged rows.
      softDeleteFlag: 'isDeleted',
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

    // Timestamp provenance. Renamed here for the reason spelled out below the
    // is_predicted block: `repository.create()` matches on propertyName, so a
    // snake_case key that is not translated is silently DROPPED — and a dropped
    // `time_source: 'ingest'` is the worst possible failure for this pair,
    // because the row still gets its fabricated instant and loses the only
    // thing that said the instant was fabricated.
    if (item.time_source) {
      toCreate.timeSource = item.time_source;
    }

    if (item.time_precision) {
      toCreate.timePrecision = item.time_precision;
    }

    if (item.observed_at) {
      toCreate.observedAt = item.observed_at;
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

    if (item.connection_id) {
      toCreate.connectionId = item.connection_id;
    }

    if (item.capture_tick_id) {
      toCreate.captureTickId = item.capture_tick_id;
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

    if (item.task_id) {
      toCreate.taskId = item.task_id;
    }

    if (item.planned_minutes != null) {
      toCreate.plannedMinutes = item.planned_minutes;
    }

    // Calendar shape and confidence — the same silent-drop mechanism as the
    // provenance block above, and the reason it went unnoticed for so long:
    // ci.events DEFAULTs all four (is_all_day false, is_recurring false,
    // confidence_score 1.0), so a dropped write lands on a plausible-looking
    // default instead of erroring. Google's all-day Christmas was stored as a
    // midnight point event, an RRULE series master was stored as a one-off, and
    // a 0.4-confidence geocode claimed 1.0 to HBPE/RAG — the exact outcome
    // TransformGoogleCalendar computes that number to prevent.
    //
    // Compared against `undefined`, not truthiness: `is_all_day: false` and
    // `confidence_score: 0` are assertions, not omissions.
    if (item.is_all_day !== undefined) {
      toCreate.isAllDay = item.is_all_day;
    }

    if (item.is_recurring !== undefined) {
      toCreate.isRecurring = item.is_recurring;
    }

    if (item.recurrence_pattern !== undefined) {
      toCreate.recurrencePattern = item.recurrence_pattern;
    }

    if (item.confidence_score !== undefined) {
      toCreate.confidenceScore = item.confidence_score;
    }

    // `status` needs no rename (the column and the property share a name), but
    // it does need an explicit null dropped: `repository.create()` would write
    // that NULL over the column DEFAULT, and every calendar read is a
    // three-valued `status NOT IN (...)`, which a NULL-status row never
    // satisfies — the event would exist and be invisible on every schedule
    // surface. EventResolver forwards a nullable `status` verbatim, so this is
    // reachable from the public API.
    if (item.status == null) {
      delete (toCreate as Record<string, unknown>).status;
    }

    return toCreate;
  }

  /**
   * Find-or-create a single event, idempotent on the provenance triple. Kept as
   * the per-row path (a re-ingest / flaky-client retry returns the existing row);
   * the array path below uses a set-based insert for bulk importer pushes.
   */
  /**
   * Reject an inverted time pair before it reaches the `events_time_order`
   * CHECK, which would surface as an opaque 500.
   *
   * Lives here rather than in each caller because there are four of them —
   * `createEvent`/`updateEvent`, `scheduleTask`, `rescheduleEvent`, and
   * `CandidateService.accept`, which had no guard of its own at all. Equal
   * instants stay legal: the constraint is `start_time <= end_time`, and a
   * zero-length marker is a real thing a calendar carries.
   */
  private assertTimeOrder(startTime?: Date | null, endTime?: Date | null): void {
    if (startTime && endTime && endTime < startTime) {
      throw new BadRequestException('`endTime` must not precede `startTime`');
    }
  }

  private async createOne(context: UserServiceContext, item: CreateEventDto): Promise<Event> {
    this.assertTimeOrder(item.start_time, item.end_time);

    const toCreate = this.toEntityFields(item);

    // Idempotency: (source_type, source_system, source_id) is the stable
    // provenance triple capture sources carry. Re-ingesting the same event
    // — flaky-client retries, a full importer re-sync — must NOT create a
    // duplicate. When the triple is present, return the existing row.
    //
    // Deliberately NOT filtered by `isDeleted`: `events_source_identity_uniq`
    // covers tombstoned rows too, so skipping one here would send the insert
    // below into a guaranteed 23505. Matching it instead means a re-import of
    // an event the user deleted stays deleted rather than silently coming
    // back — the deletion outlives the next sync.
    //
    // Matches (source_system, source_id) only — source_type is provenance,
    // and a row written by the other pipeline is a hit
    // (docs/design/cross-pipeline-identity.md).
    const sourceWhere: FindOptionsWhere<EventEntity> | null = item.source_id
      ? {
          sourceSystem: item.source_system ?? IsNull(),
          sourceId: item.source_id,
          user: { id: context.userId },
        }
      : null;

    if (sourceWhere) {
      const existing = await this.eventRepository.findOne({ where: sourceWhere });
      if (existing) {
        // A tombstoned PLANNING row is the one case where returning the match
        // verbatim is wrong. Its identity is derived, not carried
        // (`platformIdentity('planning', 'task', id)` → `task:<uuid>`), so it is
        // single-use: after `PlannedBlockService.unschedule` tombstones the
        // block, the next place() matches that same dead row, reports the task
        // placed, and renders nothing — for good, since every retry re-matches.
        // Restore and retime it instead. The return-verbatim contract above is
        // unchanged for capture sources, where the identity comes from the
        // provider and a deletion must outlive the next sync.
        if (item.source_type === 'planning' && !isLivePlannedBlock(existing)) {
          return this.restorePlannedBlock(context, existing.id, item);
        }

        await this.ledgerArrival(context, existing.id, item);

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

        const saved = await manager.getRepository(EventEntity).save(event);
        await this.graphDeltaWriter.entityCreated({
          entityId: id,
          entityType: 'Event',
          name: item.title,
          description: item.description ?? null,
          ownerUserId: context.userId,
          changeSource: 'CalendarEventService.create',
          changedByUserId: typeof context.userId === 'string' ? context.userId : null,
          manager,
        });

        return saved;
      });
    } catch (err) {
      // Lost a race to a concurrent insert of the same triple (the partial-
      // unique index raised 23505) — fetch and return the winner. The failed
      // transaction rolled back the base row too.
      if (sourceWhere && (err as { code?: string })?.code === '23505') {
        const existing = await this.eventRepository.findOne({ where: sourceWhere });
        if (existing) {
          await this.ledgerArrival(context, existing.id, item);

          return this.composeOne(existing);
        }
      }

      throw err;
    }

    await this.ledgerArrival(context, eventResult.id, item);
    await this.signallingEventService.send(EventCreatedEvent, {
      eventId: eventResult.id,
    });
    await this.hbpeNotify?.notifyEvents(eventResult.userId, eventResult.startTime);

    return EventEntity.toEgressType(eventResult, {
      name: item.title,
      description: item.description ?? null,
    });
  }

  /**
   * Bring a tombstoned planned block back at the slot the placer just chose.
   *
   * Clears the tombstone through {@link restore} (so the search index and the
   * graph delta are re-published exactly as an Undo would), then writes the new
   * timing over the stale one. The write goes straight at the repository rather
   * than through {@link update}, because the fields that matter here —
   * `status`, `planned_minutes` — are the ones a partial update is entitled to
   * leave alone, and a restored block must not keep the previous placement's.
   */
  private async restorePlannedBlock(
    context: UserServiceContext,
    id: string,
    item: CreateEventDto,
  ): Promise<Event> {
    const restored = await this.restore(context, id);

    await this.eventRepository.update(
      { id },
      {
        startTime: item.start_time,
        endTime: item.end_time ?? null,
        status: item.status ?? 'planned',
        plannedMinutes: item.planned_minutes ?? null,
        taskId: item.task_id ?? null,
      },
    );

    await this.eventBaseRepository.update(
      { id },
      { name: item.title, description: item.description ?? null },
    );

    const reloaded = await this.eventRepository.findOne({ where: { id } });

    return reloaded ? this.composeOne(reloaded) : (restored as Event);
  }

  /**
   * Ledger one arrival of an event (insert, dedup hit, or lost race — all
   * three evidence the record; see ci.record_sources). No-op on an incomplete
   * triple. Mirrors CommunicationService.ledgerArrival.
   */
  private async ledgerArrival(
    context: UserServiceContext,
    recordId: string,
    item: Pick<
      CreateEventDto,
      'source_type' | 'source_system' | 'source_id' | 'source_platform' | 'connection_id'
    >,
  ): Promise<void> {
    if (!item.source_type || !item.source_system || !item.source_id) {
      return;
    }

    await appendRecordSources(this.eventRepository.manager, { table: 'events', userId: context.userId }, [
      {
        recordId,
        sourceType: item.source_type,
        sourceSystem: item.source_system,
        sourceId: item.source_id,
        connectionId: item.connection_id ?? null,
        importRunId: context.importRunId ?? null,
        platform: ledgerPlatform(item.source_system, item.source_platform),
      },
    ]);
  }

  async create(context: UserServiceContext, data: CreateEventDto | CreateEventDto[]): Promise<Event[]> {
    if (!Array.isArray(data)) {
      return [await this.createOne(context, data)];
    }

    return this.createManyBatched(context, data);
  }

  /**
   * Same ingest as {@link create}, reporting which rows this call actually
   * INSERTED rather than found already present.
   *
   * Batch-only: the single-record path inserts unconditionally, so there is no
   * ambiguity to report there.
   */
  async createDetailed(
    context: UserServiceContext,
    data: CreateEventDto[],
  ): Promise<Array<BulkInsertResult<Event>>> {
    return this.createManyBatchedDetailed(context, data);
  }

  /**
   * Batch, idempotent event ingest for the importer. Dedupes on the provenance
   * triple (source_type, source_system, source_id), scoped to the user, via one
   * set-based INSERT ... ON CONFLICT DO NOTHING instead of a per-row findOne + save
   * loop (the old path was N findOnes + N inserts and throttled the ~1M-row push).
   * Re-syncing the same triple returns the existing row instead of inserting a
   * duplicate. Paired with the events_source_identity_uniq partial unique index,
   * which also absorbs a lost insert race. Bulk ingest does NOT emit a per-row
   * EventCreatedEvent — search indexing is deferred to the post-load batch embed
   * (POST /api/maintenance/search-index/backfill); single-row create() still emits.
   */
  private async createManyBatched(context: UserServiceContext, data: CreateEventDto[]): Promise<Event[]> {
    return (await this.createManyBatchedDetailed(context, data)).map(({ entity }) => entity);
  }

  private async createManyBatchedDetailed(
    context: UserServiceContext,
    data: CreateEventDto[],
  ): Promise<Array<BulkInsertResult<Event>>> {
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
    // Ledger platform per input row (entities[i] came from withIds[i]).
    const platformById = new Map(
      withIds.map((item) => [item.id, ledgerPlatform(item.source_system, item.source_platform)]),
    );

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
          sourcePlatform: platformById.get(entity.id) ?? null,
        }),
        scope: { userId: context.userId },
        // Must match events_source_identity_uniq (20260901175654).
        conflictTarget: '(user_id, source_system, source_id) WHERE source_id IS NOT NULL',
        identityColumns: ['source_system', 'source_id'],
        sourceLedger: {
          table: 'events',
          userId: context.userId,
          importRunId: context.importRunId ?? null,
          getConnectionId: (entity) => entity.connectionId,
        },
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

      await this.graphDeltaWriter.recordMany(
        detailResults
          .filter(({ inserted }) => inserted)
          .map(({ entity }) => {
            const ingress = ingressById.get(entity.id);

            return {
              nodeType: 'entity' as const,
              changeType: 'created' as const,
              entityId: entity.id,
              entityType: 'Event',
              ownerUserId: context.userId,
              changeSource: 'CalendarEventService.createMany',
              changedByUserId: typeof context.userId === 'string' ? context.userId : null,
              changedFields: {
                name: { new: ingress?.title ?? null },
                description: { new: ingress?.description ?? null },
                entity_type: { new: 'Event' },
                properties: { new: {} },
              },
            };
          }),
        manager,
      );

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
    // One HBPE notify per distinct UTC day — not per row — so a 90k import
    // does not flood LISTEN.
    await this.hbpeNotify?.notifyEvents(
      context.userId,
      results.map(({ entity }) => entity.startTime),
    );

    return results.map(({ entity, inserted }) => ({
      entity: EventEntity.toEgressType(entity, bases.get(entity.id)),
      inserted,
    }));
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
   * Filtered to SCHEDULE_EVENT_TYPES, plus rows with a NULL `event_type`. The
   * NULL arm is load-bearing, not a fallthrough: events the user creates through
   * EventResolver and events materialized by CandidateService when a schedule
   * suggestion is accepted both leave `event_type` unset, and dropping them
   * would empty the calendar of exactly the entries the user put there.
   *
   * ═══ RECURRING SERIES ARE EXPANDED HERE, AND ONLY HERE ═══
   * `ci.events` holds one row per recurring SERIES, not one per occurrence —
   * the Google connector fetches `singleEvents=false` deliberately
   * (docs/design/cross-pipeline-identity.md) and the .ics importer does not
   * expand either. Nothing else in the system walked an RRULE, so a weekly
   * standup appeared on the grid once, the gap solver saw an empty morning
   * every other week and booked straight over it, and peer free/busy answered
   * FREE for every occurrence after the first.
   *
   * This method is the choke point that fixes all three at once: the schedule
   * grid reads it and `PlannedBlockService` builds its occupied set from it.
   * The occurrences are synthesized per-read and never persisted — see
   * `recurrence/types.ts` for why writing them would collide with the override
   * namespace.
   */
  async findInRange(context: ServiceContext, from: Date, to: Date): Promise<Event[]> {
    // Sargable floor for events_user_time_idx: the planner can now range-scan
    // (user_id, start_time) instead of walking the user's whole history.
    const lowerBound = new Date(from.getTime() - MAX_EVENT_LOOKBACK_DAYS * DAY_MS);

    const query = this.dataSource
      .getRepository(EventEntity)
      .createQueryBuilder('event')
      .where('event.is_deleted = false')
      // COALESCE because `NOT IN` is three-valued: ci.events.status is still
      // nullable in the database, and a NULL-status row makes the predicate
      // NULL, not TRUE — the event would exist, be returned by every other
      // read, and be missing from the calendar with nothing to explain why.
      // Same guard as dailyAggregateSql's meeting counts.
      .andWhere(LIVE_EVENT_SQL)
      .andWhere('event.start_time >= :lowerBound', { lowerBound })
      .andWhere('event.start_time < :to', { to })
      .andWhere('COALESCE(event.end_time, event.start_time) >= :from', { from })
      .andWhere('(event.event_type IS NULL OR event.event_type IN (:...scheduleEventTypes))', {
        scheduleEventTypes: [...SCHEDULE_EVENT_TYPES],
      })
      .orderBy('event.start_time', 'ASC')
      .addOrderBy('event.event_id', 'ASC')
      .take(MAX_RANGE_EVENTS);

    if (context.userId !== SYSTEM_USER) {
      query.andWhere('event.user_id = :userId', { userId: context.userId });
    }

    const result = await query.getMany();
    const inWindow = await this.composeMany(result);

    // SYSTEM_USER reads the whole box, and both halves of expansion are
    // per-user: the fallback zone comes from `ci.users.timezone`, and override
    // suppression is scoped by user_id. Rather than guess a zone or leak one
    // user's overrides into another's occurrences, the cross-user path keeps
    // the old master-only behaviour.
    if (context.userId === SYSTEM_USER) {
      return inWindow;
    }

    const occurrences = await this.expandRecurring(context.userId, from, to, inWindow);

    if (occurrences.length === 0) {
      return inWindow;
    }

    return [...inWindow, ...occurrences]
      .sort(
        (left, right) =>
          left.startTime.getTime() - right.startTime.getTime() ||
          (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
      )
      .slice(0, MAX_RANGE_EVENTS);
  }

  /**
   * Series masters that could put an occurrence in the window.
   *
   * Two deliberate differences from the main query above:
   *
   *  1. **No `MAX_EVENT_LOOKBACK_DAYS` floor.** A series anchored in 2023 is
   *     precisely the row whose occurrences are missing today; a floor would
   *     silently expand only series younger than a quarter.
   *  2. **No overlap predicate.** The main query also requires
   *     `COALESCE(end_time, start_time) >= :from`, which a master's own DTSTART
   *     almost never satisfies — that is why the masters have to be fetched
   *     again rather than filtered out of `inWindow`.
   *
   * Everything else — the tombstone check, LIVE_EVENT_SQL and the event-type
   * allowlist — is repeated verbatim so an occurrence can never appear on the
   * grid under rules its own master would have been hidden by.
   */
  private recurringMasters(userId: string, to: Date): Promise<EventEntity[]> {
    return this.dataSource
      .getRepository(EventEntity)
      .createQueryBuilder('event')
      .where('event.is_deleted = false')
      .andWhere(LIVE_EVENT_SQL)
      .andWhere('event.is_recurring = true')
      .andWhere('event.start_time < :to', { to })
      .andWhere('(event.event_type IS NULL OR event.event_type IN (:...scheduleEventTypes))', {
        scheduleEventTypes: [...SCHEDULE_EVENT_TYPES],
      })
      .andWhere('event.user_id = :userId', { userId })
      .orderBy('event.start_time', 'DESC')
      .take(MAX_RECURRING_MASTERS)
      .getMany();
  }

  /**
   * The synthetic occurrences to add to a range read.
   *
   * Masters already returned by the main query are reused rather than composed
   * twice — `composeMany` is a second round-trip for the `ci.entities` base
   * rows, and a master whose DTSTART falls inside the window is in BOTH result
   * sets.
   */
  private async expandRecurring(
    userId: string,
    from: Date,
    to: Date,
    inWindow: readonly Event[],
  ): Promise<Event[]> {
    const alreadyComposed = new Set(inWindow.map((event) => event.id));
    const extra = (await this.recurringMasters(userId, to)).filter((row) => !alreadyComposed.has(row.id));
    const masters = [...(await this.composeMany(extra)), ...inWindow.filter((event) => event.isRecurring)];

    if (masters.length === 0) {
      return [];
    }

    const zone = await resolveExpansionZone(this.eventRepository, userId);
    const specs = expandAll(
      masters,
      { from, to },
      {
        fallbackTimeZone: zone.timeZone,
        fallbackTimeZoneSource: zone.source,
        limits: { maxTotalOccurrences: MAX_EXPANDED_OCCURRENCES },
      },
    );
    const kept = await dropExistingOverrides(this.eventRepository, userId, specs);
    const byId = new Map(masters.map((master) => [master.id, master]));

    return kept.flatMap((spec) => {
      const master = byId.get(spec.seriesId);

      return master ? [this.materializeOccurrence(master, spec)] : [];
    });
  }

  /**
   * One computed occurrence dressed as the event it stands for.
   *
   * It carries the master's whole payload — title, participants, location,
   * tags — because to every reader it IS that meeting, just on another day.
   * `parentEventId` is cleared rather than pointed at the master: that column
   * means something else (a real FK to a real row) and the two must not be
   * confused. `seriesMasterId` is the field that says where this came from, and
   * it is what the GraphQL resolvers batch tags/content/media by, since the
   * synthetic id backs no row.
   */
  private materializeOccurrence(master: Event, spec: OccurrenceSpec): Event {
    return {
      ...master,
      id: spec.occurrenceId,
      startTime: spec.startTime,
      endTime: spec.endTime,
      seriesMasterId: master.id,
      recurrenceId: spec.recurrenceInstant,
      parentEventId: null,
      metadata: {
        ...master.metadata,
        occurrence: {
          masterEventId: master.id,
          recurrenceInstant: spec.recurrenceInstant,
          timeZoneSource: spec.timeZoneSource,
          synthetic: true,
        },
      },
    };
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
        // A tombstoned event is not reschedulable — it is gone as far as every
        // reader is concerned, and moving one would resurrect it in the
        // calendar's write path without clearing the flag.
        isDeleted: false,
        ...(context.userId !== SYSTEM_USER && { user: { id: context.userId } }),
      },
    });

    if (!event) {
      return null;
    }

    this.assertTimeOrder(startTime, endTime);

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
    const query = this.eventRepository
      .createQueryBuilder('event')
      .where("(event.event_type IS NULL OR event.event_type <> 'planned_block')")
      // Tombstoned events are gone as far as every reader is concerned.
      .andWhere('event.is_deleted = false');

    if (context.userId !== SYSTEM_USER) {
      query.andWhere('event.user_id = :userId', { userId: context.userId });
    }

    const result = await query.getMany();

    return this.composeMany(result);
  }

  /**
   * Keyset-paginated page for the GraphQL connection — ordered by (start_time,
   * event_id) DESC, reading one page (+1 sentinel) instead of the whole table.
   *
   * {@link findAll} loads every event the user owns and the resolver then threw
   * all but `first` of them away. `ci.events` is the timeline for photos,
   * visits and every ETL connector as well as calendar entries, so on a real
   * library that is six figures of rows hydrated to serve a page of 20.
   *
   * The scope repeats findAll's two predicates rather than sharing them,
   * because `keysetPaginate` runs its own COUNT for `totalCount`: if the count
   * and the page disagreed on which rows exist, the connection would advertise
   * pages that never arrive.
   */
  async findPage(context: UserServiceContext, args: KeysetPageArgs): Promise<KeysetPage<Event>> {
    const page = await keysetPaginate(this.eventRepository, args, {
      alias: 'event',
      timeProp: 'startTime',
      userId: context.userId,
      scope: (qb) =>
        qb
          .andWhere("(event.event_type IS NULL OR event.event_type <> 'planned_block')")
          .andWhere('event.is_deleted = false'),
    });

    return {
      ...page,
      entities: await this.composeMany(page.entities),
    };
  }

  /**
   * Batch id lookup. Tombstoned events resolve to `null` — which is also what
   * keeps a just-deleted event out of the search results: SearchResolver
   * hydrates its candidate ids through here and drops the misses, so the row
   * disappears immediately rather than waiting on the async un-index.
   */
  async findByIds(context: ServiceContext, ids: string[]): Promise<(Event | null)[]> {
    const result = await this.eventRepository.find({
      where: {
        id: In(ids),
        isDeleted: false,
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
        isDeleted: false,
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

    // `!== undefined` from here down wherever false/0/null is a real value: a
    // partial update distinguishes "not mentioned" from "cleared", and
    // truthiness collapses the two. `end_time: null` is how an event
    // mis-imported with a bogus end is made open-ended again.
    if (data.end_time !== undefined) {
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

    if (data.connection_id !== undefined) {
      updateData.connectionId = data.connection_id;
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

    // Every field below is one whose falsy value is the interesting one:
    // `confidence_score: 0` is "no confidence", `priority: 0` is the baseline a
    // de-prioritized event must be able to return to, and each boolean's `false`
    // is the correction. Guarded on truthiness, a flag could be set and never
    // cleared — the all-day toggle in EditEventModal turned on but not off.
    if (data.confidence_score !== undefined) {
      updateData.confidenceScore = data.confidence_score;
    }

    if (data.is_recurring !== undefined) {
      updateData.isRecurring = data.is_recurring;
    }

    // Null clears the pattern, which is what turning a series back into a
    // one-off means; the column is nullable for exactly that.
    if (data.recurrence_pattern !== undefined) {
      updateData.recurrencePattern = data.recurrence_pattern;
    }

    if (data.is_all_day !== undefined) {
      updateData.isAllDay = data.is_all_day;
    }

    if (data.is_private !== undefined) {
      updateData.isPrivate = data.is_private;
    }

    if (data.priority !== undefined) {
      updateData.priority = data.priority;
    }

    if (data.metadata) {
      updateData.metadata = data.metadata;
    }

    // `is_predicted: false` is the write that promotes a suggestion the user
    // committed to — the same assertion toEntityFields spells out on the create
    // side — so it must not be read as an omission here either.
    if (data.is_predicted !== undefined) {
      updateData.isPredicted = data.is_predicted;
    }

    if (data.is_inferred !== undefined) {
      updateData.isInferred = data.is_inferred;
    }

    if (data.inference_sources) {
      updateData.inferenceSources = data.inference_sources;
    }

    if (data.tags) {
      updateData.tags = data.tags;
    }

    // 0 is a real reading for both: neutral sentiment, and the flat end of the
    // energy scale toEntityFields already calls "a legal energy_level".
    if (data.sentiment_score !== undefined) {
      updateData.sentimentScore = data.sentiment_score;
    }

    if (data.energy_level !== undefined) {
      updateData.energyLevel = data.energy_level;
    }

    if (data.status) {
      updateData.status = data.status;
    }

    // Deliberately still truthiness, unlike the booleans above: `is_deleted:
    // false` must NOT be settable here. Clearing a tombstone is `restore`,
    // which re-publishes the search index and the graph delta; doing it through
    // a field patch would bring the row back invisible to both.
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
    const updated = await this.aggregate.applyUpdate(
      context,
      id,
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        detail: updateData as any, // TypeORM will handle JSON serialization
        base: basePatch,
      },
      {
        withinTx: async ({ manager }) => {
          const base = await manager.getRepository(EventBaseEntity).findOne({ where: { id } });
          await this.graphDeltaWriter.entityUpdated({
            entityId: id,
            entityType: 'Event',
            name: base?.name ?? null,
            changedFields: {
              ...(basePatch.name !== undefined ? { name: { new: basePatch.name } } : {}),
              ...(basePatch.description !== undefined ? { description: { new: basePatch.description } } : {}),
              ...(Object.keys(updateData).length > 0 ? { detail_updated: { new: true } } : {}),
            },
            ownerUserId: typeof context.userId === 'string' ? context.userId : null,
            changeSource: 'CalendarEventService.update',
            changedByUserId: typeof context.userId === 'string' ? context.userId : null,
            manager,
          });
        },
      },
    );

    if (!updated) {
      return null;
    }

    await this.signallingEventService.send(EventUpdatedEvent, {
      eventId: updated.id,
    });
    await this.hbpeNotify?.notifyEvents(updated.userId, updated.startTime);

    // The transaction already reloaded the detail row; one base fetch
    // completes the egress composition.
    const [event] = await this.composeMany([updated]);

    return event;
  }

  /**
   * Tombstones an event: `ci.events.is_deleted` is set, both rows stay on disk,
   * and the read paths above stop returning it. The emitted
   * {@link EventRemovedEvent} still drops the row from the search index, so it
   * disappears from the explorer exactly as a physical delete would — but
   * nothing that referenced it is cascaded away and {@link restore} can bring it
   * back verbatim.
   */
  async remove(context: ServiceContext, id: string): Promise<boolean> {
    let removedAt: { userId: string; time: Date | null } | undefined;
    const removed = await this.aggregate.remove(context, id, {
      withinTx: async ({ manager, before }) => {
        removedAt = { userId: before.userId, time: before.startTime };
        const base = await manager.getRepository(EventBaseEntity).findOne({ where: { id } });
        await this.graphDeltaWriter.entityDeleted({
          entityId: id,
          entityType: 'Event',
          name: base?.name ?? null,
          ownerUserId: typeof context.userId === 'string' ? context.userId : null,
          changeSource: 'CalendarEventService.remove',
          changedByUserId: typeof context.userId === 'string' ? context.userId : null,
          manager,
        });
      },
    });

    if (!removed) {
      return false;
    }

    await this.signallingEventService.send(EventRemovedEvent, {
      eventId: id,
    });
    if (removedAt) {
      await this.hbpeNotify?.notifyEvents(removedAt.userId, [removedAt.time]);
    }

    return true;
  }

  /**
   * Undoes {@link remove}: clears the tombstone and re-indexes the event, so an
   * accidental deletion is recoverable (this is what the "Undo" affordance on
   * the delete toast calls). A no-op for an event that was never deleted.
   *
   * @returns the restored event, or `null` when the caller has no tombstoned
   *   event with that id.
   */
  async restore(context: ServiceContext, id: string): Promise<Event | null> {
    const restored = await this.aggregate.restore(context, id, {
      withinTx: async ({ manager, after }) => {
        const base = await manager.getRepository(EventBaseEntity).findOne({ where: { id } });
        await this.graphDeltaWriter.entityCreated({
          entityId: id,
          entityType: 'Event',
          name: base?.name ?? null,
          ownerUserId: typeof context.userId === 'string' ? context.userId : (after?.userId ?? null),
          changeSource: 'CalendarEventService.restore',
          changedByUserId: typeof context.userId === 'string' ? context.userId : null,
          manager,
        });
      },
    });

    if (!restored) {
      return null;
    }

    // The update listener re-upserts the search-index rows the delete removed.
    await this.signallingEventService.send(EventUpdatedEvent, {
      eventId: id,
    });
    await this.hbpeNotify?.notifyEvents(restored.userId, restored.startTime);

    return this.composeOne(restored);
  }

  async search(context: ServiceContext, query: SearchEventDto): Promise<Event[]> {
    const { title, description, ...detailQuery } = query;

    // title/description live on the CTI base row; the FK guarantees every
    // detail row has one, so the base is joined unconditionally and its
    // columns are hydrated in the SAME query — no second composition fetch.
    let qb = this.eventRepository
      .createQueryBuilder('event')
      .innerJoin(BaseEntity, 'base', 'base.entity_id = event.event_id')
      .addSelect('base.name', 'base_name')
      .addSelect('base.description', 'base_description')
      .where('event.is_deleted = false');

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

  /**
   * The filter half of the event read path — every predicate
   * {@link getEntitiesForEvents}, {@link countEntitiesForEvents} and
   * {@link findMapPins} share, applied to a caller-supplied builder.
   *
   * Owning them in one place is what keeps a map pin, an explorer row and the
   * explorer's totalCount describing the same set of events: the three callers
   * differ only in what they SELECT and how they order/limit it.
   */
  private applyEventFilters<T extends ObjectLiteral>(
    query: SelectQueryBuilder<T>,
    context: ServiceContext,
    options: CountOptions,
  ): SelectQueryBuilder<T> {
    // Tombstoned events are gone as far as every reader is concerned. This sits
    // in the shared filter rather than in each caller so a soft-deleted event
    // cannot come back as a map pin or inflate the explorer's totalCount while
    // being absent from the rows — the whole reason these three share a filter.
    query = query.andWhere('event.is_deleted = false');

    // Explicit id set (a text-query / tag candidate set resolved elsewhere).
    // An empty array is a real "nothing matched", not "no filter" — `= ANY('{}')`
    // is false for every row, which is exactly the intent.
    if (options.ids != null) {
      query = query.andWhere('event.event_id = ANY(:eventIds)', { eventIds: options.ids });
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

    // "Where" (located only): the event must carry geographic coordinates —
    // either its own denormalised `location_coordinates` (set directly, e.g. by
    // EXIF/reverse-geocode ingest) or, when the event is only linked to a known
    // Place via `location_entity_id`, that Place's `location_point`. An event
    // can carry either one independently (CreateEventInput/UpdateEventInput
    // accept `locationCoordinates` and `locationEntityId` as separate, optional
    // fields — see EventResolver), so a coordinate-only check here missed every
    // event whose location came from a Place link alone: `locationCoordinates`
    // stayed null while `location` (the resolved Place) was fully populated,
    // which made the map render zero pins for such events despite the event
    // itself being genuinely located and appearing correctly in the explorer
    // (which resolves the same fallback client-side — see
    // MapView.getEntityCoordinates).
    const needsLocationCoordinate =
      options.hasLocation === true ||
      (options.bbox != null &&
        options.bbox.length === 4 &&
        options.bbox.every((value) => Number.isFinite(value)));

    if (needsLocationCoordinate) {
      query = query.leftJoin(
        PlaceEntity,
        'location_entity',
        'location_entity.entity_id = event.location_entity_id AND location_entity.entity_type = :locationEntityType',
        { locationEntityType: 'Location' },
      );
    }

    if (options.hasLocation) {
      query = query.andWhere(
        'COALESCE(event.location_coordinates, location_entity.location_point) IS NOT NULL',
      );
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
        'ST_Within(COALESCE(event.location_coordinates, location_entity.location_point)::geometry, ' +
          'ST_MakeEnvelope(:minLon, :minLat, :maxLon, :maxLat, 4326))',
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

    return query;
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

    query = this.applyEventFilters(query, context, options);

    const results = await query.getRawMany();

    return results.map((row: { event_id: string; type: IndexableEntity }) => ({
      id: row.event_id,
      type: 'event' as IndexableEntity,
    }));
  }

  /**
   * True total of events matching the same filters {@link getEntitiesForEvents} applies —
   * a real `COUNT(*)`, not the length of one `limit`-bounded page of identifiers. Used by
   * the search/explorer `totalCount` field, which previously reported the size of the
   * over-fetched candidate window (bounded by page size) instead of the actual match count.
   */
  async countEntitiesForEvents(context: ServiceContext, options: CountOptions): Promise<number> {
    let query = this.dataSource
      .getRepository(EventEntity)
      .createQueryBuilder('event')
      .where('event.user_id = :userId', { userId: context.userId })
      .andWhere('event.is_deleted = false');

    query = this.applyEventFilters(query, context, options);

    return query.getCount();
  }

  /**
   * Located events as map markers: the same filters {@link getEntitiesForEvents}
   * applies, projected down to a point + label ({@link MapPin}) and ordered
   * newest-first.
   *
   * This exists because the map is not a paged feed. Drawing a life on a map
   * means plotting the whole located set at once — ten thousand rows here, and
   * the browse page size is thirty — so the read is bounded by `limit` (a hard
   * cap the caller reports as truncation) rather than by a cursor.
   *
   * `hasLocation` is forced on: a marker with no coordinates is not a marker,
   * and ST_Y/ST_X of NULL would surface as a pin at (0, 0) in the Gulf of
   * Guinea. Titles live on the CTI base row, so `ci.entities` is joined the
   * same way {@link search} joins it.
   */
  async findMapPins(context: ServiceContext, options: MapPinOptions): Promise<MapPin[]> {
    let query = this.dataSource
      .getRepository(EventEntity)
      .createQueryBuilder('event')
      .innerJoin(BaseEntity, 'base', 'base.entity_id = event.event_id')
      .select('event.event_id', 'event_id')
      .addSelect('base.name', 'title')
      .addSelect('event.start_time', 'start_time')
      .addSelect('event.end_time', 'end_time')
      .addSelect('event.event_type', 'event_type')
      .addSelect('event.location_name', 'location_name')
      .addSelect('event.time_source', 'time_source')
      // COALESCE with the linked Place's `location_point` — see the comment in
      // applyEventFilters for why an event's location is not always on the
      // event row itself.
      .addSelect(
        'ST_Y(COALESCE(event.location_coordinates, location_entity.location_point)::geometry)',
        'latitude',
      )
      .addSelect(
        'ST_X(COALESCE(event.location_coordinates, location_entity.location_point)::geometry)',
        'longitude',
      )
      .where('event.user_id = :userId', { userId: context.userId })
      .orderBy('event.start_time', 'DESC')
      .addOrderBy('event.event_id', 'DESC')
      .limit(options.limit);

    query = this.applyEventFilters(query, context, { ...options, hasLocation: true });

    const rows = await query.getRawMany<{
      event_id: string;
      title: string | null;
      start_time: Date | null;
      end_time: Date | null;
      event_type: string | null;
      location_name: string | null;
      time_source: string | null;
      latitude: number | string | null;
      longitude: number | string | null;
    }>();

    return (
      rows
        .map((row) => ({
          id: row.event_id,
          title: row.title,
          startTime: row.start_time,
          endTime: row.end_time,
          eventType: row.event_type,
          locationName: row.location_name,
          timeSource: row.time_source,
          // `Number(null)` is 0, not NaN — a null coordinate would otherwise
          // become a pin in the Gulf of Guinea instead of being dropped below.
          latitude: row.latitude == null ? Number.NaN : Number(row.latitude),
          longitude: row.longitude == null ? Number.NaN : Number(row.longitude),
        }))
        // A row whose geography failed to project has no place on a map; dropping
        // it here keeps NaN out of the client's bounds/cluster maths.
        .filter((pin) => Number.isFinite(pin.latitude) && Number.isFinite(pin.longitude))
    );
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
      .andWhere('event.is_deleted = false')
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
      .andWhere('event.is_deleted = false')
      .andWhere('event.event_type IS NOT NULL')
      .andWhere("event.event_type <> 'planned_block'")
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
        .andWhere('event.is_deleted = false')
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
      .where('event.is_deleted = false')
      .groupBy('user_id')
      .addGroupBy('bucket_start')
      .getRawMany();

    return rows.map((row) => ({ userId: row.user_id, bucketStart: row.bucket_start, count: row.count }));
  }
}
