import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * 'downloaded' — the bytes reached the uploads dir and an import run was
 * started for them; this is the state the skip-check in
 * {@link CloudFileIngestLedgerService.findCurrent} looks for. 'failed' —
 * every attempt in the download-with-retry loop failed; the row still
 * records what was tried so the NEXT sync tick retries automatically (a
 * 'failed' row never satisfies the skip check).
 */
export type CloudFileIngestStatus = 'downloaded' | 'failed';

/**
 * One row per (connection, provider file id) — the download ledger described
 * in migration 20260821224650_create_cloud_file_ingests. `provider` is
 * 'google_drive' today; every other column already generalizes to a future
 * Dropbox/OneDrive equivalent (an opaque revision string, a hash of what was
 * actually staged), so extending this table is expected to mean a new
 * `provider` value, not a new table.
 */
export interface CloudFileIngest {
  id: string;
  userId: string;
  connectionId: string;
  provider: string;
  externalFileId: string;
  revision: string;
  contentSha256: string | null;
  byteSize: number | null;
  status: CloudFileIngestStatus;
  dropId: string | null;
  importRunId: string | null;
  attemptCount: number;
  lastError: string | null;
  downloadedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

@Entity({ schema: 'ci_etl', name: 'cloud_file_ingests' })
@Index('cloud_file_ingests_connection_external_file_uq', ['connectionId', 'externalFileId'], { unique: true })
@Index('cloud_file_ingests_user_provider_idx', ['userId', 'provider'])
export class CloudFileIngestEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'uuid', name: 'connection_id' })
  connectionId!: string;

  @Column({ type: 'text' })
  provider!: string;

  /**
   * The file id AT THE PROVIDER (Google Drive's `id`), never the ci.files
   * row this ingest may eventually produce — the same caution
   * TransformGoogleDrive.ts documents at its own `external_id` field.
   */
  @Column({ type: 'text', name: 'external_file_id' })
  externalFileId!: string;

  /** The provider's change signal as of the last successful download. */
  @Column({ type: 'text' })
  revision!: string;

  @Column({ type: 'text', name: 'content_sha256', nullable: true })
  contentSha256!: string | null;

  @Column({ type: 'bigint', name: 'byte_size', nullable: true })
  byteSize!: number | null;

  @Column({ type: 'text', default: 'downloaded' })
  status!: CloudFileIngestStatus;

  @Column({ type: 'uuid', name: 'drop_id', nullable: true })
  dropId!: string | null;

  @Column({ type: 'uuid', name: 'import_run_id', nullable: true })
  importRunId!: string | null;

  /** From the MOST RECENT sync attempt — not a lifetime total. See the migration. */
  @Column({ type: 'integer', name: 'attempt_count', default: 1 })
  attemptCount!: number;

  @Column({ type: 'text', name: 'last_error', nullable: true })
  lastError!: string | null;

  @Column({ type: 'timestamptz', name: 'downloaded_at', nullable: true })
  downloadedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  static toEgressType(entity: CloudFileIngestEntity): CloudFileIngest {
    return {
      id: entity.id,
      userId: entity.userId,
      connectionId: entity.connectionId,
      provider: entity.provider,
      externalFileId: entity.externalFileId,
      revision: entity.revision,
      contentSha256: entity.contentSha256,
      byteSize: entity.byteSize,
      status: entity.status,
      dropId: entity.dropId,
      importRunId: entity.importRunId,
      attemptCount: entity.attemptCount,
      lastError: entity.lastError,
      downloadedAt: entity.downloadedAt,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}
