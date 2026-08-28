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

    if (chunks.length === 0) {
      this.logger.log('Document chunks indexed', { fileId: payload.fileId, indexed: 0 });

      return;
    }

    // One batched call instead of one-per-chunk, matching DenseEmbedStageBase's
    // pattern. A single row's content can't fail this call on its own — Ollama's
    // /api/embed is all-or-nothing for the array it's given — so a failure here
    // means the whole document, not one chunk.
    let vectors: number[][];

    try {
      vectors = await this.embeddingGenerationService.generateEmbeddings(
        chunks.map((chunk) => chunk.content),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      this.logger.error(
        `Embedding call failed for ${chunks.length} chunks of file ${payload.fileId}`,
        err instanceof Error ? err : new Error(message),
      );

      // Rethrow so pg-boss's real retry/dead-letter path engages instead of
      // acking a document that never got a single chunk indexed.
      throw err;
    }

    const failedChunkIds: string[] = [];

    for (const [index, chunk] of chunks.entries()) {
      const userContext = { userId: chunk.userId };

      try {
        await this.embeddingService.upsert(userContext, {
          entityType: 'file-chunk',
          entityId: chunk.id,
          embedding: vectors[index],
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
        failedChunkIds.push(chunk.id);

        this.logger.warn('Failed to index chunk, continuing', {
          chunkId: chunk.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (failedChunkIds.length > 0) {
      // file-chunk has no backfill sweep or pipeline stage to catch a partially
      // indexed document later, so anything short of every chunk landing must
      // fail the job rather than let autoAcknowledge mark it done.
      throw new Error(
        `Failed to index ${failedChunkIds.length}/${chunks.length} chunks for file ${payload.fileId}: ${failedChunkIds.join(', ')}`,
      );
    }

    this.logger.log('Document chunks indexed', {
      fileId: payload.fileId,
      indexed: chunks.length,
    });
  }
}
