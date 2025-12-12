import { Field, ObjectType } from '@nestjs/graphql';

import { type TimestampedTag } from '@ci/domains/search-next';

@ObjectType()
export class EntityTagType {
  @Field(() => String)
  label!: string;

  @Field(() => Date)
  taggedAt!: Date;

  static toType(tag: TimestampedTag): EntityTagType {
    return {
      label: tag.label,
      taggedAt: tag.taggedAt,
    };
  }
}
