import { Field, ID, InputType } from '@nestjs/graphql';

@InputType()
export class CreateProviderKeyInput {
  @Field(() => ID)
  providerId!: string;

  @Field(() => String)
  clientId!: string;

  @Field(() => String)
  clientSecret!: string;
}
