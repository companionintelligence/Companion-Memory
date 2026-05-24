import { Field, ID, ObjectType } from '@nestjs/graphql';

import { type Provider } from '@ci/domains/connections';

import { GlobalUID } from './GlobalUID';
import { Node } from './Node';

@ObjectType()
export class ProviderEndpointType {
  @Field(() => String)
  name!: string;

  @Field(() => String)
  description!: string;

  @Field(() => String)
  iterationType!: string;

  @Field(() => Number, { nullable: true })
  TTL?: number | null;
}

@ObjectType()
export class ProviderThemeType {
  @Field(() => String, { nullable: true })
  backgroundColor!: string | null;

  @Field(() => String, { nullable: true })
  borderColor!: string | null;
}

@ObjectType({ implements: () => [Node] })
export class ProviderType {
  __typename = ProviderType.name;

  __source!: Provider;

  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  name!: string | null;

  @Field(() => String, { nullable: true })
  description!: string | null;

  @Field(() => [ProviderEndpointType])
  endpoints!: ProviderEndpointType[];

  @Field(() => String, { nullable: true })
  logoUrl!: string | null;

  @Field(() => String, { nullable: true })
  authType!: string | null;

  @Field(() => String, { nullable: true })
  openidKeyLink!: string | null;

  @Field(() => ProviderThemeType, { nullable: true })
  theme!: ProviderThemeType | null;

  static toType(provider: Provider): ProviderType {
    return {
      __typename: ProviderType.name,
      __source: provider,
      id: GlobalUID.encode('provider', provider.id),
      name: provider.name,
      description: provider.description,
      endpoints: provider.endpoints,
      logoUrl: provider.logoUrl,
      authType: provider.authType,
      openidKeyLink: provider.openidKeyLink,
      theme: provider.theme,
    };
  }
}
