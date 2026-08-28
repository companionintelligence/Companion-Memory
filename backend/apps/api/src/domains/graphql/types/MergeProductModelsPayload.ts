import { Field, Int, ObjectType } from '@nestjs/graphql';

import type { ProductMergeCounts } from '@ci/domains/memory';

import { ProductModelType } from './ProductModelType';

/** What a catalog-model merge re-pointed, per table. */
@ObjectType()
export class ProductMergeCountsType {
  @Field(() => Int)
  identifiers!: number;

  @Field(() => Int)
  receiptLineItems!: number;

  /** Owned units whose `productId` moved onto the target. */
  @Field(() => Int)
  objectProduct!: number;

  @Field(() => Int)
  observations!: number;

  static toType(counts: ProductMergeCounts): ProductMergeCountsType {
    return {
      identifiers: counts.identifiers,
      receiptLineItems: counts.receiptLineItems,
      objectProduct: counts.objectProduct,
      observations: counts.observations,
    };
  }
}

@ObjectType()
export class MergeProductModelsPayload {
  @Field()
  success!: boolean;

  /** The surviving canonical model after the merge. */
  @Field(() => ProductModelType, { nullable: true })
  product?: ProductModelType;

  @Field(() => ProductMergeCountsType, { nullable: true })
  counts?: ProductMergeCountsType;
}
