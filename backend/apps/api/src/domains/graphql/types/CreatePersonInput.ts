import { Field, InputType } from '@nestjs/graphql';

@InputType()
export class CreatePersonInput {
  @Field()
  name!: string;

  @Field({ nullable: true })
  description?: string;
}
