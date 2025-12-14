import { Field, ObjectType, ID } from '@nestjs/graphql';

import { type User } from '@ci/domains/user';

import { GlobalUID } from './GlobalUID';
import { Node } from './Node';

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

  static toType(user: User): UserType {
    return {
      __typename: UserType.name,
      __source: user,
      id: GlobalUID.encode('user', user.id),
      name: user.name,
      email: user.email,
      onboarded: user.onboarded,
    };
  }
}
