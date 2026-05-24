import { Field, Int, InterfaceType } from '@nestjs/graphql';

import { Edge } from './Edge';
import { PageInfo } from './PageInfo';

@InterfaceType()
export abstract class Connection {
  @Field(() => [Edge])
  edges!: Edge[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;

  @Field(() => Int)
  totalCount!: number;
}
