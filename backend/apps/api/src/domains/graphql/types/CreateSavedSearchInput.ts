import { Field, InputType } from '@nestjs/graphql';

import { IndexableEntity } from '@ci/domains/search-next';

import { SavedSearchFiltersInput } from './SavedSearchFiltersType';

@InputType()
export class CreateSavedSearchInput {
  /**
   * The search's global id, when the client minted it before the row reached the
   * server — a phone's offline replica (PowerSync) creates the row under its own id
   * and replays the create later, and the id must survive so the row syncing back
   * down is the same row. Omit it for an ordinary create.
   */
  @Field(() => String, { nullable: true })
  id?: string;

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
