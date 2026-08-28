import { Field, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

import type { ObjectDuplicateReason } from '@ci/domains/memory';

import { ItemType } from './ItemType';

/** Why a duplicate group was proposed, strongest evidence first. */
export const ItemDuplicateReasonEnum = {
  IDENTIFIER: 'identifier',
  PRODUCT_NAME: 'product_name',
  BRAND_MODEL: 'brand_model',
} as const satisfies Record<Uppercase<ObjectDuplicateReason>, ObjectDuplicateReason>;

export type ItemDuplicateReasonEnum = (typeof ItemDuplicateReasonEnum)[keyof typeof ItemDuplicateReasonEnum];

registerEnumType(ItemDuplicateReasonEnum, {
  name: 'ItemDuplicateReason',
  description:
    'What a duplicate group collapsed on: a shared identifier, the same product, or the same brand+model bought on the same day.',
});

/**
 * A group of owned units that look like the same physical thing.
 *
 * SUGGESTIONS ONLY — two rows that look identical to a query are sometimes two
 * real things (you own two of the same mug), and there is no evidence in the
 * database that can tell them apart. Merging is always a user decision.
 */
@ObjectType()
export class ItemDuplicateGroupType {
  @Field(() => ItemDuplicateReasonEnum)
  reason!: ObjectDuplicateReason;

  /** The shared normalized value the group collapsed on. */
  @Field(() => String)
  value!: string;

  @Field(() => [ItemType])
  items!: ItemType[];

  /**
   * Units sharing `value` in total, before truncation.
   *
   * `items` is capped, so a placeholder SKU written onto 900 rows by a bad
   * import arrives as six members and `totalItems: 900` — the UI has to say so
   * rather than imply the group is small.
   */
  @Field(() => Int)
  totalItems!: number;
}
