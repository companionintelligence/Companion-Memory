import { Field, ID, InputType } from '@nestjs/graphql';

@InputType()
export class SetTagCategoriesInput {
  /** The intention tag whose category membership is being replaced. */
  @Field(() => ID)
  id!: string;

  /** The full replacement set of category tag ids. Empty clears it (Unsorted). */
  @Field(() => [ID])
  categoryIds!: string[];
}
