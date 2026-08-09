import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * A job that died terminally, kept with its payload instead of dropped. Mirrors
 * migration 20260809032723_create_pipeline_control_plane.
 *
 * pg-boss archives a failed job and then expires the archive. That is correct
 * for a queue and wrong for an appliance, where the failed payload is routinely
 * the only surviving copy of a record the source will not re-send. A dead
 * letter is REPLAYABLE: {@link payload} plus {@link eventName} is everything
 * needed to re-emit, and {@link replayedAt} is the idempotency flag that keeps
 * a replay-all from looping.
 *
 * Compare `ci.record_rejections`: a dead letter is US failing to process a
 * valid record; a rejection is THEIR record failing validation.
 */
@Entity({ schema: 'ci', name: 'pipeline_dead_letters' })
@Index('pipeline_dead_letters_queue_failed_idx', ['queue', 'failedAt'])
export class PipelineDeadLetterEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'text' })
  queue!: string;

  /** The event that was being handled, and the one a replay re-emits. */
  @Column({ type: 'text', name: 'event_name' })
  eventName!: string;

  /** Stage id when the failure happened inside a stage; NULL for plain queue handlers. */
  @Column({ type: 'text', nullable: true })
  stage!: string | null;

  @Column({ type: 'text', name: 'entity_type', nullable: true })
  entityType!: string | null;

  @Column({ type: 'uuid', name: 'entity_id', nullable: true })
  entityId!: string | null;

  /**
   * Owning user, read off the failed job's payload.
   *
   * Present so `domains/portability` discovers this table: it finds user-scoped
   * tables by column name (`DISCOVER_USER_TABLES_SQL`), so without `user_id` an
   * erasure request would sweep every other control-plane table and leave the
   * verbatim failed payloads here behind.
   *
   * Nullable because not every job is user-scoped. NULL means "not
   * attributable", not "not yet populated".
   */
  @Column({ type: 'uuid', name: 'user_id', nullable: true })
  userId!: string | null;

  /** The job payload verbatim. The whole reason this table exists — never trim it. */
  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  /** Message and stack of the terminal failure. */
  @Column({ type: 'text' })
  error!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'failed_at' })
  failedAt!: Date;

  /**
   * Stamped once the letter has been re-emitted. Non-NULL rows are excluded
   * from the replay queue (`pipeline_dead_letters_unreplayed_idx`), so "replay
   * all" is safe to run twice.
   */
  @Column({ type: 'timestamptz', name: 'replayed_at', nullable: true })
  replayedAt!: Date | null;
}

export type PipelineDeadLetter = Readonly<PipelineDeadLetterEntity>;
