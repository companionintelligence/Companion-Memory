import { Field, Int, ObjectType } from '@nestjs/graphql';

import type { ObjectMergeCounts } from '@ci/domains/memory';

import { ItemType } from './ItemType';

/**
 * What a unit merge re-pointed, per table, so the UI can say what actually
 * moved rather than "merged" and nothing else. Mirrors the counts recorded in
 * the `ci.entity_merges` audit row.
 */
@ObjectType()
export class ObjectMergeCountsType {
  @Field(() => Int)
  identifiers!: number;

  @Field(() => Int)
  observations!: number;

  /** Child units whose parent pointer moved onto the target. */
  @Field(() => Int)
  objectParent!: number;

  /** Units related to a source, re-pointed at the target. */
  @Field(() => Int)
  objectRelated!: number;

  @Field(() => Int)
  receiptLineItems!: number;

  /** Search rows deleted for the tombstoned sources. */
  @Field(() => Int)
  searchRowsDeleted!: number;

  @Field(() => Int)
  tagLinksMoved!: number;

  static toType(counts: ObjectMergeCounts): ObjectMergeCountsType {
    return {
      identifiers: counts.identifiers,
      observations: counts.observations,
      objectParent: counts.objectParent,
      objectRelated: counts.objectRelated,
      receiptLineItems: counts.receiptLineItems,
      searchRowsDeleted: counts.searchRowsDeleted,
      tagLinksMoved: counts.tagLinksMoved,
    };
  }
}

@ObjectType()
export class MergeItemsPayload {
  @Field()
  success!: boolean;

  /** The surviving canonical unit after the merge. */
  @Field(() => ItemType, { nullable: true })
  item?: ItemType;

  @Field(() => ObjectMergeCountsType, { nullable: true })
  counts?: ObjectMergeCountsType;
}
