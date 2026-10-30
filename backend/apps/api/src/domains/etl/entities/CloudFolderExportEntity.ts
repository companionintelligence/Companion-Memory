import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * 'collecting' — files are still arriving; wait for the folder to stop
 * changing. 'downloading' — a download is running (`updatedAt` is its
 * heartbeat). 'imported' — downloaded whole, import run started. A failed
 * download returns to 'collecting' with `lastError` set; so does a folder
 * that settled before anything an importer reads had arrived in it, with
 * `lastError` saying it is waiting.
 */
export type CloudFolderExportStatus = 'collecting' | 'downloading' | 'imported';

/**
 * One data export that lives in a cloud drive as a folder of loose files — see
 * migration 20261005214655_create_cloud_folder_exports for why a folder needs
 * its own ledger rather than a row per file.
 */
export interface CloudFolderExport {
  id: string;
  userId: string;
  connectionId: string;
  provider: string;
  rootPath: string;
  importers: string[];
  status: CloudFolderExportStatus;
  lastChangeAt: Date;
  fileCount: number | null;
  byteSize: number | null;
  dropId: string | null;
  importRunId: string | null;
  attemptCount: number;
  lastError: string | null;
  importedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

@Entity({ schema: 'ci_etl', name: 'cloud_folder_exports' })
@Index('cloud_folder_exports_connection_id_root_path_key', ['connectionId', 'rootPath'], { unique: true })
@Index('cloud_folder_exports_user_provider_idx', ['userId', 'provider'])
export class CloudFolderExportEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'uuid', name: 'connection_id' })
  connectionId!: string;

  @Column({ type: 'text' })
  provider!: string;

  /** The provider's normalized folder path (Dropbox: `path_lower`). */
  @Column({ type: 'text', name: 'root_path' })
  rootPath!: string;

  @Column({ type: 'text', array: true })
  importers!: string[];

  @Column({ type: 'text', default: 'collecting' })
  status!: CloudFolderExportStatus;

  @Column({ type: 'timestamptz', name: 'last_change_at' })
  lastChangeAt!: Date;

  @Column({ type: 'integer', name: 'file_count', nullable: true })
  fileCount!: number | null;

  @Column({ type: 'bigint', name: 'byte_size', nullable: true })
  byteSize!: number | null;

  @Column({ type: 'uuid', name: 'drop_id', nullable: true })
  dropId!: string | null;

  @Column({ type: 'uuid', name: 'import_run_id', nullable: true })
  importRunId!: string | null;

  @Column({ type: 'integer', name: 'attempt_count', default: 0 })
  attemptCount!: number;

  @Column({ type: 'text', name: 'last_error', nullable: true })
  lastError!: string | null;

  @Column({ type: 'timestamptz', name: 'imported_at', nullable: true })
  importedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  static toEgressType(entity: CloudFolderExportEntity): CloudFolderExport {
    return {
      id: entity.id,
      userId: entity.userId,
      connectionId: entity.connectionId,
      provider: entity.provider,
      rootPath: entity.rootPath,
      importers: entity.importers,
      status: entity.status,
      lastChangeAt: entity.lastChangeAt,
      fileCount: entity.fileCount,
      byteSize: entity.byteSize == null ? null : Number(entity.byteSize),
      dropId: entity.dropId,
      importRunId: entity.importRunId,
      attemptCount: entity.attemptCount,
      lastError: entity.lastError,
      importedAt: entity.importedAt,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}
