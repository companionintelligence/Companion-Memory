import { Field, ObjectType } from '@nestjs/graphql';

import { Connection } from './Connection';
import { SearchResultEdge } from './SearchResultEdge';

@ObjectType()
export class SearchConnection extends Connection {
  @Field(() => [SearchResultEdge])
  declare edges: SearchResultEdge[];
}
