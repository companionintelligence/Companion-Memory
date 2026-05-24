import { Field, Int, ObjectType } from '@nestjs/graphql';

import { Connection } from './Connection';
import { ConnectionSyncJobEdge } from './ConnectionSyncJobEdge';
import { PageInfo } from './PageInfo';

@ObjectType({ implements: () => [Connection] })
export class ConnectionSyncJobConnection implements Connection {
  @Field(() => [ConnectionSyncJobEdge])
  edges!: ConnectionSyncJobEdge[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;

  @Field(() => Int)
  totalCount!: number;
}
