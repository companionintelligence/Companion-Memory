import { Field, ObjectType } from '@nestjs/graphql';

import { Edge } from './Edge';
import { MessageType } from './MessageType';

@ObjectType({ implements: () => [Edge] })
export class MessageEdge implements Edge {
  @Field(() => String)
  cursor!: string;

  @Field(() => MessageType)
  node!: MessageType;
}
