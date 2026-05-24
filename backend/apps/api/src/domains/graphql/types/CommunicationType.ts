import { Field, ID, ObjectType } from '@nestjs/graphql';

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
    };
  }
}
