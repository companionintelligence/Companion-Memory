import { Entity, PrimaryColumn, Column, CreateDateColumn } from 'typeorm';

export type DeletionScope = 'connection' | 'account';
/**
 * `started`: an account delete ended the account and handed its rows to the
 * purge; the `completed` row that follows carries the counts.
 */
export type DeletionStatus = 'started' | 'completed' | 'failed';

/**
 * Append-only audit record of a privacy deletion action (per-connection
 * disconnect or full account deletion). Written by {@link DataDeletionService}
 * for CASA/ASVS V8 accountability: who requested the deletion, when, over what
 * scope, whether the OAuth grant was revoked, and the per-table row counts
 * purged.
 *
 * Intentionally NOT foreign-keyed to `ci.users`: the record must survive
 * deletion of the very user it describes.
 */
@Entity({ schema: 'ci', name: 'data_deletion_audit' })
export class DataDeletionAuditEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid', name: 'subject_user_id' })
  subjectUserId!: string;

  @Column({ type: 'uuid', name: 'requested_by_user_id' })
  requestedByUserId!: string;

  @Column({ type: 'text' })
  scope!: DeletionScope;

  @Column({ type: 'uuid', nullable: true, name: 'connection_id' })
  connectionId!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'provider_id' })
  providerId!: string | null;

  @Column({ type: 'boolean', nullable: true, name: 'token_revoked' })
  tokenRevoked!: boolean | null;

  @Column({ type: 'jsonb', default: {}, name: 'deleted_counts' })
  deletedCounts!: Record<string, number>;

  @Column({ type: 'integer', default: 0, name: 'total_deleted' })
  totalDeleted!: number;

  @Column({ type: 'text', default: 'completed' })
  status!: DeletionStatus;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  static toEgressType(entity: DataDeletionAuditEntity): DataDeletionAudit {
    return {
      id: entity.id,
      subjectUserId: entity.subjectUserId,
      requestedByUserId: entity.requestedByUserId,
      scope: entity.scope,
      connectionId: entity.connectionId,
      providerId: entity.providerId,
      tokenRevoked: entity.tokenRevoked,
      deletedCounts: entity.deletedCounts,
      totalDeleted: entity.totalDeleted,
      status: entity.status,
      error: entity.error,
      createdAt: entity.createdAt,
    };
  }
}

export type DataDeletionAudit = Readonly<DataDeletionAuditEntity>;
