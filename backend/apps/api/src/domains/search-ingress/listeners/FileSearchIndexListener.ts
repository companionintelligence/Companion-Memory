import { Injectable } from '@nestjs/common';

import { ServiceContext, SYSTEM_USER } from '@ci/common/context';
import { EmbeddingGenerationService } from '@ci/common/embeddings';
import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';
import { type File, FileService } from '@ci/domains/files';
import {
  FileCreatedEvent,
  FileRemovedEvent,
  FileUpdatedEvent,
  FileUploadedEvent,
  type FileCreatedPayload,
  type FileDeletedPayload,
  type FileUpdatedPayload,
  type FileUploadedPayload,
} from '@ci/domains/files/events';
import { fileSearchDocument, fileWeightedTexts } from '@ci/domains/search-ingress/searchTexts';
import { EmbeddingService } from '@ci/domains/search-ingress/services/EmbeddingService';
import { VectorService } from '@ci/domains/search-ingress/services/VectorService';
import { type WeightedText } from '@ci/domains/search-ingress/types';

@Injectable()
export class FileSearchIndexListener {
  constructor(
    private readonly fileService: FileService,
    private readonly embeddingGenerationService: EmbeddingGenerationService,
    private readonly embeddingService: EmbeddingService,
    private readonly vectorService: VectorService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(FileSearchIndexListener.name);
  }

  @OnEvent(FileCreatedEvent, { queue: 'search-index' })
  async indexFile(payload: FileCreatedPayload | FileUpdatedPayload) {
    this.logger.log('Adding new file to search index', {
      fileId: payload.fileId,
    });

    await this.upsertFile(payload);
  }

  @OnEvent(FileUploadedEvent, { queue: 'search-index' })
  async indexUploadedFile(payload: FileUploadedPayload) {
    this.logger.log('Adding new file to search index', {
      fileId: payload.fileId,
    });

    await this.upsertFile(payload);
  }

  @OnEvent(FileUpdatedEvent, { queue: 'search-index' })
  async updateFile(payload: FileCreatedPayload | FileUpdatedPayload) {
    this.logger.log('Updating file in search index', {
      fileId: payload.fileId,
    });

    await this.upsertFile(payload);
  }

  @OnEvent(FileRemovedEvent, { queue: 'search-index' })
  async unindexFile(payload: FileDeletedPayload) {
    this.logger.log('Removing file in search index', {
      fileId: payload.fileId,
    });

    const context = {
      userId: SYSTEM_USER,
    } satisfies ServiceContext;

    await this.embeddingService.remove(context, {
      entityType: 'file',
      entityId: payload.fileId,
    });

    this.logger.log('Removed embedding for file');

    await this.vectorService.remove(context, {
      entityType: 'file',
      entityId: payload.fileId,
    });

    this.logger.log('Removed tsvector for file');
  }

  private async upsertFile(payload: FileCreatedPayload | FileUpdatedPayload) {
    const context = {
      userId: SYSTEM_USER,
    } satisfies ServiceContext;

    const file = await this.fileService.findById(context, payload.fileId);

    if (file == null) {
      this.logger.warn('File not found, skipping indexing');

      return;
    }

    if (file.userId == null) {
      this.logger.warn('File has no associated user, cannot index');

      return;
    }

    const searchDocument = this.getSearchDocument(file);

    if (searchDocument == null) {
      this.logger.log('File has no search document, skipping embedding');
    } else {
      await this.embeddingService.upsertDocument(
        { userId: file.userId },
        { entityType: 'file', entityId: file.id, text: searchDocument },
        (text) => this.embeddingGenerationService.generateEmbedding(text),
      );

      this.logger.log('Generated embedding for file');
    }

    const searchFile = this.getSearchFile(file);

    if (searchFile.length === 0) {
      this.logger.log('File has no search file, skipping vectorization');
    } else {
      await this.vectorService.upsert(
        {
          userId: file.userId,
        },
        {
          entityType: 'file',
          entityId: file.id,
          searchableText: searchFile,
        },
      );

      this.logger.log('Generated tsvector for file');
    }
  }

  private getSearchFile(file: File): WeightedText[] {
    return fileWeightedTexts(file);
  }

  private getSearchDocument(file: File): string | null {
    return fileSearchDocument(file);
  }
}
