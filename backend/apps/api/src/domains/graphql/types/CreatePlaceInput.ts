import { Field, InputType } from '@nestjs/graphql';

import { GraphQLJSONObject } from '@ci/domains/graphql/scalars/JsonObjectScalar';

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

  /** Full-precision coordinates for the typed location_point column. */
  @Field(() => Number, { nullable: true })
  latitude?: number;

  @Field(() => Number, { nullable: true })
  longitude?: number;

  /** room|building|venue|address|neighborhood|city|region|country|continent|planet|other. */
  @Field({ nullable: true })
  placeKind?: string;

  /** GlobalUID of the containing place. */
  @Field({ nullable: true })
  parentId?: string;
}
