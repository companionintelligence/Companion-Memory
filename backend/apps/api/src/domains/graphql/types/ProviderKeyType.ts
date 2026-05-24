import { Field, ID, ObjectType } from '@nestjs/graphql';

import { type ProviderKey } from '@ci/domains/connections';

import { GlobalUID } from './GlobalUID';
import { Node } from './Node';

@ObjectType({ implements: () => [Node] })
export class ProviderKeyType {
  __typename = ProviderKeyType.name;

  __source!: ProviderKey;

  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  providerId!: string;

  @Field(() => String)
  clientId!: string;

  @Field(() => String)
  clientSecret!: string;

  @Field(() => ID)
  userId!: string;

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => Date)
  updatedAt!: Date;

  static toType(providerKey: ProviderKey): ProviderKeyType {
    return {
      __typename: ProviderKeyType.name,
      __source: providerKey,
      id: GlobalUID.encode('provider-key', providerKey.id),
      providerId: GlobalUID.encode('provider', providerKey.providerId),
      clientId: providerKey.clientId,
      clientSecret: providerKey.clientSecret,
      userId: GlobalUID.encode('user', providerKey.userId),
      createdAt: providerKey.createdAt,
      updatedAt: providerKey.updatedAt,
    };
  }
}
