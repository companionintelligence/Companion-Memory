import { Field, Int, ObjectType } from '@nestjs/graphql';

import { ItemDuplicateGroupType } from './ItemDuplicateGroupType';

/**
 * One page of duplicate-owned-unit suggestions, plus how many there are.
 *
 * The count is what makes the cap honest and `hasMore` is what makes it
 * pageable — the same shape, for the same reason, as
 * {@link PersonDuplicatesPayload}.
 */
@ObjectType()
export class ItemDuplicatesPayload {
  @Field(() => [ItemDuplicateGroupType])
  groups!: ItemDuplicateGroupType[];

  /**
   * Candidate groups matching the filter across the whole library.
   *
   * Counted before rejected pairs are dropped from each group, so it can
   * slightly overstate what a full walk would yield — it is the size of the
   * queue, not a promise about every page.
   */
  @Field(() => Int)
  totalCount!: number;

  @Field(() => Boolean)
  hasMore!: boolean;
}
