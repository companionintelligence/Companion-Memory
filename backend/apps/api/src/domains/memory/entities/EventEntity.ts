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
@Index('events_source_triple_uniq', ['sourceType', 'sourceSystem', 'sourceId'], {
  unique: true,
  where: '"source_id" IS NOT NULL',
})
export class EventEntity {
  @PrimaryColumn('uuid', { name: 'event_id' })
  id!: string;

  @Column({ type: 'text' })
  title!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

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

  @Column({ type: 'uuid', nullable: true, name: 'event_entity_id' })
  eventEntityId!: string | null;

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

  @Column({ type: 'text', nullable: true, name: 'prediction_model' })
  predictionModel!: string | null;

  @Column({ type: 'jsonb', default: '{}', name: 'inference_sources' })
  inferenceSources!: Record<string, unknown>;

  @Column('text', { array: true, nullable: true })
  tags!: string[] | null;

  @Column({ type: 'double precision', nullable: true, name: 'sentiment_score' })
  sentimentScore!: number | null;

  @Column({ type: 'integer', nullable: true, name: 'energy_level' })
  energyLevel!: number | null;

  @Column({ type: 'double precision', nullable: true, name: 'productivity_impact' })
  productivityImpact!: number | null;

  @Column({ type: 'text', default: 'confirmed' })
  status!: string;

  @Column({ type: 'boolean', default: false, name: 'is_deleted' })
  isDeleted!: boolean;

  @Column({ type: 'text', nullable: true, name: 'external_sync_status' })
  externalSyncStatus!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'last_synced_at' })
  lastSyncedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true, name: 'parent_event_id' })
  parentEventId!: string | null;

  @Column('uuid', { array: true, nullable: true, name: 'related_event_ids' })
  relatedEventIds!: string[] | null;

  @Column({ type: 'uuid', nullable: true, name: 'supersedes_event_id' })
  supersedesEventId!: string | null;

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

  static toEgressType(entity: EventEntity) {
    return {
      id: entity.id,
      title: entity.title,
      description: entity.description,
      eventType: entity.eventType,
      category: entity.category,
      startTime: entity.startTime,
      endTime: entity.endTime,
      durationMinutes: entity.durationMinutes,
      locationName: entity.locationName,
      eventEntityId: entity.eventEntityId,
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
      predictionModel: entity.predictionModel,
      inferenceSources: entity.inferenceSources,
      tags: entity.tags,
      sentimentScore: entity.sentimentScore,
      energyLevel: entity.energyLevel,
      productivityImpact: entity.productivityImpact,
      status: entity.status,
      isDeleted: entity.isDeleted,
      externalSyncStatus: entity.externalSyncStatus,
      lastSyncedAt: entity.lastSyncedAt,
      parentEventId: entity.parentEventId,
      relatedEventIds: entity.relatedEventIds,
      supersedesEventId: entity.supersedesEventId,
      createdBy: entity.createdBy,
      userId: entity.userId,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}

export type Event = Readonly<Omit<EventEntity, 'user'>> & {
  user?: User;
};
