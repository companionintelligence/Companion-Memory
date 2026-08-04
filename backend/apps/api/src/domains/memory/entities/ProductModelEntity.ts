import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

import { minorUnitsTransformer } from './minorUnits';

/**
 * A catalog product model — the thing a GTIN names ("iPhone 15 Pro 256GB Blue
 * Titanium"). Mirrors migration 20260803223013_create_product_models.
 *
 * The other half of the product/instance split: `ItemEntity` (ci.inventory)
 * holds the owned UNITS, this holds what they are instances of. Before this
 * table, buying three of the same headphones produced three unrelated inventory
 * rows with the brand/model strings duplicated three times and nowhere to hang
 * the canonical barcode, spec sheet, MSRP or manual.
 */
@Entity({ schema: 'ci', name: 'product_models' })
export class ProductModelEntity {
  @PrimaryColumn('uuid', { name: 'product_id' })
  id!: string;

  @Column('uuid', { name: 'user_id' })
  userId!: string;

  @Column('uuid', { name: 'owner_user_id', nullable: true })
  ownerUserId!: string | null;

  /** Graph mirror (ci.entities, entity_type 'Product'). Written lazily, never on bulk ingest. */
  @Column('uuid', { name: 'product_entity_id', nullable: true })
  productEntityId!: string | null;

  @Column('text', { name: 'title' })
  title!: string;

  @Column('text', { name: 'brand', nullable: true })
  brand!: string | null;

  @Column('text', { name: 'manufacturer', nullable: true })
  manufacturer!: string | null;

  @Column('text', { name: 'model_number', nullable: true })
  modelNumber!: string | null;

  @Column('text', { name: 'category', nullable: true })
  category!: string | null;

  @Column('text', { name: 'subcategory', nullable: true })
  subcategory!: string | null;

  @Column('text', { name: 'product_type', nullable: true })
  productType!: string | null;

  @Column('text', { name: 'description', nullable: true })
  description!: string | null;

  /**
   * Variant AXES only — the attributes that distinguish this model from a
   * sibling ({color, capacity, size}). Kept apart from `spec` so that
   * "which variant is this?" never has to sift descriptive specs.
   */
  @Column('jsonb', { name: 'variant_attributes', default: {} })
  variantAttributes!: Record<string, unknown>;

  /** Descriptive specifications that do not distinguish variants. */
  @Column('jsonb', { name: 'spec', default: {} })
  spec!: Record<string, unknown>;

  /** Integer minor units of `currency` — see minorUnitsTransformer for why not DECIMAL. */
  @Column('bigint', { name: 'msrp_minor', nullable: true, transformer: minorUnitsTransformer })
  msrpMinor!: number | null;

  @Column('text', { name: 'currency', nullable: true })
  currency!: string | null;

  /** Stock image as a ci.content id. No FK — content is purgeable. */
  @Column('uuid', { name: 'image_content_id', nullable: true })
  imageContentId!: string | null;

  @Column('uuid', { name: 'manual_content_ids', array: true, nullable: true })
  manualContentIds!: string[] | null;

  @Column('boolean', { name: 'is_digital', default: false })
  isDigital!: boolean;

  /**
   * 1.0 = user-entered or barcode-scanned; ~0.85 structured feed; ~0.7
   * receipt-derived; ~0.4 guessed from a photo. 1.0 reads as ground truth to
   * HBPE and RAG, so never write it for an inferred row.
   */
  @Column('real', { name: 'identity_confidence', default: 1.0 })
  identityConfidence!: number;

  /** Merge tombstone. Non-NULL means this row lost a merge; follow the pointer. */
  @Column('uuid', { name: 'merged_into_product_id', nullable: true })
  mergedIntoProductId!: string | null;

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

export type ProductModel = Readonly<ProductModelEntity>;
