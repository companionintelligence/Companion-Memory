import { AfterLoad, Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, Point } from 'typeorm';

import type { AcquisitionMethod, UnitSystem } from '../physicalProperties';

import { numericMeasurementTransformer } from './numericMeasurement';

export type ObjectCondition = 'new' | 'like_new' | 'good' | 'fair' | 'poor' | 'broken' | 'n/a';

/**
 * Ownership state. Mirrors the objects_lifecycle_state_check constraint —
 * widening one without the other fails the write, so change both together.
 */
export type ObjectLifecycleState =
  | 'active'
  | 'stored'
  | 'lent_out'
  | 'lost'
  | 'disposed'
  | 'consumed'
  | 'returned'
  | 'archived';

/** How this unit's identity was established. Mirrors objects_identity_method_check. */
export type ObjectIdentityMethod = 'user' | 'barcode' | 'receipt' | 'vision' | 'import' | 'inferred';

@Entity({ schema: 'ci', name: 'objects' })
export class ItemEntity {
  @PrimaryColumn('uuid', { name: 'object_id' })
  id!: string;

  /**
   * CTI discriminator pin (migration 20260811061402): always 'Item'. Pairs
   * with object_id in the composite FK to ci.entities(entity_id, entity_type)
   * so a detail row can never point at a base row of another type. DEFAULTed
   * and CHECKed in the schema; never written by the application.
   */
  @Column({ type: 'text', name: 'entity_type', default: 'Item', insert: false, update: false })
  entityType!: string;

  // name/description live ONLY on the CTI base row (ci.entities, see
  // ItemBaseEntity); the egress type composes them back on via toEgressType.

  @Column('text', { name: 'category', nullable: true })
  category!: string | null;

  @Column('text', { name: 'subcategory', nullable: true })
  subcategory!: string | null;

  @Column('text', { name: 'brand', nullable: true })
  brand!: string | null;

  @Column('text', { name: 'model', nullable: true })
  model!: string | null;

  @Column('jsonb', { name: 'identifier_codes', default: {} })
  identifierCodes!: Record<string, unknown>;

  @Column('decimal', { name: 'purchase_price', precision: 10, scale: 2, nullable: true })
  purchasePrice!: number | null;

  @Column('decimal', { name: 'current_value', precision: 10, scale: 2, nullable: true })
  currentValue!: number | null;

  @Column('text', { name: 'currency', default: 'USD' })
  currency!: string;

  @Column('timestamptz', { name: 'acquired_at', nullable: true })
  acquiredAt!: Date | null;

  @Column('timestamptz', { name: 'warranty_expires_at', nullable: true })
  warrantyExpiresAt!: Date | null;

  @Column('timestamptz', { name: 'disposed_at', nullable: true })
  disposedAt!: Date | null;

  @Column('text', { name: 'disposal_method', nullable: true })
  disposalMethod!: string | null;

  @Column('timestamptz', { name: 'last_used_at', nullable: true })
  lastUsedAt!: Date | null;

  @Column('text', { name: 'usage_frequency', nullable: true })
  usageFrequency!: string | null;

  @Column('int', { name: 'usage_count', default: 0 })
  usageCount!: number;

  @Column('text', { name: 'location_description', nullable: true })
  locationDescription!: string | null;

  @Column('text', { name: 'storage_location', nullable: true })
  storageLocation!: string | null;

  @Column('geography', {
    name: 'current_location_coordinates',
    nullable: true,
    spatialFeatureType: 'Point',
    srid: 4326,
  })
  currentLocationCoordinates!: Point | null;

  @Column('text', { name: 'condition', nullable: true })
  condition!: ObjectCondition | null;

  @Column('boolean', { name: 'maintenance_needed', default: false })
  maintenanceNeeded!: boolean;

  @Column('jsonb', { name: 'maintenance_notes', default: {} })
  maintenanceNotes!: Record<string, unknown>;

  @Column('boolean', { name: 'is_digital', default: false })
  isDigital!: boolean;

  @Column('text', { name: 'digital_location', nullable: true })
  digitalLocation!: string | null;

  @Column('text', { name: 'license_key', nullable: true })
  licenseKey!: string | null;

  @Column('boolean', { name: 'is_subscription', default: false })
  isSubscription!: boolean;

  @Column('timestamptz', { name: 'subscription_expiration_date', nullable: true })
  subscriptionExpirationDate!: Date | null;

  @Column('jsonb', { name: 'metadata', default: {}, nullable: true })
  metadata!: Record<string, unknown> | null;

  @Column('text', { name: 'user_id' })
  userId!: string;

  @Column('text', { name: 'owner_user_id', nullable: true })
  ownerUserId!: string | null;

  // Provenance triple — the stable key capture sources carry. Lets the importer
  // route timeline items into ci.objects and re-ingest idempotently (paired with
  // the objects_source_triple_uniq partial unique index).
  @Column('text', { name: 'source_type', nullable: true })
  sourceType!: string | null;

  @Column('text', { name: 'source_system', nullable: true })
  sourceSystem!: string | null;

  @Column('text', { name: 'source_id', nullable: true })
  sourceId!: string | null;

  // ---------------------------------------------------------------------------
  // Object identity (migration 20260803223025_extend_inventory_object_identity)
  //
  // ci.objects stays the table of record for OWNED UNITS; these columns give
  // a unit its catalog model, its purchase provenance, an honest lifecycle, and
  // a merge tombstone — the four things it could not express before.
  // ---------------------------------------------------------------------------

  /** The catalog model this unit is an instance of. NULL = unit is real, product not yet known. */
  @Column('uuid', { name: 'product_id', nullable: true })
  productId!: string | null;

  @Column('uuid', { name: 'acquisition_receipt_id', nullable: true })
  acquisitionReceiptId!: string | null;

  /** The receipt line this unit was minted from — the back half of the provenance chain. */
  @Column('uuid', { name: 'acquisition_line_item_id', nullable: true })
  acquisitionLineItemId!: string | null;

  /**
   * Queryable ownership state. Supersedes disposedAt/disposalMethod as the
   * filter (those keep the when and the how, and are not deprecated).
   */
  @Column('text', { name: 'lifecycle_state', default: 'active' })
  lifecycleState!: ObjectLifecycleState;

  @Column('int', { name: 'quantity', default: 1 })
  quantity!: number;

  /**
   * 1.0 = user-entered or barcode-scanned; ~0.7 receipt-derived; ~0.4
   * vision-guessed. 1.0 reads as ground truth to HBPE and RAG, so never write
   * it for an inferred unit.
   */
  @Column('real', { name: 'identity_confidence', default: 1.0 })
  identityConfidence!: number;

  @Column('text', { name: 'identity_method', nullable: true })
  identityMethod!: ObjectIdentityMethod | null;

  /** Last confirmed sighting, denormalized from ci.object_observations for sort/filter. */
  @Column('timestamptz', { name: 'last_seen_at', nullable: true })
  lastSeenAt!: Date | null;

  @Column('uuid', { name: 'last_seen_place_entity_id', nullable: true })
  lastSeenPlaceEntityId!: string | null;

  /** Merge tombstone. Non-NULL means this row lost a merge; every read filters IS NULL. */
  @Column('uuid', { name: 'merged_into_object_id', nullable: true })
  mergedIntoObjectId!: string | null;

  // ---------------------------------------------------------------------------
  // Physical properties (migration 20260818020839_expand_inventory_physical_properties)
  //
  // What the object IS, as opposed to what it cost. Every measurement is stored
  // in one canonical unit and is strictly positive — NULL is the only way to
  // say "unmeasured". Callers never convert: `normalizePhysicalProperties` in
  // ../physicalProperties.ts is the single place units are resolved, and it
  // enforces the same bounds as the CHECK constraints.
  //
  // NUMERIC comes back from node-postgres as a string, so these carry
  // numericMeasurementTransformer to make the declared `number` true — see the
  // purchasePrice/currentValue columns above, which predate it and still lie.
  // ---------------------------------------------------------------------------

  /** Longest dimension in MILLIMETRES. */
  @Column('numeric', {
    name: 'length_mm',
    precision: 14,
    scale: 3,
    nullable: true,
    transformer: numericMeasurementTransformer,
  })
  lengthMm!: number | null;

  /** Width in MILLIMETRES. */
  @Column('numeric', {
    name: 'width_mm',
    precision: 14,
    scale: 3,
    nullable: true,
    transformer: numericMeasurementTransformer,
  })
  widthMm!: number | null;

  /** Height in MILLIMETRES. */
  @Column('numeric', {
    name: 'height_mm',
    precision: 14,
    scale: 3,
    nullable: true,
    transformer: numericMeasurementTransformer,
  })
  heightMm!: number | null;

  /** As-owned mass in GRAMS. */
  @Column('numeric', {
    name: 'mass_g',
    precision: 16,
    scale: 3,
    nullable: true,
    transformer: numericMeasurementTransformer,
  })
  massG!: number | null;

  /** Capacity — what it HOLDS — in MILLILITRES, not the bounding volume. */
  @Column('numeric', {
    name: 'volume_ml',
    precision: 16,
    scale: 3,
    nullable: true,
    transformer: numericMeasurementTransformer,
  })
  volumeMl!: number | null;

  /** Display preference the measurements were entered in. Presentation only. */
  @Column('text', { name: 'unit_system', nullable: true })
  unitSystem!: UnitSystem | null;

  /** Lowercase colour names, dominant first. */
  @Column('text', { name: 'colors', array: true, nullable: true })
  colors!: string[] | null;

  /** Dominant colour as lowercase `#rrggbb`, for UI swatches. */
  @Column('text', { name: 'color_hex', nullable: true })
  colorHex!: string | null;

  /** Lowercase material names — what the object is made of. */
  @Column('text', { name: 'materials', array: true, nullable: true })
  materials!: string[] | null;

  /** `{material: fraction}`, fractions in (0,1] summing to at most 1. `{}` = proportions unknown. */
  @Column('jsonb', { name: 'composition', default: {} })
  composition!: Record<string, number>;

  /** How it came to be owned — a purchase and a gift mean different things by `acquiredAt`. */
  @Column('text', { name: 'acquisition_method', nullable: true })
  acquisitionMethod!: AcquisitionMethod | null;

  /** Seller/giver as free text, for counterparties not (yet) resolved to a graph entity. */
  @Column('text', { name: 'acquired_from', nullable: true })
  acquiredFrom!: string | null;

  @Column('uuid', { name: 'acquired_from_entity_id', nullable: true })
  acquiredFromEntityId!: string | null;

  /** When the object was made — the start of its physical life, not of ownership. */
  @Column('timestamptz', { name: 'manufactured_at', nullable: true })
  manufacturedAt!: Date | null;

  /** When it stops being usable. Distinct from warrantyExpiresAt, which is a contract. */
  @Column('timestamptz', { name: 'expires_at', nullable: true })
  expiresAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  sourceFileId!: string | null;

  @AfterLoad()
  loadMetadataProperties() {
    this.sourceFileId = (this.metadata?.source_file_id as string) || null;
  }

  /**
   * Composes the egress item from the CTI pair: the ci.objects detail row
   * plus its ci.entities base row, which is the sole owner of
   * name/description. Callers that only have the detail (e.g. straight after
   * an insert they themselves composed) may pass the base values inline.
   */
  static toEgressType(
    entity: ItemEntity,
    base?: { name: string | null; description: string | null } | null,
  ): Item {
    return {
      id: entity.id,
      name: base?.name ?? null,
      description: base?.description ?? null,
      category: entity.category,
      subcategory: entity.subcategory,
      brand: entity.brand,
      model: entity.model,
      identifierCodes: entity.identifierCodes,
      purchasePrice: entity.purchasePrice,
      currentValue: entity.currentValue,
      currency: entity.currency,
      acquiredAt: entity.acquiredAt,
      warrantyExpiresAt: entity.warrantyExpiresAt,
      disposedAt: entity.disposedAt,
      disposalMethod: entity.disposalMethod,
      lastUsedAt: entity.lastUsedAt,
      usageFrequency: entity.usageFrequency,
      usageCount: entity.usageCount,
      locationDescription: entity.locationDescription,
      storageLocation: entity.storageLocation,
      currentLocationCoordinates: entity.currentLocationCoordinates,
      condition: entity.condition,
      maintenanceNeeded: entity.maintenanceNeeded,
      maintenanceNotes: entity.maintenanceNotes,
      isDigital: entity.isDigital,
      digitalLocation: entity.digitalLocation,
      licenseKey: entity.licenseKey,
      isSubscription: entity.isSubscription,
      subscriptionExpirationDate: entity.subscriptionExpirationDate,
      metadata: entity.metadata,

      userId: entity.userId,
      ownerUserId: entity.ownerUserId,
      sourceType: entity.sourceType,
      sourceSystem: entity.sourceSystem,
      sourceId: entity.sourceId,
      sourceFileId: entity.sourceFileId,

      productId: entity.productId,
      acquisitionReceiptId: entity.acquisitionReceiptId,
      acquisitionLineItemId: entity.acquisitionLineItemId,
      lifecycleState: entity.lifecycleState,
      quantity: entity.quantity,
      identityConfidence: entity.identityConfidence,
      identityMethod: entity.identityMethod,
      lastSeenAt: entity.lastSeenAt,
      lastSeenPlaceEntityId: entity.lastSeenPlaceEntityId,
      mergedIntoObjectId: entity.mergedIntoObjectId,

      lengthMm: entity.lengthMm,
      widthMm: entity.widthMm,
      heightMm: entity.heightMm,
      massG: entity.massG,
      volumeMl: entity.volumeMl,
      unitSystem: entity.unitSystem,
      colors: entity.colors,
      colorHex: entity.colorHex,
      materials: entity.materials,
      composition: entity.composition ?? {},
      acquisitionMethod: entity.acquisitionMethod,
      acquiredFrom: entity.acquiredFrom,
      acquiredFromEntityId: entity.acquiredFromEntityId,
      manufacturedAt: entity.manufacturedAt,
      expiresAt: entity.expiresAt,

      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}

export type Item = Readonly<Omit<ItemEntity, 'loadMetadataProperties' | 'entityType'>> & {
  // Owned by the CTI base row (ci.entities); composed on egress.
  readonly name: string | null;
  readonly description: string | null;
};
