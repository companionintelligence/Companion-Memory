import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ schema: 'pgboss', name: 'archive' })
export class PgBossArchiveEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'name', type: 'text' })
  name!: string;

  @Column({ name: 'priority', type: 'integer' })
  priority!: number;

  @Column({ name: 'data', type: 'jsonb', nullable: true })
  data!: Record<string, unknown> | null;

  @Column({ name: 'state', type: 'text' })
  state!: string;

  @Column({ name: 'retry_limit', type: 'integer' })
  retryLimit!: number;

  @Column({ name: 'retry_count', type: 'integer' })
  retryCount!: number;

  @Column({ name: 'retry_delay', type: 'integer' })
  retryDelay!: number;

  @Column({ name: 'retry_backoff', type: 'boolean' })
  retryBackoff!: boolean;

  @Column({ name: 'start_after', type: 'timestamptz' })
  startAfter!: Date;

  @Column({ name: 'started_on', type: 'timestamptz', nullable: true })
  startedOn!: Date | null;

  @Column({ name: 'created_on', type: 'timestamptz' })
  createdOn!: Date;

  @Column({ name: 'completed_on', type: 'timestamptz', nullable: true })
  completedOn!: Date | null;

  @Column({ name: 'dead_letter', type: 'text', nullable: true })
  deadLetter!: string | null;

  @Column({ name: 'policy', type: 'text', nullable: true })
  policy!: string | null;

  @Column({ name: 'output', type: 'jsonb', nullable: true })
  output!: Record<string, unknown> | null;

  @Column({ name: 'archived_on', type: 'timestamptz' })
  archivedOn!: Date;
}
