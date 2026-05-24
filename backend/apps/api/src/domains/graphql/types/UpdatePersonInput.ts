import { Field, InputType } from '@nestjs/graphql';

@InputType()
export class UpdatePersonInput {
  @Field()
  id!: string;

  @Field()
  name?: string;

  @Field({ nullable: true })
  description?: string;
}
