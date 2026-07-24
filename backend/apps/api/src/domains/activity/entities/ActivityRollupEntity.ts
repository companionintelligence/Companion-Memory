import { Entity, PrimaryColumn, Column } from 'typeorm';

/**
 * Precomputed per-user activity counts in hourly UTC buckets. Rows exist only
 * for (user, source, hour) buckets with activity; the refresh cron fully
 * recomputes them from the source tables, so reads are eventually consistent.
 */
@Entity({ schema: 'ci', name: 'activity_rollup' })
export class ActivityRollupEntity {
  @PrimaryColumn({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @PrimaryColumn({ type: 'text' })
  source!: string;

  @PrimaryColumn({ type: 'timestamptz', name: 'bucket_start' })
  bucketStart!: Date;

  @Column({ type: 'integer' })
  count!: number;

  @Column({ type: 'timestamptz', name: 'refreshed_at', default: () => 'NOW()' })
  refreshedAt!: Date;
}
