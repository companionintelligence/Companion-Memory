import { Field, ID, InputType } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

@InputType()
export class UpdateConnectionInput {
  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  name!: string | null;

  @Field(() => Boolean, { nullable: true })
  active!: boolean;

  @Field(() => String, { nullable: true })
  schedule!: string | null;

  @Field(() => String, { nullable: true })
  accessToken!: string | null;

  @Field(() => String, { nullable: true })
  refreshToken!: string | null;

  @Field(() => Date, { nullable: true })
  tokenExpiry!: Date | null;

  @Field(() => GraphQLJSONObject, { nullable: true })
  syncState!: Record<string, unknown>;

  @Field(() => Boolean, { nullable: true })
  needsReauth!: boolean;

  @Field(() => [String], { nullable: true })
  activeEndpoints!: string[];

  // No `externalId`. It names the provider account a connection belongs to, and the appliance
  // sends it to CI Portal to address a stored grant when a connection is disconnected. Every
  // account on the appliance shares one CI Portal device, so a client that could set it could
  // point its own disconnect at another account's grant. Only the sign-in completion writes it.
}
