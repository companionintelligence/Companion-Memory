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

  /**
   * Whether a client secret is stored. The secret itself is write-only: it is
   * accepted by the create/update inputs and never returned to a client, the
   * same rule every other credential on the appliance follows.
   */
  @Field(() => Boolean)
  hasClientSecret!: boolean;

  /** Last four characters of the stored secret, so the settings UI can show which secret is in place. */
  @Field(() => String, { nullable: true })
  clientSecretHint!: string | null;

  @Field(() => ID)
  userId!: string;

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => Date)
  updatedAt!: Date;

  /** A hint is only offered for secrets long enough that four characters reveal nothing useful. */
  static hintFor(secret: string | null | undefined): string | null {
    return secret && secret.length >= 12 ? secret.slice(-4) : null;
  }

  static toType(providerKey: ProviderKey): ProviderKeyType {
    return {
      __typename: ProviderKeyType.name,
      __source: providerKey,
      id: GlobalUID.encode('provider-key', providerKey.id),
      providerId: GlobalUID.encode('provider', providerKey.providerId),
      clientId: providerKey.clientId,
      hasClientSecret: Boolean(providerKey.clientSecret),
      clientSecretHint: ProviderKeyType.hintFor(providerKey.clientSecret),
      userId: GlobalUID.encode('user', providerKey.userId),
      createdAt: providerKey.createdAt,
      updatedAt: providerKey.updatedAt,
    };
  }
}
