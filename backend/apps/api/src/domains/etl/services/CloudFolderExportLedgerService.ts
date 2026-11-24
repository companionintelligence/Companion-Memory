import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';

import type { CloudFolderExport } from '../entities/CloudFolderExportEntity';

/**
 * A folder is "settled" once no sync has seen a file under it change for this
 * long. Meta wrote a small Facebook export to Dropbox over 40 minutes, a few
 * files at a time, so the window has to span several of the ten-minute
 * incremental ticks: importing a half-written export would leave its media
 * with nothing to attach to.
 */
export const FOLDER_SETTLE_MS = 20 * 60 * 1000;

/**
 * A 'downloading' row whose heartbeat is older than this was abandoned (the
 * process died mid-download) and may be claimed again.
 */
export const FOLDER_DOWNLOAD_STALE_MS = 15 * 60 * 1000;

const COLUMNS = `id, user_id AS "userId", connection_id AS "connectionId", provider, root_path AS "rootPath",
  importers, status, last_change_at AS "lastChangeAt", file_count AS "fileCount", byte_size::float8 AS "byteSize",
  drop_id AS "dropId", import_run_id AS "importRunId", attempt_count AS "attemptCount",
  last_error AS "lastError", imported_at AS "importedAt", created_at AS "createdAt", updated_at AS "updatedAt"`;

interface FolderKey {
  connectionId: string;
  provider: string;
}

/**
 * The ledger of cloud folders recognised as data exports. Raw SQL, because
 * every state change here is a conditional UPDATE whose WHERE clause is the
 * concurrency control — two sync ticks must not both start downloading the
 * same folder — and that is clearer written than assembled.
 */
@Injectable()
export class CloudFolderExportLedgerService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Every export folder known for this connection, whatever its state. */
  async listForConnection(ctx: UserServiceContext, key: FolderKey): Promise<CloudFolderExport[]> {
    return this.dataSource.query<CloudFolderExport[]>(
      `SELECT ${COLUMNS} FROM ci_etl.cloud_folder_exports
        WHERE user_id = $1::uuid AND connection_id = $2::uuid AND provider = $3`,
      [ctx.userId, key.connectionId, key.provider],
    );
  }

  /**
   * A sync saw files under `rootPath`: record the folder if it is new, and
   * either way note that it changed just now. An export that was already
   * imported goes back to 'collecting' — the provider wrote more into it — and
   * will be downloaded again once it settles; the importers' ids are stable,
   * so a second import adds only what is new.
   *
   * A folder that is mid-download keeps its state: the download is reading a
   * listing that may predate this change, and the bumped `last_change_at`
   * is what makes the finish step send it round again (see markImported).
   */
  async recordChange(
    ctx: UserServiceContext,
    key: FolderKey & { rootPath: string; importers: string[] },
  ): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO ci_etl.cloud_folder_exports (user_id, connection_id, provider, root_path, importers)
            VALUES ($1::uuid, $2::uuid, $3, $4, $5::text[])
       ON CONFLICT (connection_id, root_path) DO UPDATE
              SET last_change_at = now(),
                  updated_at = now(),
                  importers = (SELECT array_agg(DISTINCT name)
                                 FROM unnest(ci_etl.cloud_folder_exports.importers || EXCLUDED.importers) AS name),
                  status = CASE WHEN ci_etl.cloud_folder_exports.status = 'imported'
                                THEN 'collecting' ELSE ci_etl.cloud_folder_exports.status END`,
      [ctx.userId, key.connectionId, key.provider, key.rootPath, key.importers],
    );
  }

  /**
   * Take every folder of this connection that is ready to download — settled
   * and still 'collecting', or abandoned mid-download — and mark it
   * 'downloading'. The UPDATE is the claim: a folder is returned to exactly
   * one caller.
   */
  async claimSettled(ctx: UserServiceContext, key: FolderKey): Promise<CloudFolderExport[]> {
    const rows = await this.dataSource.query<CloudFolderExport[] | [CloudFolderExport[], number]>(
      `UPDATE ci_etl.cloud_folder_exports
          SET status = 'downloading', attempt_count = attempt_count + 1, updated_at = now()
        WHERE user_id = $1::uuid AND connection_id = $2::uuid AND provider = $3
          AND ((status = 'collecting' AND last_change_at < now() - make_interval(secs => $4::float8 / 1000))
            OR (status = 'downloading' AND updated_at < now() - make_interval(secs => $5::float8 / 1000)))
      RETURNING ${COLUMNS}`,
      [ctx.userId, key.connectionId, key.provider, FOLDER_SETTLE_MS, FOLDER_DOWNLOAD_STALE_MS],
    );

    // node-postgres answers an UPDATE … RETURNING as [rows, affectedCount].
    return Array.isArray(rows[0]) ? rows[0] : (rows as CloudFolderExport[]);
  }

  /** The download is still alive. */
  async heartbeat(id: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE ci_etl.cloud_folder_exports SET updated_at = now() WHERE id = $1::uuid AND status = 'downloading'`,
      [id],
    );
  }

  /**
   * The folder was downloaded and a run started. If a sync saw it change
   * AFTER this download was claimed, the copy just imported may be short of
   * those files, so the row goes back to 'collecting' instead and the folder
   * is fetched again once it settles.
   */
  async markImported(
    id: string,
    result: { claimedAt: Date; fileCount: number; byteSize: number; dropId: string; importRunId: string },
  ): Promise<void> {
    await this.dataSource.query(
      `UPDATE ci_etl.cloud_folder_exports
          SET status = CASE WHEN last_change_at > $2::timestamptz THEN 'collecting' ELSE 'imported' END,
              file_count = $3, byte_size = $4, drop_id = $5::uuid, import_run_id = $6::uuid,
              last_error = NULL, imported_at = now(), updated_at = now()
        WHERE id = $1::uuid`,
      [id, result.claimedAt, result.fileCount, result.byteSize, result.dropId, result.importRunId],
    );
  }

  /**
   * The folder settled, but nothing in it is something its importers read
   * yet: the service that writes it has paused, not finished. Nothing was
   * downloaded. The row waits out another settle window from NOW before it
   * is looked at again (sooner sightings of a change restart the window as
   * usual), with the reason where a failure's would be.
   */
  async markWaiting(id: string, result: { fileCount: number; reason: string }): Promise<void> {
    await this.dataSource.query(
      `UPDATE ci_etl.cloud_folder_exports
          SET status = 'collecting', last_change_at = now(), file_count = $2, last_error = $3, updated_at = now()
        WHERE id = $1::uuid`,
      [id, result.fileCount, result.reason],
    );
  }

  /** The download failed; the next sync tick that finds it settled tries again. */
  async markFailed(id: string, error: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE ci_etl.cloud_folder_exports
          SET status = 'collecting', last_error = $2, updated_at = now()
        WHERE id = $1::uuid`,
      [id, error],
    );
  }
}
