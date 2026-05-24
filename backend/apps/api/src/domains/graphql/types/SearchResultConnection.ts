import { Field, ObjectType } from '@nestjs/graphql';

import { Connection } from './Connection';
import { SearchResultEdge } from './SearchResultEdge';

@ObjectType()
export class SearchResultConnection extends Connection {
  @Field(() => [SearchResultEdge])
  declare edges: SearchResultEdge[];
}
