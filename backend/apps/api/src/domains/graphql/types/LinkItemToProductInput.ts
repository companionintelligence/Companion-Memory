import { Field, ID, InputType } from '@nestjs/graphql';

@InputType()
export class LinkItemToProductInput {
  @Field(() => ID)
  itemId!: string;

  /** The catalog model this unit is an INSTANCE_OF. Null unlinks it. */
  @Field(() => ID, { nullable: true })
  productId?: string | null;
}
