import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

import { minorUnitsTransformer } from './minorUnits';

export type ReceiptExtractionState = 'pending' | 'extracted' | 'failed' | 'manual' | 'not_applicable';
export type ReceiptChannel = 'online' | 'in_store' | 'app' | 'phone' | 'unknown';

/**
 * Purchase evidence. Mirrors migration
 * 20260803223019_create_receipts_and_line_items.
 *
 * The chain is receipt (evidence) -> line item (claim) -> ci.inventory (owned
 * unit). Before this table the importer flattened a whole purchase into ONE
 * inventory row named after the order, so a four-item Amazon order became one
 * "thing", tax and shipping were lost, and nothing could answer "where did this
 * come from?".
 *
 * Money is integer minor units throughout — see {@link minorUnitsTransformer}.
 */
@Entity({ schema: 'ci', name: 'receipts' })
export class ReceiptEntity {
  @PrimaryColumn('uuid', { name: 'receipt_id' })
  id!: string;

  @Column('uuid', { name: 'user_id' })
  userId!: string;

  @Column('uuid', { name: 'owner_user_id', nullable: true })
  ownerUserId!: string | null;

  /** Merchant as printed. Always populated when known, even if unresolved in the graph. */
  @Column('text', { name: 'merchant_name', nullable: true })
  merchantName!: string | null;

  /** Graph Organization for the merchant. */
  @Column('uuid', { name: 'merchant_entity_id', nullable: true })
  merchantEntityId!: string | null;

  /**
   * Graph Location where the purchase happened. The "known place" half of
   * object identification: an in-store purchase pins the receipt and everything
   * on it to a place, which is the strongest prior an image-based resolver has.
   */
  @Column('uuid', { name: 'place_entity_id', nullable: true })
  placeEntityId!: string | null;

  @Column('timestamptz', { name: 'purchased_at', nullable: true })
  purchasedAt!: Date | null;

  @Column('text', { name: 'currency', nullable: true })
  currency!: string | null;

  @Column('bigint', { name: 'subtotal_minor', nullable: true, transformer: minorUnitsTransformer })
  subtotalMinor!: number | null;

  @Column('bigint', { name: 'tax_minor', nullable: true, transformer: minorUnitsTransformer })
  taxMinor!: number | null;

  @Column('bigint', { name: 'tip_minor', nullable: true, transformer: minorUnitsTransformer })
  tipMinor!: number | null;

  @Column('bigint', { name: 'shipping_minor', nullable: true, transformer: minorUnitsTransformer })
  shippingMinor!: number | null;

  @Column('bigint', { name: 'discount_minor', nullable: true, transformer: minorUnitsTransformer })
  discountMinor!: number | null;

  @Column('bigint', { name: 'total_minor', nullable: true, transformer: minorUnitsTransformer })
  totalMinor!: number | null;

  @Column('text', { name: 'payment_method', nullable: true })
  paymentMethod!: string | null;

  /** Last four digits ONLY, for user-facing disambiguation. Never a full card number. */
  @Column('text', { name: 'payment_last4', nullable: true })
  paymentLast4!: string | null;

  @Column('text', { name: 'order_number', nullable: true })
  orderNumber!: string | null;

  @Column('text', { name: 'channel', nullable: true })
  channel!: ReceiptChannel | null;

  /** The receipt document (PDF/photo/email body) as a ci.content id. No FK — content is purgeable. */
  @Column('uuid', { name: 'document_content_id', nullable: true })
  documentContentId!: string | null;

  @Column('uuid', { name: 'source_file_id', nullable: true })
  sourceFileId!: string | null;

  @Column('text', { name: 'source_message_id', nullable: true })
  sourceMessageId!: string | null;

  /** 'pending' rows are the drain queue for the extraction listener. */
  @Column('text', { name: 'extraction_state', default: 'pending' })
  extractionState!: ReceiptExtractionState;

  @Column('real', { name: 'extraction_confidence', nullable: true })
  extractionConfidence!: number | null;

  @Column('text', { name: 'extraction_model', nullable: true })
  extractionModel!: string | null;

  @Column('text', { name: 'extraction_error', nullable: true })
  extractionError!: string | null;

  /** OCR/text layer, kept so re-extraction with a better model needs no binary. */
  @Column('text', { name: 'raw_text', nullable: true })
  rawText!: string | null;

  @Column('uuid', { name: 'event_id', nullable: true })
  eventId!: string | null;

  @Column('jsonb', { name: 'metadata', default: {} })
  metadata!: Record<string, unknown>;

  @Column('text', { name: 'source_type', nullable: true })
  sourceType!: string | null;

  @Column('text', { name: 'source_system', nullable: true })
  sourceSystem!: string | null;

  @Column('text', { name: 'source_id', nullable: true })
  sourceId!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}

export type Receipt = Readonly<ReceiptEntity>;
