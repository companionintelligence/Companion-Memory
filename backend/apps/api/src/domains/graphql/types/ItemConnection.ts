import { Field, Int, ObjectType } from '@nestjs/graphql';

import { Connection } from './Connection';
import { ItemEdge } from './ItemEdge';
import { PageInfo } from './PageInfo';

@ObjectType({ implements: () => [Connection] })
export class ItemConnection implements Connection {
  @Field(() => [ItemEdge])
  edges!: ItemEdge[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;

  @Field(() => Int)
  totalCount!: number;
}
