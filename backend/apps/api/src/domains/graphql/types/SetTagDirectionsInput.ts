import { Field, ID, InputType } from '@nestjs/graphql';

@InputType()
export class SetTagDirectionsInput {
  /** The intention tag whose direction membership is being replaced. */
  @Field(() => ID)
  id!: string;

  /** The full replacement set of direction tag ids. Empty clears it (Unsorted). */
  @Field(() => [ID])
  directionIds!: string[];
}
