import { Field, InputType } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

@InputType()
export class CreatePlaceInput {
  @Field()
  name!: string;

  @Field({ nullable: true })
  description?: string;

  @Field(() => GraphQLJSONObject, { nullable: true })
  properties?: Record<string, unknown>;

  @Field({ nullable: true })
  type?: string;

  @Field({ nullable: true })
  geoFormat?: string;

  @Field(() => GraphQLJSONObject, { nullable: true })
  geolocation?: Record<string, unknown>;

  @Field(() => GraphQLJSONObject, { nullable: true })
  locationBoundary?: Record<string, unknown>;

  @Field({ nullable: true })
  estimated?: boolean;

  @Field({ nullable: true })
  tracked?: boolean;

  @Field({ nullable: true })
  uploaded?: boolean;
}
