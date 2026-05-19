import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

export type IngestRunStatus = 'running' | 'ok' | 'error' | 'partial';

@Entity({ schema: 'ci', name: 'ingest_runs' })
export class IngestRunEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  actor_id!: string;

  @Column({ type: 'text' })
  provider!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'started_at' })
  started_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  ended_at!: Date | null;

  @Column({ type: 'text' })
  status!: IngestRunStatus;

  @Column({ type: 'text', nullable: true })
  cursor!: string | null;

  @Column({ type: 'int', default: 0 })
  entities_written!: number;

  @Column({ type: 'int', default: 0 })
  relationships_written!: number;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  rollback_at!: Date | null;
}
