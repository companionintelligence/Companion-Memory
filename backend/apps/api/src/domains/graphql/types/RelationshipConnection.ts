import { Field, Int, ObjectType } from '@nestjs/graphql';

import { Connection } from './Connection';
import { PageInfo } from './PageInfo';
import { RelationshipEdge } from './RelationshipEdge';

@ObjectType({ implements: () => [Connection] })
export class RelationshipConnection implements Connection {
  @Field(() => [RelationshipEdge])
  edges!: RelationshipEdge[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;

  @Field(() => Int)
  totalCount!: number;
}
