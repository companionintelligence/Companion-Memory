import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

import { minorUnitsTransformer } from './minorUnits';

/**
 * One product claim on a receipt. Mirrors migration
 * 20260803223019_create_receipts_and_line_items.
 *
 * The unit of object minting: a four-item order produces four lines and up to
 * four ci.inventory rows, replacing the single order-named row the importer
 * writes today. `(receiptId, lineNumber)` is the natural key, so re-extracting
 * the same document updates lines in place instead of appending a second copy.
 */
@Entity({ schema: 'ci', name: 'receipt_line_items' })
export class ReceiptLineItemEntity {
  @PrimaryColumn('uuid', { name: 'line_item_id' })
  id!: string;

  @Column('uuid', { name: 'receipt_id' })
  receiptId!: string;

  @Column('uuid', { name: 'user_id' })
  userId!: string;

  @Column('uuid', { name: 'owner_user_id', nullable: true })
  ownerUserId!: string | null;

  /** Position on the receipt; half of the re-extraction idempotency key. */
  @Column('int', { name: 'line_number' })
  lineNumber!: number;

  @Column('text', { name: 'description' })
  description!: string;

  /**
   * NUMERIC(12,3) — fractional quantities are real (1.5 kg of coffee).
   * node-postgres returns numeric as a string, so this is parsed explicitly
   * rather than declared `number` and quietly lied about.
   */
  @Column('numeric', {
    name: 'quantity',
    precision: 12,
    scale: 3,
    default: 1,
    transformer: {
      from: (value: string | number | null): number => (value == null ? 1 : Number(value)),
      to: (value: number | null | undefined): number => value ?? 1,
    },
  })
  quantity!: number;

  @Column('bigint', { name: 'unit_price_minor', nullable: true, transformer: minorUnitsTransformer })
  unitPriceMinor!: number | null;

  @Column('bigint', { name: 'total_price_minor', nullable: true, transformer: minorUnitsTransformer })
  totalPriceMinor!: number | null;

  @Column('text', { name: 'currency', nullable: true })
  currency!: string | null;

  /** Resolved catalog product, when the line could be identified. */
  @Column('uuid', { name: 'product_id', nullable: true })
  productId!: string | null;

  @Column('text', { name: 'brand', nullable: true })
  brand!: string | null;

  @Column('text', { name: 'model_number', nullable: true })
  modelNumber!: string | null;

  @Column('text', { name: 'category', nullable: true })
  category!: string | null;

  /**
   * Whether this line is a physical good. A Kindle book and a toaster both
   * appear on an Amazon receipt; only one becomes an owned thing. Stored per
   * line rather than sniffed at read time, so the classification is auditable
   * and a user can correct it.
   */
  @Column('boolean', { name: 'is_physical', default: true })
  isPhysical!: boolean;

  /** The ci.inventory row minted from this line, if any. */
  @Column('uuid', { name: 'minted_object_id', nullable: true })
  mintedObjectId!: string | null;

  @Column('jsonb', { name: 'metadata', default: {} })
  metadata!: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}

export type ReceiptLineItem = Readonly<ReceiptLineItemEntity>;
