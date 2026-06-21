import { Field, Float, ID, Int, InputType } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

@InputType()
export class CreateEventInput {
  @Field(() => String, { nullable: true })
  category?: string;

  @Field(() => String, { nullable: true })
  title!: string;

  @Field(() => String, { nullable: true })
  description?: string;

  @Field(() => String, { nullable: true })
  eventType?: string;

  @Field(() => Date)
  startTime!: Date;

  @Field(() => Date, { nullable: true })
  endTime?: Date;

  @Field(() => Int, { nullable: true })
  durationMinutes?: number;

  @Field(() => String, { nullable: true })
  locationName?: string;

  @Field(() => GraphQLJSONObject, { nullable: true })
  locationCoordinates?: {
    type: 'Point';
    coordinates: number[];
  };

  @Field(() => ID, { nullable: true })
  locationEntityId?: string;

  @Field(() => [ID], { nullable: true })
  participantEntityIds?: string[];

  @Field(() => ID, { nullable: true })
  organizerEntityId?: string;

  @Field(() => String, { nullable: true })
  sourceType?: string;

  @Field(() => String, { nullable: true })
  sourceSystem?: string;

  @Field(() => ID, { nullable: true })
  sourceId?: string;

  @Field(() => Float, { nullable: true })
  confidenceScore?: number;

  @Field(() => Boolean, { nullable: true })
  isRecurring?: boolean;

  @Field(() => Boolean, { nullable: true })
  isAllDay?: boolean;

  @Field(() => GraphQLJSONObject, { nullable: true })
  metadata?: Record<string, unknown>;

  @Field(() => String, { nullable: true })
  status?: string;

  // Consent scope for this event (e.g. 'private', 'household', 'public').
  // Defaults to 'private' server-side when omitted.
  @Field(() => String, { nullable: true })
  sharingLevel?: string;
}
