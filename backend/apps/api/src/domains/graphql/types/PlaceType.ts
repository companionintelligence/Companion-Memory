import { Field, ObjectType, ID } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

import { type Place } from '@ci/domains/memory';

import { EntityTagType } from './EntityTagType';
import { GlobalUID } from './GlobalUID';
import { Node } from './Node';
import { Taggable } from './Taggable';

@ObjectType({ implements: () => [Node, Taggable] })
export class PlaceType implements Node, Taggable {
  __typename = PlaceType.name;

  __source!: Place;

  @Field(() => ID)
  id!: string;

  @Field(() => String)
  entityType!: string;

  @Field(() => String, { nullable: true })
  name!: string | null;

  @Field(() => String, { nullable: true })
  description!: string | null;

  @Field(() => GraphQLJSONObject)
  properties!: Record<string, unknown>;

  @Field(() => String, { nullable: true })
  type!: string | null;

  @Field(() => String, { nullable: true })
  geoFormat?: string | null;

  @Field(() => GraphQLJSONObject, { nullable: true })
  geolocation!: Record<string, unknown> | null;

  @Field(() => GraphQLJSONObject, { nullable: true })
  locationBoundary!: Record<string, unknown> | null;

  @Field(() => Boolean, { nullable: true })
  estimated!: boolean | null;

  @Field(() => Boolean, { nullable: true })
  tracked!: boolean | null;

  @Field(() => Boolean, { nullable: true })
  uploaded!: boolean | null;

  @Field(() => [EntityTagType])
  tags!: EntityTagType[];

  static toType(place: Place): PlaceType {
    return {
      __typename: PlaceType.name,
      __source: place,
      id: GlobalUID.encode('place', place.id),
      name: place.name,
      entityType: place.entityType,
      description: place.description,
      type: place.type,
      geoFormat: place.geoFormat,
      geolocation: place.geolocation,
      locationBoundary: place.locationBoundary,
      estimated: place.estimated,
      tracked: place.tracked,
      properties: place.properties,
      uploaded: place.uploaded,
      tags: [], // Hydrated by resolver
    };
  }
}
