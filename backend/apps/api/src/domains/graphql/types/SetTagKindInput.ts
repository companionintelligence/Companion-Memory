import { Field, ID, InputType } from '@nestjs/graphql';

import { TagKindEnum } from './TagType';

@InputType()
export class SetTagKindInput {
  @Field(() => ID)
  id!: string;

  @Field(() => TagKindEnum)
  kind!: TagKindEnum;
}
