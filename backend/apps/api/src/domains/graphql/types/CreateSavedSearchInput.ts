import { Field, InputType } from '@nestjs/graphql';

import { IndexableEntity } from '@ci/domains/search-next';

import { SavedSearchFiltersInput } from './SavedSearchFiltersType';

@InputType()
export class CreateSavedSearchInput {
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
