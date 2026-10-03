import { Field, ObjectType, ID } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

import { type Place } from '@ci/domains/memory';

import { EntityTagType } from './EntityTagType';
import { GlobalUID } from './GlobalUID';
import { Node } from './Node';
import { RelationshipType } from './RelationshipType';
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

  /**
   * LEGACY: the LifeScope-era `properties.location_boundary` JSONB blob, which
   * nothing validates. Prefer {@link boundary}, the typed PostGIS polygon that
   * placesContaining actually queries.
   */
  @Field(() => GraphQLJSONObject, { nullable: true })
  locationBoundary!: Record<string, unknown> | null;

  /**
   * The place's polygon footprint as a GeoJSON Polygon (SRID 4326), from the
   * typed `ci.entities.location_boundary` geography column. Null for places
   * known only as a point.
   */
  @Field(() => GraphQLJSONObject, { nullable: true })
  boundary!: Record<string, unknown> | null;

  @Field(() => Boolean, { nullable: true })
  estimated!: boolean | null;

  @Field(() => Boolean, { nullable: true })
  tracked!: boolean | null;

  @Field(() => Boolean, { nullable: true })
  uploaded!: boolean | null;

  /** Full-precision latitude from the typed location_point (legacy fallbacks applied). */
  @Field(() => Number, { nullable: true })
  latitude!: number | null;

  @Field(() => Number, { nullable: true })
  longitude!: number | null;

  @Field(() => String, { nullable: true })
  placeKind!: string | null;

  /** Containing place (venue -> city -> region -> country chain). */
  @Field(() => ID, { nullable: true })
  parentId!: string | null;

  /**
   * First real visit inside the active search date window (an event that
   * happened whose location_entity_id is this place, excluding ingest
   * wall-clock times).
   * Null when the browse has no date filter or this place was not visited in
   * the window. SearchResolver stamps this from the identifier's sortTime; do
   * not add a ResolveField that overwrites it with first-ever.
   */
  @Field(() => Date, { nullable: true })
  appearedAt!: Date | null;

  @Field(() => [EntityTagType])
  tags!: EntityTagType[];

  /** Life-graph ego edges — resolved from ci.relationships (WS5). */
  @Field(() => [RelationshipType], { nullable: true })
  outgoingRelationships?: RelationshipType[];

  @Field(() => [RelationshipType], { nullable: true })
  incomingRelationships?: RelationshipType[];

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
      boundary: (place.boundary as Record<string, unknown> | null) ?? null,
      estimated: place.estimated,
      tracked: place.tracked,
      properties: place.properties,
      uploaded: place.uploaded,
      latitude: place.latitude ?? null,
      longitude: place.longitude ?? null,
      placeKind: place.placeKind ?? null,
      parentId: place.parentPlaceId ? GlobalUID.encode('place', place.parentPlaceId) : null,
      appearedAt: place.appearedAt ?? null,
      tags: [], // Hydrated by resolver
    };
  }
}
