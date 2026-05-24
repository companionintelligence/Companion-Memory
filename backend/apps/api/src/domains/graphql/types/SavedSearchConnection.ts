import { Field, Int, ObjectType } from '@nestjs/graphql';

import { Connection } from './Connection';
import { PageInfo } from './PageInfo';
import { SavedSearchEdge } from './SavedSearchEdge';

@ObjectType({ implements: () => [Connection] })
export class SavedSearchConnection implements Connection {
  @Field(() => [SavedSearchEdge])
  edges!: SavedSearchEdge[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;

  @Field(() => Int)
  totalCount!: number;
}
