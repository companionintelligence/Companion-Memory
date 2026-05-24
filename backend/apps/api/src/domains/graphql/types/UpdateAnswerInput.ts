import { Field, InputType } from '@nestjs/graphql';

@InputType()
export class UpdateAnswerInput {
  @Field()
  id!: string;

  @Field()
  answer?: string;
}
