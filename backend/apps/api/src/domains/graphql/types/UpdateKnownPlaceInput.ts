import { Field, Float, InputType } from '@nestjs/graphql';

/** A [lat, lng] coordinate pair for confirming a known place. */
@InputType()
export class KnownPlaceCoordinatesInput {
  @Field(() => Float)
  lat!: number;

  @Field(() => Float)
  lng!: number;
}

/**
 * User-confirmation of a known place (geodata-plan Phase 3). Upserts the label
 * row and, for home/work, the matching LIVES_IN / WORKS_AT relationship.
 */
@InputType()
export class UpdateKnownPlaceInput {
  @Field(() => String)
  label!: string;

  /** home | work | school | social | other. */
  @Field(() => String)
  kind!: string;

  /** ci.entities Location node id (raw uuid) to anchor the label/relationship to. */
  @Field(() => String, { nullable: true })
  locationId?: string | null;

  @Field(() => KnownPlaceCoordinatesInput, { nullable: true })
  coordinates?: KnownPlaceCoordinatesInput | null;

  @Field(() => Float, { nullable: true })
  confidence?: number;

  /** ISO date; defaults to the epoch ("as long as we know"). */
  @Field(() => String, { nullable: true })
  activeFrom?: string;

  /** ISO date, or omitted for "still current". */
  @Field(() => String, { nullable: true })
  activeTo?: string | null;

  @Field(() => [String], { nullable: true })
  aliases?: string[];

  /** manual | inferred | geocoded; defaults to manual on confirm. */
  @Field(() => String, { nullable: true })
  source?: string;
}
