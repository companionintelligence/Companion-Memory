import { Field, ID, ObjectType } from '@nestjs/graphql';

import { type Tag } from '@ci/domains/search-next';

import { GlobalUID } from './GlobalUID';
import { Node } from './Node';

@ObjectType({ implements: () => [Node] })
export class TagType {
  __typename = TagType.name;

  __source!: Tag;

  @Field(() => ID)
  id!: string;

  @Field(() => String)
  label!: string;

  @Field(() => String, { nullable: true })
  description!: string | null;

  static toType(tag: Tag): TagType {
    return {
      __typename: TagType.name,
      __source: tag,
      id: GlobalUID.encode('tag', tag.id),
      label: tag.label,
      description: tag.description,
    };
  }
}
