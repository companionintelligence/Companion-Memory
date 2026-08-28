import { Field, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

import type { PlaceDuplicateReason } from '@ci/domains/memory';

import { PlaceType } from './PlaceType';

/** Why a duplicate place group was proposed, strongest evidence first. */
export const PlaceDuplicateReasonEnum = {
  PLACE_ID: 'place_id',
  NAME_PROXIMITY: 'name_proximity',
} as const satisfies Record<Uppercase<PlaceDuplicateReason>, PlaceDuplicateReason>;

export type PlaceDuplicateReasonEnum =
  (typeof PlaceDuplicateReasonEnum)[keyof typeof PlaceDuplicateReasonEnum];

registerEnumType(PlaceDuplicateReasonEnum, {
  name: 'PlaceDuplicateReason',
  description:
    'What a duplicate place group collapsed on: the same provider place id, or the same name within 150 m.',
});

/**
 * A group of places that look like the same place. SUGGESTIONS ONLY — merging
 * is `mergePlaces` and is a user decision.
 */
@ObjectType()
export class PlaceDuplicateGroupType {
  @Field(() => PlaceDuplicateReasonEnum)
  reason!: PlaceDuplicateReason;

  /** The shared provider place id, or the shared name. */
  @Field(() => String)
  value!: string;

  @Field(() => [PlaceType])
  places!: PlaceType[];

  /** Members in total, before truncation of `places`. */
  @Field(() => Int)
  totalPlaces!: number;
}
