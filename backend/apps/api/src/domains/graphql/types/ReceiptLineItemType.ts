import { Field, Float, ID, Int, ObjectType } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

import { type ReceiptLineItem } from '@ci/domains/memory';

import { GlobalUID } from './GlobalUID';

/**
 * One line on a receipt: what was bought, how many, for how much.
 *
 * `lineNumber` is 1-based and STABLE — it is half of the natural key
 * `(receipt_id, line_number)`, so re-extracting the same document updates the
 * line in place instead of forking it.
 *
 * Money is integer MINOR units of `currency`. `quantity` is fractional on
 * purpose: 1.5 kg of coffee is a real line.
 */
@ObjectType()
export class ReceiptLineItemType {
  __source!: ReceiptLineItem;

  @Field(() => ID)
  id!: string;

  /** The receipt this line belongs to, as a global id. */
  @Field(() => ID)
  receiptId!: string;

  @Field(() => Int)
  lineNumber!: number;

  @Field(() => String)
  description!: string;

  @Field(() => Float)
  quantity!: number;

  @Field(() => Int, { nullable: true, description: 'Integer MINOR units of `currency`.' })
  unitPriceMinor!: number | null;

  @Field(() => Int, { nullable: true, description: 'Integer MINOR units of `currency`.' })
  totalPriceMinor!: number | null;

  @Field(() => String, { nullable: true })
  currency!: string | null;

  @Field(() => String, { nullable: true })
  brand!: string | null;

  @Field(() => String, { nullable: true })
  modelNumber!: string | null;

  @Field(() => String, { nullable: true })
  category!: string | null;

  @Field(() => Boolean, {
    description: 'False for ebooks, subscriptions and gift cards. Only physical lines mint owned units.',
  })
  isPhysical!: boolean;

  /** The catalog model this line resolved to, as a global id. */
  @Field(() => ID, { nullable: true })
  productId!: string | null;

  /** The owned unit minted from this line, as a global id. */
  @Field(() => ID, { nullable: true })
  mintedObjectId!: string | null;

  @Field(() => GraphQLJSONObject)
  metadata!: Record<string, unknown>;

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => Date)
  updatedAt!: Date;

  static toType(line: ReceiptLineItem): ReceiptLineItemType {
    return {
      __source: line,
      id: GlobalUID.encode('receipt-line-item', line.id),
      receiptId: GlobalUID.encode('receipt', line.receiptId),
      lineNumber: line.lineNumber,
      description: line.description,
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      totalPriceMinor: line.totalPriceMinor,
      currency: line.currency,
      brand: line.brand,
      modelNumber: line.modelNumber,
      category: line.category,
      isPhysical: line.isPhysical,
      productId: line.productId == null ? null : GlobalUID.encode('product', line.productId),
      mintedObjectId: line.mintedObjectId == null ? null : GlobalUID.encode('item', line.mintedObjectId),
      metadata: line.metadata ?? {},
      createdAt: line.createdAt,
      updatedAt: line.updatedAt,
    };
  }
}
