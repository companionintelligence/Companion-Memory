import { Field, Int, ObjectType } from '@nestjs/graphql';

import { Connection } from './Connection';
import { PageInfo } from './PageInfo';
import { SummaryEdge } from './SummaryEdge';

@ObjectType({ implements: () => [Connection] })
export class SummaryConnection implements Connection {
  @Field(() => [SummaryEdge])
  edges!: SummaryEdge[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;

  @Field(() => Int)
  totalCount!: number;
}
