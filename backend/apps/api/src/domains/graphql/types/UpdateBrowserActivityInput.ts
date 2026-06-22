import { Field, ID, InputType } from '@nestjs/graphql';

@InputType()
export class UpdateBrowserActivityInput {
  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  title?: string;

  @Field(() => String, { nullable: true })
  url?: string;
}
