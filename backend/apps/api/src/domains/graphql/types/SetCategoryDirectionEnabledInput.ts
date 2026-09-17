import { Field, ID, InputType } from '@nestjs/graphql';

@InputType()
export class SetCategoryDirectionEnabledInput {
  @Field(() => ID)
  categoryId!: string;

  @Field(() => ID)
  directionId!: string;

  /** false inserts an opt-out row (the category no longer applies under this direction); true removes one. */
  @Field(() => Boolean)
  enabled!: boolean;
}
