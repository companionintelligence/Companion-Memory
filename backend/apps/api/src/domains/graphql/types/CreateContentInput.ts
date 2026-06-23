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

  // Provenance triple. When present, the batch createContents mutation dedupes on
  // (userId, sourceType, sourceSystem, sourceId) and, if no explicit eventId is
  // given, auto-links the content to the event sharing the same triple. See
  // content_source_triple_uniq and ContentService.createMany.
  @Field(() => String, { nullable: true })
  sourceType?: string;

  @Field(() => String, { nullable: true })
  sourceSystem?: string;

  @Field(() => String, { nullable: true })
  sourceId?: string;
}
