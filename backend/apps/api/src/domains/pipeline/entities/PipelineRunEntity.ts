import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Operator intent for a run. This is the CONTROL channel, distinct from
 * {@link PipelineRunEntity.status}, which is what the workers report.
 *
 * Pause and cancel work by writing here and letting workers notice between
 * batches. Nothing reaches into pg-boss to delete queued jobs — that operation
 * always races with a worker that has already claimed one.
 */
export type PipelineRunDesiredState = 'running' | 'paused' | 'cancelled';

/**
 * One invocation of a pipeline for one user. Mirrors migration
 * 20260809032723_create_pipeline_control_plane.
 *
 * At most one run per user is active at a time, enforced in the database by
 * `pipeline_runs_active_uniq` — a partial unique index on `user_id` where
 * `finished_at IS NULL`. An operator double-clicking "reprocess" gets a unique
 * violation rather than two workers racing over the same rows, so callers
 * should treat a 23505 on insert as "a run is already going", not an error.
 */
@Entity({ schema: 'ci', name: 'pipeline_runs' })
@Index('pipeline_runs_user_started_idx', ['userId', 'startedAt'])
export class PipelineRunEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  /** Which pipeline this is a run of, e.g. 'full_reprocess' | 'import'. */
  @Column({ type: 'text' })
  kind!: string;

  @Column({ type: 'text', name: 'desired_state' })
  desiredState!: PipelineRunDesiredState;

  /**
   * Observed state, owned by the runner. Free text rather than a CHECK-ed
   * vocabulary on purpose: the runner's state machine will grow, and the
   * "is it active?" question is answered by `finishedAt`, not by this.
   */
  @Column({ type: 'text' })
  status!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'started_at' })
  startedAt!: Date;

  /**
   * NULL means the run is still active — the exact predicate of the one-active-
   * run-per-user index. A cancelled run stays active until a worker finalizes
   * it, which is what stops a cancel from orphaning in-flight batches.
   */
  @Column({ type: 'timestamptz', name: 'finished_at', nullable: true })
  finishedAt!: Date | null;

  /** Free-form run summary: counts per stage, the triggering request, errors. */
  @Column({ type: 'jsonb', default: {} })
  detail!: Record<string, unknown>;
}

export type PipelineRun = Readonly<PipelineRunEntity>;
