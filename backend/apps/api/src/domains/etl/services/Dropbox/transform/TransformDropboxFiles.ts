import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { type Connection } from '@ci/domains/connections';
import { FileService } from '@ci/domains/files';
import { mimeForFile } from '@ci/domains/import';

import { ConnectionSyncJob } from '../../../types';
import { CloudFileIngestService } from '../../CloudFileIngestService';
import { isDownloadableDocumentType, isPhotoOrVideoType, isZipArchive } from '../../cloudFileTypes';
import { CloudFolderIngestService } from '../../CloudFolderIngestService';
import { dropboxWebLink } from '../dropboxWebLink';
import type { DropboxFile } from '../sync/SyncFiles';

/**
 * Dropbox files, handled the way GoogleDriveTransformService handles Drive's:
 *
 *  - a FOLDER that an importer recognises as a data export (Meta transfers a
 *    Facebook export here as loose files) is set aside whole: its files get no
 *    rows of their own, and once the folder stops changing it is downloaded
 *    and imported as one run — see CloudFolderIngestService;
 *  - a zip that an importer recognises as a data export (a Takeout) is
 *    downloaded and imported by that importer;
 *  - a document (PDF, Office, text) is downloaded and imported for its content;
 *  - photos and videos are downloaded and imported as real media, a sync page
 *    at a time (one import run per page, not per photo);
 *  - anything else gets a pointer row: name, size, modified time and a link.
 *
 * Dropbox reports no content type, so it is inferred from the file name.
 */
@Injectable()
export class DropboxFilesTransformService {
  constructor(
    private readonly fileService: FileService,
    private readonly cloudFileIngestService: CloudFileIngestService,
    private readonly cloudFolderIngestService: CloudFolderIngestService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(DropboxFilesTransformService.name);
  }

  async transform({
    connection,
    syncJob,
  }: {
    connection: Connection;
    syncJob: ConnectionSyncJob;
  }): Promise<void> {
    const { id: syncJobId, userId, data } = syncJob;
    const listed = this.extractFiles(data);

    // Files inside an export folder are that folder's business, not this
    // loop's. Claimed first, so a change seen in this very listing counts
    // against the folder being settled.
    const inExportFolder = await this.cloudFolderIngestService.claimDropboxFiles({
      connection,
      userId,
      files: listed.map((file) => ({ file, path: file.path_lower ?? '' })).filter((entry) => entry.path),
    });
    const claimed = new Set([...inExportFolder].map((entry) => entry.file));
    const files = listed.filter((file) => !claimed.has(file));

    // Every sync tick is also the clock that notices a folder has settled —
    // including the ticks that list nothing, which is what "settled" looks
    // like. Deliberately not awaited: see ingestSettledDropboxFolders.
    void this.cloudFolderIngestService.ingestSettledDropboxFolders({ connection, userId });

    if (files.length === 0) {
      this.logger.log('No Dropbox files found to transform', {
        userId,
        syncJobId,
        inExportFolders: claimed.size,
      });

      return;
    }

    this.logger.log(`Processing ${files.length} Dropbox files`, {
      userId,
      syncJobId,
      inExportFolders: claimed.size,
    });

    const media = files.filter((file) => isPhotoOrVideoType(this.mimeTypeOf(file)));
    const mediaSet = new Set(media);

    await this.processMedia({ media, connection, userId });
    await Promise.all(
      files
        .filter((file) => !mediaSet.has(file))
        .map((file) => this.processFile({ file, connection, userId })),
    );

    this.logger.log('Dropbox transformation completed', { userId, syncJobId, processedCount: files.length });
  }

  private extractFiles(data: unknown): DropboxFile[] {
    const files = (data as { files?: unknown } | null)?.files;

    return Array.isArray(files) ? (files as DropboxFile[]).filter((f) => f?.id && f.name) : [];
  }

  private mimeTypeOf(file: DropboxFile): string {
    return mimeForFile(file.name) ?? 'application/octet-stream';
  }

  /**
   * This page's photos and videos, downloaded together and imported as one
   * run. A file that could not be fetched keeps a pointer row so it is not
   * simply missing; one that was fetched loses any pointer row an earlier
   * sync wrote for it, since the import now holds the real thing.
   */
  private async processMedia({
    media,
    userId,
    connection,
  }: {
    media: DropboxFile[];
    userId: string;
    connection: Connection;
  }): Promise<void> {
    if (media.length === 0) {
      return;
    }

    try {
      const result = await this.cloudFileIngestService.ingestDropboxMedia({
        connection,
        userId,
        files: media.map((file) => ({
          id: file.id,
          name: file.name,
          mimeType: this.mimeTypeOf(file),
          revision: file.rev ?? null,
          size: file.size ?? null,
          // The Dropbox path keeps same-named photos in different folders apart.
          relativePath: (file.path_display ?? file.name).replace(/^\/+/, ''),
        })),
      });
      const byId = new Map(media.map((file) => [file.id, file]));

      for (const { id, reason } of result.failed) {
        const file = byId.get(id)!;

        this.logger.warn('Dropbox media download failed; recording a pointer instead', {
          fileId: id,
          fileName: file.name,
          reason,
        });
        await this.createPointerFile(userId, connection.id, file, this.mimeTypeOf(file));
      }

      const imported = [...result.downloaded, ...result.unchanged]
        .map((id) => dropboxWebLink(byId.get(id)!))
        .filter((link): link is string => link != null);

      await this.fileService.removePointersByExternalIds({ userId }, imported);
    } catch (error) {
      this.logger.error('Error processing Dropbox media', {
        userId,
        connectionId: connection.id,
        files: media.length,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      // Don't throw - the rest of the page still gets processed
    }
  }

  private async processFile({
    file,
    userId,
    connection,
  }: {
    file: DropboxFile;
    userId: string;
    connection: Connection;
  }): Promise<void> {
    try {
      const mimeType = this.mimeTypeOf(file);
      const ingestFile = { id: file.id, name: file.name, mimeType, rev: file.rev ?? null };

      if (isZipArchive(mimeType, file.name)) {
        const result = await this.cloudFileIngestService.ingestDropboxArchive({
          connection,
          userId,
          file: { ...ingestFile, size: file.size ?? null },
        });

        if (result.outcome === 'downloaded') {
          this.logger.log('Dropbox archive recognised as an export; started an import run', {
            fileId: file.id,
            fileName: file.name,
            importers: result.importers,
            runId: result.importRunId,
            byteSize: result.byteSize,
          });
        } else if (result.outcome !== 'skipped_unchanged') {
          await this.createPointerFile(userId, connection.id, file, mimeType);
        }

        return;
      }

      if (isDownloadableDocumentType(mimeType)) {
        // No pointer row beside a successful download: the import run creates
        // its own ci.files/ci.content from the real bytes, and a pointer would
        // be a second row for the same file.
        const result = await this.cloudFileIngestService.ingestDropboxDocument({
          connection,
          userId,
          file: ingestFile,
        });

        if (result.outcome === 'failed') {
          this.logger.warn('Dropbox content download failed; recording a pointer instead', {
            fileId: file.id,
            fileName: file.name,
            reason: result.reason,
          });
          await this.createPointerFile(userId, connection.id, file, mimeType);
        }

        return;
      }

      await this.createPointerFile(userId, connection.id, file, mimeType);
    } catch (error) {
      this.logger.error('Error processing individual Dropbox file', {
        userId,
        connectionId: connection.id,
        fileId: file.id,
        fileName: file.name,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      // Don't throw - continue processing other files
    }
  }

  /** The pointer-only `ci.files` row, same shape as Drive's. */
  private async createPointerFile(
    userId: string,
    connectionId: string,
    file: DropboxFile,
    mimeType: string,
  ): Promise<void> {
    await this.fileService.create(
      { userId },
      {
        connectionId,
        filename: file.name,
        contentType: mimeType,
        externalId: dropboxWebLink(file),
        size: file.size ?? null,
        externalUpdatedAt: file.server_modified ? new Date(file.server_modified) : null,
      },
    );
  }
}
