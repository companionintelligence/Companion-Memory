import { Field, ID, InputType } from '@nestjs/graphql';

@InputType()
export class MergeProductModelsInput {
  /** Catalog models to merge away (become tombstones pointing at the target). */
  @Field(() => [ID])
  sourceIds!: string[];

  /** The canonical model that survives. */
  @Field(() => ID)
  targetId!: string;
}
