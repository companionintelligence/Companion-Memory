import { Field, ObjectType, ID } from '@nestjs/graphql';

import { type User } from '@ci/domains/user';

import { GlobalUID } from './GlobalUID';
import { Node } from './Node';
import { PersonType } from './PersonType';

@ObjectType({ implements: () => [Node] })
export class UserType implements Node {
  __typename = UserType.name;

  __source!: User;

  @Field(() => ID)
  id!: string;

  @Field(() => String)
  name!: string;

  @Field(() => String)
  email!: string;

  @Field(() => Boolean)
  onboarded!: boolean;

  @Field(() => String)
  timezone!: string;

  @Field(() => Boolean)
  needsIdentityStep!: boolean;

  /**
   * Whether this account owns the appliance — `UserEntity.role === 'admin'`, granted to the
   * account that claims an unowned appliance (`UserService.claimApplianceIfUnowned`).
   *
   * Exists so the UI can stop offering controls the server will refuse. Before it, the client had
   * no notion of role at all, so the MCP settings rendered every admin-gated control to everyone
   * and each one failed as a generic "something went wrong" — the 403 was invisible as a cause.
   *
   * ═══ WHAT THIS DOES AND DOES NOT PREDICT ═══
   *
   * It predicts {@link AdminOnlyGuard} exactly, and that guard only. It does NOT predict
   * {@link ApplianceAdminGuard}, which additionally admits everyone on an appliance with no live
   * admin — so gating an `ApplianceAdminGuard` surface (the `/jobs` appliance-wide controls,
   * `/signup-codes` minting) on this flag would hide controls that would actually have succeeded.
   * Those two guards fail in opposite directions and one boolean cannot stand for both.
   *
   * A derived boolean rather than the raw `role`, deliberately: `UserRole` has four values and
   * exactly one question is asked of it today, so shipping the enum to the client would invent
   * three client-side states nothing grants and nothing reads.
   *
   * Not a security boundary. Every route behind it is still guarded server-side; a client that
   * lies to itself about this only re-earns the 403 it would have got anyway.
   */
  @Field(() => Boolean)
  isAdmin!: boolean;

  @Field(() => PersonType, { nullable: true })
  entity?: PersonType | null;

  /**
   * The owner's own avatar — read off their `is_self` Person entity.
   * Resolved by `UserResolver.avatarUrl`, not set in `toType`; null when
   * there is no `is_self` Person yet, or it has no avatar set.
   */
  @Field(() => String, { nullable: true })
  avatarUrl?: string | null;

  static toType(user: User): UserType {
    return {
      __typename: UserType.name,
      __source: user,
      id: GlobalUID.encode('user', user.id),
      name: user.name,
      email: user.email,
      onboarded: user.onboarded,
      timezone: user.timezone,
      needsIdentityStep: user.name === user.email,
      isAdmin: user.role === 'admin',
    };
  }
}
