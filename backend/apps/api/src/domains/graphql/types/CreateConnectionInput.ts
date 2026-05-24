import { Field, ID, InputType } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

@InputType()
export class CreateConnectionInput {
  @Field(() => String, { nullable: true })
  name!: string;

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

  @Field(() => [String])
  activeEndpoints!: string[];

  @Field(() => ID)
  providerId!: string;
}
