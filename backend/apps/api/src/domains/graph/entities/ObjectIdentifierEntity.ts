import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

import type { ObjectIdentifierNamespace } from '../utils/normalizeObjectIdentifier';

/** Which table `subjectId` points into. */
export type ObjectIdentifierSubjectType = 'product_model' | 'object_instance';

/**
 * Normalized identifier -> physical-thing lookup. Mirrors migration
 * 20260803223016_create_object_identifiers.
 *
 * The object-side twin of {@link EntityIdentifierEntity}, deliberately a
 * separate table: that one resolves people by email/phone/name, this one
 * resolves things by barcode. Sharing a unique index across two unrelated
 * resolution domains would mean a GTIN and a phone number could collide.
 *
 * SUBJECT-POLYMORPHIC. A GTIN identifies a product MODEL (every unit shares
 * it); a serial identifies one owned INSTANCE. `subjectId` therefore has no FK
 * — it points at `ci.product_models.product_id` or `ci.inventory.object_id`
 * depending on `subjectType`, and keeping the referential integrity is
 * ObjectMergeService's job, not the database's.
 *
 * `valueNormalized` is produced by `normalizeObjectIdentifier` and by nothing
 * else — see that module for why the rule must never be reimplemented in SQL.
 */
@Entity({ schema: 'ci', name: 'object_identifiers' })
export class ObjectIdentifierEntity {
  @PrimaryColumn({ name: 'identifier_id', type: 'uuid' })
  id!: string;

  @Column({ name: 'owner_user_id', type: 'uuid' })
  ownerUserId!: string;

  @Column({ name: 'subject_type', type: 'text' })
  subjectType!: ObjectIdentifierSubjectType;

  @Column({ name: 'subject_id', type: 'uuid' })
  subjectId!: string;

  @Column({ type: 'text' })
  namespace!: ObjectIdentifierNamespace;

  @Column({ name: 'value_normalized', type: 'text' })
  valueNormalized!: string;

  /** Exactly what the source said, pre-normalization. Never matched against. */
  @Column({ name: 'value_raw', type: 'text', nullable: true })
  valueRaw!: string | null;

  /**
   * Scope for namespaces that are not globally unique (serial, sku); '' for
   * gtin/isbn/asin/imei/vin. Part of the claim uniqueness key, and STABLE —
   * see `computeQualifier`.
   */
  @Column({ type: 'text', default: '' })
  qualifier!: string;

  /** Confidence in the CLAIM. 1.0 = user-entered or scanned; lower = derived. */
  @Column({ type: 'real', default: 1.0 })
  confidence!: number;

  /** Provenance of the assertion (user, barcode_scan, receipt_ocr, vision, importer:amazon). */
  @Column({ type: 'text', nullable: true })
  source!: string | null;

  /** The identifier shown first for this subject (service-enforced, one per subject). */
  @Column({ name: 'is_primary', type: 'boolean', default: false })
  isPrimary!: boolean;

  @Column({ type: 'jsonb', default: {} })
  metadata!: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

export type ObjectIdentifier = Readonly<ObjectIdentifierEntity>;
