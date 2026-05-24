import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { type Connection, ConnectionService } from '@ci/domains/connections';
import { FileService } from '@ci/domains/files';
import { ContentService } from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';

interface OneDriveItem {
  id?: string;
  name?: string;
  size?: number;
  file?: {
    mimeType?: string;
  };
  folder?: {
    childCount?: number;
  };
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  webUrl?: string;
  parentReference?: {
    path?: string;
  };
  content?: {
    id: string;
    file: {
      hashes: {
        sha1Hash: string;
        sha256Hash: string;
        quickXorHash: string;
      };
      mimeType: string;
    };
    name: string;
    size: number;
    image?: {
      width: number;
      height: number;
    };
    video?: {
      width: number;
      height: number;
      bitrate: number;
      duration: number;
      frameRate: number;
      audioChannels: number;
      audioBitsPerSample: number;
      audioSamplesPerSecond: number;
      fourceCC: string;
    };
    photo?: {
      orientation: number;
      takenDateTime: string;
    };
    webUrl: string;
    createdBy?: {
      user: {
        displayName?: string;
        id: string;
        email?: string;
      };
    };
    lastModifiedDateTime?: string;
    '@microsoft.graph.downloadUrl': string;
  };
}

@Injectable()
export class OneDriveTransformService {
  constructor(
    private readonly contentService: ContentService,
    private readonly fileService: FileService,
    private readonly connectionService: ConnectionService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(OneDriveTransformService.name);
  }

  async transformOneDrive({
    connection,
    syncJob,
  }: {
    connection: Connection;
    syncJob: ConnectionSyncJob;
  }): Promise<void> {
    const { id: syncJobId, userId, data } = syncJob;

    try {
      this.logger.log('Starting OneDrive transformation', {
        userId,
        syncJobId,
      });

      const items = this.extractOneDriveItems(data);

      if (items.length === 0) {
        this.logger.log('No OneDrive items found to transform', { userId, syncJobId });

        return;
      }

      this.logger.log(`Processing ${items.length} OneDrive items`, {
        userId,
        syncJobId,
        itemCount: items.length,
      });

      await Promise.all(
        items.map(
          async (item) =>
            await this.processOneDriveItem({
              item,
              connectionId: connection.id,
              userId,
            }),
        ),
      );

      this.logger.log('OneDrive transformation completed', {
        userId,
        syncJobId,
        processedCount: items.length,
      });
    } catch (error: unknown) {
      this.logger.error('Error transforming OneDrive items', {
        userId,
        syncJobId,
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  private extractOneDriveItems(data: unknown): OneDriveItem[] {
    if (!data || typeof data !== 'object') {
      this.logger.warn('Invalid data type for OneDrive items', {
        dataType: typeof data,
      });

      return [];
    }

    const dataObj = data as Record<string, unknown>;

    // Handle the structure from Microsoft Graph API
    if ('files' in dataObj && Array.isArray(dataObj.files)) {
      return dataObj.files as OneDriveItem[];
    }

    if ('id' in dataObj && 'name' in dataObj) {
      return [dataObj as OneDriveItem];
    }

    this.logger.warn('No OneDrive items found in data', {
      dataKeys: Object.keys(dataObj),
    });

    return [];
  }

  private async processOneDriveItem({
    item,
    userId,
    connectionId,
  }: {
    item: OneDriveItem;
    userId: string;
    connectionId: string;
  }): Promise<void> {
    try {
      const itemId = item.content?.id || item.id || 'unknown';
      const itemName = item.content?.name || item.name || 'Untitled Item';

      // Skip folders
      if (item.folder) {
        this.logger.debug('Skipping OneDrive folder', {
          userId,
          connectionId,
          itemId,
          itemName,
        });

        return;
      }

      const mimeType = item.content?.file?.mimeType || item.file?.mimeType || 'application/octet-stream';
      const webUrl = item.content?.webUrl || item.webUrl || null;

      this.logger.log('Processing OneDrive file', {
        itemId,
        itemName,
        mimeType,
      });

      console.log('Processing OneDrive item', item);
      // Create file entity
      await this.fileService.create(
        { userId },
        {
          filename: itemName,
          contentType: mimeType,
          externalId: webUrl,
          size: item.content?.size || item.size || null,
          height: item.content?.image?.height || item.content?.video?.height || null,
          width: item.content?.image?.width || item.content?.video?.width || null,
          externalCreatedAt: item?.content?.photo?.takenDateTime
            ? new Date(item?.content?.photo?.takenDateTime)
            : item.createdDateTime
              ? new Date(item.createdDateTime)
              : null,
          externalUpdatedAt: item.lastModifiedDateTime ? new Date(item.lastModifiedDateTime) : null,
        },
      );

      // If it's a document type, also create a content entity
      if (this.isDocumentType(mimeType)) {
        await this.contentService.create(
          { userId },
          {
            type: 'onedrive_document',
            title: itemName,
            text: `OneDrive document: ${itemName}`,
            url: webUrl ?? undefined,
            mimetype: mimeType,
            external_id: itemId,
            user: {
              id: userId,
            },
          },
        );

        this.logger.log('Created content entity for OneDrive document', {
          itemId,
          itemName,
        });
      }

      this.logger.log('OneDrive file saved successfully', {
        itemId,
        itemName,
        mimeType,
      });
    } catch (error) {
      this.logger.error('Error processing individual OneDrive file', {
        userId,
        connectionId,
        itemId: item.id,
        itemName: item.name,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      // Don't throw - continue processing other files
    }
  }

  private isDocumentType(mimeType: string): boolean {
    const documentTypes = [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/msword',
      'application/vnd.ms-excel',
      'application/vnd.ms-powerpoint',
      'application/pdf',
      'text/plain',
      'text/html',
      'text/markdown',
    ];

    return documentTypes.includes(mimeType);
  }
}
