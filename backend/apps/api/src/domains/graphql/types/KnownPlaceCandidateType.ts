import { Field, Float, Int, ObjectType } from '@nestjs/graphql';

import { type KnownPlaceCandidate, type KnownPlaceSampleEvent } from '@ci/domains/memory';

/** One event behind a known-place candidate, so an unnamed cluster is recognizable. */
@ObjectType()
export class KnownPlaceSampleEventType {
  @Field(() => String)
  id!: string;

  @Field(() => String)
  title!: string;

  @Field(() => String)
  startTime!: string;

  static toType(event: KnownPlaceSampleEvent): KnownPlaceSampleEventType {
    return {
      id: event.id,
      title: event.title,
      startTime: event.startTime,
    };
  }
}

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

  @Field(() => [KnownPlaceSampleEventType])
  sampleEvents!: KnownPlaceSampleEventType[];

  @Field(() => Float)
  confidence!: number;

  /**
   * Distinct local days the user's location history puts them in this
   * candidate's grid cell. 0 on a candidate anchored to a Location.
   */
  @Field(() => Int)
  presenceDays!: number;

  /** Distinct local nights (21:00–06:00) of location history in the cell. */
  @Field(() => Int)
  presenceNights!: number;

  static toType(candidate: KnownPlaceCandidate): KnownPlaceCandidateType {
    return {
      locationId: candidate.locationId,
      label: candidate.label,
      kind: candidate.kind,
      lat: candidate.lat,
      lng: candidate.lng,
      eventCount: candidate.eventCount,
      sampleEvents: candidate.sampleEvents.map((event) => KnownPlaceSampleEventType.toType(event)),
      confidence: candidate.confidence,
      presenceDays: candidate.presenceDays,
      presenceNights: candidate.presenceNights,
    };
  }
}
