import { Field, ID, InputType } from '@nestjs/graphql';

@InputType()
export class MergePlacesInput {
  /** Places to merge away (become tombstones pointing at the target). */
  @Field(() => [ID])
  sourceIds!: string[];

  /** The canonical place that survives. */
  @Field(() => ID)
  targetId!: string;
}
