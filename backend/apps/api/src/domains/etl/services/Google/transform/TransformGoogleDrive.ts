import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { type Connection, ConnectionService } from '@ci/domains/connections';
import { FileService } from '@ci/domains/files';
import {
  canonicalSystem,
  ContentService,
  platformIdentity,
  SOURCE_NATIVE_EXTERNAL_ID_KIND,
} from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';
import { CloudFileIngestService } from '../../CloudFileIngestService';
import { isPhotoOrVideoType, isZipArchive } from '../../cloudFileTypes';
import { CloudFolderIngestService } from '../../CloudFolderIngestService';

const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

interface DriveFile {
  id?: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  /** The folder the file is in. Absent for a file that is in none of this drive's folders. */
  parents?: string[];
  owners?: Array<{
    displayName?: string;
    emailAddress?: string;
  }>;
  iconLink?: string;
  webViewLink?: string;
  size?: string;
}

@Injectable()
export class GoogleDriveTransformService {
  constructor(
    private readonly contentService: ContentService,
    private readonly fileService: FileService,
    private readonly connectionService: ConnectionService,
    private readonly cloudFileIngestService: CloudFileIngestService,
    private readonly cloudFolderIngestService: CloudFolderIngestService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(GoogleDriveTransformService.name);
  }

  async transformGoogleDrive({
    connection,
    syncJob,
  }: {
    connection: Connection;
    syncJob: ConnectionSyncJob;
  }): Promise<void> {
    const { id: syncJobId, userId, data } = syncJob;

    try {
      this.logger.log('Starting Google Drive transformation', {
        userId,
        syncJobId,
      });

      const listed = this.extractDriveFiles(data);

      // A FOLDER an importer recognises as a data export (Meta transfers a
      // Facebook export to Drive as loose files, in several part folders) is
      // set aside whole: its files get no rows of their own, and once the
      // folder stops changing it is downloaded and imported as one run — see
      // CloudFolderIngestService. Claimed first, so a change seen in this
      // very listing counts against the folder being settled.
      const isFolder = (file: DriveFile): boolean => file.mimeType === DRIVE_FOLDER_MIME;
      const describe = (file: DriveFile) => ({
        file,
        id: file.id!,
        name: file.name ?? '',
        parents: file.parents,
      });
      const inExportFolder = await this.cloudFolderIngestService.claimDriveFiles({
        connection,
        userId,
        files: listed.filter((file) => file.id && !isFolder(file)).map(describe),
        folders: listed.filter((file) => file.id && isFolder(file)).map(describe),
      });
      const claimed = new Set([...inExportFolder].map((entry) => entry.file));
      const files = listed.filter((file) => !claimed.has(file));

      // Every sync tick is also the clock that notices a folder has settled —
      // including the ticks that list nothing, which is what "settled" looks
      // like. Deliberately not awaited: see ingestSettledDropboxFolders.
      void this.cloudFolderIngestService.ingestSettledDriveFolders({ connection, userId });

      if (files.length === 0) {
        this.logger.log('No Drive files found to transform', {
          userId,
          syncJobId,
          inExportFolders: claimed.size,
        });

        return;
      }

      this.logger.log(`Processing ${files.length} Drive files`, {
        userId,
        syncJobId,
        fileCount: files.length,
        inExportFolders: claimed.size,
      });

      // Photos and videos go together, as one download and one import run
      // for the page; everything else is handled file by file.
      const media = files.filter(
        (file) =>
          file.id && isPhotoOrVideoType(file.mimeType) && !isZipArchive(file.mimeType, file.name ?? ''),
      );
      const mediaSet = new Set(media);

      await this.processDriveMedia({ media, connection, userId });
      await Promise.all(
        files
          .filter((file) => !mediaSet.has(file))
          .map(
            async (file) =>
              await this.processDriveFile({
                file,
                connection,
                userId,
              }),
          ),
      );

      this.logger.log('Google Drive transformation completed', {
        userId,
        syncJobId,
        processedCount: files.length,
      });
    } catch (error: unknown) {
      this.logger.error('Error transforming Google Drive files', {
        userId,
        syncJobId,
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  /**
   * This page's photos and videos, downloaded and imported as real media
   * rather than left as a name and a link. A file that could not be fetched
   * keeps its pointer row so it is not simply missing; one that was fetched
   * loses any pointer row an earlier sync wrote for it.
   */
  private async processDriveMedia({
    media,
    userId,
    connection,
  }: {
    media: DriveFile[];
    userId: string;
    connection: Connection;
  }): Promise<void> {
    if (media.length === 0) {
      return;
    }

    try {
      const result = await this.cloudFileIngestService.ingestDriveMedia({
        connection,
        userId,
        files: media.map((file) => ({
          id: file.id!,
          name: file.name || 'Untitled File',
          mimeType: file.mimeType!,
          revision: file.modifiedTime ?? null,
          size: file.size != null ? Number(file.size) : null,
          // Drive lists names, not paths, and names repeat; the file id keeps
          // two IMG_0001.jpg apart.
          // (A Drive name may itself contain a slash, which a path cannot.)
          relativePath: `${file.id}/${(file.name || 'Untitled File').replace(/[\\/]/g, '_')}`,
        })),
      });
      const byId = new Map(media.map((file) => [file.id!, file]));

      for (const { id, reason } of result.failed) {
        const file = byId.get(id)!;

        this.logger.warn('Drive media download failed; recording a pointer instead', {
          fileId: id,
          fileName: file.name,
          reason,
        });
        await this.createPointerFile({
          userId,
          connectionId: connection.id,
          fileName: file.name || 'Untitled File',
          mimeType: file.mimeType!,
          webViewLink: file.webViewLink || null,
          file,
        });
      }

      const imported = [...result.downloaded, ...result.unchanged]
        .map((id) => byId.get(id)!.webViewLink)
        .filter((link): link is string => !!link);

      await this.fileService.removePointersByExternalIds({ userId }, imported);
    } catch (error) {
      this.logger.error('Error processing Drive media', {
        userId,
        connectionId: connection.id,
        files: media.length,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      // Don't throw - the rest of the page still gets processed
    }
  }

  private extractDriveFiles(data: unknown): DriveFile[] {
    if (!data || typeof data !== 'object') {
      this.logger.warn('Invalid data type for Drive files', {
        dataType: typeof data,
      });

      return [];
    }

    const dataObj = data as Record<string, unknown>;

    // Handle the structure from Google Drive API
    if ('files' in dataObj && Array.isArray(dataObj.files)) {
      return dataObj.files as DriveFile[];
    }

    if ('id' in dataObj && 'name' in dataObj && 'mimeType' in dataObj) {
      return [dataObj as DriveFile];
    }

    this.logger.warn('No Drive files found in data', {
      dataKeys: Object.keys(dataObj),
    });

    return [];
  }

  private async processDriveFile({
    file,
    userId,
    connection,
  }: {
    file: DriveFile;
    userId: string;
    connection: Connection;
  }): Promise<void> {
    const connectionId = connection.id;

    try {
      const fileId = file.id || 'unknown';
      const fileName = file.name || 'Untitled File';
      const mimeType = file.mimeType || 'application/octet-stream';
      const webViewLink = file.webViewLink || null;

      // Skip Google Drive folders
      if (mimeType === DRIVE_FOLDER_MIME) {
        this.logger.debug('Skipping Google Drive folder', {
          userId,
          connectionId,
          fileId,
          fileName,
        });

        return;
      }

      this.logger.log('Processing Drive file', {
        fileId,
        fileName,
        mimeType,
      });

      if (isZipArchive(mimeType, fileName)) {
        // A zip MAY be an export an importer reads (a Facebook "Download your
        // information" archive synced to Drive, a Takeout). The ingest service
        // decides from the archive's file listing, and downloads + imports it
        // only when a specific importer claims it. Everything else — and a
        // failure, which the ledger retries next tick — is an ordinary Drive
        // file: the same pointer row every other non-document gets.
        const size = file.size != null ? Number(file.size) : null;
        const result = await this.cloudFileIngestService.ingestDriveArchive({
          connection,
          userId,
          file: { id: fileId, name: fileName, mimeType, modifiedTime: file.modifiedTime ?? null, size },
        });

        if (result.outcome === 'downloaded') {
          this.logger.log('Drive archive recognised as an export; started an import run', {
            fileId,
            fileName,
            importers: result.importers,
            runId: result.importRunId,
            byteSize: result.byteSize,
          });
        } else if (result.outcome !== 'skipped_unchanged') {
          await this.createPointerFile({ userId, connectionId, fileName, mimeType, webViewLink, file });
        }
      } else if (this.isDownloadableDocumentType(mimeType)) {
        // A document whose bytes we can actually fetch (alt=media) rather
        // than a native Google type that would need /export?mimeType= — see
        // CloudFileIngestService's docstring for why that mapping isn't
        // built yet. No pointer ci.files row is created here: a successful
        // download hands real bytes to the import pipeline, which creates
        // its OWN ci.files/ci.content from the actual content, and creating
        // a pointer row alongside it would leave two rows for one Drive file.
        const result = await this.cloudFileIngestService.ingestDriveDocument({
          connection,
          userId,
          file: { id: fileId, name: fileName, mimeType, modifiedTime: file.modifiedTime ?? null },
        });

        if (result.outcome === 'failed') {
          // Downloading failed even after retry. Fall back to today's
          // pointer + placeholder behavior so the file is not simply
          // invisible — degraded, but present — and log it clearly. The
          // ledger's 'failed' row means the NEXT sync tick tries the real
          // download again automatically.
          this.logger.warn('Drive content download failed; recording a placeholder instead', {
            fileId,
            fileName,
            reason: result.reason,
          });

          await this.createPointerFile({ userId, connectionId, fileName, mimeType, webViewLink, file });
          await this.createPlaceholderContent({
            userId,
            connectionId,
            fileId,
            fileName,
            mimeType,
            webViewLink,
          });
        } else if (result.outcome === 'downloaded') {
          this.logger.log('Downloaded Drive document content and started an import run', {
            fileId,
            fileName,
            dropId: result.dropId,
            runId: result.importRunId,
            byteSize: result.byteSize,
          });
        } else {
          this.logger.debug('Drive document unchanged since last sync; skipped re-download', {
            fileId,
            fileName,
            revision: result.revision,
          });
        }
      } else if (this.isDocumentType(mimeType)) {
        // A native Google Docs/Sheets/Slides/Forms/Drawing file. Content
        // download for these needs /export?mimeType=<exportMime>, not
        // alt=media — deliberately out of scope for this pass (see the
        // audit's notDone). Keep today's pointer + placeholder behavior.
        await this.createPointerFile({ userId, connectionId, fileName, mimeType, webViewLink, file });
        await this.createPlaceholderContent({
          userId,
          connectionId,
          fileId,
          fileName,
          mimeType,
          webViewLink,
        });
      } else {
        // Neither a document nor media (photos and videos were taken out
        // before this loop) — nothing here to read, so a pointer it is.
        await this.createPointerFile({ userId, connectionId, fileName, mimeType, webViewLink, file });
      }

      this.logger.log('Drive file saved successfully', {
        fileId,
        fileName,
        mimeType,
      });
    } catch (error) {
      this.logger.error('Error processing individual Drive file', {
        userId,
        connectionId,
        fileId: file.id,
        fileName: file.name,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      // Don't throw - continue processing other files
    }
  }

  /** The pointer-only `ci.files` row: today's whole behavior for non-content files. */
  private async createPointerFile({
    userId,
    connectionId,
    fileName,
    mimeType,
    webViewLink,
    file,
  }: {
    userId: string;
    connectionId: string;
    fileName: string;
    mimeType: string;
    webViewLink: string | null;
    file: DriveFile;
  }): Promise<void> {
    await this.fileService.create(
      { userId },
      {
        // So disconnecting Drive removes the pointer rows it wrote.
        connectionId,
        filename: fileName,
        contentType: mimeType,
        externalId: webViewLink,
        size: file.size ? Number(file.size) : null,
        externalUpdatedAt: file.modifiedTime ? new Date(file.modifiedTime) : null,
      },
    );
  }

  /** The `Google Drive document: <name>` placeholder content entity. */
  private async createPlaceholderContent({
    userId,
    connectionId,
    fileId,
    fileName,
    mimeType,
    webViewLink,
  }: {
    userId: string;
    connectionId: string;
    fileId: string;
    fileName: string;
    mimeType: string;
    webViewLink: string | null;
  }): Promise<void> {
    // The real Drive id, or undefined — never the 'unknown' logging fallback,
    // which as a dedup key would collapse every id-less file onto one row.
    const sourceId = fileId !== 'unknown' ? fileId : undefined;

    // Find-or-skip on the provenance triple: content_source_identity_uniq only
    // covers rows with a source_id, and ContentService.create is a plain
    // insert — without this, every re-sync appended another placeholder row
    // per document.
    const existing = sourceId
      ? await this.contentService.findBySource(
          { userId },
          { source_type: 'ETL', source_system: 'google_drive', source_id: sourceId },
        )
      : null;

    if (existing) {
      this.logger.debug('Drive document content already present; skipping', {
        fileId,
        fileName,
      });

      return;
    }

    await this.contentService.create(
      { userId },
      {
        connection_id: connectionId,
        type: 'google_drive_document',
        title: fileName,
        text: `Google Drive document: ${fileName}`,
        url: webViewLink ?? undefined,
        mimetype: mimeType,
        // Google Drive's OWN file id, not the ci.files row created just
        // above (that one gets its own generated uuid) — joining this
        // against ci.files would find nothing.
        external_id: fileId,
        external_id_kind: SOURCE_NATIVE_EXTERNAL_ID_KIND,
        source_type: sourceId ? 'ETL' : undefined,
        source_system: sourceId ? canonicalSystem('google_drive') : undefined,
        source_id: sourceId ? platformIdentity('google_drive', sourceId).id : undefined,
        user: {
          id: userId,
        },
      },
    );

    this.logger.log('Created content entity for Drive document', {
      fileId,
      fileName,
    });
  }

  /**
   * Every mimeType that gets document-style handling at all — either a real
   * content download (the downloadable subset below) or, for native Google
   * types, today's placeholder.
   */
  private isDocumentType(mimeType: string): boolean {
    const documentTypes = [
      'application/vnd.google-apps.document',
      'application/vnd.google-apps.spreadsheet',
      'application/vnd.google-apps.presentation',
      'application/vnd.google-apps.form',
      'application/vnd.google-apps.drawing',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/plain',
      'text/html',
      'text/markdown',
    ];

    return documentTypes.includes(mimeType);
  }

  /**
   * The five Google-native editor formats, whose bytes live behind
   * `/export?mimeType=`, not `/files/{id}?alt=media` — Drive answers
   * `alt=media` on these with a 403 ("Only files with binary content can be
   * downloaded"). Not implemented this pass; see CloudFileIngestService's
   * docstring.
   */
  private isNativeGoogleType(mimeType: string): boolean {
    const nativeTypes = [
      'application/vnd.google-apps.document',
      'application/vnd.google-apps.spreadsheet',
      'application/vnd.google-apps.presentation',
      'application/vnd.google-apps.form',
      'application/vnd.google-apps.drawing',
    ];

    return nativeTypes.includes(mimeType);
  }

  /** isDocumentType(mimeType) minus the native Google types alt=media can't read. */
  private isDownloadableDocumentType(mimeType: string): boolean {
    return this.isDocumentType(mimeType) && !this.isNativeGoogleType(mimeType);
  }
}
