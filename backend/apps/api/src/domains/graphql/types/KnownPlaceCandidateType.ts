import { Field, Float, Int, ObjectType } from '@nestjs/graphql';

import { type KnownPlaceCandidate } from '@ci/domains/memory';

/**
 * A not-yet-confirmed known-place candidate surfaced by the frequency /
 * clustering pass, for display as a confirmable insight.
 */
@ObjectType()
export class KnownPlaceCandidateType {
  @Field(() => String, { nullable: true })
  locationId!: string | null;

  @Field(() => String)
  label!: string;

  /** Suggested kind: home | work | other. */
  @Field(() => String)
  kind!: string;

  @Field(() => Float)
  lat!: number;

  @Field(() => Float)
  lng!: number;

  @Field(() => Int)
  eventCount!: number;

  @Field(() => Float)
  confidence!: number;

  static toType(candidate: KnownPlaceCandidate): KnownPlaceCandidateType {
    return {
      locationId: candidate.locationId,
      label: candidate.label,
      kind: candidate.kind,
      lat: candidate.lat,
      lng: candidate.lng,
      eventCount: candidate.eventCount,
      confidence: candidate.confidence,
    };
  }
}
