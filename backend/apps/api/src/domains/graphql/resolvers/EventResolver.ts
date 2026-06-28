import { UseGuards } from '@nestjs/common';
import { Args, Float, ID, Int, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { EventService } from '@ci/domains/memory';
import { type Person } from '@ci/domains/memory';

import { type EventMedia, EventMediaLoader } from '../loaders/EventMediaLoader';
import { PersonLoader } from '../loaders/PersonLoader';
import { PlaceLoader } from '../loaders/PlaceLoader';
import { TagLoader } from '../loaders/TagLoader';
import { CreateEventInput } from '../types/CreateEventInput';
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
import { UpdateEventInput } from '../types/UpdateEventInput';
import { entityOwnerScope } from '../utils/entityOwnerScope';
import { Paginator } from '../utils/Paginator';

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => EventType)
export class EventResolver {
  constructor(
    private readonly eventService: EventService,
    private readonly personLoader: PersonLoader,
    private readonly placeLoader: PlaceLoader,
    private readonly tagLoader: TagLoader,
    private readonly eventMediaLoader: EventMediaLoader,
  ) {}

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
      source_id: input.sourceId,
      source_system: input.sourceSystem,
      confidence_score: input.confidenceScore,
      is_recurring: input.isRecurring,
      is_all_day: input.isAllDay,
      metadata: input.metadata,
      status: input.status,
      sharing_level: input.sharingLevel,
    };
  }

  @Mutation(() => EventType)
  async createEvent(
    @Context() context: RequestContext,
    @Args('input') input: CreateEventInput,
  ): Promise<EventType> {
    const serviceContext = toServiceContext(context);

    const entity = await this.eventService.create(serviceContext, this.toDto(input));

    return EventType.toType(entity[0]);
  }

  /**
   * Batch create events in one round-trip. Returns the created-or-existing rows
   * in input order (EventService.create dedups on the
   * (source_type, source_system, source_id) triple), so a re-import is a no-op.
   * The clean batch equivalent of N aliased createEvent mutations.
   */
  @Mutation(() => [EventType])
  async createEvents(
    @Context() context: RequestContext,
    @Args({ name: 'input', type: () => [CreateEventInput] }) input: CreateEventInput[],
  ): Promise<EventType[]> {
    const serviceContext = toServiceContext(context);

    const entities = await this.eventService.create(
      serviceContext,
      input.map((i) => this.toDto(i)),
    );

    return entities.map((e) => EventType.toType(e));
  }

  @Mutation(() => EventType, { nullable: true })
  async updateEvent(
    @Context() context: RequestContext,
    @Args('input') input: UpdateEventInput,
  ): Promise<EventType | null> {
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
      source_id: input.sourceId,
      source_system: input.sourceSystem,
      confidence_score: input.confidenceScore,
      is_recurring: input.isRecurring,
      is_all_day: input.isAllDay,
      metadata: input.metadata,
      status: input.status,
    });

    return entity ? EventType.toType(entity) : entity;
  }

  @Mutation(() => Boolean)
  async removeEvent(@Context() context: RequestContext, @Args('id') id: string): Promise<boolean> {
    const serviceContext = toServiceContext(context);

    return this.eventService.remove(serviceContext, id);
  }

  @Query(() => EventConnection)
  async events(
    @Context() context: RequestContext,
    @Args() pagination: PaginationArgs,
  ): Promise<EventConnection> {
    const serviceContext = toServiceContext(context);

    const entities = await this.eventService.findAll(serviceContext);

    const { slice, pageInfo, totalCount } = Paginator.paginate(entities, {
      ...pagination,
      getId: (entity) => GlobalUID.encode('event', entity.id),
    });

    const edges: EventEdge[] = slice.map((entity) => {
      const node = EventType.toType(entity);

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
      id: parent.__source.id,
    });

    return tags.map((tag) => EntityTagType.toType(tag));
  }

  /**
   * Resolve the photo/video linked to this event (null for non-media events).
   * The six media fields below all read from this one DataLoader call, so a
   * page of events resolves its media in a single batch.
   */
  private resolveMedia(context: RequestContext, parent: EventType): Promise<EventMedia | null> {
    return this.eventMediaLoader.load(entityOwnerScope(context, parent.__source.userId), parent.__source.id);
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
