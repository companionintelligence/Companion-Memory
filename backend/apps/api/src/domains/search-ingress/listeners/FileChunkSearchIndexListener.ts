import { Injectable } from '@nestjs/common';

import { EmbeddingGenerationService } from '@ci/common/embeddings';
import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';
import { FileChunkService, DocumentParsedEvent, type DocumentParsedPayload } from '@ci/domains/parsing';

import { EmbeddingService } from '../services/EmbeddingService';
import { VectorService } from '../services/VectorService';

@Injectable()
export class FileChunkSearchIndexListener {
  constructor(
    private readonly chunkService: FileChunkService,
    private readonly embeddingGenerationService: EmbeddingGenerationService,
    private readonly embeddingService: EmbeddingService,
    private readonly vectorService: VectorService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(FileChunkSearchIndexListener.name);
  }

  @OnEvent(DocumentParsedEvent, { queue: 'search-index' })
  async indexChunks(payload: DocumentParsedPayload) {
    this.logger.log('Indexing document chunks', {
      fileId: payload.fileId,
      chunkCount: payload.chunkIds.length,
    });

    const chunks = await this.chunkService.findByIds(payload.chunkIds);

    for (const chunk of chunks) {
      const userContext = { userId: chunk.userId };

      try {
        const embedding = await this.embeddingGenerationService.generateEmbedding(chunk.content);

        await this.embeddingService.upsert(userContext, {
          entityType: 'file-chunk',
          entityId: chunk.id,
          embedding,
        });

        await this.vectorService.upsert(userContext, {
          entityType: 'file-chunk',
          entityId: chunk.id,
          searchableText: [
            ...(chunk.sectionTitle ? [{ text: chunk.sectionTitle, weight: 8 }] : []),
            { text: chunk.content, weight: 3 },
          ],
        });
      } catch (err) {
        this.logger.warn('Failed to index chunk, continuing', {
          chunkId: chunk.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.logger.log('Document chunks indexed', {
      fileId: payload.fileId,
      indexed: chunks.length,
    });
  }
}
