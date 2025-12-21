import { createHmac } from 'crypto';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';

import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';
import { ConnectionService } from '@ci/domains/connections';
import { OneDrivePageEntity, OneDriveFileEntity } from '@ci/domains/connections/clients/MicrosoftClient';
import { FileService as FileStorageService } from '@ci/domains/files';
import { EventService as MemoryEventService } from '@ci/domains/memory';

import { PromoteService } from '../PromoteService';

interface RawData {
  data: object;
  syncState: object;
}

interface FileParticipant {
  email: string;
  name: string;
}

interface ExtractedFile {
  id: string;
  startTime: Date;
  participants: FileParticipant[];
  content?: OneDriveFileEntity;
}

@Injectable()
export class OneDrivePromotionService {
  constructor(
    private readonly eventService: MemoryEventService,
    private readonly connectionService: ConnectionService,
    private readonly fileStorageService: FileStorageService,
    private readonly promoteService: PromoteService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(OneDrivePromotionService.name);
  }

  async promoteOneDriveFiles(apiLogContent: unknown, userId: string, connectionId: string): Promise<void> {
    this.logger.log('Starting OneDrive file promotion', {
      userId,
      connectionId,
      contentType: typeof apiLogContent,
      contentKeys: apiLogContent && typeof apiLogContent === 'object' ? Object.keys(apiLogContent) : [],
    });

    // Extract event ids from the API log content
    const files = this.extractOneDriveFiles(apiLogContent as RawData[]);

    // Get the connection
    const connection = await this.connectionService.findById({ userId }, connectionId);
    if (!connection || !connection.accessToken) {
      this.logger.error('Connection not found or missing access token', { connectionId });

      return;
    }

    // Process each event individually
    for (const file of files) {
      if (!file.id) {
        this.logger.warn('Skipping event without ID', { file });
        continue;
      }

      // Process the event
      await this.processOneDriveFile(file, userId, connectionId);
    }
  }

  private extractOneDriveFiles(content: RawData[]): OneDrivePageEntity[] {
    if (!content || typeof content !== 'object') {
      this.logger.warn('Invalid content type for OutlookCalendar events', {
        contentType: typeof content,
        contentNull: content === null,
      });

      return [];
    }

    let returned = [] as OneDrivePageEntity[];

    content.map((obj) => {
      const dataObj = obj.data as Record<string, unknown>;

      // Handle the structure from OutlookCalendar API - events array
      if (dataObj.files && Array.isArray(dataObj.files)) {
        this.logger.log('Extracting events from events array', {
          eventCount: dataObj.files.length,
        });

        returned = returned.concat(dataObj.files as OneDrivePageEntity[]);
      }

      if (returned.length === 0) {
        this.logger.warn('No files found in content', {
          contentKeys: Object.keys(dataObj),
        });
      }
    });

    return returned;
  }

  private async processOneDriveFile(
    file: OneDrivePageEntity,
    userId: string,
    connectionId: string,
  ): Promise<void> {
    // Extract event details
    const fileDetails = await this.extractFileDetails(file);

    this.logger.log('Processing OneDrive file', {
      eventId: fileDetails.id,
    });

    const participantEntityIds = await this.promoteService.processParticipants(
      fileDetails.participants,
      userId,
      connectionId,
      'drive',
      'EDITED_WITH',
    );

    if (fileDetails.content) {
      if (fileDetails.content['@microsoft.graph.downloadUrl']) {
        const downloadResponse = await fetch(fileDetails.content['@microsoft.graph.downloadUrl']);
        fileDetails.content.raw = await buffer(downloadResponse.body!);
      }

      const buff = fileDetails.content.raw ? fileDetails.content.raw : Buffer.from('');
      const fileHash = createHmac('sha256', config.auth.session.fieldPepper).update(buff).digest('hex');

      const existingFiles = await this.fileStorageService.search(
        { userId },
        {
          contentType: fileDetails.content.file?.mimeType,
          size: fileDetails.content.size,
          fileHash: fileHash,
          filename: fileDetails.content.name,
        },
      );

      if (existingFiles.length === 0) {
        await this.fileStorageService.upload(
          { userId },
          {
            fieldname: 'attachment', //Multer requires this, but it's not actually used in our logic
            originalname: fileDetails.content.name, //Multer requires this, but it's not actually used in our logic
            mimetype: fileDetails.content.file?.mimeType,
            size: fileDetails.content.size,
            encoding: 'base64',
            destination: '',
            stream: '' as unknown as Readable,
            filename: fileDetails.content.name,
            path: '',
            buffer: buff,
          },
        );
      }
    }

    const existingEvents = await this.eventService.search(
      { userId },
      {
        start_time: new Date(fileDetails.startTime),
        title: 'Edited ' + fileDetails.content?.name,
        category: 'document_edit',
        source_system: 'Microsoft OneDrive',
        event_type: 'work',
        source_type: 'ETL',
      },
    );

    if (existingEvents.length === 0) {
      await this.eventService.create(
        { userId },
        {
          id: uuidv7(),
          start_time: new Date(fileDetails.startTime),
          title: 'Edited ' + fileDetails.content?.name,
          user: {
            id: userId,
          },
          category: 'document_edit',
          source_system: 'Microsoft OneDrive',
          event_type: 'work',
          source_type: 'ETL',
          participant_entity_ids: participantEntityIds,
          metadata: {
            connection_id: connectionId,
          },
        },
      );
    }
  }

  private async extractFileDetails(file: OneDrivePageEntity): Promise<ExtractedFile> {
    const { eTag, lastModifiedDateTime, createdBy, lastModifiedBy, content } = file;

    // Extract participants
    const participants: FileParticipant[] = [
      {
        name: createdBy.user.displayName,
        email: createdBy.user.email,
      },
      {
        name: lastModifiedBy.user.displayName,
        email: lastModifiedBy.user.email,
      },
    ];

    return {
      id: eTag || 'unknown',
      startTime: new Date(lastModifiedDateTime),
      participants,
      content,
    };
  }
}
