import { AfterLoad, Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, Point } from 'typeorm';

export type InventoryCondition = 'new' | 'like_new' | 'good' | 'fair' | 'poor' | 'broken' | 'n/a';

@Entity({ schema: 'ci', name: 'inventory' })
export class ItemEntity {
  @PrimaryColumn('uuid', { name: 'object_id' })
  id!: string;

  @Column('text', { name: 'name' })
  name!: string;

  @Column('text', { name: 'description', nullable: true })
  description!: string | null;

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
  condition!: InventoryCondition | null;

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

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  sourceFileId!: string | null;

  @AfterLoad()
  loadMetadataProperties() {
    this.sourceFileId = (this.metadata?.source_file_id as string) || null;
  }

  static toEgressType(entity: ItemEntity): Item {
    return {
      id: entity.id,
      name: entity.name,
      description: entity.description,
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
      sourceFileId: entity.sourceFileId,

      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}

export type Item = Readonly<Omit<ItemEntity, 'loadMetadataProperties'>>;
