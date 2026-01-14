import { Field, ObjectType, ID } from '@nestjs/graphql';

import { MutationPayload } from './MutationPayload';

@ObjectType()
export class DeleteByIdPayload extends MutationPayload {
  @Field(() => ID, { nullable: true })
  deletedId?: string;
}
