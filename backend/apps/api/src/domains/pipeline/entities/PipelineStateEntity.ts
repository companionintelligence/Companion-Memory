import { Column, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Terminal and non-terminal outcomes a stage can record for an entity.
 *
 * `done` | `skipped` | `failed` are the StageResult outcomes a stage itself
 * returns; `pending`/`running` are written by the runner around the call, and
 * `quarantined` is written by the retry policy when a row is out of attempts.
 * A quarantined row is never reclaimed by a sweep — it needs a human.
 */
export type PipelineStageStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'quarantined';

/**
 * One row per (entity, stage): the ledger of what has been processed. Mirrors
 * migration 20260809032723_create_pipeline_control_plane (schema sync stays
 * off; the SQL is the source of truth).
 *
 * This is the LEFT JOIN target of every staleness sweep, which is why the PK is
 * the natural triple (entityType, entityId, stage) rather than a surrogate id:
 * the join the sweep performs is an index-only lookup on the PK, and an upsert
 * gets its ON CONFLICT target for free.
 *
 * The row is a fact about work already done, never a work item. Nothing here is
 * a queue — pg-boss still owns dispatch, and stages never touch it.
 */
@Entity({ schema: 'ci', name: 'pipeline_state' })
@Index('pipeline_state_stage_version_idx', ['stage', 'stageVersion'])
export class PipelineStateEntity {
  /** Logical kind of the entity, e.g. 'content' | 'file' | 'communication'. */
  @PrimaryColumn({ type: 'text', name: 'entity_type' })
  entityType!: string;

  @PrimaryColumn({ type: 'uuid', name: 'entity_id' })
  entityId!: string;

  /** Stage id, e.g. 'enrich.media_dimensions'. */
  @PrimaryColumn({ type: 'text' })
  stage!: string;

  /**
   * The STAGE_VERSIONS value in force when this row was written. Rows below the
   * stage's current version are stale and get re-swept, which makes bumping the
   * constant the entire reprocessing mechanism — no backfill script, no DELETE.
   */
  @Column({ type: 'integer', name: 'stage_version', default: 0 })
  stageVersion!: number;

  @Column({ type: 'text' })
  status!: PipelineStageStatus;

  /**
   * Why the row was skipped or failed. Required by convention for those two
   * statuses, deliberately not enforced by a CHECK so an error path can never
   * be blocked by a constraint.
   */
  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  /**
   * Retry gate. A `failed` row is only reclaimed by the sweep once this is due,
   * so backoff survives a process restart — it lives in the row, not in a timer.
   */
  @Column({ type: 'timestamptz', name: 'next_attempt_at', nullable: true })
  nextAttemptAt!: Date | null;

  /**
   * Denormalized from the source row so sweeps, dashboards and reapers can
   * filter by user without joining back to the entity's own table. NULL for the
   * stages whose entities are not user-scoped.
   */
  @Column({ type: 'uuid', name: 'user_id', nullable: true })
  userId!: string | null;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}

export type PipelineState = Readonly<PipelineStateEntity>;
