import { Field, ID, InputType, ObjectType, GraphQLISODateTime } from '@nestjs/graphql';

import { type HouseholdTier, TRUST_TIERS } from '@ci/domains/asks';

import { GlobalUID } from './GlobalUID';

/** One owner's trust tier for another LOCAL account. */
@ObjectType()
export class HouseholdTierType {
  @Field(() => ID)
  id!: string;

  /** The other local account. Opaque — a local asker has no handle on this wire. */
  @Field(() => ID)
  memberId!: string;

  @Field(() => String)
  trustTier!: string;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;

  static toType(row: HouseholdTier): HouseholdTierType {
    return {
      id: GlobalUID.encode('household-tier', row.id),
      memberId: GlobalUID.encode('user', row.memberUserId),
      trustTier: row.trustTier,
      updatedAt: row.updatedAt,
    };
  }
}

@InputType()
export class SetHouseholdTierInput {
  @Field(() => ID)
  memberId!: string;

  /**
   * One of `TRUST_TIERS`. `household` is legal here — it is the DEFAULT this
   * setting exists to let an owner move away from, and restoring it must not
   * require deleting the row.
   *
   * Validated in the service and REJECTED if off-vocabulary rather than
   * coerced: silently storing a tier that later reads as `stranger` would hand
   * an owner a setting they did not choose, and no explanation of why their
   * housemate stopped getting answers.
   */
  @Field(() => String, {
    description: `One of: ${TRUST_TIERS.join(', ')}`,
  })
  trustTier!: string;
}
