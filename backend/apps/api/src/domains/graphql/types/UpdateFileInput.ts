import { Field, ID, InputType } from '@nestjs/graphql';

@InputType()
export class UpdateFileInput {
  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  title?: string;

  @Field(() => String, { nullable: true })
  description?: string;
}
