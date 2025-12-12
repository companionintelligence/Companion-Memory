import { Field, ID, InputType } from '@nestjs/graphql';

@InputType()
export class TagEntitiesInput {
  @Field()
  label!: string;

  @Field(() => [ID])
  ids!: string[];
}
