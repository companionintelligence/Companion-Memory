import { Field, InputType } from '@nestjs/graphql';

@InputType()
export class UpdateQuestionInput {
  @Field()
  id!: string;

  @Field()
  text!: string;

  @Field()
  category!: string;
}
