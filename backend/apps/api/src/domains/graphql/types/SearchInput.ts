import { Field, InputType } from '@nestjs/graphql';

import { IndexableEntity } from '@ci/domains/search-next';

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

  // "How things happened" — narrows event results to these event types
  // (visited, messaged, called, ...). Only affects entities of type `event`.
  @Field(() => [String], { nullable: true })
  eventTypes?: string[];

  @Field(() => String, { nullable: true })
  startTime?: string;

  @Field(() => String, { nullable: true })
  endTime?: string;
}
