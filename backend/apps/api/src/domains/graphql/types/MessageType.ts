import { Field, ObjectType, ID } from '@nestjs/graphql';

import { type Message } from '@ci/domains/conversations';

import { GlobalUID } from './GlobalUID';
import { Node } from './Node';

@ObjectType({ implements: () => [Node] })
export class MessageType implements Node {
  __typename: string = MessageType.name;

  __source!: Message;

  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  threadId!: string | null;

  @Field(() => String)
  content!: string;

  @Field(() => String, { nullable: true })
  role!: string | null;

  static toType(message: Message): MessageType {
    return {
      __typename: MessageType.name,
      __source: message,
      id: GlobalUID.encode('message', message.id),
      content: message.content,
      role: message.role,
      threadId: message.threadId ?? null,
    };
  }
}
