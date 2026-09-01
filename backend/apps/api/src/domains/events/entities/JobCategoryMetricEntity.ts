import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * One sample of one job CATEGORY's behaviour — the taxonomy-grained sibling of
 * {@link JobMetricEntity}.
 *
 * Two tables rather than one because a queue cannot be folded to a category:
 * pg-boss rewrites `name` to the literal `dead-letter` on the copy it makes of
 * a job that exhausted its retries (43% of rows on a live appliance), so the
 * originating queue is gone. The event name at `data->>'name'` survives that
 * copy, and it is the event the taxonomy maps. See the migration
 * `20260901192406_add_job_category_metrics.sql`.
 */
@Entity({ schema: 'ci', name: 'job_category_metrics' })
export class JobCategoryMetricEntity {
  @PrimaryColumn({ name: 'sampled_at', type: 'timestamptz' })
  sampledAt!: Date;

  /**
   * A `JOB_CATEGORIES` value, or `UNCLASSIFIED_CATEGORY` for an event with no
   * taxonomy entry. Not an enum column: the taxonomy is TypeScript data that
   * gains entries in ordinary pull requests, and a database enum would turn
   * every one of those into a migration.
   */
  @PrimaryColumn({ name: 'category', type: 'text' })
  category!: string;

  @Column({ name: 'pending', type: 'integer', default: 0 })
  pending!: number;

  @Column({ name: 'active', type: 'integer', default: 0 })
  active!: number;

  @Column({ name: 'retry', type: 'integer', default: 0 })
  retry!: number;

  @Column({ name: 'dead_lettered', type: 'integer', default: 0 })
  deadLettered!: number;

  /**
   * Jobs ENQUEUED during the interval ending at `sampledAt` — a delta, not a
   * total, and the column the category chart plots. Excludes dead-letter
   * copies, which carry a fresh `created_on` and would otherwise report a
   * surge of new work at the moment work started failing.
   */
  @Column({ name: 'arrived', type: 'integer', default: 0 })
  arrived!: number;

  /** Jobs that completed during the interval ending at `sampledAt` — a delta. */
  @Column({ name: 'completed', type: 'integer', default: 0 })
  completed!: number;

  /** Jobs that failed during the interval ending at `sampledAt` — a delta. */
  @Column({ name: 'failed', type: 'integer', default: 0 })
  failed!: number;
}
