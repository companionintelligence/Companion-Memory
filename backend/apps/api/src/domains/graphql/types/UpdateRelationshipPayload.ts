import { Field, ObjectType } from '@nestjs/graphql';

import { MutationPayload } from './MutationPayload';
import { RelationshipType } from './RelationshipType';

@ObjectType()
export class UpdateRelationshipPayload extends MutationPayload {
  @Field(() => RelationshipType, { nullable: true })
  relationship?: RelationshipType;
}
