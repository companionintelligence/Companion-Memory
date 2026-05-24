import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';

import { ConnectionEntity } from '@ci/domains/connections';
import { UserEntity } from '@ci/domains/user';

import type { ConnectionSyncJob, JobStatus } from '../types';

@Entity({ schema: 'ci_etl', name: 'connection_sync_jobs' })
export class ConnectionSyncJobEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'uuid', name: 'connection_id' })
  connectionId!: string;

  @Column({ type: 'uuid', nullable: true, name: 'job_id' })
  jobId!: string | null;

  @Column({ type: 'text', name: 'endpoint_name' })
  endpointName!: string;

  @Column({
    type: 'enum',
    enum: ['in_progress', 'failed', 'success'],
    default: 'in_progress',
  })
  status!: JobStatus;

  @Column({ type: 'jsonb', default: {} })
  data!: Record<string, unknown>;

  @Column({ type: 'text' })
  type!: string;

  @Column({ type: 'jsonb', nullable: true, default: {} })
  cursor!: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: true, default: {}, name: 'next_cursor' })
  nextCursor!: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: true, default: {} })
  properties!: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  error!: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'completed_at' })
  completedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'last_transformed' })
  lastTransformed!: Date | null;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity;

  @ManyToOne(() => ConnectionEntity)
  @JoinColumn({ name: 'connection_id' })
  connection?: ConnectionEntity;

  static toEgressType(entity: ConnectionSyncJobEntity): ConnectionSyncJob {
    return {
      id: entity.id,
      userId: entity.userId,
      connectionId: entity.connectionId,
      jobId: entity.jobId,
      endpointName: entity.endpointName,
      status: entity.status,
      data: entity.data,
      type: entity.type,
      cursor: entity.cursor,
      nextCursor: entity.nextCursor,
      properties: entity.properties,
      error: entity.error,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      completedAt: entity.completedAt,
      lastTransformed: entity.lastTransformed,
      user: entity.user ? UserEntity.toEgressType(entity.user) : undefined,
      connection: entity.connection ? ConnectionEntity.toEgressType(entity.connection) : undefined,
    };
  }
}
