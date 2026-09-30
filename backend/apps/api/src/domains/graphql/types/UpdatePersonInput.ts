import { Field, InputType } from '@nestjs/graphql';

import { PersonAddressInput } from './PersonAddressType';
import { PersonContactInput } from './PersonContactInput';

/**
 * Partial update: only provided fields change. Structured fields patch the
 * matching properties JSONB keys (first_name, birth_date, ...); an explicit
 * empty string clears a property.
 */
@InputType()
export class UpdatePersonInput {
  @Field()
  id!: string;

  @Field({ nullable: true })
  name?: string;

  @Field({ nullable: true })
  description?: string;

  @Field({ nullable: true })
  firstName?: string;

  @Field({ nullable: true })
  middleName?: string;

  @Field({ nullable: true })
  lastName?: string;

  @Field({ nullable: true })
  nickname?: string;

  @Field({ nullable: true })
  pronouns?: string;

  @Field({ nullable: true })
  gender?: string;

  /** ISO date (YYYY-MM-DD). */
  @Field({ nullable: true })
  birthDate?: string;

  @Field({ nullable: true })
  jobTitle?: string;

  @Field({ nullable: true })
  organization?: string;

  @Field({ nullable: true })
  department?: string;

  @Field({ nullable: true })
  website?: string;

  /**
   * Replaces the whole address list (the form edits it as one unit, so a merge
   * would leave no way to delete an address). An empty list clears it. Omit to
   * leave addresses untouched.
   */
  @Field(() => [PersonAddressInput], { nullable: true })
  addresses?: PersonAddressInput[];

  /**
   * Reconciles this person's email/phone identifiers against the list: adds,
   * relabels, and DROPS what is missing. Omit to leave contact methods
   * untouched; send an empty list to clear them.
   *
   * A value another person already holds fails the whole update (CONFLICT)
   * before anything is written, the other fields included: the fix is a merge,
   * not a re-point.
   */
  @Field(() => [PersonContactInput], { nullable: true })
  contacts?: PersonContactInput[];

  // Flat single-address fields, kept for callers that predate `addresses`.
  // Ignored when `addresses` is also sent.
  @Field({ nullable: true })
  streetAddress?: string;

  @Field({ nullable: true })
  streetAddress2?: string;

  @Field({ nullable: true })
  city?: string;

  @Field({ nullable: true })
  region?: string;

  @Field({ nullable: true })
  country?: string;

  @Field({ nullable: true })
  postalCode?: string;

  @Field({ nullable: true })
  avatarUrl?: string;
}
