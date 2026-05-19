import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { EmbeddingGenerationService } from '@ci/common/embeddings';
import { LoggerService } from '@ci/common/logging';

import { DocumentChunkEntity } from '../entities/DocumentChunkEntity';

import { FileService } from './FileService';

/** Supported MIME types for text extraction. */
const SUPPORTED_TEXT_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'application/json',
  'application/ld+json',
]);

export interface ParseResult {
  fileId: string;
  chunksWritten: number;
  skipped: boolean;
  skipReason?: string;
}

/**
 * Plan 18 — document parsing pipeline for uploaded files.
 *
 * Pipeline stages:
 *  1. Fetch raw file bytes via `FileService.getFileContent`.
 *  2. Extract text from the buffer based on MIME type.
 *  3. Chunk the text into overlapping fixed-size windows.
 *  4. Embed each chunk via `EmbeddingGenerationService`.
 *  5. Persist chunks + embeddings as `DocumentChunkEntity` rows.
 *
 * Supported formats (initial set):
 *  - text/plain, text/markdown, text/csv, text/html
 *  - application/json, application/ld+json
 *
 * Unsupported formats (PDF, DOCX, images) return a `skipped=true` result
 * so callers can surface a "format not yet supported" message without
 * treating it as an error. Full PDF support requires `pdf-parse` (follow-up).
 *
 * Chunking defaults: 1000 chars per chunk, 200 chars overlap.
 * Embedding dimension: 768 (nomic-embed-text, matches the Ollama default).
 */
@Injectable()
export class DocumentParserService {
  static readonly DEFAULT_CHUNK_SIZE = 1_000;

  static readonly DEFAULT_OVERLAP = 200;

  constructor(
    @InjectRepository(DocumentChunkEntity)
    private readonly chunkRepo: Repository<DocumentChunkEntity>,
    private readonly fileService: FileService,
    private readonly embeddingService: EmbeddingGenerationService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(DocumentParserService.name);
  }

  /**
   * Run the full parse → chunk → embed → persist pipeline for a file.
   * Idempotent: existing chunks for the file are deleted before writing new
   * ones so a re-parse always produces a clean result set.
   */
  async parseAndIngest(fileId: string, userId: string): Promise<ParseResult> {
    this.logger.log('Starting document parse', { fileId, userId });

    // 1. Fetch file metadata to get content type and storage key.
    const file = await this.fileService.findById({ userId }, fileId);

    if (!file) {
      return { fileId, chunksWritten: 0, skipped: true, skipReason: 'file_not_found' };
    }

    if (!file.key) {
      return { fileId, chunksWritten: 0, skipped: true, skipReason: 'no_storage_key' };
    }

    const contentType = file.contentType?.toLowerCase().split(';')[0].trim() ?? '';

    if (!SUPPORTED_TEXT_TYPES.has(contentType)) {
      this.logger.log('Skipping parse — unsupported content type', { fileId, contentType });

      return {
        fileId,
        chunksWritten: 0,
        skipped: true,
        skipReason: `unsupported_content_type:${contentType}`,
      };
    }

    // 2. Fetch raw bytes and extract text.
    const bytes = await this.fileService.getFileContent({ userId }, file.key);
    const text = this.extractText(Buffer.from(bytes), contentType);

    if (!text.trim()) {
      return { fileId, chunksWritten: 0, skipped: true, skipReason: 'empty_text' };
    }

    // 3. Chunk.
    const chunks = this.chunkText(text);

    // 4. Delete old chunks (idempotent re-parse).
    await this.chunkRepo.delete({ fileId });

    // 5. Embed + persist in parallel batches of 5.
    const batchSize = 5;
    let chunksWritten = 0;

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);

      await Promise.all(
        batch.map(async (chunkText, batchIdx) => {
          const chunkIndex = i + batchIdx;
          let embedding: number[] | null = null;

          try {
            embedding = await this.embeddingService.generateEmbedding(chunkText);
          } catch (err) {
            this.logger.warn('Embedding failed for chunk — storing without embedding', {
              fileId,
              chunkIndex,
              error: err instanceof Error ? err.message : String(err),
            });
          }

          await this.chunkRepo.save(
            this.chunkRepo.create({
              id: uuidv7(),
              fileId,
              userId,
              chunkIndex,
              text: chunkText,
              embedding,
            }),
          );

          chunksWritten += 1;
        }),
      );
    }

    this.logger.log('Document parse completed', { fileId, chunksWritten });

    return { fileId, chunksWritten, skipped: false };
  }

  // ─── Text extraction ───────────────────────────────────────────────────────

  /**
   * Extract plain text from raw file bytes.
   * `text/html` has tags stripped; all others are decoded as UTF-8.
   */
  extractText(buffer: Buffer, contentType: string): string {
    const raw = buffer.toString('utf-8');

    if (contentType === 'text/html') {
      // Strip HTML tags (sufficient for most structured HTML).
      return raw
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/\s{2,}/g, ' ')
        .trim();
    }

    return raw;
  }

  // ─── Chunking ──────────────────────────────────────────────────────────────

  /**
   * Split text into overlapping fixed-size windows.
   *
   * @param text      - Input text.
   * @param chunkSize - Maximum characters per chunk (default 1000).
   * @param overlap   - Characters shared between consecutive chunks (default 200).
   */
  chunkText(
    text: string,
    chunkSize = DocumentParserService.DEFAULT_CHUNK_SIZE,
    overlap = DocumentParserService.DEFAULT_OVERLAP,
  ): string[] {
    if (text.length === 0) {
      return [];
    }

    const stride = chunkSize - overlap;
    const chunks: string[] = [];

    for (let start = 0; start < text.length; start += stride) {
      const chunk = text.slice(start, start + chunkSize).trim();

      if (chunk.length > 0) {
        chunks.push(chunk);
      }

      if (start + chunkSize >= text.length) {
        break;
      }
    }

    return chunks;
  }
}
