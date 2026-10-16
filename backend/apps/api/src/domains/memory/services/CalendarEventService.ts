import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  In,
  IsNull,
  Repository,
  type EntityManager,
  type FindOptionsOrder,
  type FindOptionsWhere,
  type ObjectLiteral,
  type SelectQueryBuilder,
} from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { v7 as uuidv7 } from 'uuid';

import { type ServiceContext, SYSTEM_USER, type UserServiceContext } from '@ci/common/context';
import { HbpeNotifyService } from '@ci/common/hbpe';
import {
  type BulkInsertResult,
  type KeysetPage,
  type KeysetPageArgs,
  appendRecordSources,
  bulkInsertIdempotent,
  countAffected,
  keysetOrderOf,
  keysetPaginate,
  keysetSeek,
  INGEST_REFRESH_COLUMNS,
} from '@ci/common/persistence';
import { EventService } from '@ci/domains/events';
import { FileRemovedEvent } from '@ci/domains/files/events';
import { LiveChangesService } from '@ci/domains/live-changes';
import {
  ContentRemovedEvent,
  EventCreatedEvent,
  EventRemovedEvent,
  EventUpdatedEvent,
} from '@ci/domains/memory/events';
import type { EntityIdentifier, IndexableEntity } from '@ci/domains/search-next';

import { BaseEntity } from '../entities/BaseEntity';
import { EventBaseEntity } from '../entities/EventBaseEntity';
import { EventEntity, Event, type RecurrenceDefinition } from '../entities/EventEntity';
import { PlaceEntity } from '../entities/PlaceEntity';
import { ledgerPlatform } from '../identity';
import { expandAll } from '../recurrence/expandAll';
import { recurrenceRuleRejection } from '../recurrence/parseRecurrence';
import { dropExistingOverrides, resolveExpansionZone } from '../recurrence/queries';
import type { OccurrenceSpec } from '../recurrence/types';
import { CreateEventDto, UpdateEventDto, SearchEventDto, type SourceAssertedField } from '../types';

import { CtiAggregate } from './CtiAggregate';
import { resolveEventLocationReopener } from './eventLocationReopener';
import { type PurgedEventAggregates, purgeEventAggregates } from './eventPurge';
import { resolveEventStatusReopener } from './eventStatusReopener';
import { resolveEventTimeReopener } from './eventTimeReopener';
import { STORED_OBJECTS, StoredObjectsDeletedError, type StoredObjects } from './filePurge';
import { GraphDeltaWriter } from './GraphDeltaWriter';
import {
  type EventWhen,
  type StoredWhen,
  type TitleMerge,
  mergeSourceTitle,
  mergeSourceWhen,
  recurrenceOf,
  sameTimes,
  sameWhen,
} from './sourceFieldMerge';
import {
  type DeliveredLocation,
  type SourceLocation,
  type StoredLocation,
  SOURCE_LOCATION_VOCABULARY,
  confidenceOf,
  coordinatesOf,
  heardLocation,
  locationBaseOf,
  locationBaseRecord,
  mergeSourceLocation,
  normalizeLocationName,
  sameCoordinates,
  sameLocation,
} from './sourceLocationMerge';
import { DEFAULT_EVENT_STATUS, mergeSourceStatus } from './sourceStatusMerge';
import { nothingWrapped, type WrappedFilesPurged } from './wrappedFilePurge';

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
  /**
   * "Where" (by name): place name patterns matched (ILIKE) against the linked
   * Location entity / location_name. ORed with `areas`: an event matches by
   * name OR by falling inside a rectangle, never both at once.
   */
  places?: string[];
  /** "Where": when true, only events with geographic coordinates are returned. */
  hasLocation?: boolean;
  /**
   * "Where" (map areas): bounding boxes, each [minLon, minLat, maxLon, maxLat]
   * (EPSG:4326), ORed — an event matches inside any of them, or by `places`.
   */
  areas?: number[][];
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

/** Whether a status says the event did not happen ({@link DEAD_EVENT_STATUSES}); none counts as the column default. */
function isDeadStatus(status: string | null | undefined): boolean {
  return (DEAD_EVENT_STATUSES as readonly string[]).includes(status ?? DEFAULT_EVENT_STATUS);
}

/**
 * Whether a status change moved an event across the line between "still
 * counts" and "called off", in either direction. Those are the only status
 * changes the pipeline's decisions on whether the event happened have to hear
 * about (eventStatusReopener.ts): `confirmed` → `tentative` changes none of
 * them, and `cancelled` → `no_show` leaves it called off.
 */
function crossedLiveLine(from: string | null | undefined, to: string | null | undefined): boolean {
  return isDeadStatus(from) !== isDeadStatus(to);
}

/**
 * Whether an identity belongs to a SOURCE — a calendar connection, the
 * importer, a capture client — whose later re-deliveries may move the row's
 * status (see sourceStatusMerge.ts).
 *
 * Planning is excluded: it is the one server-minted identity that reaches
 * createOne (`platformIdentity('planning', 'task', id)` → `task:<uuid>`). The
 * planner is not a source whose view can drift from the row's; its blocks have
 * their own lifecycle (`restorePlannedBlock`), and a live one is still handed
 * back verbatim.
 */
function isSourceOwned(sourceId: string | null | undefined, sourceType: string | null | undefined): boolean {
  return Boolean(sourceId) && sourceType !== 'planning';
}

/**
 * `time_source` for an instant the writer stamped because it had none — the
 * `TIME_SOURCES.INGEST` value of pipeline/stages/clean/TemporalRepairStage
 * (memory cannot import the pipeline). Such a time is nobody's word on when
 * the event happens, so a re-delivery carrying one moves nothing.
 */
const INGEST_TIME_SOURCE = 'ingest';

const recurrenceLogger = new Logger('CalendarEventService');

/**
 * `item` without a recurrence rule this appliance refuses to expand.
 *
 * Every create funnels through here: GraphQL `createEvent(s)`, Google Calendar
 * sync (which stores `recurrence` verbatim in `metadata.recurrenceRule`), the
 * .ics import lane, bulk ingest. A rule rrule would walk forever, or one outside
 * RFC 5545's ranges, is dropped and the event kept: it then shows once, as its
 * master row, which is what read-time expansion would have fallen back to
 * anyway. Dropping rather than refusing keeps one bad rule from failing a whole
 * sync or import batch. See recurrence/ruleChecks.ts.
 */
function withoutRefusedRecurrence(item: CreateEventDto): CreateEventDto {
  const ruleReason = recurrenceRuleRejection(item.metadata?.recurrenceRule);
  const patternReason = recurrenceRuleRejection(item.recurrence_pattern?.rrule);

  if (!ruleReason && !patternReason) {
    return item;
  }

  recurrenceLogger.warn(
    `Stored an event from ${item.source_system ?? 'an unnamed source'} without its recurrence rule ` +
      `(${ruleReason ?? patternReason}); it will show once instead of repeating`,
  );

  const next: CreateEventDto = { ...item };

  if (ruleReason && item.metadata) {
    const { recurrenceRule: _refused, ...metadata } = item.metadata;
    next.metadata = metadata;
  }

  if (patternReason && item.recurrence_pattern) {
    const { rrule: _refused, ...pattern } = item.recurrence_pattern;
    next.recurrence_pattern = pattern;
  }

  return next;
}

/** The metadata keys a series' recurrence is read from (parseRecurrence.ts), and the only ones the refresh rewrites. */
const RECURRENCE_METADATA_KEYS = ['recurrenceRule', 'recurrenceTimeZone'] as const;

/** A delivered time, with what travels onto the row when that time is applied. */
interface DeliveredWhen extends EventWhen {
  /** `is_all_day`, applied with the times (a meeting turned into an all-day event changes both). */
  isAllDay?: boolean;
  /** `is_recurring`, applied with the recurrence. */
  isRecurring?: boolean;
  /** The delivery's own reading of its instant; NULL (unexamined) when it states none. */
  timeSource: string | null;
  timePrecision: string | null;
  /** The delivered {@link RECURRENCE_METADATA_KEYS} that are present; an absent one is removed. */
  recurrenceKeys: Record<string, unknown>;
}

/**
 * What one re-delivery says about the fields its source owns: only the fields
 * it actually says. A field left out is not refreshed.
 */
interface SourceDelivery {
  status?: string;
  when?: DeliveredWhen;
  title?: string;
  location?: DeliveredLocation;
}

/**
 * The fields a create DTO asserts, for the refresh of a row it finds already
 * stored.
 *
 * A status counts only when one was sent (the column DEFAULT is nobody's
 * assertion), a time only when it is not an ingest stamp, and a delivery that
 * names `source_asserts` speaks for those fields alone — a cancelled occurrence
 * rebuilt from its series fills in a time and a title its source never sent.
 */
function sourceDeliveryOf(item: CreateEventDto): SourceDelivery {
  const claimed = item.source_asserts ? new Set<SourceAssertedField>(item.source_asserts) : null;
  const says = (field: SourceAssertedField): boolean => claimed === null || claimed.has(field);
  const delivery: SourceDelivery = {};

  if (item.status != null && says('status')) {
    delivery.status = item.status;
  }

  if (item.start_time && item.time_source !== INGEST_TIME_SOURCE && says('time')) {
    const recurrenceKeys: Record<string, unknown> = {};

    for (const key of RECURRENCE_METADATA_KEYS) {
      if (item.metadata?.[key] !== undefined) {
        recurrenceKeys[key] = item.metadata[key];
      }
    }

    delivery.when = {
      startTime: new Date(item.start_time),
      endTime: item.end_time ? new Date(item.end_time) : null,
      recurrence: recurrenceOf(item.metadata),
      ...(item.is_all_day !== undefined ? { isAllDay: item.is_all_day } : {}),
      ...(item.is_recurring !== undefined ? { isRecurring: item.is_recurring } : {}),
      timeSource: item.time_source ?? null,
      timePrecision: item.time_precision ?? null,
      recurrenceKeys,
    };
  }

  if (item.title != null && says('title')) {
    delivery.title = item.title;
  }

  // The place is the one field a delivery can state by saying nothing: no name
  // is a source that says the event has none (the organizer cleared it, or
  // replaced it with a meeting link the transforms drop).
  if (says('location')) {
    delivery.location = locationOf(item);
  }

  return delivery;
}

/**
 * The `changed_fields` a moved place adds to the event's graph delta: each part
 * that changed, as the row had it and as it now is, and the place link that
 * went with them.
 */
function locationDelta(
  from: StoredLocation,
  to: SourceLocation,
  linkedTo: string | null,
): Record<string, { old?: unknown; new?: unknown }> {
  return {
    ...(from.name !== to.name ? { location_name: { old: from.name, new: to.name } } : {}),
    ...(sameCoordinates(from.coordinates, to.coordinates)
      ? {}
      : { location_coordinates: { old: from.coordinates, new: to.coordinates } }),
    ...(linkedTo !== null ? { location_entity_id: { old: linkedTo, new: null } } : {}),
  };
}

/**
 * The `metadata` a person's write to the place leaves behind: the same bag with
 * the pipeline's marks that write supersedes taken out, or null when it
 * supersedes none.
 *
 * The stages tag what they write (`metadata.location_source`, and
 * `metadata.promote` for the place link) and read the tag as "mine, and
 * replaceable". A person who has since rewritten the value did not leave that
 * tag behind on purpose: left in place it lets the next `enrich.geocode` or
 * `enrich.event_reverse` generation overwrite the correction, and it makes the
 * source's next move read the person's value as the pipeline's, which is the
 * one thing the location refresh (sourceLocationMerge.ts) must not do. Only the
 * marks the write supersedes go: a point replaces the tags that describe a
 * point, a name the tag that describes a name, a link the link's marker. A
 * caller that sends `metadata` itself owns the bag and is left alone.
 */
function metadataWithoutSupersededMarks(data: UpdateEventDto): (() => string) | null {
  if (data.metadata) {
    return null;
  }

  const { geocoded, approximate, estimated, reverseGeocoded } = SOURCE_LOCATION_VOCABULARY;
  const tags = [
    ...(data.location_coordinates ? [geocoded, approximate, estimated] : []),
    ...(data.location_name ? [reverseGeocoded] : []),
  ];

  if (tags.length === 0 && !data.location_entity_id) {
    return null;
  }

  let bag = `COALESCE(metadata, '{}'::jsonb)`;

  if (tags.length > 0) {
    bag = `CASE WHEN metadata->>'location_source' IN (${tags.map((tag) => `'${tag}'`).join(', ')})
                 THEN (${bag} - 'location_source') ELSE ${bag} END`;
  }

  if (data.location_entity_id) {
    bag = `(${bag} - 'promote')`;
  }

  return () => bag;
}

/** What a create DTO says about the place: a name and a point, each possibly absent, and the confidence of the point. */
function locationOf(
  item: Pick<CreateEventDto, 'location_name' | 'location_coordinates' | 'confidence_score'>,
): DeliveredLocation {
  return {
    name: normalizeLocationName(item.location_name),
    coordinates: coordinatesOf(item.location_coordinates),
    confidence: confidenceOf(item.confidence_score),
  };
}

/** A row's time base, or null when it has none (`source_start_time` unset). */
function baseWhenOf(row: {
  sourceStartTime: Date | null;
  sourceEndTime: Date | null;
  sourceRecurrence: RecurrenceDefinition | null;
}): EventWhen | null {
  return row.sourceStartTime
    ? {
        startTime: row.sourceStartTime,
        endTime: row.sourceEndTime ?? null,
        recurrence: row.sourceRecurrence ?? null,
      }
    : null;
}

/**
 * Whether every field a delivery asserts equals the base already stored for
 * it — the usual re-delivery (the organizer edited the agenda), which then
 * costs no lock and no write. Read off a row loaded without a lock: a stale
 * read only sends a delivery to the locked path, which decides again.
 */
function deliveredBefore(existing: EventEntity, delivery: SourceDelivery): boolean {
  if (delivery.status !== undefined && existing.sourceStatus !== delivery.status) {
    return false;
  }

  if (delivery.when) {
    const base = baseWhenOf(existing);

    if (base === null || !sameWhen(base, delivery.when)) {
      return false;
    }
  }

  if (delivery.location) {
    const base = locationBaseOf(existing.sourceLocation);

    if (base === null || !sameLocation(base, heardLocation(base, delivery.location))) {
      return false;
    }
  }

  return delivery.title === undefined || existing.sourceTitle === delivery.title;
}

/** The columns {@link CalendarEventService.refreshFromSource} reads under the row lock. */
interface LockedEventRow {
  status: string;
  source_status: string | null;
  is_deleted: boolean;
  start_time: Date;
  end_time: Date | null;
  source_start_time: Date | null;
  source_end_time: Date | null;
  source_recurrence: RecurrenceDefinition | null;
  recurrence_rule: unknown;
  recurrence_time_zone: string | null;
  start_time_original: Date | null;
  end_time_original: Date | null;
  last_moved_at: Date | null;
  source_title: string | null;
  location_name: string | null;
  location_lng: number | null;
  location_lat: number | null;
  location_entity_id: string | null;
  location_source: string | null;
  promoted_by: string | null;
  source_location: unknown;
}

/**
 * Spanning-aggregate service for the events CTI split: an event is ONE logical
 * entity persisted as a `ci.entities` base row (discriminated 'Event', the
 * SOLE owner of title/description — see {@link EventBaseEntity}) plus a
 * `ci.events` detail row sharing the same uuid. Writes touch both rows in one
 * transaction; reads compose the egress {@link Event} from the pair with one
 * batched base-row fetch.
 */
/** The entries of `areas` that are usable map areas: exactly four finite numbers each. */
function validAreas(areas: number[][] | undefined): [number, number, number, number][] {
  return (areas ?? []).filter(
    (area): area is [number, number, number, number] =>
      Array.isArray(area) && area.length === 4 && area.every((value) => Number.isFinite(value)),
  );
}

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
    /**
     * Resolves EVENT_TIME_REOPENER and EVENT_STATUS_REOPENER (bound by
     * PipelineModule) when a write moves an event's time, or calls it off or
     * reinstates it — a source's re-delivery, or a person's `update` or
     * `reschedule`. See eventTimeReopener.ts and eventStatusReopener.ts.
     * Optional only so suites can construct the service by hand; such a write
     * without it throws.
     */
    @Optional() private readonly moduleRef?: ModuleRef,
    /**
     * The object store, which {@link purge} deletes the stored files of a photo from. Optional so that a
     * service built without one still does everything else; a purge that would have to delete stored
     * bytes and has no store is refused before it changes anything.
     */
    @Optional() @Inject(STORED_OBJECTS) private readonly storedObjects?: StoredObjects,
    /**
     * Tells the user's other open calendars to re-read. Optional for hand-built
     * suites, and LAST so the suites that construct this positionally keep working.
     */
    @Optional() private readonly liveChanges?: LiveChangesService,
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

    // Booleans compared against `undefined`, matching `is_predicted` above:
    // `is_locked: false` / `is_auto: false` are real assertions a caller can
    // make, not omissions to fall through to the column DEFAULT.
    if (item.is_locked !== undefined) {
      toCreate.isLocked = item.is_locked;
    }

    if (item.is_auto !== undefined) {
      toCreate.isAuto = item.is_auto;
    }

    if (item.last_moved_at !== undefined) {
      toCreate.lastMovedAt = item.last_moved_at;
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

    // Not a column. It qualifies a re-delivery (see sourceDeliveryOf).
    delete (toCreate as Record<string, unknown>).source_asserts;

    // The merge bases for the refresh in createOne: what the SOURCE said, kept
    // beside what the row shows, so a later re-delivery can tell the source's
    // old value from a user's edit (sourceStatusMerge.ts, sourceFieldMerge.ts).
    // Only on an identity a source owns.
    if (isSourceOwned(item.source_id, item.source_type)) {
      // Only a status the source actually sent: the column DEFAULT is nobody's
      // assertion.
      if (item.status != null) {
        toCreate.sourceStatus = item.status;
      }

      // Every time and title the row is written with, including an ingest
      // stamp and a cancelled occurrence's filled-in ones: nobody else wrote
      // them, so a later delivery that does state them must find the row
      // still showing its base, and land.
      toCreate.sourceStartTime = item.start_time;
      toCreate.sourceEndTime = item.end_time ?? null;
      toCreate.sourceRecurrence = recurrenceOf(item.metadata);

      if (item.title != null) {
        toCreate.sourceTitle = item.title;
      }

      // The place as the delivery stated it, including none: a row first synced
      // with no place must find its base when the organizer adds one.
      toCreate.sourceLocation = locationBaseRecord(locationOf(item));
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
    // duplicate. When the triple is present, return the existing row. What a
    // re-delivery may still change on it is what its source owns — the
    // status, the time and the title — and only where the source's own value
    // moved and nobody else has changed it since (returnExisting /
    // refreshFromSource): a meeting cancelled, moved or renamed after its first
    // sync must not stay as it first arrived forever.
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

        return this.returnExisting(context, existing, item);
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
          return this.returnExisting(context, existing, item);
        }
      }

      throw err;
    }

    await this.ledgerArrival(context, eventResult.id, item);
    await this.signallingEventService.send(EventCreatedEvent, {
      eventId: eventResult.id,
    });
    await this.hbpeNotify?.notifyEvents(eventResult.userId, eventResult.startTime);
    await this.liveChanges?.publish(eventResult.userId, 'calendar');

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
   * `status`, `planned_minutes`, `is_auto`, `last_moved_at` — are the ones a
   * partial update is entitled to leave alone, and a restored block must not
   * keep the previous placement's (a block revived by automation must not read
   * as still manually-placed just because the dead row once was, and its
   * "last moved" instant is now, not whenever it was tombstoned).
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
        isAuto: item.is_auto ?? false,
        lastMovedAt: item.last_moved_at ?? new Date(),
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
   * A re-delivery of a row that already exists: ledger the arrival and hand the
   * row back, with whatever its source owns brought up to date when the row
   * belongs to a source and that source's value moved (see
   * {@link refreshFromSource}). Nothing else on the row is touched — the
   * find-or-return contract above.
   */
  private async returnExisting(
    context: UserServiceContext,
    existing: EventEntity,
    item: CreateEventDto,
  ): Promise<Event> {
    const current = isSourceOwned(item.source_id, item.source_type)
      ? await this.refreshFromSource(context, existing, sourceDeliveryOf(item))
      : existing;

    await this.ledgerArrival(context, existing.id, item);

    return this.composeOne(current);
  }

  /**
   * Apply what the row's SOURCE just delivered for the fields it owns — the
   * status, the time, the title and the place — each by a three-way merge
   * against what that source delivered last time (sourceStatusMerge.ts,
   * sourceFieldMerge.ts, sourceLocationMerge.ts). A value someone else set
   * stands; the source's own earlier value gives way.
   *
   * Lock first, decide second. The merge reads the row version this
   * transaction holds the lock on, so a user's edit that commits while a sync
   * is in flight is seen and kept; deciding from `existing` — read before the
   * lock — would overwrite it. The title lives on the base row
   * (`ci.entities`), so that row is locked too, AFTER the events row: the
   * order every write to the aggregate takes (CtiAggregate), so a sync and a
   * user's rename cannot deadlock.
   *
   * A moved time is applied the way `update` applies one: the graph delta, the
   * update event, and HBPE told about the day it left and the day it lands on.
   * It also clears what `clean.temporal_repair` recorded about the OLD time
   * and re-opens the decisions stages made on it, in this transaction (see
   * eventTimeReopener.ts). It does not stamp `last_moved_at`, which says a
   * person moved the row (sourceFieldMerge.ts reads it). A status that calls
   * the event off, or reinstates it, settles the pipeline's decisions on
   * whether it happened in the same transaction (eventStatusReopener.ts).
   *
   * A moved place replaces the name and the point in one statement, together
   * with what is derived from them: the confidence that rode with the point,
   * the pipeline's tags, an estimate's markers, and the link to a Location
   * `promote.place` made. The Event −LOCATED_AT→ Place edge the edge leg
   * projected from that link is deleted in the same transaction, because the
   * projection only ever inserts, and the pipeline's decisions on the old place
   * are re-opened (eventLocationReopener.ts). The Location row itself, and its
   * footprint, are left to the stages: a place's footprint is already a
   * high-water mark when links are withdrawn.
   *
   * A tombstone follows its source as well, so the trash's Undo brings back
   * what the source says NOW rather than what it said when the row was
   * deleted. But `is_deleted` is never written, and nothing is published for a
   * tombstone — no graph delta, no update event, no HBPE notification: to
   * every reader it is gone, and the deletion outlives the sync.
   *
   * @returns the stored row, re-read when anything was written.
   */
  private async refreshFromSource(
    context: UserServiceContext,
    existing: EventEntity,
    delivery: SourceDelivery,
  ): Promise<EventEntity> {
    // The usual re-delivery — the organizer edited the agenda, nothing this
    // refreshes moved — costs nothing: the source said all of it last time.
    if (deliveredBefore(existing, delivery)) {
      return existing;
    }

    const id = existing.id;

    const outcome = await this.eventRepository.manager.transaction(async (manager) => {
      const [row] = (await manager.query(
        `SELECT status, source_status, is_deleted,
                start_time, end_time, source_start_time, source_end_time, source_recurrence,
                metadata->'recurrenceRule' AS recurrence_rule,
                metadata->>'recurrenceTimeZone' AS recurrence_time_zone,
                start_time_original, end_time_original, last_moved_at,
                source_title,
                location_name,
                ST_X(location_coordinates::geometry) AS location_lng,
                ST_Y(location_coordinates::geometry) AS location_lat,
                location_entity_id,
                metadata->>'location_source' AS location_source,
                metadata->'promote'->>'stage' AS promoted_by,
                source_location
           FROM ci.events
          WHERE event_id = $1 AND user_id = $2
            FOR UPDATE`,
        [id, context.userId],
      )) as LockedEventRow[];

      if (!row) {
        return null;
      }

      const status =
        delivery.status === undefined
          ? null
          : mergeSourceStatus({ status: row.status, sourceStatus: row.source_status }, delivery.status);

      const shown: StoredWhen = {
        startTime: row.start_time,
        endTime: row.end_time,
        recurrence: recurrenceOf({
          recurrenceRule: row.recurrence_rule,
          recurrenceTimeZone: row.recurrence_time_zone,
        }),
        startTimeOriginal: row.start_time_original,
        endTimeOriginal: row.end_time_original,
        lastMovedAt: row.last_moved_at,
      };
      const when = delivery.when
        ? mergeSourceWhen(
            shown,
            baseWhenOf({
              sourceStartTime: row.source_start_time,
              sourceEndTime: row.source_end_time,
              sourceRecurrence: row.source_recurrence,
            }),
            delivery.when,
          )
        : null;

      // The base row only when the title can move: a repeated title needs no
      // second lock.
      let title: TitleMerge | null = null;
      let shownTitle: string | null = null;

      if (delivery.title !== undefined && row.source_title !== delivery.title) {
        const [base] = (await manager.query(`SELECT name FROM ci.entities WHERE entity_id = $1 FOR UPDATE`, [
          id,
        ])) as Array<{ name: string | null }>;
        shownTitle = base?.name ?? null;
        title = mergeSourceTitle(shownTitle, row.source_title, delivery.title);
      }

      const shownLocation: StoredLocation = {
        name: normalizeLocationName(row.location_name),
        coordinates:
          row.location_lng === null || row.location_lat === null
            ? null
            : coordinatesOf({ type: 'Point', coordinates: [row.location_lng, row.location_lat] }),
        source: row.location_source,
        linked: row.location_entity_id !== null,
        linkedBy: row.promoted_by,
      };
      const location = delivery.location
        ? mergeSourceLocation(shownLocation, locationBaseOf(row.source_location), delivery.location)
        : null;

      if (!status && !when && !title && !location) {
        return null;
      }

      const statusChanged = status?.statusChanged ?? false;
      const timesChanged = when?.timesChanged ?? false;
      const recurrenceChanged = when?.recurrenceChanged ?? false;
      const titleChanged = title?.changed ?? false;
      const placeMoved = location?.apply != null;
      const visible = statusChanged || timesChanged || recurrenceChanged || titleChanged || placeMoved;

      // One UPDATE, built from what moved. A new base alone changes nothing any
      // reader sees, so `updated_at` moves only with a visible change: that is
      // what incremental consumers key on. A rename bumps it too, as `update`
      // does for a title-only patch.
      const params: unknown[] = [id, context.userId];
      const sets: string[] = [];
      const assign = (column: string, value: unknown, cast = ''): void => {
        params.push(value);
        sets.push(`${column} = $${params.length}${cast}`);
      };

      // `metadata` is edited by more than one part of the merge (the series'
      // rule, the pipeline's location tags), and a column may be assigned once
      // per UPDATE, so each part wraps the expression the last one built.
      let metadata = `COALESCE(metadata, '{}'::jsonb)`;

      if (status) {
        assign('status', status.status);
        assign('source_status', status.sourceStatus);
      }

      if (when && delivery.when) {
        assign('source_start_time', when.base.startTime);
        assign('source_end_time', when.base.endTime);
        assign(
          'source_recurrence',
          when.base.recurrence ? JSON.stringify(when.base.recurrence) : null,
          '::jsonb',
        );

        if (timesChanged) {
          assign('start_time', when.when.startTime);
          assign('end_time', when.when.endTime);
          // What the clean stage recorded described the old time: the source
          // has replaced it, so the new one is unexamined until the stage —
          // re-opened below — looks at it. An undo through the old
          // start_time_original would put back a time the source has left.
          assign('time_source', delivery.when.timeSource);
          assign('time_precision', delivery.when.timePrecision);
          sets.push('start_time_original = NULL', 'end_time_original = NULL');

          if (delivery.when.isAllDay !== undefined) {
            assign('is_all_day', delivery.when.isAllDay);
          }
        }

        if (recurrenceChanged) {
          params.push(JSON.stringify(delivery.when.recurrenceKeys));
          // Parenthesized whole: `||` binds looser than `-`, so a later step that
          // removes a key from this expression would otherwise remove it from the
          // right-hand side only.
          metadata = `((${metadata} - ${RECURRENCE_METADATA_KEYS.map((key) => `'${key}'`).join(' - ')}) || $${
            params.length
          }::jsonb)`;

          if (delivery.when.isRecurring !== undefined) {
            assign('is_recurring', delivery.when.isRecurring);
          }
        }
      }

      if (title) {
        assign('source_title', title.base);
      }

      if (location) {
        assign('source_location', JSON.stringify(locationBaseRecord(location.base)), '::jsonb');
      }

      if (location?.apply) {
        const { location: placed, confidence } = location.apply;

        assign('location_name', placed.name);

        if (placed.coordinates) {
          params.push(placed.coordinates[0], placed.coordinates[1]);
          sets.push(
            `location_coordinates = ST_SetSRID(ST_MakePoint($${params.length - 1}, $${params.length}), 4326)::geography`,
          );
        } else {
          sets.push('location_coordinates = NULL');
        }

        // What the point's precision was, and what the pipeline derived from the
        // old name and point: none of it describes the new place. The link goes
        // with the pair it was made from, and the edge projected from it is
        // deleted below. An estimate's markers go only where they are the
        // estimator's (`inference_sources` is replaced wholesale by it, so
        // `temporal_nn` is its mark); anything else in them is someone else's.
        assign('confidence_score', confidence);
        sets.push(
          'location_entity_id = NULL',
          `is_inferred = CASE WHEN inference_sources->>'method' = 'temporal_nn' THEN false ELSE is_inferred END`,
          `inference_sources = CASE WHEN inference_sources->>'method' = 'temporal_nn' THEN '{}'::jsonb ELSE inference_sources END`,
        );
        metadata = `(${metadata} - 'location_source' - 'promote')`;
      }

      if (metadata !== `COALESCE(metadata, '{}'::jsonb)`) {
        sets.push(`metadata = ${metadata}`);
      }

      if (visible) {
        sets.push('updated_at = now()');
      }

      await manager.query(
        `UPDATE ci.events SET ${sets.join(', ')} WHERE event_id = $1 AND user_id = $2`,
        params,
      );

      if (title && titleChanged) {
        await manager.query(`UPDATE ci.entities SET name = $2, updated_at = now() WHERE entity_id = $1`, [
          id,
          title.title,
        ]);
      }

      if (timesChanged) {
        await resolveEventTimeReopener(this.moduleRef).reopenTimeDecisions([id], manager);
      }

      if (location?.apply) {
        // The link was derived from the place that just changed (a link anyone
        // else made would have kept the location out of the merge), and so was
        // the edge projected from it.
        if (row.location_entity_id !== null) {
          await this.retractPlaceEdge(manager, context.userId, id, row.location_entity_id);
        }

        await resolveEventLocationReopener(this.moduleRef).reopenLocationDecisions([id], manager);
      }

      // A cancellation takes back the location the estimator lent the event; a
      // reinstatement offers it to the estimator again. A status the merge left
      // alone (the user's stands) is the stored one, so it crosses nothing. A
      // tombstone's status follows its source like any other, so the same
      // applies to one — quietly.
      if (status && crossedLiveLine(row.status, status.status)) {
        await resolveEventStatusReopener(this.moduleRef).reopenStatusDecisions([id], manager);
      }

      const published = visible && !row.is_deleted;
      // HBPE reads the status, the time and the title of an event; the place is
      // not a token feature, so a place alone is not worth a re-serialization.
      const hbpeRelevant = statusChanged || timesChanged || recurrenceChanged || titleChanged;

      if (published) {
        const name = title
          ? title.title
          : ((
              (await manager.query(`SELECT name FROM ci.entities WHERE entity_id = $1`, [id])) as Array<{
                name: string | null;
              }>
            )[0]?.name ?? null);

        await this.graphDeltaWriter.entityUpdated({
          entityId: id,
          entityType: 'Event',
          name,
          changedFields: {
            ...(statusChanged && status ? { status: { old: row.status, new: status.status } } : {}),
            ...(timesChanged && when
              ? {
                  start_time: { old: row.start_time, new: when.when.startTime },
                  end_time: { old: row.end_time, new: when.when.endTime },
                }
              : {}),
            ...(recurrenceChanged && when
              ? { recurrence: { old: shown.recurrence, new: when.when.recurrence } }
              : {}),
            ...(titleChanged && title ? { name: { old: shownTitle, new: title.title } } : {}),
            ...(location?.apply
              ? locationDelta(shownLocation, location.apply.location, row.location_entity_id)
              : {}),
          },
          ownerUserId: context.userId,
          changeSource: 'CalendarEventService.refreshFromSource',
          changeReason: "re-delivered by the event's source",
          // The source changed it, not the user.
          changedByUserId: null,
          manager,
        });
      }

      return { published, hbpeRelevant, movedFrom: timesChanged ? row.start_time : null };
    });

    if (!outcome) {
      return existing;
    }

    const reloaded = (await this.eventRepository.findOne({ where: { id } })) ?? existing;

    if (outcome.published) {
      await this.signallingEventService.send(EventUpdatedEvent, { eventId: id });

      if (outcome.hbpeRelevant) {
        // Both days a move touches: the one the event left and the one it lands on.
        await this.hbpeNotify?.notifyEvents(
          reloaded.userId,
          outcome.movedFrom ? [outcome.movedFrom, reloaded.startTime] : reloaded.startTime,
        );
        await this.liveChanges?.publish(reloaded.userId, 'calendar');
      }
    }

    return reloaded;
  }

  /**
   * A person has just moved this event's start or end (`update`, `reschedule`):
   * what the pipeline recorded about the OLD time no longer describes the row.
   * Take it back, on `manager`, the transaction that moved it.
   *
   * What the move does to the clean stage's record of the old time:
   *
   *  - It clears all four columns the stage writes: `time_source`,
   *    `time_precision`, `start_time_original` and `end_time_original`. The
   *    stage documents its undo as `SET start_time = start_time_original WHERE
   *    start_time_original IS NOT NULL`; left in place, that would put the
   *    time the source had before the repair over the one the person has just
   *    typed. And it writes the pair `COALESCE(start_time_original,
   *    start_time)` — once, on the first repair — so with the old one still
   *    there, a later repair of the new time would keep the stale original for
   *    good. `time_source` ('repaired', or 'ingest' on an undated event the
   *    person has now dated) and `time_precision` describe the old instant just
   *    as much. Cleared, the time reads as unexamined, which is what NULL
   *    means on a fresh insert, until the stage looks at it again. The source
   *    refresh does the same for a source's move.
   *  - It keeps `last_moved_at`, which the callers stamp. That column is how
   *    the merge (sourceFieldMerge.ts) tells a person's time from the one the
   *    stage left, and it reads the stamp, not these columns.
   *  - It re-opens the stage, and the location estimate's, so both look at the
   *    new time (eventTimeReopener.ts).
   *
   * Only when the start or end moved. The Plan page's edit sends both times on
   * every save, a rename included, and a save that repeats the stored time has
   * moved nothing: erasing the record of a repair that still holds would lose
   * it for no reason. (Such a save still stamps `last_moved_at`, as it always
   * has.)
   */
  private async settleTimeMove(manager: EntityManager, id: string): Promise<void> {
    await manager.query(
      `UPDATE ci.events
          SET time_source = NULL, time_precision = NULL,
              start_time_original = NULL, end_time_original = NULL
        WHERE event_id = $1
          AND (time_source IS NOT NULL OR time_precision IS NOT NULL
               OR start_time_original IS NOT NULL OR end_time_original IS NOT NULL)`,
      [id],
    );

    await resolveEventTimeReopener(this.moduleRef).reopenTimeDecisions([id], manager);
  }

  /**
   * Delete the Event −LOCATED_AT→ Place edge `promote.edge_event` projected from
   * an event's place link, and record that it is gone.
   *
   * The projection only ever inserts (`ON CONFLICT DO NOTHING`), so nothing but
   * the writer that withdraws the link can take the edge back, and one left
   * behind would tell every graph read that the meeting is at the old place.
   * Only the matrix's own edge: another rule can draw the same pair (a
   * receipt's `receipt.event_at_place`), and that one is justified by its
   * receipt, not by the event's place. The place is read through its merge
   * survivor, which is what the projection resolves an endpoint to.
   *
   * A `deleted` delta stays in the log for the edge's creation, which a summary
   * may already have read (the log is append-only; see the repair migrations).
   */
  private async retractPlaceEdge(
    manager: EntityManager,
    userId: string,
    eventId: string,
    placeId: string,
  ): Promise<void> {
    const gone = (await manager.query(
      `WITH gone AS (
         DELETE FROM ci.relationships r
          USING ci.entities l
          WHERE l.entity_id = $3
            AND r.owner_user_id = $1
            AND r.from_entity_id = $2
            AND r.to_entity_id = COALESCE(l.merged_into_entity_id, l.entity_id)
            AND r.relationship_type = 'LOCATED_AT'
            AND r.properties->>'rule' = 'event.happened_at'
          RETURNING r.relationship_id, r.relationship_type, r.from_entity_id, r.to_entity_id
       )
       SELECT relationship_id, relationship_type, from_entity_id, to_entity_id FROM gone`,
      [userId, eventId, placeId],
    )) as Array<{
      relationship_id: string;
      relationship_type: string;
      from_entity_id: string;
      to_entity_id: string;
    }>;

    await this.graphDeltaWriter.recordMany(
      gone.map((edge) => ({
        nodeType: 'relationship' as const,
        changeType: 'deleted' as const,
        relationshipId: edge.relationship_id,
        relationshipType: edge.relationship_type,
        fromEntityId: edge.from_entity_id,
        toEntityId: edge.to_entity_id,
        ownerUserId: userId,
        changeSource: 'CalendarEventService.refreshFromSource',
        changeReason: "the event's place moved at its source",
      })),
      manager,
    );
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
      return [await this.createOne(context, withoutRefusedRecurrence(data))];
    }

    return this.createManyBatched(context, data.map(withoutRefusedRecurrence));
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
    return this.createManyBatchedDetailed(context, data.map(withoutRefusedRecurrence));
  }

  /**
   * Apply a status an event's SOURCE now reports to a row the caller has
   * already found — the door for a re-delivery too thin to go through
   * {@link create}. Google's stub for a deleted event is its id and
   * `status: 'cancelled'`: no start time to create with, and usually no
   * iCalUID to find the row by.
   *
   * The same merge as a re-delivery through `create` ({@link refreshFromSource}),
   * for the status alone: a status the user set stands, a tombstone stays one,
   * and nothing is ever inserted.
   *
   * @returns the stored event, or `null` when the caller owns no such row, or
   *   owns one no source does (a planned block, an event the user made).
   */
  async applyStatusFromSource(
    context: UserServiceContext,
    id: string,
    status: string,
  ): Promise<Event | null> {
    const existing = await this.eventRepository.findOne({ where: { id, userId: context.userId } });

    if (!existing || !isSourceOwned(existing.sourceId, existing.sourceType)) {
      return null;
    }

    return this.composeOne(await this.refreshFromSource(context, existing, { status }));
  }

  /**
   * Stored events by identity, keyed by `source_id` — TOMBSTONES INCLUDED.
   *
   * For an ingest path working out what a source's re-delivery refers to, not
   * for anything a user reads. Such a caller has to see a row the user
   * deleted: the identity is still taken, and a cancellation still lands on it
   * (quietly — see {@link refreshFromSource}). One `source_id IN (…)`, so the
   * read lands on events_source_identity_uniq.
   */
  async findSourceRows(
    context: UserServiceContext,
    sourceSystem: string,
    sourceIds: readonly string[],
  ): Promise<Map<string, Event>> {
    const ids = [...new Set(sourceIds)];

    if (ids.length === 0) {
      return new Map();
    }

    const rows = await this.eventRepository.find({
      where: { userId: context.userId, sourceSystem, sourceId: In(ids) },
    });

    return new Map((await this.composeMany(rows)).map((event) => [event.sourceId as string, event]));
  }

  /**
   * Stored events one connection wrote, keyed by the provider's own event id
   * (`metadata.rawEventId`) — TOMBSTONES INCLUDED, for the same reason as
   * {@link findSourceRows}.
   *
   * Rows are keyed by iCalUID (cross-pipeline identity), but the payloads that
   * cancel them often carry only the provider's id: a cancelled occurrence
   * names its series by the master's Google id (`recurringEventId`), a deleted
   * Google event is its own id and a status, and an Outlook tombstone
   * (`@removed`) is the Graph id and nothing else. This is the way back from one
   * to the other; {@link recordProviderEventId} keeps it current. Scoped to the
   * connection (idx_events_connection_id), so one account's ids can never
   * resolve to another's rows.
   */
  async findByProviderEventIds(
    context: UserServiceContext,
    connectionId: string,
    providerEventIds: readonly string[],
  ): Promise<Map<string, Event>> {
    const ids = [...new Set(providerEventIds)];

    if (ids.length === 0) {
      return new Map();
    }

    const rows = await this.eventRepository
      .createQueryBuilder('event')
      .where('event.user_id = :userId', { userId: context.userId })
      .andWhere('event.connection_id = :connectionId', { connectionId })
      .andWhere(`event.metadata->>'rawEventId' IN (:...providerEventIds)`, { providerEventIds: ids })
      .getMany();

    return new Map((await this.composeMany(rows)).map((event) => [String(event.metadata.rawEventId), event]));
  }

  /**
   * Point {@link findByProviderEventIds} at the provider's CURRENT id for a row
   * this connection wrote — the id an id-only re-delivery will name it by.
   *
   * A re-delivery through {@link create} hands the stored row back without
   * touching its metadata, so a row keeps the `rawEventId` it was inserted with:
   * none, if its transform did not record one then (Outlook's, before it kept
   * the Graph id), and a stale one once the provider re-ids the event (Graph
   * does, unless asked for immutable ids, when an event moves to another
   * calendar). Only that key is written, and only on a row of this connection —
   * the finder is scoped to the connection, so an id on another's row would
   * resolve nothing. Readers see no change, so `updated_at` stays and nothing is
   * published.
   *
   * @returns whether the stored id changed.
   */
  async recordProviderEventId(
    context: UserServiceContext,
    id: string,
    connectionId: string,
    providerEventId: string,
  ): Promise<boolean> {
    const changed = await countAffected(
      this.eventRepository.manager,
      `WITH recorded AS (
         UPDATE ci.events
            SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{rawEventId}', to_jsonb($4::text))
          WHERE event_id = $1
            AND user_id = $2
            AND connection_id = $3
            AND metadata->>'rawEventId' IS DISTINCT FROM $4::text
         RETURNING 1
       )
       SELECT count(*)::int AS count FROM recorded`,
      [id, context.userId, connectionId, providerEventId],
    );

    return changed > 0;
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
    // One hint per bulk call, not per row, for the same reason as above.
    await this.liveChanges?.publish(context.userId, 'calendar');

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
   *
   * Stamps `lastMovedAt` unconditionally — this method's whole purpose is "a
   * move happened", for every event type, not only planned blocks (the column
   * is inert for anything else today, but the semantics are the same: this is
   * the last instant the row's placement changed). `opts.isAuto`, when given,
   * overrides `isAuto` too: a human dragging a block onto a new time is a
   * manual placement from that moment on, regardless of how the block got
   * there — `PlannedBlockService.scheduleTaskAt` passes `{ isAuto: false }` for
   * exactly that reason. Omit it (the plain `rescheduleEvent` GraphQL mutation
   * does) to leave `isAuto` as it was.
   *
   * A move that changes the start or the end also takes back what the pipeline
   * recorded about the old time, in the same transaction
   * ({@link CalendarEventService.settleTimeMove}).
   */
  async reschedule(
    context: ServiceContext,
    id: string,
    startTime: Date,
    endTime?: Date,
    opts?: { isAuto?: boolean },
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
    const newEnd = endTime ?? (priorSpanMs > 0 ? new Date(startTime.getTime() + priorSpanMs) : null);
    // Against what is stored, before the row takes the new values: a drop on the
    // slot it already holds moves nothing (settleTimeMove).
    const moved = !sameTimes(event, { startTime, endTime: newEnd });
    const previousStart = event.startTime;

    event.startTime = startTime;
    event.endTime = newEnd;
    event.lastMovedAt = new Date();

    if (opts?.isAuto !== undefined) {
      event.isAuto = opts.isAuto;
    }

    if (event.sourceSystem) {
      event.externalSyncStatus = 'pending';
    }

    // The move and what the pipeline decided on the old time commit together.
    await this.eventRepository.manager.transaction(async (manager) => {
      await manager.getRepository(EventEntity).save(event);

      if (moved) {
        await this.settleTimeMove(manager, event.id);
      }
    });

    await this.signallingEventService.send(EventUpdatedEvent, { eventId: event.id });
    // Both days, as in update(): the move empties a slot on the old day and
    // fills one on the new, and HBPE re-serializes only the days it is told.
    await this.hbpeNotify?.notifyEvents(event.userId, [previousStart, event.startTime]);
    await this.liveChanges?.publish(event.userId, 'calendar');

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
   * The tombstones — the only read path in the service that returns them.
   *
   * `deleteEvent` is a soft delete and `restoreEvent` genuinely reverses it, but
   * until this existed the reversal was nominal: every other read here filters
   * `is_deleted = false`, so the sole handle on a deleted event was the id
   * echoed once in the delete payload. A caller that discarded that response —
   * an agent, a failed request, a closed tab — had destroyed the event in every
   * way it could observe, while the label said the operation was reversible.
   *
   * Deliberately its own method rather than an `includeDeleted` flag on
   * {@link findPage}: a flag threaded through the normal read path is one
   * defaulting mistake away from leaking tombstones into the timeline, and the
   * two have opposite failure modes. This one returning nothing is an empty
   * trash view; findPage returning tombstones is a bug users would report as
   * "deleted events came back".
   *
   * Same keyset pagination and the same planned_block exclusion as
   * {@link findPage}, so the two pages cannot disagree about what an event is.
   */
  async findDeletedPage(context: UserServiceContext, args: KeysetPageArgs): Promise<KeysetPage<Event>> {
    const page = await keysetPaginate(this.eventRepository, args, {
      alias: 'event',
      timeProp: 'startTime',
      userId: context.userId,
      scope: (qb) =>
        qb
          .andWhere("(event.event_type IS NULL OR event.event_type <> 'planned_block')")
          .andWhere('event.is_deleted = true'),
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

  /**
   * Why `data` must not be stored as an edit of event `id`, or null.
   *
   * A rule this appliance refuses is still accepted when the patch only hands
   * back the rule the row already stores. `metadata` is replaced whole, so a
   * caller changing one key sends the rest back as it read it
   * (GeocodeBatchListener's `location_source`), and a row stored before the
   * write check could otherwise never be patched again. Read time refuses that
   * stored rule on its own (parseRecurrence), so passing it through adds nothing
   * to expand. The row is read only when a refused rule is present, and only
   * the caller's own, as {@link findById} scopes it.
   */
  private async refusedRecurrenceEdit(
    context: ServiceContext,
    id: string,
    data: UpdateEventDto,
  ): Promise<string | null> {
    const metadataRule = data.metadata?.recurrenceRule;
    const patternRule = data.recurrence_pattern?.rrule;
    const metadataReason = recurrenceRuleRejection(metadataRule);
    const patternReason = recurrenceRuleRejection(patternRule);

    if (!metadataReason && !patternReason) {
      return null;
    }

    const stored = await this.eventRepository.findOne({
      where: { id, ...(context.userId !== SYSTEM_USER && { user: { id: context.userId } }) },
      select: { id: true, metadata: true, recurrencePattern: true },
    });
    const unchanged = (sent: unknown, kept: unknown): boolean =>
      stored != null && JSON.stringify(sent) === JSON.stringify(kept);

    if (metadataReason && !unchanged(metadataRule, stored?.metadata?.recurrenceRule)) {
      return metadataReason;
    }

    if (patternReason && !unchanged(patternRule, stored?.recurrencePattern?.rrule)) {
      return patternReason;
    }

    return null;
  }

  /**
   * Patch an event. A patch that moves its start or end, or calls it off or
   * reinstates it, also takes back what the pipeline decided about the old time
   * or about whether it happened, in the same transaction
   * ({@link CalendarEventService.settleTimeMove}, eventStatusReopener.ts). The
   * event it returns is the row as it stands after that.
   */
  async update(context: ServiceContext, id: string, data: UpdateEventDto): Promise<Event | null> {
    // An edit is one person's request, not a batch, so a rule that would hang
    // the calendar is refused outright rather than dropped as on create.
    const recurrenceReason = await this.refusedRecurrenceEdit(context, id, data);

    if (recurrenceReason) {
      throw new BadRequestException(`Unsupported recurrence rule: ${recurrenceReason}`);
    }

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

    // "Any write that changes start_time/end_time" (roadmap M3) — not scoped
    // to planned blocks specifically, because this is the shared partial-update
    // path every event type goes through (`updateEvent` can retime a planned
    // block without going via `reschedule`). Mirrors the unconditional stamp
    // `reschedule` carries.
    if (data.start_time || data.end_time !== undefined) {
      updateData.lastMovedAt = new Date();
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

    // Falsy is meaningful: `isLocked: false` unlocks a block, same reasoning
    // as the boolean block above.
    if (data.is_locked !== undefined) {
      updateData.isLocked = data.is_locked;
    }

    // A person's place takes the pipeline's marks on the value it replaces with
    // it (see metadataWithoutSupersededMarks).
    const supersededMarks = metadataWithoutSupersededMarks(data);
    const detail: QueryDeepPartialEntity<EventEntity> = {
      ...(updateData as QueryDeepPartialEntity<EventEntity>),
      ...(supersededMarks ? { metadata: supersededMarks } : {}),
    };

    // One transaction across both halves of the aggregate (see CtiAggregate).
    // A title/description-only patch still bumps ci.events.updated_at so
    // detail-side incremental consumers see the change.
    let previousStart: Date | null | undefined;
    const updated = await this.aggregate.applyUpdate(
      context,
      id,
      {
        detail, // TypeORM will handle JSON serialization
        base: basePatch,
      },
      {
        withinTx: async ({ manager, before, after }) => {
          previousStart = before.startTime;
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

          // What the pipeline decided about the old time, and about whether the
          // event happened, taken back in this transaction. Judged against the
          // row as this transaction found it: a patch that repeats what is
          // stored changes neither.
          const moved = after !== null && !sameTimes(before, after);
          const calledOffOrReinstated = after !== null && crossedLiveLine(before.status, after.status);

          if (moved) {
            await this.settleTimeMove(manager, id);
          }

          if (calledOffOrReinstated) {
            await resolveEventStatusReopener(this.moduleRef).reopenStatusDecisions([id], manager);
          }

          // `after` was read before either wrote to the row, so the caller is
          // handed the row as it stands now: cleared markers and a withdrawn
          // estimate, not the ones the move just replaced.
          return moved || calledOffOrReinstated
            ? ((await manager.getRepository(EventEntity).findOne({ where: { id } })) ?? undefined)
            : undefined;
        },
      },
    );

    if (!updated) {
      return null;
    }

    await this.signallingEventService.send(EventUpdatedEvent, {
      eventId: updated.id,
    });
    // The day it left as well as the day it is on: a retimed event's tokens
    // stay on its old day until HBPE re-serializes that day, and the payload
    // is the only way HBPE learns which day it was. The service sends one
    // notification per distinct UTC day, so an unmoved event costs one.
    await this.hbpeNotify?.notifyEvents(updated.userId, [previousStart, updated.startTime]);
    await this.liveChanges?.publish(updated.userId, 'calendar');

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
   *
   * The tombstone covers BOTH halves of the aggregate. Readers of `ci.events`
   * decide liveness from `is_deleted`, but graph readers only ever see the
   * `ci.entities` base row and decide it from `is_active` — node reads and
   * counts in GraphUtilityService, and the deterministic edge matrix, whose
   * endpoint join would otherwise keep deriving fresh edges onto a deleted
   * event. Flipping one flag without the other leaves an event that is gone
   * from one family of readers and present in the other.
   */
  async remove(context: ServiceContext, id: string): Promise<boolean> {
    let removedAt: { userId: string; time: Date | null } | undefined;
    const removed = await this.aggregate.remove(context, id, {
      withinTx: async ({ manager, before }) => {
        removedAt = { userId: before.userId, time: before.startTime };
        await manager.getRepository(EventBaseEntity).update({ id }, { isActive: false });
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
      await this.liveChanges?.publish(removedAt.userId, 'calendar');
    }

    return true;
  }

  /**
   * Undoes {@link remove}: clears the tombstone and re-indexes the event, so an
   * accidental deletion is recoverable (this is what the "Undo" affordance on
   * the delete toast calls). A no-op for an event that was never deleted.
   *
   * Reactivates the base row too, the mirror of {@link remove}. A tombstone
   * written before `remove` deactivated it has an active base row already, so
   * the write changes nothing there.
   *
   * @returns the restored event, or `null` when the caller has no tombstoned
   *   event with that id.
   */
  async restore(context: ServiceContext, id: string): Promise<Event | null> {
    const restored = await this.aggregate.restore(context, id, {
      withinTx: async ({ manager, after }) => {
        await manager.getRepository(EventBaseEntity).update({ id }, { isActive: true });
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
    await this.liveChanges?.publish(restored.userId, 'calendar');

    return this.composeOne(restored);
  }

  /**
   * Permanently deletes events, with their attached content and everything that
   * only exists because of them. This is the other end from {@link remove}:
   * that moves an event to the trash and {@link restore} brings it back, this
   * cannot be undone. See {@link purgeEventAggregates} for what goes, and for
   * what a plain delete of the base row would have left behind, or failed on.
   *
   * The photos of an event go with it when nothing else uses them: the files its
   * content wraps, and the ones linked straight to it. A file that something else
   * still uses stays, reported in `files.kept` ({@link planWrappedFiles}). Their
   * objects are deleted from the object store inside the transaction, while the
   * rows are locked, and before any row is.
   *
   * It works on an event in any state, including one already in the trash, so
   * "empty the trash" is the same call. An event that arrived from a source that
   * syncs again will arrive again: only the tombstone, which this removes, stood
   * in the way of that.
   *
   * Everything is one transaction. Search is told afterwards, HBPE is told to
   * re-serialise the days the events were on, and the ids that were not the
   * caller's, or no longer exist, are simply left out of the result.
   *
   * @throws {StoredObjectsDeletedError} if the stored files were deleted and the rows
   *   then could not be. The events named in it are still there, and purging them
   *   again finishes the job. Anything that failed before that left everything as it was.
   * @returns the ids that were purged, the content that went with them, and what was
   *   done about the files.
   */
  async purge(
    context: UserServiceContext,
    ids: string[],
  ): Promise<{ eventIds: string[]; contentIds: string[]; files: WrappedFilesPurged }> {
    const requested = Array.from(new Set(ids));

    if (requested.length === 0) {
      return { eventIds: [], contentIds: [], files: nothingWrapped() };
    }

    // Named by the purge itself once the objects are gone, and read here rather than there
    // because the commit that follows can fail too.
    let objectsGoneFor: string[] = [];
    let purged: PurgedEventAggregates;

    try {
      purged = await this.eventRepository.manager.transaction((manager) =>
        purgeEventAggregates(manager, context.userId, requested, {
          objects: this.storedObjects,
          onObjectsDeleted: (named) => {
            objectsGoneFor = named;
          },
        }),
      );
    } catch (error) {
      throw objectsGoneFor.length > 0 ? new StoredObjectsDeletedError(objectsGoneFor, error) : error;
    }

    // The index rows were deleted in the transaction. These tell anything else
    // that listens, and are what announces a removal everywhere else in the app.
    for (const event of purged.events) {
      await this.signallingEventService.send(EventRemovedEvent, { eventId: event.id });
    }

    for (const contentId of purged.contentIds) {
      await this.signallingEventService.send(ContentRemovedEvent, { contentId });
    }

    for (const fileId of purged.files.fileIds) {
      await this.signallingEventService.send(FileRemovedEvent, { fileId });
    }

    if (purged.events.length > 0) {
      await this.hbpeNotify?.notifyEvents(
        context.userId,
        purged.events.map((event) => event.startTime),
      );
      await this.liveChanges?.publish(context.userId, 'calendar');
    }

    return {
      eventIds: purged.events.map((event) => event.id),
      contentIds: purged.contentIds,
      files: purged.files,
    };
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
    const areas = validAreas(options.areas);
    const needsLocationCoordinate = options.hasLocation === true || areas.length > 0;

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

    // "Where" (map areas): the event's coordinates fall inside ANY of the
    // bounding boxes, each [minLon, minLat, maxLon, maxLat] (EPSG:4326) — a trip
    // to London and Paris is two rectangles ORed, not one box over the Channel.
    // The geography column is cast to geometry so the planar ST_MakeEnvelope /
    // ST_Within pair applies (and the functional GIST index on the cast can
    // serve it). NULL coordinates are excluded by ST_Within. An entry that is
    // not four finite numbers is dropped. Applied below, ORed with the place
    // names: the Where popover offers both, and "100 Duranzo Aisle + Map
    // Areas (2)" means at that address OR inside a rectangle, so an event with
    // only a named place still matches.
    const whereClauses: string[] = [];
    const whereParams: Record<string, unknown> = {};

    if (areas.length > 0) {
      const clauses: string[] = [];

      areas.forEach(([minLon, minLat, maxLon, maxLat], index) => {
        clauses.push(
          'ST_Within(COALESCE(event.location_coordinates, location_entity.location_point)::geometry, ' +
            `ST_MakeEnvelope(:minLon${index}, :minLat${index}, :maxLon${index}, :maxLat${index}, 4326))`,
        );
        Object.assign(whereParams, {
          [`minLon${index}`]: minLon,
          [`minLat${index}`]: minLat,
          [`maxLon${index}`]: maxLon,
          [`maxLat${index}`]: maxLat,
        });
      });

      whereClauses.push(`(${clauses.join(' OR ')})`);
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
      whereClauses.push(`(
          event.location_entity_id IN (
            SELECT entity_id FROM ci.entities
            WHERE owner_user_id = :userId AND entity_type = 'Location' AND name ILIKE ANY(:placePatterns)
          )
          OR event.location_name ILIKE ANY(:placePatterns)
        )`);
      Object.assign(whereParams, {
        userId: context.userId,
        placePatterns: options.places.map((name) => `%${name}%`),
      });
    }

    // One Where predicate: by name OR inside an area. Alone, each reads as before.
    if (whereClauses.length > 0) {
      query = query.andWhere(
        whereClauses.length === 1 ? whereClauses[0] : `(${whereClauses.join(' OR ')})`,
        whereParams,
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

    // The direction `order` asks for (its first key, as for the primary sort); the tiebreak and the
    // keyset below run the same way, so a page is always the rows PAST the cursor in that direction.
    const direction = keysetOrderOf(options.order);

    if (options.order) {
      for (const [field, fieldDirection] of Object.entries(options.order)) {
        query = query.orderBy(`event.${field}`, fieldDirection as 'ASC' | 'DESC');
      }

      // Deterministic tiebreak so same-timestamp rows have a stable total order
      // that the keyset cursor below can page through.
      query = query.addOrderBy('event.event_id', direction);
    }

    // Composite keyset: page strictly past (afterTime, afterId) in (start_time, event_id), in
    // `order` — see keysetSeek. A same-timestamp cluster larger than one fetch is walked through
    // instead of re-returning its top rows.
    if (options.afterTime && options.afterId) {
      query = query.andWhere(
        ...keysetSeek('event.start_time', 'event.event_id', direction, options.afterTime, options.afterId),
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
