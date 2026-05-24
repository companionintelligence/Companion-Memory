import { Field, ID, ObjectType } from '@nestjs/graphql';

import { type Thread } from '@ci/domains/conversations';

import { EntityTagType } from './EntityTagType';
import { GlobalUID } from './GlobalUID';
import { Node } from './Node';
import { Taggable } from './Taggable';

@ObjectType({ implements: () => [Node, Taggable] })
export class ThreadType implements Node, Taggable {
  __typename = ThreadType.name;

  __source!: Thread;

  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  name!: string | null;

  @Field(() => String, { nullable: true })
  description!: string | null;

  @Field(() => [EntityTagType])
  tags!: EntityTagType[];

  static toType(thread: Thread): ThreadType {
    return {
      __typename: ThreadType.name,
      __source: thread,
      id: GlobalUID.encode('thread', thread.id),
      name: thread.name,
      description: thread.description,
      tags: [], // Resolved by ThreadResolver
    };
  }
}
