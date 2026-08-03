import { Field, ID, InputType } from '@nestjs/graphql';

@InputType()
export class DetachPersonProfileInput {
  /** The person_profiles row to detach onto a fresh person. */
  @Field(() => ID)
  profileId!: string;
}
