import { Field, Float, ID, Int, ObjectType } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

import { type Event } from '@ci/domains/memory';

import { ContentConnection } from './ContentConnection';
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

  @Field(() => String, {
    nullable: true,
    description:
      "Provenance for `startTime`: 'source' | 'user' | 'repaired' | 'ingest', or null for a row " +
      "written before this column existed. 'ingest' means the value is NOT a real date — the source " +
      'gave this record no time, and `startTime` carries the import wall clock only because the ' +
      'column is NOT NULL. A client MUST treat \'ingest\' as "no date" rather than sort or display it ' +
      'as a real instant (see EventEntity.timeSource).',
  })
  timeSource!: string | null;

  @Field(() => String, {
    nullable: true,
    description:
      "How much of `startTime` is meaningful: 'second' | 'minute' | 'day' | 'ambiguous' | 'unknown'. " +
      "'unknown' pairs with `timeSource = 'ingest'` — no field of the stored instant carries information " +
      '(see EventEntity.timePrecision).',
  })
  timePrecision!: string | null;

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

  @Field(() => String, {
    nullable: true,
    description: "'pending' when the local row has been changed here but not pushed back to `sourceSystem`.",
  })
  externalSyncStatus!: string | null;

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

  @Field(() => ID, {
    nullable: true,
    description: 'Parent event for sub-events / follow-ups. Children: filter by this id.',
  })
  parentEventId!: string | null;

  @Field(() => ID, {
    nullable: true,
    description: 'Task this planned block schedules (`event_type = planned_block`).',
  })
  taskId!: string | null;

  @Field(() => Int, {
    nullable: true,
    description: 'Intended minutes for a planned block. Distinct from generated durationMinutes.',
  })
  plannedMinutes!: number | null;

  @Field(() => [EntityTagType])
  tags!: EntityTagType[];

  @Field(() => ContentConnection, {
    description: 'Content rows linked to this event via ci.content.event_id.',
  })
  contents?: ContentConnection;

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
      timeSource: event.timeSource,
      timePrecision: event.timePrecision,
      durationMinutes: event.durationMinutes,
      locationName: event.locationName,
      locationCoordinates: event.locationCoordinates,
      locationEntityId: event.locationEntityId,
      participantEntityIds: event.participantEntityIds,
      organizerEntityId: event.organizerEntityId,
      sourceType: event.sourceType,
      sourceSystem: event.sourceSystem,
      externalSyncStatus: event.externalSyncStatus,
      sourceId: event.sourceId,
      confidenceScore: event.confidenceScore,
      isRecurring: event.isRecurring,
      isAllDay: event.isAllDay,
      metadata: event.metadata,
      status: event.status,
      parentEventId: event.parentEventId ? GlobalUID.encode('event', event.parentEventId) : null,
      taskId: event.taskId ? GlobalUID.encode('task', event.taskId) : null,
      plannedMinutes: event.plannedMinutes,
      tags: [], // Hydrated by resolver
    };
  }
}
