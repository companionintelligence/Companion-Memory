import { Field, InputType, Int, registerEnumType } from '@nestjs/graphql';

import { IndexableEntity } from '@ci/domains/search-next';

export enum SearchSortBy {
  TIME = 'time',
  NAME = 'name',
  RELEVANCE = 'relevance',
}

registerEnumType(SearchSortBy, {
  name: 'SearchSortBy',
  description: 'Field to sort search/explorer results by. RELEVANCE only applies to text queries.',
});

export enum SearchSortOrder {
  ASC = 'ASC',
  DESC = 'DESC',
}

registerEnumType(SearchSortOrder, {
  name: 'SearchSortOrder',
});

@InputType()
export class SearchInput {
  @Field({ nullable: true })
  query?: string;

  @Field(() => [String], { nullable: true })
  excludeTypes?: IndexableEntity[];

  @Field(() => [String], { nullable: true })
  includeTypes?: IndexableEntity[];

  @Field(() => [String], { nullable: true })
  tags?: string[];

  @Field(() => String, { nullable: true })
  startTime?: string;

  @Field(() => String, { nullable: true })
  endTime?: string;

  @Field(() => SearchSortBy, { nullable: true })
  sortBy?: SearchSortBy;

  @Field(() => SearchSortOrder, { nullable: true })
  sortOrder?: SearchSortOrder;

  @Field(() => Int, { nullable: true })
  limit?: number;
}
