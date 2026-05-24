import { Field, Int, ObjectType } from '@nestjs/graphql';

import { CommunicationEdge } from './CommunicationEdge';
import { Connection } from './Connection';
import { PageInfo } from './PageInfo';

@ObjectType({ implements: () => [Connection] })
export class CommunicationConnection implements Connection {
  @Field(() => [CommunicationEdge])
  edges!: CommunicationEdge[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;

  @Field(() => Int)
  totalCount!: number;
}
