import { Field, InputType } from '@nestjs/graphql';

@InputType()
export class CreateAnswerInput {
  @Field()
  answer!: string;

  @Field()
  questionId!: string;
}
