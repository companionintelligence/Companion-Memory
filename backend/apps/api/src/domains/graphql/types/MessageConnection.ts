import { Field, Int, ObjectType } from '@nestjs/graphql';

import { Connection } from './Connection';
import { MessageEdge } from './MessageEdge';
import { PageInfo } from './PageInfo';

@ObjectType({ implements: () => [Connection] })
export class MessageConnection implements Connection {
  @Field(() => [MessageEdge])
  edges!: MessageEdge[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;

  @Field(() => Int)
  totalCount!: number;
}
