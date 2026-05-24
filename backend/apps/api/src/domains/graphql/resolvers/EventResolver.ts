import { UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { EventService } from '@ci/domains/memory';
import { type Person } from '@ci/domains/memory';

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
import { Paginator } from '../utils/Paginator';

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => EventType)
export class EventResolver {
  constructor(
    private readonly eventService: EventService,
    private readonly personLoader: PersonLoader,
    private readonly placeLoader: PlaceLoader,
    private readonly tagLoader: TagLoader,
  ) {}

  @Mutation(() => EventType)
  async createEvent(
    @Context() context: RequestContext,
    @Args('input') input: CreateEventInput,
  ): Promise<EventType> {
    const serviceContext = toServiceContext(context);

    const entity = await this.eventService.create(serviceContext, {
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

    return EventType.toType(entity[0]);
  }

  @Mutation(() => EventType, { nullable: true })
  async updateEvent(
    @Context() context: RequestContext,
    @Args('input') input: UpdateEventInput,
  ): Promise<EventType | null> {
    const serviceContext = toServiceContext(context);

    const entity = await this.eventService.update(serviceContext, input.id, {
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
    const serviceContext = toServiceContext(context);

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
    const serviceContext = toServiceContext(context);

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
    const serviceContext = toServiceContext(context);

    if (parent.__source.locationEntityId == null) {
      return null;
    }

    const place = await this.placeLoader.load(serviceContext, parent.__source.locationEntityId);

    return place ? PlaceType.toType(place) : null;
  }

  @ResolveField(() => [EntityTagType])
  async tags(@Context() context: RequestContext, @Parent() parent: EventType): Promise<EntityTagType[]> {
    const serviceContext = toServiceContext(context);

    const tags = await this.tagLoader.load(serviceContext, {
      type: 'event',
      id: parent.__source.id,
    });

    return tags.map((tag) => EntityTagType.toType(tag));
  }
}
