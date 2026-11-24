import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ schema: 'pgboss', name: 'queue' })
export class PgBossQueueEntity {
  @PrimaryColumn({ type: 'text' })
  name!: string;

  @Column({ name: 'policy', type: 'text', nullable: true })
  policy!: string | null;

  // Nullable in the database, and NULL on any queue created before the retry
  // policy was written onto the row: pg-boss resolves retries as
  // COALESCE(job, queue, constructor default), so a queue that never set its
  // own simply has none. Declaring these non-null made TypeORM hand the DTO a
  // null typed as `number`, which the UI then rendered as the string "null".
  @Column({ name: 'retry_limit', type: 'integer', nullable: true })
  retryLimit!: number | null;

  @Column({ name: 'retry_delay', type: 'integer', nullable: true })
  retryDelay!: number | null;

  @Column({ name: 'retry_backoff', type: 'boolean', nullable: true })
  retryBackoff!: boolean | null;

  @Column({ name: 'expire_seconds', type: 'integer', nullable: true })
  expireInSeconds!: number | null;

  @Column({ name: 'retention_seconds', type: 'integer', nullable: true })
  retentionSeconds!: number | null;

  @Column({ name: 'dead_letter', type: 'text', nullable: true })
  deadLetter!: string | null;

  @Column({ name: 'created_on', type: 'timestamptz' })
  createdOn!: Date;

  @Column({ name: 'updated_on', type: 'timestamptz', nullable: true })
  updatedOn!: Date | null;
}
