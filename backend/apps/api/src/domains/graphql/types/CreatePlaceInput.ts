import { Field, Float, InputType } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

@InputType()
export class CreatePlaceInput {
  @Field()
  name!: string;

  @Field({ nullable: true })
  description?: string;

  @Field(() => GraphQLJSONObject, { nullable: true })
  properties?: Record<string, unknown>;

  /**
   * First-class latitude/longitude for a captured pin (e.g. a CI-Earth-2 globe
   * pin). Normalized into `properties.latitude` / `properties.longitude` so the
   * memory-explorer Map view (`readCoordinates`) can render it — the map reads
   * top-level numeric `latitude`/`longitude` off the Place properties bag, not
   * the free-form `geolocation` blob. Prefer these over hand-assembling
   * `geolocation` when the caller has plain decimal-degree coordinates.
   */
  @Field(() => Float, { nullable: true })
  latitude?: number;

  @Field(() => Float, { nullable: true })
  longitude?: number;

  /**
   * ISO-8601 capture time for the pin (Earth pin `time`). Stored on
   * `properties.capturedAt` so time-scrubbed spatial views can order pins.
   */
  @Field({ nullable: true })
  capturedAt?: string;

  /**
   * Opaque reference back to the memory this pin represents (the Pin/Scan
   * `MemoryRef` contract). Stored on `properties.memoryRef` untouched.
   */
  @Field(() => GraphQLJSONObject, { nullable: true })
  memoryRef?: Record<string, unknown>;

  /**
   * Provenance tag for where the pin came from (e.g. `earth-2`). Stored on
   * `properties.source`.
   */
  @Field({ nullable: true })
  source?: string;

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
