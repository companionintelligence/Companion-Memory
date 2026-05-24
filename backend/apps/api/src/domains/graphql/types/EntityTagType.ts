import { Field, ObjectType } from '@nestjs/graphql';

import { type TimestampedTag } from '@ci/domains/search-next';

import { GlobalUID } from './GlobalUID';
import { Node } from './Node';

@ObjectType({ implements: () => [Node] })
export class EntityTagType extends Node {
  __typename = EntityTagType.name;

  __source!: TimestampedTag;

  @Field(() => String)
  label!: string;

  @Field(() => Date)
  taggedAt!: Date;

  static toType(tag: TimestampedTag): EntityTagType {
    return {
      __typename: EntityTagType.name,
      __source: tag,
      id: GlobalUID.encode('tag', tag.id),
      label: tag.label,
      taggedAt: tag.taggedAt,
    };
  }
}
