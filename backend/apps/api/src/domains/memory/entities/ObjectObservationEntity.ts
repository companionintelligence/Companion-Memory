import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, Point } from 'typeorm';

export type ObservationSourceKind = 'photo' | 'video_frame' | 'live_camera' | 'screenshot' | 'manual';
export type ObservationLabelSource = 'yolo' | 'ollama_vision' | 'clip' | 'user' | 'import';
export type ObservationResolutionMethod =
  | 'identifier'
  | 'embedding'
  | 'place_prior'
  | 'label'
  | 'user'
  | 'none';

/** Normalized bounding box in 0..1 of the source image, origin top-left. */
export interface ObservationBoundingBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A SIGHTING of a physical thing in an image. Mirrors migration
 * 20260803223022_create_object_observations.
 *
 * This exists to keep two very different claims apart: "a coffee mug is visible
 * in this photo" and "I own this specific coffee mug". Conflating them is what
 * the old InventoryListener did — it wrote speculative ci.inventory rows
 * straight from a vision guess, polluting the owned-things table with every
 * object that ever appeared in frame.
 *
 * An observation is the weak claim. Resolution to an owned unit
 * (`resolvedObjectId`) or a catalog product (`resolvedProductId`) is a separate,
 * revisable decision with its own method and confidence. Nothing here writes
 * ci.inventory directly.
 *
 * The `embedding` column (vector(768)) is deliberately NOT mapped: pgvector
 * columns are read and written through raw SQL in this codebase — the same
 * convention as `ci.inventory.object_embedding`, which ItemEntity also omits —
 * so that ordinary reads do not drag 768 floats per row.
 */
@Entity({ schema: 'ci', name: 'object_observations' })
export class ObjectObservationEntity {
  @PrimaryColumn('uuid', { name: 'observation_id' })
  id!: string;

  @Column('uuid', { name: 'user_id' })
  userId!: string;

  @Column('uuid', { name: 'owner_user_id', nullable: true })
  ownerUserId!: string | null;

  @Column('timestamptz', { name: 'observed_at' })
  observedAt!: Date;

  @Column('text', { name: 'source_kind', default: 'photo' })
  sourceKind!: ObservationSourceKind;

  /** Where the pixels live. No FKs — content and files are purgeable. */
  @Column('uuid', { name: 'content_id', nullable: true })
  contentId!: string | null;

  @Column('uuid', { name: 'file_id', nullable: true })
  fileId!: string | null;

  @Column('uuid', { name: 'event_id', nullable: true })
  eventId!: string | null;

  /**
   * Graph Location the sighting happened at. The place_prior resolution step
   * scopes candidate objects to things known to be at this place — a "mug" at
   * home resolves against a small set; the same label in a cafe resolves to
   * nothing and correctly stays an unresolved observation.
   */
  @Column('uuid', { name: 'place_entity_id', nullable: true })
  placeEntityId!: string | null;

  @Column('geography', {
    name: 'location_coordinates',
    nullable: true,
    spatialFeatureType: 'Point',
    srid: 4326,
  })
  locationCoordinates!: Point | null;

  /** What the detector said, verbatim. Always present — a label-less sighting carries no information. */
  @Column('text', { name: 'label' })
  label!: string;

  @Column('text', { name: 'label_source', nullable: true })
  labelSource!: ObservationLabelSource | null;

  @Column('text', { name: 'detector', nullable: true })
  detector!: string | null;

  @Column('text', { name: 'detector_version', nullable: true })
  detectorVersion!: string | null;

  @Column('real', { name: 'detection_confidence', nullable: true })
  detectionConfidence!: number | null;

  @Column('jsonb', { name: 'bbox', nullable: true })
  bbox!: ObservationBoundingBox | null;

  /** Cropped region as its own ci.content row, so review UI shows the thing, not the whole photo. */
  @Column('uuid', { name: 'crop_content_id', nullable: true })
  cropContentId!: string | null;

  @Column('uuid', { name: 'resolved_object_id', nullable: true })
  resolvedObjectId!: string | null;

  @Column('uuid', { name: 'resolved_product_id', nullable: true })
  resolvedProductId!: string | null;

  @Column('text', { name: 'resolution_method', default: 'none' })
  resolutionMethod!: ObservationResolutionMethod;

  @Column('real', { name: 'resolution_confidence', nullable: true })
  resolutionConfidence!: number | null;

  /**
   * TRUE only after a human confirms. Never written by a detector or an LLM —
   * it is the flag that separates ground truth from a good guess, and HBPE/RAG
   * are entitled to rely on that.
   */
  @Column('boolean', { name: 'confirmed_by_user', default: false })
  confirmedByUser!: boolean;

  /** Observed state: {color, condition, count}. */
  @Column('jsonb', { name: 'attributes', default: {} })
  attributes!: Record<string, unknown>;

  /**
   * Idempotency arbiter for detector-generated rows, which carry no provenance
   * triple: a stable digest of (contentId, detector, rounded bbox). Imported
   * observations use the source triple instead; a row has one or the other.
   */
  @Column('text', { name: 'detection_key', nullable: true })
  detectionKey!: string | null;

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

export type ObjectObservation = Readonly<ObjectObservationEntity>;
