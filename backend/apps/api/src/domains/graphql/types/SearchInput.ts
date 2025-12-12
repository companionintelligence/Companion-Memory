import { Field, InputType } from '@nestjs/graphql';

@InputType()
export class SearchInput {
  @Field({ nullable: true })
  query?: string;

  @Field(() => [String], { nullable: true })
  tags?: string[];
}
