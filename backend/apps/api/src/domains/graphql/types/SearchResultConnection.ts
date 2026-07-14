import { Field, ObjectType } from '@nestjs/graphql';

import { Connection } from './Connection';
import { SearchResultEdge } from './SearchResultEdge';
import { TagType } from './TagType';

@ObjectType()
export class SearchResultConnection extends Connection {
  @Field(() => [SearchResultEdge])
  declare edges: SearchResultEdge[];

  // Tags whose label matches the search query. A sibling of the entity edges
  // rather than a union member: tags aren't memory items (no timestamp for the
  // time-ordered cursors) and must not leak into the explorer grid, which
  // shares this connection. Empty unless the input carried a query.
  @Field(() => [TagType])
  matchingTags!: TagType[];
}
