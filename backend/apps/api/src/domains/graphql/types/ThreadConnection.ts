import { Field, Int, ObjectType } from '@nestjs/graphql';

import { Connection } from './Connection';
import { PageInfo } from './PageInfo';
import { ThreadEdge } from './ThreadEdge';

@ObjectType({ implements: () => [Connection] })
export class ThreadConnection implements Connection {
  @Field(() => [ThreadEdge])
  edges!: ThreadEdge[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;

  @Field(() => Int)
  totalCount!: number;
}
