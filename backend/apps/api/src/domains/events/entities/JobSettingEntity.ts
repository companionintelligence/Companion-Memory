import { Column, Entity, PrimaryColumn } from 'typeorm';

import type { JobControlKind, JobMode } from '@ci/common/job-controls';

/**
 * One persisted operator control over the job system.
 *
 * The full row vocabulary — which `kind`/`key` pairs exist and which columns
 * mean anything for each — is written out in the migration that created the
 * table (`…_job_settings.sql`) and mirrored in `common/job-controls/types.ts`.
 *
 * This entity is the WRITE side: the settings API reads and updates through it.
 * The read side on the hot paths is {@link JobControlStore}, which polls the
 * same table with raw SQL because its callers (the `@Cron` decorator, the
 * enqueue path) cannot await a repository — see that file for why.
 */
@Entity({ schema: 'ci', name: 'job_settings' })
export class JobSettingEntity {
  @PrimaryColumn({ name: 'kind', type: 'text' })
  kind!: JobControlKind;

  @PrimaryColumn({ name: 'key', type: 'text' })
  key!: string;

  /** NULL = no opinion; inherit the shipped default. */
  @Column({ name: 'mode', type: 'text', nullable: true })
  mode!: JobMode | null;

  /** NULL = no opinion; inherit the shipped default. A ceiling, never a floor. */
  @Column({ name: 'concurrency', type: 'integer', nullable: true })
  concurrency!: number | null;

  /**
   * Cumulative work this setting has dropped. `bigint` comes back from
   * node-postgres as a string — the API parses it rather than trusting the
   * declared type.
   */
  @Column({ name: 'skipped_count', type: 'bigint', default: 0 })
  skippedCount!: string;

  @Column({ name: 'last_skipped_at', type: 'timestamptz', nullable: true })
  lastSkippedAt!: Date | null;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedBy!: string | null;
}
