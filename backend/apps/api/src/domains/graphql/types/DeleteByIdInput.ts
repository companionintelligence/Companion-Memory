import { Field, InputType } from '@nestjs/graphql';

@InputType()
export class DeleteByIdInput {
  @Field()
  id!: string;
}
