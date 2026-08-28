import { Field, Int, ObjectType } from '@nestjs/graphql';

import type { PlaceMergeCounts } from '@ci/domains/memory';

import { PlaceType } from './PlaceType';

/**
 * What a place merge re-pointed, per table, so the UI can say what moved.
 * Mirrors the counts recorded in the `ci.entity_merges` audit row.
 */
@ObjectType()
export class PlaceMergeCountsType {
  @Field(() => Int)
  events!: number;

  @Field(() => Int)
  positions!: number;

  @Field(() => Int)
  childPlaces!: number;

  @Field(() => Int)
  objects!: number;

  @Field(() => Int)
  observations!: number;

  @Field(() => Int)
  receipts!: number;

  @Field(() => Int)
  identifiers!: number;

  @Field(() => Int)
  relationshipsFrom!: number;

  @Field(() => Int)
  relationshipsTo!: number;

  @Field(() => Int)
  relationshipsDropped!: number;

  @Field(() => Int)
  searchRowsDeleted!: number;

  @Field(() => Int)
  tagLinksMoved!: number;

  static toType(counts: PlaceMergeCounts): PlaceMergeCountsType {
    return { ...counts };
  }
}

@ObjectType()
export class MergePlacesPayload {
  @Field()
  success!: boolean;

  /** The surviving canonical place after the merge. */
  @Field(() => PlaceType, { nullable: true })
  place?: PlaceType;

  @Field(() => PlaceMergeCountsType, { nullable: true })
  counts?: PlaceMergeCountsType;
}
