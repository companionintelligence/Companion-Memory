import { Field, Float, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

import type { Receipt, ReceiptChannel, ReceiptExtractionState } from '@ci/domains/memory';

import { EntityTagType } from './EntityTagType';
import { GlobalUID } from './GlobalUID';
import { Node } from './Node';
import { ReceiptLineItemType } from './ReceiptLineItemType';
import { Taggable } from './Taggable';

/**
 * How far extraction got on the document behind a receipt.
 *
 * `satisfies Record<Uppercase<T>, T>` for the same reason the physical-property
 * enums are: the CHECK constraint, the domain union and this enum widen
 * together or not at all.
 */
export const ReceiptExtractionStateEnum = {
  PENDING: 'pending',
  EXTRACTED: 'extracted',
  FAILED: 'failed',
  MANUAL: 'manual',
  NOT_APPLICABLE: 'not_applicable',
} as const satisfies Record<Uppercase<ReceiptExtractionState>, ReceiptExtractionState>;

export type ReceiptExtractionStateEnum =
  (typeof ReceiptExtractionStateEnum)[keyof typeof ReceiptExtractionStateEnum];

registerEnumType(ReceiptExtractionStateEnum, {
  name: 'ReceiptExtractionState',
  description: 'How far structured extraction got on the receipt document.',
});

export const ReceiptChannelEnum = {
  ONLINE: 'online',
  IN_STORE: 'in_store',
  APP: 'app',
  PHONE: 'phone',
  UNKNOWN: 'unknown',
} as const satisfies Record<Uppercase<ReceiptChannel>, ReceiptChannel>;

export type ReceiptChannelEnum = (typeof ReceiptChannelEnum)[keyof typeof ReceiptChannelEnum];

registerEnumType(ReceiptChannelEnum, {
  name: 'ReceiptChannel',
  description: 'Where the purchase happened.',
});

/**
 * Purchase evidence: a receipt header, and (through `lineItems`) what was on it.
 *
 * A receipt is EVIDENCE, not an owned thing. It is what justifies minting an owned
 * unit — the acquisition provenance an {@link ItemType} points back at through
 * `acquisition` — and it stays around after the thing is gone, which is why it
 * is a first-class record rather than a bag of fields on the item.
 *
 * Money is integer MINOR units of `currency` throughout. `paymentLast4` is the
 * only card data stored, ever.
 */
@ObjectType({ implements: () => [Node, Taggable] })
export class ReceiptType implements Node, Taggable {
  __typename = ReceiptType.name;

  __source!: Receipt;

  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  merchantName!: string | null;

  /** The ci.entities node for the merchant, when it was resolved. */
  @Field(() => ID, { nullable: true })
  merchantEntityId!: string | null;

  /** The place the purchase happened, as a global place id. */
  @Field(() => ID, { nullable: true })
  placeEntityId!: string | null;

  @Field(() => Date, { nullable: true })
  purchasedAt!: Date | null;

  @Field(() => String, { nullable: true })
  currency!: string | null;

  @Field(() => Int, { nullable: true, description: 'Integer MINOR units of `currency`.' })
  subtotalMinor!: number | null;

  @Field(() => Int, { nullable: true, description: 'Integer MINOR units of `currency`.' })
  taxMinor!: number | null;

  @Field(() => Int, { nullable: true, description: 'Integer MINOR units of `currency`.' })
  tipMinor!: number | null;

  @Field(() => Int, { nullable: true, description: 'Integer MINOR units of `currency`.' })
  shippingMinor!: number | null;

  @Field(() => Int, { nullable: true, description: 'Integer MINOR units of `currency`.' })
  discountMinor!: number | null;

  @Field(() => Int, { nullable: true, description: 'Integer MINOR units of `currency`.' })
  totalMinor!: number | null;

  @Field(() => String, { nullable: true })
  paymentMethod!: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'Last four digits only. A full card number is never stored.',
  })
  paymentLast4!: string | null;

  @Field(() => String, { nullable: true })
  orderNumber!: string | null;

  @Field(() => ReceiptChannelEnum, { nullable: true })
  channel!: ReceiptChannel | null;

  /** ci.content row holding the receipt document (scan, PDF, email body). */
  @Field(() => ID, { nullable: true })
  documentContentId!: string | null;

  @Field(() => ID, { nullable: true })
  sourceFileId!: string | null;

  @Field(() => String, { nullable: true })
  sourceMessageId!: string | null;

  @Field(() => ReceiptExtractionStateEnum)
  extractionState!: ReceiptExtractionState;

  @Field(() => Float, { nullable: true })
  extractionConfidence!: number | null;

  @Field(() => String, { nullable: true })
  extractionModel!: string | null;

  @Field(() => String, { nullable: true })
  extractionError!: string | null;

  /** The purchase event this receipt was attached to, as a global event id. */
  @Field(() => ID, { nullable: true })
  eventId!: string | null;

  @Field(() => GraphQLJSONObject)
  metadata!: Record<string, unknown>;

  // --- Provenance triple ---------------------------------------------------

  @Field(() => String, { nullable: true })
  sourceType!: string | null;

  @Field(() => String, { nullable: true })
  sourceSystem!: string | null;

  @Field(() => String, { nullable: true })
  sourceId!: string | null;

  /** The lines on this receipt, in line order. Hydrated by the resolver. */
  @Field(() => [ReceiptLineItemType])
  lineItems!: ReceiptLineItemType[];

  @Field(() => [EntityTagType])
  tags!: EntityTagType[];

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => Date)
  updatedAt!: Date;

  static toType(receipt: Receipt): ReceiptType {
    return {
      __typename: ReceiptType.name,
      __source: receipt,
      id: GlobalUID.encode('receipt', receipt.id),
      merchantName: receipt.merchantName,
      merchantEntityId:
        receipt.merchantEntityId == null ? null : GlobalUID.encode('person', receipt.merchantEntityId),
      placeEntityId: receipt.placeEntityId == null ? null : GlobalUID.encode('place', receipt.placeEntityId),
      purchasedAt: receipt.purchasedAt,
      currency: receipt.currency,
      subtotalMinor: receipt.subtotalMinor,
      taxMinor: receipt.taxMinor,
      tipMinor: receipt.tipMinor,
      shippingMinor: receipt.shippingMinor,
      discountMinor: receipt.discountMinor,
      totalMinor: receipt.totalMinor,
      paymentMethod: receipt.paymentMethod,
      paymentLast4: receipt.paymentLast4,
      orderNumber: receipt.orderNumber,
      channel: receipt.channel,
      documentContentId:
        receipt.documentContentId == null ? null : GlobalUID.encode('content', receipt.documentContentId),
      sourceFileId: receipt.sourceFileId == null ? null : GlobalUID.encode('file', receipt.sourceFileId),
      sourceMessageId: receipt.sourceMessageId,
      extractionState: receipt.extractionState,
      extractionConfidence: receipt.extractionConfidence,
      extractionModel: receipt.extractionModel,
      extractionError: receipt.extractionError,
      eventId: receipt.eventId == null ? null : GlobalUID.encode('event', receipt.eventId),
      metadata: receipt.metadata ?? {},
      sourceType: receipt.sourceType,
      sourceSystem: receipt.sourceSystem,
      sourceId: receipt.sourceId,

      lineItems: [], // Hydrated by resolver
      tags: [], // Hydrated by resolver
      createdAt: receipt.createdAt,
      updatedAt: receipt.updatedAt,
    };
  }
}
