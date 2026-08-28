import { Field, ID, InputType } from '@nestjs/graphql';

@InputType()
export class SetSavedSearchSharingInput {
  @Field(() => ID)
  id!: string;

  /** Turn link-sharing on (mints/rotates a token) or off (revokes it). */
  @Field(() => Boolean)
  isPublic!: boolean;

  /**
   * The most any reader of this link may ever receive — a `DISCLOSURE_RUNGS`
   * rung (`none` | `boolean` | `count` | `summary` | `redacted` | `full`).
   *
   * Omitted means "no ceiling from the share", which is what every link created
   * before this field existed carries and what keeps them disclosing exactly
   * what they always did. It is NOT a default of `full`: absent and `full` are
   * different statements, and only one of them is something the owner said.
   *
   * Ignored when `isPublic` is false — turning sharing off clears the posture
   * along with the token, so a later re-share does not inherit a restriction
   * written for a different audience.
   */
  @Field(() => String, { nullable: true })
  maxDisclosure?: string;

  /**
   * When the link lapses. Omitted = stands until the owner unshares.
   *
   * Stamped onto each reader's grant when they first open the link, so a reader
   * who has already claimed the share lapses on the same schedule rather than
   * keeping an open-ended grant behind an expired link.
   */
  @Field(() => Date, { nullable: true })
  expiresAt?: Date;
}
