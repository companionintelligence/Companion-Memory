import { Field, Int, ObjectType } from '@nestjs/graphql';

import { Connection } from './Connection';
import { PageInfo } from './PageInfo';
import { ProductModelEdge } from './ProductModelEdge';

@ObjectType({ implements: () => [Connection] })
export class ProductModelConnection implements Connection {
  @Field(() => [ProductModelEdge])
  edges!: ProductModelEdge[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;

  @Field(() => Int)
  totalCount!: number;
}
