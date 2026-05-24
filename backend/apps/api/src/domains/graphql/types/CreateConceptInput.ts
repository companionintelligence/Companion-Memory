import { Field, InputType } from '@nestjs/graphql';

@InputType()
export class CreateConceptInput {
  @Field()
  name!: string;

  @Field({ nullable: true })
  description?: string;
}
