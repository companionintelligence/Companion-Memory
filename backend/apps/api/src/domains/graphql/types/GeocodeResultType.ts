import { Field, Float, ObjectType } from '@nestjs/graphql';

/**
 * A place name → its best match on the map, for the event form's "Look up"
 * beside the Place field. One answer, not a list: the provider behind
 * `GeocodeService` returns a single best match per query, and the cache in
 * front of it means a name typed twice is billed once.
 */
@ObjectType()
export class GeocodeResultType {
  /** `OK`, `ZERO_RESULTS`, or a provider / transport status. */
  @Field(() => String)
  status!: string;

  @Field(() => Float, { nullable: true })
  latitude!: number | null;

  @Field(() => Float, { nullable: true })
  longitude!: number | null;

  /** The provider's formatted address for the match, to confirm it is the right place. */
  @Field(() => String, { nullable: true })
  normalizedAddress!: string | null;

  /** 0–1, lower for a city- or region-grade match than for a street address. */
  @Field(() => Float, { nullable: true })
  confidence!: number | null;

  /** Served from the appliance's own cache: no provider call was billed. */
  @Field(() => Boolean)
  cached!: boolean;
}
