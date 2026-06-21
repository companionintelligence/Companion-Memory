import { Field, ID, InputType } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

@InputType()
export class CreateContentInput {
  @Field(() => String, { nullable: true })
  type!: string;

  // Link this content (e.g. an attachment / media file reference) to an event,
  // matching ci.content.event_id. Lets a capture source attach media to the
  // event it belongs to.
  @Field(() => ID, { nullable: true })
  eventId?: string;

  @Field(() => String, { nullable: true })
  title?: string;

  @Field(() => String, { nullable: true })
  text?: string;

  @Field(() => String, { nullable: true })
  url?: string;

  @Field(() => String, { nullable: true })
  mimetype?: string;

  @Field(() => String, { nullable: true })
  externalId?: string;

  @Field(() => String, { nullable: true })
  sourceUrl?: string;

  @Field(() => GraphQLJSONObject, { nullable: true })
  sourceData?: Record<string, unknown>;
}
