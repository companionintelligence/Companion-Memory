import { Field, Int, ObjectType } from '@nestjs/graphql';

import { Connection } from './Connection';
import { EventEdge } from './EventEdge';
import { PageInfo } from './PageInfo';

@ObjectType({ implements: () => [Connection] })
export class EventConnection implements Connection {
  @Field(() => [EventEdge])
  edges!: EventEdge[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;

  @Field(() => Int)
  totalCount!: number;
}
