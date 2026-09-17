import { Field, ObjectType } from '@nestjs/graphql';

import { MutationPayload } from './MutationPayload';
import { TagType } from './TagType';

@ObjectType()
export class SetTagKindPayload extends MutationPayload {
  @Field(() => TagType, { nullable: true })
  tag?: TagType;
}
