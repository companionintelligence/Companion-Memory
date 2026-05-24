import { Field, ObjectType } from '@nestjs/graphql';

import { MutationPayload } from './MutationPayload';
import { SavedSearchType } from './SavedSearchType';

@ObjectType()
export class CreateSavedSearchPayload extends MutationPayload {
  @Field(() => SavedSearchType, { nullable: true })
  savedSearch?: SavedSearchType;
}
