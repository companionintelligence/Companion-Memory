import { Field, ID, InputType } from '@nestjs/graphql';

@InputType()
export class UpdateCommunicationInput {
  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  subject?: string;

  @Field(() => String, { nullable: true })
  content?: string;
}
