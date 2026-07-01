import { Field, ID, InputType } from '@nestjs/graphql';

@InputType()
export class SetSavedSearchSharingInput {
  @Field(() => ID)
  id!: string;

  /** Turn link-sharing on (mints/rotates a token) or off (revokes it). */
  @Field(() => Boolean)
  isPublic!: boolean;
}
