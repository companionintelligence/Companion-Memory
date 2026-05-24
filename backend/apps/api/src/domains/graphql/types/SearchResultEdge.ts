import { Field, ObjectType } from '@nestjs/graphql';

import { type SearchResult, SearchResultType } from './SearchResultType';

// Notably this class does not implement the generic Edge. The type for the
// `node` field is a union type and violates the strict enforcement of GraphQL
// typegen even though all return types from `resolveType` satisfy the generic
// Node. We are accepting this as an exclusion to strict type enforcement.
@ObjectType()
export class SearchResultEdge {
  @Field(() => String)
  cursor!: string;

  @Field(() => SearchResultType)
  node!: SearchResult;
}
