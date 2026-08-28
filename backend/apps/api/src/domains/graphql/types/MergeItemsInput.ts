import { Field, ID, InputType } from '@nestjs/graphql';

@InputType()
export class MergeItemsInput {
  /** Owned units to merge away (become tombstones pointing at the target). */
  @Field(() => [ID])
  sourceIds!: string[];

  /** The canonical owned unit that survives. */
  @Field(() => ID)
  targetId!: string;
}
