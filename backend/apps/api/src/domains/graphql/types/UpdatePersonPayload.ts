import { Field, ObjectType } from '@nestjs/graphql';

import { MutationPayload } from './MutationPayload';
import { PersonType } from './PersonType';

@ObjectType()
export class UpdatePersonPayload extends MutationPayload {
  @Field(() => PersonType, { nullable: true })
  person?: PersonType;
}
