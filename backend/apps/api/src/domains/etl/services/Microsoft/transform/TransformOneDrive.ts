import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { type Connection, ConnectionService } from '@ci/domains/connections';
import { FileService } from '@ci/domains/files';
import {
  canonicalSystem,
  ContentService,
  fileIdentity,
  platformIdentity,
  SOURCE_NATIVE_EXTERNAL_ID_KIND,
  type SourceIdentity,
} from '@ci/domains/memory';

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
      // The real Graph id, or null — never the 'unknown' logging fallback,
      // which as a dedup key would collapse every id-less item onto one row.
      const graphItemId = item.content?.id || item.id || null;

      this.logger.log('Processing OneDrive file', {
        itemId,
        itemName,
        mimeType,
      });

      // Create file entity. FileService.create dedupes by externalId (then by
      // content hash, but a pointer row has no bytes to hash), so fall back to
      // the Graph item id when webUrl is missing — with a NULL externalId
      // every re-sync minted another ci.files row for the same item.
      await this.fileService.create(
        { userId },
        {
          filename: itemName,
          contentType: mimeType,
          externalId: webUrl ?? graphItemId,
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
        // Identity: the Graph API reports the bytes' SHA-256 for a stored
        // file (`file.hashes.sha256Hash`), so the row keys on the `file`
        // federated kind — the same pair the import pipeline mints when it
        // uploads those bytes out of a `microsoft_account` export, or any
        // other archive carrying the same document
        // (docs/design/cross-pipeline-identity.md §3.2). Only when Graph gave
        // no hash does the row fall back to the platform item id, which
        // converges with nothing but a re-sync of this connection.
        const identity: SourceIdentity | null = (() => {
          const sha256 = item.content?.file?.hashes?.sha256Hash;
          if (sha256 && /^[0-9a-fA-F]{64}$/.test(sha256)) {
            return fileIdentity(sha256);
          }

          return graphItemId ? platformIdentity('onedrive', graphItemId) : null;
        })();

        // Find-or-skip on the identity pair: content_source_identity_uniq
        // only covers rows with a source_id, and ContentService.create is a
        // plain insert — without this, every re-sync appended another
        // placeholder row per document.
        const existing = identity
          ? await this.contentService.findBySource(
              { userId },
              { source_type: 'ETL', source_system: identity.system, source_id: identity.id },
            )
          : null;

        if (existing) {
          this.logger.debug('OneDrive document content already present; skipping', {
            itemId,
            itemName,
          });
        } else {
          await this.contentService.create(
            { userId },
            {
              connection_id: connectionId,
              type: 'onedrive_document',
              title: itemName,
              text: `OneDrive document: ${itemName}`,
              url: webUrl ?? undefined,
              mimetype: mimeType,
              // OneDrive's OWN item id, not the ci.files row created just above
              // (that one gets its own generated uuid) — joining this against
              // ci.files would find nothing.
              external_id: itemId,
              external_id_kind: SOURCE_NATIVE_EXTERNAL_ID_KIND,
              source_type: identity ? 'ETL' : undefined,
              // Ledger platform: the row may key on the federated `file` kind.
              source_platform: canonicalSystem('onedrive'),
              source_system: identity?.system ?? canonicalSystem('onedrive'),
              source_id: identity?.id,
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
