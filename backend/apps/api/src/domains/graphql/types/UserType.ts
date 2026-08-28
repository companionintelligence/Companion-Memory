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
    };
  }
}
