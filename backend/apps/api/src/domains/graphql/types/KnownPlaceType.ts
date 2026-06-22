import { Field, Float, ID, ObjectType } from '@nestjs/graphql';

import { type KnownPlace } from '@ci/domains/memory';

/** A single [lng, lat] coordinate pair for a known place. */
@ObjectType()
export class KnownPlaceCoordinates {
  @Field(() => Float)
  lat!: number;

  @Field(() => Float)
  lng!: number;
}

/**
 * GraphQL projection of a known place — the user's confidence-tracked,
 * time-bounded LIVES_IN / WORKS_AT / VISITED relationship to a `ci.entities`
 * Location node (no bespoke table; the relationship + entity are the record).
 */
@ObjectType()
export class KnownPlaceType {
  @Field(() => ID)
  id!: string;

  /** ci.entities Location node id (raw uuid), when the label is anchored to one. */
  @Field(() => String, { nullable: true })
  locationId!: string | null;

  @Field(() => String)
  label!: string;

  /** home | work | school | social | other. */
  @Field(() => String)
  kind!: string;

  @Field(() => KnownPlaceCoordinates, { nullable: true })
  coordinates!: KnownPlaceCoordinates | null;

  @Field(() => Float)
  confidence!: number;

  /** ISO date (inclusive lower bound of the era), or null when open-ended. */
  @Field(() => String, { nullable: true })
  activeFrom!: string | null;

  /** ISO date, or null when still current. */
  @Field(() => String, { nullable: true })
  activeTo!: string | null;

  @Field(() => [String])
  aliases!: string[];

  /** manual | inferred | geocoded. */
  @Field(() => String)
  source!: string;

  static toType(place: KnownPlace): KnownPlaceType {
    return {
      id: place.id,
      locationId: place.locationId,
      label: place.label,
      kind: place.kind,
      coordinates: place.coordinates ? { lat: place.coordinates.lat, lng: place.coordinates.lng } : null,
      confidence: place.confidence,
      activeFrom: place.activeFrom,
      activeTo: place.activeTo,
      aliases: place.aliases,
      source: place.source,
    };
  }
}
