import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { type Connection, ConnectionService } from '@ci/domains/connections';
import { FileService } from '@ci/domains/files';
import { ContentService } from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';

interface DriveFile {
  id?: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
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

      const files = this.extractDriveFiles(data);

      if (files.length === 0) {
        this.logger.log('No Drive files found to transform', { userId, syncJobId });

        return;
      }

      this.logger.log(`Processing ${files.length} Drive files`, {
        userId,
        syncJobId,
        fileCount: files.length,
      });

      await Promise.all(
        files.map(
          async (file) =>
            await this.processDriveFile({
              file,
              connectionId: connection.id,
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
    connectionId,
  }: {
    file: DriveFile;
    userId: string;
    connectionId: string;
  }): Promise<void> {
    try {
      const fileId = file.id || 'unknown';
      const fileName = file.name || 'Untitled File';
      const mimeType = file.mimeType || 'application/octet-stream';
      const webViewLink = file.webViewLink || null;

      // Skip Google Drive folders
      if (mimeType === 'application/vnd.google-apps.folder') {
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

      // Create file entity
      await this.fileService.create(
        { userId },
        {
          filename: fileName,
          contentType: mimeType,
          externalId: webViewLink,
          size: file.size ? Number(file.size) : null,
          externalUpdatedAt: file.modifiedTime ? new Date(file.modifiedTime) : null,
        },
      );

      // If it's a document type, also create a content entity
      if (this.isDocumentType(mimeType)) {
        await this.contentService.create(
          { userId },
          {
            type: 'google_drive_document',
            title: fileName,
            text: `Google Drive document: ${fileName}`,
            url: webViewLink ?? undefined,
            mimetype: mimeType,
            external_id: fileId,
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
}
