import { Field, ObjectType } from '@nestjs/graphql';

import { ConceptType } from './ConceptType';
import { MutationPayload } from './MutationPayload';

@ObjectType()
export class CreateConceptPayload extends MutationPayload {
  @Field(() => ConceptType, { nullable: true })
  concept?: ConceptType;
}
