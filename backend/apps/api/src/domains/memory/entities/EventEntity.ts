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

  /**
   * WHERE the instant in `startTime` came from — the vocabulary is declared in
   * `TIME_SOURCES` (pipeline/stages/clean/TemporalRepairStage): `source` (the
   * export said so), `user` (a human typed it), `repaired` (the clean stage
   * moved it, `start_time_original` holds what was there before) and `ingest`
   * (**nothing** said so — the transform stamped a wall clock because the column
   * is NOT NULL).
   *
   * Declared on the entity, and not only in the clean stage's raw UPDATE,
   * because the honest place to say "this instant is not evidence" is the write
   * that MINTS it. A marker only a later sweep can apply is a marker that is
   * absent for every row between the import and the sweep — which is exactly
   * how five Google Maps saved places ("Home", "Work", "Gym") came to sit at the
   * top of the timeline dated the moment of the import with nothing anywhere
   * saying they were undated. The importer now stamps `ingest` at insert
   * (import/push/inputs.ts `toEventInput`); the clean stage still owns
   * `repaired` and the `*_original` pair.
   *
   * Nullable: rows written before this existed, and every writer that genuinely
   * has nothing to assert, leave it NULL. NULL means "unexamined", not "source".
   */
  @Column({ type: 'text', nullable: true, name: 'time_source' })
  timeSource!: string | null;

  /**
   * HOW MUCH of `startTime` is meaningful — `TIME_PRECISIONS` in the same file:
   * `second` / `minute` / `day` / `ambiguous` / `unknown`. `unknown` is the one
   * that pairs with `timeSource = 'ingest'`: there was no source timestamp at
   * all, so not one field of the stored instant carries information.
   */
  @Column({ type: 'text', nullable: true, name: 'time_precision' })
  timePrecision!: string | null;

  /**
   * WHEN the capture source actually recorded this event, as distinct from
   * `startTime` (when the event itself occurred). Threaded through from
   * `ci.capture_events.observed_at` by the /v1/events materialize step
   * (migration 20260830040124); null for events materialized before that, and
   * for pathways that never send it (OAuth sync, bulk import).
   */
  @Column({ type: 'timestamptz', nullable: true, name: 'observed_at' })
  observedAt!: Date | null;

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

  /**
   * The ci.connections row whose sync produced this event, so disconnecting
   * that service can purge exactly its events. Null for events that did not
   * come from a connection (manual, imported archives, predicted).
   */
  @Column({ type: 'uuid', nullable: true, name: 'connection_id' })
  connectionId!: string | null;

  /**
   * Per-tick correlator minted by CI-Capture (one UUID per worker tick,
   * shared with the screenshot uploaded via the same tick — see
   * `ci.files.capture_tick_id`). NOT a provenance/idempotency key — that
   * role stays with (source_type, source_system, source_id); this one links
   * a row on THIS table to a row on `ci.files`, migration
   * 20260830042159_add_capture_correlation_to_files_and_events.
   */
  @Column({ type: 'uuid', nullable: true, name: 'capture_tick_id' })
  captureTickId!: string | null;

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

  /** Task this planned block schedules (`event_type = 'planned_block'`). */
  @Column({ type: 'uuid', nullable: true, name: 'task_id' })
  taskId!: string | null;

  /** Intended duration for a planned block; `duration_minutes` stays generated actual. */
  @Column({ type: 'integer', nullable: true, name: 'planned_minutes' })
  plannedMinutes!: number | null;

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
      timeSource: entity.timeSource,
      timePrecision: entity.timePrecision,
      observedAt: entity.observedAt,
      durationMinutes: entity.durationMinutes,
      locationName: entity.locationName,
      locationCoordinates: entity.locationCoordinates,
      locationEntityId: entity.locationEntityId,
      participantEntityIds: entity.participantEntityIds,
      organizerEntityId: entity.organizerEntityId,
      sourceType: entity.sourceType,
      sourceSystem: entity.sourceSystem,
      sourceId: entity.sourceId,
      connectionId: entity.connectionId,
      captureTickId: entity.captureTickId,
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
      taskId: entity.taskId,
      plannedMinutes: entity.plannedMinutes,
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
