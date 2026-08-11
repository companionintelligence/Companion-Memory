import {
  Entity,
  Index,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Point,
} from 'typeorm';

import { UserEntity, User } from '@ci/domains/user';

@Entity({ schema: 'ci', name: 'events' })
// Idempotency key for captured/imported events. Created by migration
// 20260620213807_add_events_source_idempotency; declared here so TypeORM is
// aware of it (schema sync stays off — the migration is the source of truth).
@Index('events_source_triple_uniq', ['userId', 'sourceType', 'sourceSystem', 'sourceId'], {
  unique: true,
  where: '"source_id" IS NOT NULL',
})
export class EventEntity {
  @PrimaryColumn('uuid', { name: 'event_id' })
  id!: string;

  /**
   * CTI discriminator pin (migration 20260811061409): always 'Event' (distinct
   * from the domain event_type below). Pairs with event_id in the composite FK
   * to ci.entities(entity_id, entity_type) so a detail row can never point at
   * a base row of another type. DEFAULTed and CHECKed in the schema; never
   * written by the application.
   */
  @Column({ type: 'text', name: 'entity_type', default: 'Event', insert: false, update: false })
  entityType!: string;

  // title/description live ONLY on the CTI base row (ci.entities.name/
  // description, see EventBaseEntity); the egress type composes them back on
  // via toEgressType.

  @Column({ type: 'text', nullable: true, name: 'event_type' })
  eventType!: string | null;

  @Column({ type: 'text', nullable: true })
  category!: string | null;

  @Column({ type: 'timestamptz', name: 'start_time' })
  startTime!: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'end_time' })
  endTime!: Date | null;

  @Column({ type: 'integer', nullable: true, insert: false, update: false, name: 'duration_minutes' })
  durationMinutes!: number | null;

  @Column({ type: 'text', nullable: true, name: 'location_name' })
  locationName!: string | null;

  @Column({
    type: 'geography',
    nullable: true,
    srid: 4326,
    spatialFeatureType: 'Point',
    name: 'location_coordinates',
  })
  locationCoordinates!: Point | null;

  @Column({ type: 'uuid', nullable: true, name: 'location_entity_id' })
  locationEntityId!: string | null;

  @Column('uuid', { array: true, nullable: true, name: 'participant_entity_ids' })
  participantEntityIds!: string[] | null;

  @Column({ type: 'uuid', nullable: true, name: 'organizer_entity_id' })
  organizerEntityId!: string | null;

  @Column({ type: 'text', nullable: true, name: 'source_type' })
  sourceType!: string | null;

  @Column({ type: 'text', nullable: true, name: 'source_system' })
  sourceSystem!: string | null;

  @Column({ type: 'text', nullable: true, name: 'source_id' })
  sourceId!: string | null;

  @Column({ type: 'double precision', default: 1.0, name: 'confidence_score' })
  confidenceScore!: number;

  @Column({ type: 'boolean', default: false, name: 'is_recurring' })
  isRecurring!: boolean;

  @Column({ type: 'jsonb', nullable: true, name: 'recurrence_pattern' })
  recurrencePattern!: Record<string, unknown> | null;

  @Column({ type: 'boolean', default: false, name: 'is_all_day' })
  isAllDay!: boolean;

  @Column({ type: 'boolean', default: false, name: 'is_private' })
  isPrivate!: boolean;

  @Column({ type: 'integer', default: 0 })
  priority!: number;

  @Column({ type: 'jsonb', default: '{}' })
  metadata!: Record<string, unknown>;

  @Column({ type: 'boolean', default: false, name: 'is_predicted' })
  isPredicted!: boolean;

  @Column({ type: 'boolean', default: false, name: 'is_inferred' })
  isInferred!: boolean;

  @Column({ type: 'jsonb', default: '{}', name: 'inference_sources' })
  inferenceSources!: Record<string, unknown>;

  @Column('text', { array: true, nullable: true })
  tags!: string[] | null;

  @Column({ type: 'double precision', nullable: true, name: 'sentiment_score' })
  sentimentScore!: number | null;

  @Column({ type: 'integer', nullable: true, name: 'energy_level' })
  energyLevel!: number | null;

  @Column({ type: 'text', default: 'confirmed' })
  status!: string;

  // last_accessed stays on the hot table (read-path touch). salience /
  // access_count / other unused analytics live in ci.event_analytics.
  @Column({ type: 'timestamptz', nullable: true, name: 'last_accessed' })
  lastAccessed!: Date | null;

  // Consent / sharing scope (mirrors ci.answers.sharing_level). Stored raw at
  // ingest; redaction happens at read based on the consumer's scope (G2).
  @Column({ type: 'text', default: 'private', name: 'sharing_level' })
  sharingLevel!: string;

  @Column({ type: 'boolean', default: false, name: 'is_deleted' })
  isDeleted!: boolean;

  @Column({ type: 'text', nullable: true, name: 'external_sync_status' })
  externalSyncStatus!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'parent_event_id' })
  parentEventId!: string | null;

  @Column({ type: 'text', nullable: true, name: 'created_by' })
  createdBy!: string | null;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  /**
   * Composes the egress event from the CTI pair: the ci.events detail row plus
   * its ci.entities base row, the sole owner of title (name) and description.
   */
  static toEgressType(
    entity: EventEntity,
    base?: { name: string | null; description: string | null } | null,
  ) {
    return {
      id: entity.id,
      title: base?.name ?? null,
      description: base?.description ?? null,
      eventType: entity.eventType,
      category: entity.category,
      startTime: entity.startTime,
      endTime: entity.endTime,
      durationMinutes: entity.durationMinutes,
      locationName: entity.locationName,
      locationCoordinates: entity.locationCoordinates,
      locationEntityId: entity.locationEntityId,
      participantEntityIds: entity.participantEntityIds,
      organizerEntityId: entity.organizerEntityId,
      sourceType: entity.sourceType,
      sourceSystem: entity.sourceSystem,
      sourceId: entity.sourceId,
      confidenceScore: entity.confidenceScore,
      isRecurring: entity.isRecurring,
      recurrencePattern: entity.recurrencePattern,
      isAllDay: entity.isAllDay,
      isPrivate: entity.isPrivate,
      priority: entity.priority,
      metadata: entity.metadata,
      isPredicted: entity.isPredicted,
      isInferred: entity.isInferred,
      inferenceSources: entity.inferenceSources,
      tags: entity.tags,
      sentimentScore: entity.sentimentScore,
      energyLevel: entity.energyLevel,
      status: entity.status,
      isDeleted: entity.isDeleted,
      externalSyncStatus: entity.externalSyncStatus,
      parentEventId: entity.parentEventId,
      lastAccessed: entity.lastAccessed,
      sharingLevel: entity.sharingLevel,
      createdBy: entity.createdBy,
      userId: entity.userId,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}

export type Event = Readonly<Omit<EventEntity, 'user' | 'entityType'>> & {
  // Owned by the CTI base row (ci.entities); composed on egress.
  readonly title: string | null;
  readonly description: string | null;
  user?: User;
};
