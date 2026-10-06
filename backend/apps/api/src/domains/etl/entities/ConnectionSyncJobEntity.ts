import {
  Entity,
  Index,
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
// One live (pending or in-progress) job per connection endpoint and iteration
// type. Created by migration 20260821064758_add_connection_sync_jobs_live_job_unique;
// declared here so TypeORM is aware of it (schema sync stays off — the migration
// is the source of truth). `ConnectionSyncJobService.create` reads a violation of
// this index as "a live job already exists".
@Index('connection_sync_jobs_live_job_idx', ['connectionId', 'endpointName', 'type'], {
  unique: true,
  where: `"status" IN ('pending', 'in_progress')`,
})
// The three query indexes from migration
// 20260821064528_add_connection_sync_jobs_query_indexes, restated in the order
// and with the predicates the migration uses — see it for why each column is
// where it is. The table had none of them: until that migration its only index
// was the primary key, so every read below was a sequential scan on a loop that
// runs every 30 or 60 seconds.
@Index('connection_sync_jobs_endpoint_recent_idx', ['connectionId', 'endpointName', 'updatedAt', 'id'])
@Index('connection_sync_jobs_active_idx', ['status', 'connectionId', 'updatedAt', 'id'], {
  where: `"status" IN ('pending', 'in_progress')`,
})
@Index('connection_sync_jobs_untransformed_idx', ['updatedAt', 'id'], {
  where: `"status" = 'success' AND "last_transformed" IS NULL`,
})
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

  // Internal claim marker for `ConnectionSyncJobService.claimTransform` — not
  // part of the public egress type (see `toEgressType` below). See the
  // migration that added this column for why `lastTransformed` alone cannot
  // gate concurrent transform starts.
  @Column({ type: 'timestamptz', nullable: true, name: 'transform_claimed_at' })
  transformClaimedAt!: Date | null;

  /**
   * True once the sync executor (`SyncOrchestrator.handleSyncJobExecuteEvent`)
   * has stored a fetch result in `data`. The transform sweep acts only on these
   * rows: `data` decides what the transforms write and, for Facebook media, what
   * the server downloads, so a payload anyone else wrote must never reach them.
   * See migration 20261006070904_connection_sync_jobs_fetched_by_executor.
   */
  @Column({ type: 'boolean', name: 'fetched_by_executor', default: false })
  fetchedByExecutor!: boolean;

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
      fetchedByExecutor: entity.fetchedByExecutor,
      user: entity.user ? UserEntity.toEgressType(entity.user) : undefined,
      connection: entity.connection ? ConnectionEntity.toEgressType(entity.connection) : undefined,
    };
  }
}
