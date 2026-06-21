import { Field, Int, InputType } from '@nestjs/graphql';

import { IndexableEntity } from '@ci/domains/search-next';

@InputType()
export class SearchInput {
  @Field({ nullable: true })
  query?: string;

  // Forward cursor pagination: number of results per page.
  @Field(() => Int, { nullable: true })
  first?: number;

  // Opaque cursor (PageInfo.endCursor) to fetch the page after.
  @Field(() => String, { nullable: true })
  after?: string;

  @Field(() => [String], { nullable: true })
  excludeTypes?: IndexableEntity[];

  @Field(() => [String], { nullable: true })
  includeTypes?: IndexableEntity[];

  @Field(() => [String], { nullable: true })
  tags?: string[];

  // "How things happened" — narrows event results to these event types
  // (visited, messaged, called, ...). Only affects entities of type `event`.
  @Field(() => [String], { nullable: true })
  eventTypes?: string[];

  @Field(() => String, { nullable: true })
  startTime?: string;

  @Field(() => String, { nullable: true })
  endTime?: string;

  /** 'relevance' | 'time' | 'name'. Defaults to relevance when a query is present, else time. */
  @Field(() => String, { nullable: true })
  sortBy?: string;

  /** 'asc' | 'desc'. Defaults to desc. */
  @Field(() => String, { nullable: true })
  sortOrder?: string;
}
