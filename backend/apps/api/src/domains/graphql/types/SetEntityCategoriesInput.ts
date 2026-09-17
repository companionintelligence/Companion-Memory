import { Field, ID, InputType } from '@nestjs/graphql';

@InputType()
export class SetEntityCategoriesInput {
  /** The taggable entity (any TaggableEntityType member) whose categories are being replaced. */
  @Field(() => ID)
  entityId!: string;

  /** The full replacement set of category tag ids, in display order. Capped at 3; empty clears it. */
  @Field(() => [ID])
  categoryIds!: string[];
}
