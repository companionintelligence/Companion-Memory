import { Field, Int, ObjectType } from '@nestjs/graphql';

import { Connection } from './Connection';
import { PageInfo } from './PageInfo';
import { PlaceEdge } from './PlaceEdge';

@ObjectType({ implements: () => [Connection] })
export class PlaceConnection implements Connection {
  @Field(() => [PlaceEdge])
  edges!: PlaceEdge[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;

  @Field(() => Int)
  totalCount!: number;
}
