import { Field, InputType } from '@nestjs/graphql';

@InputType()
export class UpdateProviderKeyInput {
  @Field(() => String, { nullable: true })
  clientId?: string;

  @Field(() => String, { nullable: true })
  clientSecret?: string;
}
