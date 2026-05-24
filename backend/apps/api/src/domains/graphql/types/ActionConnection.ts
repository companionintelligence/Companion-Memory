import { Field, Int, ObjectType } from '@nestjs/graphql';

import { ActionEdge } from './ActionEdge';
import { Connection } from './Connection';
import { PageInfo } from './PageInfo';

@ObjectType({ implements: () => [Connection] })
export class ActionConnection implements Connection {
  @Field(() => [ActionEdge])
  edges!: ActionEdge[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;

  @Field(() => Int)
  totalCount!: number;
}
