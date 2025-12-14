import { Field, ID, ObjectType } from '@nestjs/graphql';

import { type Thread } from '@ci/domains/conversations';

import { GlobalUID } from './GlobalUID';
import { Node } from './Node';

@ObjectType({ implements: () => [Node] })
export class ThreadType implements Node {
  __typename = ThreadType.name;

  __source!: Thread;

  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  name!: string | null;

  @Field(() => String, { nullable: true })
  description!: string | null;

  static toType(thread: Thread): ThreadType {
    return {
      __typename: ThreadType.name,
      __source: thread,
      id: GlobalUID.encode('thread', thread.id),
      name: thread.name,
      description: thread.description,
    };
  }
}
