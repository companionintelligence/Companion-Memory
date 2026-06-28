import { Field, ID, InputType } from '@nestjs/graphql';

import { IndexableEntity } from '@ci/domains/search-next';

import { SavedSearchFiltersInput } from './SavedSearchFiltersType';

@InputType()
export class UpdateSavedSearchInput {
  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  name!: string;

  @Field(() => String, { nullable: true })
  description?: string;

  @Field(() => String, { nullable: true })
  query?: string;

  @Field(() => [String], { nullable: true })
  entityTypes?: IndexableEntity[];

  @Field(() => [String], { nullable: true })
  tags?: string[];

  @Field(() => SavedSearchFiltersInput, { nullable: true })
  filters?: SavedSearchFiltersInput;
}
