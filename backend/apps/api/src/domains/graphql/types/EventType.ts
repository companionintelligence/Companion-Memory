import { Field, Float, ID, Int, ObjectType } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

import { type Event } from '@ci/domains/memory';

import { EntityTagType } from './EntityTagType';
import { GlobalUID } from './GlobalUID';
import { Node } from './Node';
import { Taggable } from './Taggable';

@ObjectType({ implements: () => [Node, Taggable] })
export class EventType implements Node, Taggable {
  __typename = EventType.name;

  __source!: Event;

  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  category!: string | null;

  @Field(() => String, { nullable: true })
  title!: string | null;

  @Field(() => String, { nullable: true })
  description!: string | null;

  @Field(() => String, { nullable: true })
  eventType!: string | null;

  @Field(() => Date)
  startTime!: Date;

  @Field(() => Date, { nullable: true })
  endTime!: Date | null;

  @Field(() => Int, { nullable: true })
  durationMinutes!: number | null;

  @Field(() => String, { nullable: true })
  locationName!: string | null;

  @Field(() => GraphQLJSONObject, { nullable: true })
  locationCoordinates!: {
    type: string;
    coordinates: number[] | null;
  } | null;

  @Field(() => ID, { nullable: true })
  locationEntityId!: string | null;

  @Field(() => [ID], { nullable: true })
  participantEntityIds!: string[] | null;

  @Field(() => ID, { nullable: true })
  organizerEntityId!: string | null;

  @Field(() => String, { nullable: true })
  sourceType!: string | null;

  @Field(() => String, { nullable: true })
  sourceSystem!: string | null;

  @Field(() => ID, { nullable: true })
  sourceId!: string | null;

  @Field(() => Float, { nullable: true })
  confidenceScore!: number;

  @Field(() => Boolean, { nullable: true })
  isRecurring!: boolean;

  @Field(() => Boolean, { nullable: true })
  isAllDay!: boolean;

  @Field(() => GraphQLJSONObject, { nullable: true })
  metadata!: Record<string, unknown>;

  @Field(() => String, { nullable: true })
  status!: string;

  @Field(() => [EntityTagType])
  tags!: EntityTagType[];

  static toType(event: Event): EventType {
    return {
      __typename: EventType.name,
      __source: event,
      id: GlobalUID.encode('event', event.id),
      category: event.category,
      title: event.title,
      description: event.description,
      eventType: event.eventType,
      startTime: event.startTime,
      endTime: event.endTime,
      durationMinutes: event.durationMinutes,
      locationName: event.locationName,
      locationCoordinates: event.locationCoordinates,
      locationEntityId: event.locationEntityId,
      participantEntityIds: event.participantEntityIds,
      organizerEntityId: event.organizerEntityId,
      sourceType: event.sourceType,
      sourceSystem: event.sourceSystem,
      sourceId: event.sourceId,
      confidenceScore: event.confidenceScore,
      isRecurring: event.isRecurring,
      isAllDay: event.isAllDay,
      metadata: event.metadata,
      status: event.status,
      tags: [], // Hydrated by resolver
    };
  }
}
