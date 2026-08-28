import { Field, Int, ObjectType } from '@nestjs/graphql';

import { PlaceDuplicateGroupType } from './PlaceDuplicateGroupType';

/** One page of duplicate-place suggestions; same shape as ItemDuplicatesPayload. */
@ObjectType()
export class PlaceDuplicatesPayload {
  @Field(() => [PlaceDuplicateGroupType])
  groups!: PlaceDuplicateGroupType[];

  /** Candidate groups across the whole library, counted before rejected pairs are dropped. */
  @Field(() => Int)
  totalCount!: number;

  @Field(() => Boolean)
  hasMore!: boolean;
}
