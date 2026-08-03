import { Field, ObjectType } from '@nestjs/graphql';

import { PersonType } from './PersonType';

@ObjectType()
export class DetachPersonProfilePayload {
  @Field(() => Boolean)
  success!: boolean;

  /** The fresh person the profile now assembles into. */
  @Field(() => PersonType, { nullable: true })
  person?: PersonType;
}
