import { Field, ID, InputType } from '@nestjs/graphql';

@InputType()
export class TagEntitiesInput {
  @Field(() => [String])
  labels!: string[];

  @Field(() => [ID])
  ids!: string[];
}
