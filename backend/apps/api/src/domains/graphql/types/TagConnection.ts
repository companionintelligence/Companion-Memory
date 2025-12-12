import { Field, Int, ObjectType } from '@nestjs/graphql';

import { Connection } from './Connection';
import { PageInfo } from './PageInfo';
import { TagEdge } from './TagEdge';

@ObjectType({ implements: () => [Connection] })
export class TagConnection implements Connection {
  @Field(() => [TagEdge])
  edges!: TagEdge[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;

  @Field(() => Int)
  totalCount!: number;
}
