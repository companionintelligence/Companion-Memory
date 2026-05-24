import { Field, Int, ObjectType } from '@nestjs/graphql';

import { Connection } from './Connection';
import { ConnectionEdge } from './ConnectionEdge';
import { PageInfo } from './PageInfo';

@ObjectType({ implements: () => [Connection] })
export class ConnectionConnection implements Connection {
  @Field(() => [ConnectionEdge])
  edges!: ConnectionEdge[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;

  @Field(() => Int)
  totalCount!: number;
}
