import { BadRequestException, UseGuards } from '@nestjs/common';
import { Args, Float, ID, Int, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { MaxArraySizePipe } from '@ci/common/pipes';
import { CalendarEventService, adoptIngestIdentity } from '@ci/domains/memory';
import { type Person } from '@ci/domains/memory';

import { GraphqlPrivacy } from '../decorators/GraphqlPrivacy';
import { EventContentsLoader } from '../loaders/EventContentsLoader';
import { type EventMedia, EventMediaLoader } from '../loaders/EventMediaLoader';
import { PersonLoader } from '../loaders/PersonLoader';
import { PlaceLoader } from '../loaders/PlaceLoader';
import { TagLoader } from '../loaders/TagLoader';
import { ContentConnection } from '../types/ContentConnection';
import { ContentEdge } from '../types/ContentEdge';
import { ContentType } from '../types/ContentType';
import { CreateEventInput } from '../types/CreateEventInput';
import { DeleteByIdInput } from '../types/DeleteByIdInput';
import { DeleteByIdPayload } from '../types/DeleteByIdPayload';
import { EntityTagType } from '../types/EntityTagType';
import { EventConnection } from '../types/EventConnection';
import { EventEdge } from '../types/EventEdge';
import { EventType } from '../types/EventType';
import { GlobalUID } from '../types/GlobalUID';
import { PaginationArgs } from '../types/PaginationArgs';
import { PersonConnection } from '../types/PersonConnection';
import { PersonEdge } from '../types/PersonEdge';
import { PersonType } from '../types/PersonType';
import { PlaceType } from '../types/PlaceType';
import { RestoreByIdInput } from '../types/RestoreByIdInput';
import { UpdateEventInput } from '../types/UpdateEventInput';
import { entityOwnerScope } from '../utils/entityOwnerScope';
import { Paginator } from '../utils/Paginator';

/** Widest window eventsInRange will serve — a quarter, enough for the month view. */
const MAX_RANGE_DAYS = 92;

/**
 * The `ci.events` row a node's batched fields must be looked up by.
 *
 * An occurrence expanded from an RRULE (`domains/memory/recurrence`) carries a
 * synthetic id that backs no row, so every DataLoader keyed on it would return
 * empty: a recurring meeting's chip would open with no tags, no attachments and
 * no thumbnail, and nothing on screen would say why. The series master is the
 * row all three actually live on.
 */
function backingEventId(parent: EventType): string {
  return parent.__source.seriesMasterId ?? parent.__source.id;
}

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => EventType)
export class EventResolver {
  constructor(
    private readonly eventService: CalendarEventService,
    private readonly personLoader: PersonLoader,
    private readonly placeLoader: PlaceLoader,
    private readonly tagLoader: TagLoader,
    private readonly eventMediaLoader: EventMediaLoader,
    private readonly eventContentsLoader: EventContentsLoader,
  ) {}

  /**
   * Refuse a reversed interval before it reaches the writer.
   *
   * `ci.events` carries `valid_time_range CHECK (end_time IS NULL OR
   * start_time <= end_time)` and formatError reduces the 23514 it raises to a
   * bare `Internal server error`, so an event minted end-before-start answers
   * user input with an unclassified 500. Equal instants stay legal — the
   * constraint allows them, and a zero-length marker is a real thing to store.
   *
   * Only decidable when the request names both ends: `updateEvent` may move
   * one edge of a stored row, and the other edge is not in the arguments.
   */
  private assertTimeOrder(startTime?: Date, endTime?: Date): void {
    if (startTime && endTime && endTime < startTime) {
      throw new BadRequestException('`endTime` must not precede `startTime`');
    }
  }

  /** Map a CreateEventInput (GraphQL) to the service's CreateEventDto. */
  private toDto(input: CreateEventInput) {
    return {
      title: input.title,
      description: input.description,
      event_type: input.eventType,
      category: input.category,
      start_time: input.startTime,
      end_time: input.endTime,
      duration_minutes: input.durationMinutes,
      location_name: input.locationName,
      location_coordinates: input.locationCoordinates,
      location_entity_id: input.locationEntityId,
      participant_entity_ids: input.participantEntityIds,
      organizer_entity_id: input.organizerEntityId,
      source_type: input.sourceType,
      // External identities are adopted, not minted: the caller owns its
      // namespace; the registry canonicalizes the system spelling
      // (docs/design/cross-pipeline-identity.md).
      source_id: adoptIngestIdentity(input.sourceSystem, input.sourceId).id,
      source_system: adoptIngestIdentity(input.sourceSystem, input.sourceId).system,
      confidence_score: input.confidenceScore,
      is_recurring: input.isRecurring,
      is_all_day: input.isAllDay,
      metadata: input.metadata,
      status: input.status,
      sharing_level: input.sharingLevel,
      is_locked: input.isLocked,
    };
  }

  @Mutation(() => EventType)
  @GraphqlPrivacy({ destructive: false })
  async createEvent(
    @Context() context: RequestContext,
    @Args('input') input: CreateEventInput,
  ): Promise<EventType> {
    this.assertTimeOrder(input.startTime, input.endTime);

    const serviceContext = toServiceContext(context);

    const entity = await this.eventService.create(serviceContext, this.toDto(input));

    return EventType.toType(entity[0]);
  }

  /**
   * Batch create events in one round-trip. Returns the created-or-existing rows
   * in input order (CalendarEventService.create dedups on the
   * (source_type, source_system, source_id) triple), so a re-import is a no-op.
   * The clean batch equivalent of N aliased createEvent mutations.
   */
  @Mutation(() => [EventType])
  @GraphqlPrivacy({ destructive: false })
  async createEvents(
    @Context() context: RequestContext,
    @Args({ name: 'input', type: () => [CreateEventInput] }, new MaxArraySizePipe())
    input: CreateEventInput[],
  ): Promise<EventType[]> {
    input.forEach((i) => this.assertTimeOrder(i.startTime, i.endTime));

    const serviceContext = toServiceContext(context);

    const entities = await this.eventService.create(
      serviceContext,
      input.map((i) => this.toDto(i)),
    );

    return entities.map((e) => EventType.toType(e));
  }

  @Mutation(() => EventType, { nullable: true })
  @GraphqlPrivacy({ destructive: false })
  async updateEvent(
    @Context() context: RequestContext,
    @Args('input') input: UpdateEventInput,
  ): Promise<EventType | null> {
    this.assertTimeOrder(input.startTime, input.endTime);

    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('event', input.id);

    const entity = await this.eventService.update(serviceContext, id, {
      title: input.title,
      description: input.description,
      event_type: input.eventType,
      category: input.category,
      start_time: input.startTime,
      end_time: input.endTime,
      duration_minutes: input.durationMinutes,
      location_name: input.locationName,
      location_coordinates: input.locationCoordinates,
      location_entity_id: input.locationEntityId,
      participant_entity_ids: input.participantEntityIds,
      organizer_entity_id: input.organizerEntityId,
      source_type: input.sourceType,
      // External identities are adopted, not minted: the caller owns its
      // namespace; the registry canonicalizes the system spelling
      // (docs/design/cross-pipeline-identity.md).
      source_id: adoptIngestIdentity(input.sourceSystem, input.sourceId).id,
      source_system: adoptIngestIdentity(input.sourceSystem, input.sourceId).system,
      confidence_score: input.confidenceScore,
      is_recurring: input.isRecurring,
      is_all_day: input.isAllDay,
      metadata: input.metadata,
      status: input.status,
      is_locked: input.isLocked,
    });

    return entity ? EventType.toType(entity) : entity;
  }

  /**
   * @deprecated Returns a bare boolean and takes a positional `id` argument. Use
   * {@link deleteEvent}, which follows the `DeleteByIdInput`/`DeleteByIdPayload`
   * convention the rest of this family uses and echoes the id it removed.
   */
  @Mutation(() => Boolean)
  // Deprecated alias for deleteEvent; declared so deprecating it cannot quietly downgrade it.
  @GraphqlPrivacy({ access: 'delete', destructive: true })
  async removeEvent(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<boolean> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('event', gid);

    return this.eventService.remove(serviceContext, id);
  }

  /**
   * Deletes an event addressed by its global id. This is a SOFT delete: the row
   * is tombstoned and drops out of every read path, and {@link restoreEvent}
   * puts it back.
   */
  @Mutation(() => DeleteByIdPayload)
  // The BASE row is a reversible tombstone (CtiAggregate softDeleteFlag: 'isDeleted'), but the
  // gate is not resting on that. EmbeddingService.remove and VectorService.remove physically
  // delete the embedding and tsvector rows, and restoreEvent RECOMPUTES them rather than
  // restoring them. And no query in the schema surfaces tombstoned events: the only handle is the
  // id echoed once in the delete payload, so a caller that discards the response has lost
  // imported history in every way it can observe.
  @GraphqlPrivacy({ access: 'delete', destructive: true })
  async deleteEvent(
    @Context() context: RequestContext,
    @Args('input') input: DeleteByIdInput,
  ): Promise<DeleteByIdPayload> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('event', input.id);

    const success = await this.eventService.remove(serviceContext, id);

    if (!success) {
      return {
        success: false,
      };
    }

    return {
      success,
      deletedId: input.id,
    };
  }

  /** Undoes {@link deleteEvent}; `null` if there is no deleted event to restore. */
  @Mutation(() => EventType, { nullable: true })
  // The undo path for deleteEvent — restorative, not destructive.
  @GraphqlPrivacy({ destructive: false })
  async restoreEvent(
    @Context() context: RequestContext,
    @Args('input') input: RestoreByIdInput,
  ): Promise<EventType | null> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('event', input.id);

    const entity = await this.eventService.restore(serviceContext, id);

    return entity ? EventType.toType(entity) : null;
  }

  @Query(() => EventConnection)
  async events(
    @Context() context: RequestContext,
    @Args() pagination: PaginationArgs,
  ): Promise<EventConnection> {
    const serviceContext = toServiceContext(context);

    // Keyset, not slice-in-memory: this used to `findAll` the user's entire
    // event table — photos, visits and every ETL row, not just calendar
    // entries — and then discard all but `first` of them. The cursors stay
    // GlobalUID-encoded row ids, so the wire contract is unchanged.
    const { entities, hasNextPage, hasPreviousPage, totalCount } = await this.eventService.findPage(
      serviceContext,
      {
        first: pagination.first,
        last: pagination.last,
        afterId: pagination.after ? GlobalUID.decode(pagination.after).id : null,
        beforeId: pagination.before ? GlobalUID.decode(pagination.before).id : null,
      },
    );

    const edges: EventEdge[] = entities.map((entity) => {
      const node = EventType.toType(entity);

      return {
        node,
        cursor: node.id,
      };
    });

    return {
      edges,
      pageInfo: {
        hasNextPage,
        hasPreviousPage,
        startCursor: edges.length > 0 ? edges[0].cursor : null,
        endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
      },
      totalCount,
    };
  }

  /**
   * The trash: events tombstoned by {@link deleteEvent}, newest first.
   *
   * This exists so `restoreEvent` is reachable. `deleteEvent` is a soft delete
   * and restore genuinely reverses the base row, but every other read path
   * filters `is_deleted = false` — so the only handle on a deleted event was
   * the id echoed once in the delete payload. Discard that response and the
   * event was unrecoverable through the API, while its label advertised a
   * reversible operation. A restore you cannot address is not a restore.
   *
   * Read-only and user-scoped like any other query here. Note what restore does
   * NOT bring back untouched: the delete physically removes the embedding and
   * tsvector rows, and restore re-computes them asynchronously rather than
   * restoring them, so a restored event reappears in the timeline immediately
   * and in semantic search once re-indexing completes.
   */
  @Query(() => EventConnection, {
    description:
      'Events deleted by deleteEvent and not yet restored — the handle restoreEvent needs. Newest first.',
  })
  async deletedEvents(
    @Context() context: RequestContext,
    @Args() pagination: PaginationArgs,
  ): Promise<EventConnection> {
    const serviceContext = toServiceContext(context);

    const { entities, hasNextPage, hasPreviousPage, totalCount } = await this.eventService.findDeletedPage(
      serviceContext,
      {
        first: pagination.first,
        last: pagination.last,
        afterId: pagination.after ? GlobalUID.decode(pagination.after).id : null,
        beforeId: pagination.before ? GlobalUID.decode(pagination.before).id : null,
      },
    );

    const edges: EventEdge[] = entities.map((entity) => {
      const node = EventType.toType(entity);

      return {
        node,
        cursor: node.id,
      };
    });

    return {
      edges,
      pageInfo: {
        hasNextPage,
        hasPreviousPage,
        startCursor: edges.length > 0 ? edges[0].cursor : null,
        endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
      },
      totalCount,
    };
  }

  /**
   * Committed time in a window — the schedule surface's read path.
   *
   * Returns the full set rather than a Connection: the date range is already the
   * bound, and a calendar that paginated its own week would be a strange object.
   * MAX_RANGE_DAYS keeps that from becoming an unbounded scan.
   */
  @Query(() => [EventType], {
    description:
      'Events overlapping [from, to) — calendar read path. Excludes cancelled/no-show; keeps tentative. Allowlisted types: calendar_event, meeting, appointment, planned_block, plus events with no event_type (user-created and accepted suggestions).',
  })
  async eventsInRange(
    @Context() context: RequestContext,
    @Args('from', { type: () => Date }) from: Date,
    @Args('to', { type: () => Date }) to: Date,
  ): Promise<EventType[]> {
    if (to <= from) {
      throw new BadRequestException('`to` must be after `from`');
    }

    const spanDays = (to.getTime() - from.getTime()) / 86_400_000;

    if (spanDays > MAX_RANGE_DAYS) {
      throw new BadRequestException(`Range too wide: ${Math.ceil(spanDays)}d exceeds ${MAX_RANGE_DAYS}d`);
    }

    const serviceContext = toServiceContext(context);

    const entities = await this.eventService.findInRange(serviceContext, from, to);

    return entities.map((entity) => EventType.toType(entity));
  }

  /**
   * Move an event on the calendar. Duration is preserved when `endTime` is
   * omitted, which is what dragging a chip does.
   */
  @Mutation(() => EventType, {
    nullable: true,
    description:
      'Move an event to a new time, keeping its duration. Externally-sourced events are moved ' +
      'locally only and marked pending — the change is not pushed to the source calendar.',
  })
  // Moves start/end time on the same row via CalendarEventService.reschedule; an ordinary field
  // update like updateEvent, not a delete-and-recreate.
  @GraphqlPrivacy({ destructive: false })
  async rescheduleEvent(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
    @Args('startTime', { type: () => Date }) startTime: Date,
    @Args('endTime', { type: () => Date, nullable: true }) endTime?: Date,
  ): Promise<EventType | null> {
    this.assertTimeOrder(startTime, endTime);

    const serviceContext = toServiceContext(context);
    const id = GlobalUID.parse('event', gid);

    const entity = await this.eventService.reschedule(serviceContext, id, startTime, endTime);

    return entity ? EventType.toType(entity) : null;
  }

  @Query(() => [String], {
    description: 'Distinct event types ("how things happened") present for the user.',
  })
  async eventTypes(@Context() context: RequestContext): Promise<string[]> {
    const serviceContext = toServiceContext(context);

    return this.eventService.getDistinctEventTypes(serviceContext);
  }

  @Query(() => [String], {
    description: 'Distinct data sources / connectors (event.source_system) present for the user.',
  })
  async eventSources(@Context() context: RequestContext): Promise<string[]> {
    const serviceContext = toServiceContext(context);

    return this.eventService.getDistinctEventSources(serviceContext);
  }

  @Query(() => EventType, { nullable: true })
  async event(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<EventType | null> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('event', gid);

    const entity = await this.eventService.findById(serviceContext, id);

    return entity ? EventType.toType(entity) : null;
  }

  @ResolveField(() => PersonType, { nullable: true })
  async organizer(
    @Context() context: RequestContext,
    @Parent() parent: EventType,
  ): Promise<PersonType | null> {
    const serviceContext = entityOwnerScope(context, parent.__source.userId);

    if (parent.__source.organizerEntityId == null) {
      return null;
    }

    const person = await this.personLoader.load(serviceContext, parent.__source.organizerEntityId);

    return person ? PersonType.toType(person) : null;
  }

  @ResolveField(() => PersonConnection)
  async participants(
    @Context() context: RequestContext,
    @Parent() parent: EventType,
    @Args() pagination: PaginationArgs,
  ): Promise<PersonConnection> {
    const serviceContext = entityOwnerScope(context, parent.__source.userId);

    const people =
      parent.__source.participantEntityIds == null
        ? []
        : await this.personLoader.loadMany(serviceContext, parent.__source.participantEntityIds);

    // TODO:
    //   Report errors here somehow instead of swallowing them.
    //   Consider emitting a warning log or investigate more deeply
    //   how we might convey a single error within a list.
    const filteredPeople = people.filter(
      (person): person is Person => person != null && !(person instanceof Error),
    );

    const { slice, pageInfo, totalCount } = Paginator.paginate(filteredPeople, {
      ...pagination,
      getId: (person) => GlobalUID.encode('person', person.id),
    });

    const edges: PersonEdge[] = slice.map((person) => {
      const node = PersonType.toType(person);

      return {
        node,
        cursor: node.id,
      };
    });

    return {
      edges,
      pageInfo,
      totalCount,
    };
  }

  @ResolveField(() => PlaceType, { nullable: true })
  async location(@Context() context: RequestContext, @Parent() parent: EventType): Promise<PlaceType | null> {
    const serviceContext = entityOwnerScope(context, parent.__source.userId);

    if (parent.__source.locationEntityId == null) {
      return null;
    }

    const place = await this.placeLoader.load(serviceContext, parent.__source.locationEntityId);

    return place ? PlaceType.toType(place) : null;
  }

  @ResolveField(() => [EntityTagType])
  async tags(@Context() context: RequestContext, @Parent() parent: EventType): Promise<EntityTagType[]> {
    const serviceContext = entityOwnerScope(context, parent.__source.userId);

    const tags = await this.tagLoader.load(serviceContext, {
      type: 'event',
      id: backingEventId(parent),
    });

    return tags.map((tag) => EntityTagType.toType(tag));
  }

  /**
   * Content linked to this event via `ci.content.event_id`. Batched per request
   * through {@link EventContentsLoader} so a page of events costs one query.
   */
  @ResolveField(() => ContentConnection)
  async contents(
    @Context() context: RequestContext,
    @Parent() parent: EventType,
    @Args() pagination: PaginationArgs,
  ): Promise<ContentConnection> {
    const serviceContext = entityOwnerScope(context, parent.__source.userId);

    const entities = await this.eventContentsLoader.load(serviceContext, backingEventId(parent));

    const { slice, pageInfo, totalCount } = Paginator.paginate(entities, {
      ...pagination,
      getId: (entity) => GlobalUID.encode('content', entity.id),
    });

    const edges: ContentEdge[] = slice.map((entity) => {
      const node = ContentType.toType(entity);

      return {
        node,
        cursor: node.id,
      };
    });

    return {
      edges,
      pageInfo,
      totalCount,
    };
  }

  /**
   * Resolve the photo/video linked to this event (null for non-media events).
   * The six media fields below all read from this one DataLoader call, so a
   * page of events resolves its media in a single batch.
   */
  private resolveMedia(context: RequestContext, parent: EventType): Promise<EventMedia | null> {
    return this.eventMediaLoader.load(
      entityOwnerScope(context, parent.__source.userId),
      backingEventId(parent),
    );
  }

  /** Thumbnail (PREVIEW variant) URL for a photo/video event. */
  @ResolveField(() => String, { nullable: true })
  async previewUrl(@Context() context: RequestContext, @Parent() parent: EventType): Promise<string | null> {
    return (await this.resolveMedia(context, parent))?.previewUrl ?? null;
  }

  /** Full-resolution (ORIGINAL variant) URL — drives the lightbox / video player. */
  @ResolveField(() => String, { nullable: true })
  async mediaUrl(@Context() context: RequestContext, @Parent() parent: EventType): Promise<string | null> {
    return (await this.resolveMedia(context, parent))?.mediaUrl ?? null;
  }

  @ResolveField(() => String, { nullable: true })
  async mediaContentType(
    @Context() context: RequestContext,
    @Parent() parent: EventType,
  ): Promise<string | null> {
    return (await this.resolveMedia(context, parent))?.contentType ?? null;
  }

  @ResolveField(() => Int, { nullable: true })
  async mediaWidth(@Context() context: RequestContext, @Parent() parent: EventType): Promise<number | null> {
    return (await this.resolveMedia(context, parent))?.width ?? null;
  }

  @ResolveField(() => Int, { nullable: true })
  async mediaHeight(@Context() context: RequestContext, @Parent() parent: EventType): Promise<number | null> {
    return (await this.resolveMedia(context, parent))?.height ?? null;
  }

  @ResolveField(() => Float, { nullable: true })
  async mediaSize(@Context() context: RequestContext, @Parent() parent: EventType): Promise<number | null> {
    return (await this.resolveMedia(context, parent))?.size ?? null;
  }
}
