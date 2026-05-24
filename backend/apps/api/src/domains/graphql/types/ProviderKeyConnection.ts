import { Field, Int, ObjectType } from '@nestjs/graphql';

import { Connection } from './Connection';
import { PageInfo } from './PageInfo';
import { ProviderKeyEdge } from './ProviderKeyEdge';

@ObjectType({ implements: () => [Connection] })
export class ProviderKeyConnection implements Connection {
  @Field(() => [ProviderKeyEdge])
  edges!: ProviderKeyEdge[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;

  @Field(() => Int)
  totalCount!: number;
}
