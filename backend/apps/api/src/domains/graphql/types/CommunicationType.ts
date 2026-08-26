import { Field, ID, ObjectType } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

import { type Communication } from '@ci/domains/memory';

import { EntityTagType } from './EntityTagType';
import { GlobalUID } from './GlobalUID';
import { Node } from './Node';
import { Taggable } from './Taggable';

@ObjectType({ implements: () => [Node, Taggable] })
export class CommunicationType implements Node, Taggable {
  __typename = CommunicationType.name;

  __source!: Communication;

  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  subject!: string | null;

  @Field(() => String, { nullable: true })
  preview!: string | null;

  @Field(() => String)
  content!: string;

  @Field(() => String)
  type!: string;

  @Field(() => String)
  direction!: string;

  @Field(() => Date)
  time!: Date;

  @Field(() => [EntityTagType])
  tags!: EntityTagType[];

  // Groups a Communication into the conversation it belongs to (e.g. an
  // iMessage/WhatsApp thread or an email thread). Correctly populated on the
  // entity (701k rows backfilled) but never reachable through the API until
  // now — a client had the data to group messages into threads and no field
  // to read it from.
  @Field(() => String, { nullable: true })
  threadId!: string | null;

  // The other participants on a group thread, as the parser recorded them
  // (shape varies by source; kept as opaque JSON rather than a typed list
  // since callers already treat participantsMetadata this way elsewhere).
  @Field(() => GraphQLJSONObject)
  participantsMetadata!: Record<string, unknown>;

  // The connector's catch-all for what has no column of its own — for a
  // Facebook post, its `permalink_url` (the post on facebook.com), the shared
  // `link`, the post type. Opaque JSON for the same reason as
  // participantsMetadata; the drawer reads the page URL out of it.
  @Field(() => GraphQLJSONObject)
  metadata!: Record<string, unknown>;

  @Field(() => String, { nullable: true })
  sourceType!: string | null;

  @Field(() => String, { nullable: true })
  sourceSystem!: string | null;

  @Field(() => String, { nullable: true })
  sourceId!: string | null;

  static toType(entity: Communication): CommunicationType {
    return {
      __typename: CommunicationType.name,
      __source: entity,
      id: GlobalUID.encode('communication', entity.id),
      subject: entity.subject,
      preview: entity.preview,
      content: entity.content,
      type: entity.communicationType,
      direction: entity.direction,
      time: entity.time,
      tags: [], // Hydrated by resolver
      threadId: entity.threadId,
      participantsMetadata: entity.participantsMetadata,
      metadata: entity.metadata ?? {},
      sourceType: entity.sourceType,
      sourceSystem: entity.sourceSystem,
      sourceId: entity.sourceId,
    };
  }
}
