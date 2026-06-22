import { Field, Float, ID, ObjectType } from '@nestjs/graphql';

import { type KnownPlaceLabel } from '@ci/domains/memory';

/** A single [lng, lat] coordinate pair for a known place. */
@ObjectType()
export class KnownPlaceCoordinates {
  @Field(() => Float)
  lat!: number;

  @Field(() => Float)
  lng!: number;
}

/**
 * GraphQL projection of a persisted ci.known_place_labels row — the
 * confidence-tracked, time-bounded assertion that a Location plays a role
 * (home/work/…) in the user's life.
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

  /** ISO date (inclusive lower bound of the era). */
  @Field(() => String)
  activeFrom!: string;

  /** ISO date, or null when still current. */
  @Field(() => String, { nullable: true })
  activeTo!: string | null;

  @Field(() => [String])
  aliases!: string[];

  /** manual | inferred | geocoded. */
  @Field(() => String)
  source!: string;

  static toType(label: KnownPlaceLabel): KnownPlaceType {
    const coords = label.coordinates;
    // PostGIS / GeoJSON store coordinates [lng, lat]; expose them as named lat/lng
    // so consumers don't have to know the axis order.
    const coordinates =
      coords && Array.isArray(coords.coordinates) && coords.coordinates.length === 2
        ? { lng: coords.coordinates[0], lat: coords.coordinates[1] }
        : null;

    return {
      id: label.id,
      locationId: label.locationId,
      label: label.label,
      kind: label.kind,
      coordinates,
      confidence: label.confidence,
      activeFrom: String(label.activeFrom),
      activeTo: label.activeTo === null ? null : String(label.activeTo),
      aliases: label.aliases,
      source: label.source,
    };
  }
}
