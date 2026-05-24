import { Field, Int, ObjectType } from '@nestjs/graphql';

import { Connection } from './Connection';
import { PageInfo } from './PageInfo';
import { ProviderEdge } from './ProviderEdge';

@ObjectType({ implements: () => [Connection] })
export class ProviderConnection implements Connection {
  @Field(() => [ProviderEdge])
  edges!: ProviderEdge[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;

  @Field(() => Int)
  totalCount!: number;
}
