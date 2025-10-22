import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ schema: 'pgboss', name: 'queue' })
export class PgBossQueueEntity {
  @PrimaryColumn({ type: 'text' })
  name!: string;

  @Column({ name: 'policy', type: 'text', nullable: true })
  policy!: string | null;

  @Column({ name: 'retry_limit', type: 'integer' })
  retryLimit!: number;

  @Column({ name: 'retry_delay', type: 'integer' })
  retryDelay!: number;

  @Column({ name: 'retry_backoff', type: 'boolean' })
  retryBackoff!: boolean;

  @Column({ name: 'expire_seconds', type: 'integer', nullable: true })
  expireInSeconds!: number | null;

  @Column({ name: 'retention_minutes', type: 'integer', nullable: true })
  retentionMinutes!: number | null;

  @Column({ name: 'dead_letter', type: 'text', nullable: true })
  deadLetter!: string | null;

  @Column({ name: 'created_on', type: 'timestamptz' })
  createdOn!: Date;

  @Column({ name: 'updated_on', type: 'timestamptz', nullable: true })
  updatedOn!: Date | null;
}
