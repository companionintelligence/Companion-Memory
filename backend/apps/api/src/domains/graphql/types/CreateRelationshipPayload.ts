import { Field, ObjectType } from '@nestjs/graphql';

import { MutationPayload } from './MutationPayload';
import { RelationshipType } from './RelationshipType';

@ObjectType()
export class CreateRelationshipPayload extends MutationPayload {
  @Field(() => RelationshipType, { nullable: true })
  relationship?: RelationshipType;
}
