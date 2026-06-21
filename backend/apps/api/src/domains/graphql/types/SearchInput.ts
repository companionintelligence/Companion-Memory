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

  @Field(() => String, { nullable: true })
  startTime?: string;

  @Field(() => String, { nullable: true })
  endTime?: string;
}
