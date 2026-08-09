import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * One unit of parallelism inside a run: a (run, stage, shardKey) slice of the
 * source table, with a resumable cursor and a lease. Mirrors migration
 * 20260809032723_create_pipeline_control_plane.
 *
 * The cursor is a KEYSET position — the last source id already handed out, fed
 * back in as the `$5::uuid` parameter of the staleness sweep. Not an OFFSET: a
 * keyset makes a resumed run cost O(remaining) instead of O(processed), and it
 * cannot skip or repeat rows when the source grows mid-scan.
 *
 * The lease pair is a cooperative mutex with a deadline, not a lock. A worker
 * claims a shard by stamping {@link leaseOwner} and {@link leaseExpiresAt}; a
 * reaper takes back anything expired. A SIGKILLed worker therefore costs one
 * lease period, not a permanently stuck run — which is the property a lock held
 * in process memory could never give us.
 */
@Entity({ schema: 'ci', name: 'pipeline_shards' })
@Index('pipeline_shards_lease_idx', ['status', 'leaseExpiresAt'])
export class PipelineShardEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid', name: 'run_id' })
  runId!: string;

  @Column({ type: 'text' })
  stage!: string;

  /** Partition label within the stage — the shard's identity alongside run and stage. */
  @Column({ type: 'text', name: 'shard_key' })
  shardKey!: string;

  /**
   * Last source id handed out for this shard. TEXT rather than UUID so a stage
   * whose source table is keyed by something else can use this table unchanged.
   * NULL means the shard has not started.
   */
  @Column({ type: 'text', nullable: true })
  cursor!: string | null;

  @Column({ type: 'text' })
  status!: string;

  /** Worker identity holding the claim. Advisory — {@link leaseExpiresAt} is what the reaper trusts. */
  @Column({ type: 'text', name: 'lease_owner', nullable: true })
  leaseOwner!: string | null;

  /**
   * When the claim goes stale. The reaper reclaims any non-terminal shard past
   * this instant regardless of who owns it, so a lease must be renewed while
   * work is in flight.
   */
  @Column({ type: 'timestamptz', name: 'lease_expires_at', nullable: true })
  leaseExpiresAt!: Date | null;
}

export type PipelineShard = Readonly<PipelineShardEntity>;
