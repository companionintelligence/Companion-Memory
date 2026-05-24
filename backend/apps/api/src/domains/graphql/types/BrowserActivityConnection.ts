import { Field, Int, ObjectType } from '@nestjs/graphql';

import { BrowserActivityEdge } from './BrowserActivityEdge';
import { Connection } from './Connection';
import { PageInfo } from './PageInfo';

@ObjectType({ implements: () => [Connection] })
export class BrowserActivityConnection implements Connection {
  @Field(() => [BrowserActivityEdge])
  edges!: BrowserActivityEdge[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;

  @Field(() => Int)
  totalCount!: number;
}
