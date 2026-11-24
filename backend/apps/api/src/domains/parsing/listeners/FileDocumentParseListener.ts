import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { OnEvent, EventService, type QueueOptions } from '@ci/domains/events';
import { FileService } from '@ci/domains/files';
import { FileUploadedEvent, type FileUploadedPayload } from '@ci/domains/files/events';

import { FileChunkEntity } from '../entities/FileChunkEntity';
import { DocumentParsedEvent } from '../events';
import { DocumentChunkerService } from '../services/DocumentChunkerService';
import { DocumentChunkService } from '../services/DocumentChunkService';
import { MAX_PARSE_BYTES, UnparseableDocumentError } from '../services/DocumentExtractor';
import { DocumentParserService } from '../services/DocumentParserService';
import { ParseStatus } from '../types';

/**
 * The document-parsing queue's retries: long enough to outlast a parser restart.
 *
 * Every queue's default is 3 retries 10 s apart with backoff, so a job used its
 * last retry about two minutes after the first failure. A document uploaded
 * while the summary service (the parser) was stopped for an update or caught in
 * a crash loop failed for good 15 s before the service came back. Nothing
 * parses it again on its own. pg-boss waits between `retryDelay * 2^(n-1)` and
 * `retryDelay * 2^n` seconds before retry `n`, so these five retries 30 s apart
 * span about 15 to 30 minutes. That holds only while the queue keeps the
 * `retryBackoff: true` every queue gets from PGBossEventService's
 * QUEUE_RETRY_POLICY; without it they span two and a half minutes.
 *
 * A file the parser refuses outright (UnparseableDocumentError) is not retried
 * at all. Every other failure is, including ones that waiting won't clear (an
 * object missing from storage, a sidecar token mismatch). Those now take half
 * an hour to reach the dead-letter queue instead of two minutes.
 */
export const DOCUMENT_PARSING_RETRY = { retryLimit: 5, retryDelay: 30 } as const satisfies QueueOptions;

@Injectable()
export class FileDocumentParseListener {
  constructor(
    @InjectRepository(FileChunkEntity)
    private readonly chunkRepository: Repository<FileChunkEntity>,
    private readonly fileService: FileService,
    private readonly parserService: DocumentParserService,
    private readonly chunkerService: DocumentChunkerService,
    private readonly chunkService: DocumentChunkService,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(FileDocumentParseListener.name);
  }

  @OnEvent(FileUploadedEvent, { queue: 'document-parsing', queueOptions: DOCUMENT_PARSING_RETRY })
  async parseDocument(payload: FileUploadedPayload) {
    const context = toServiceContext({ userId: payload.userId });

    const file = await this.fileService.findById(context, payload.fileId);

    if (file == null) {
      this.logger.warn('File not found, skipping document parse', {
        fileId: payload.fileId,
      });

      return;
    }

    if (file.parseStatus === ParseStatus.COMPLETED) {
      this.logger.log('File already parsed, skipping', {
        fileId: file.id,
      });

      return;
    }

    if (!this.parserService.canParse(file.contentType, file.filename ?? file.id)) {
      this.logger.log('MIME type not parseable, skipping', {
        fileId: file.id,
        contentType: file.contentType,
      });

      await this.updateParseStatus(file.id, ParseStatus.SKIPPED);

      return;
    }

    if (file.bucket == null || file.key == null) {
      this.logger.log('File has no object storage reference, skipping', {
        fileId: file.id,
      });

      await this.updateParseStatus(file.id, ParseStatus.SKIPPED);

      return;
    }

    // `size` is a bigint column, so it can arrive as a string.
    const size = file.size == null ? null : Number(file.size);

    if (size !== null && size > MAX_PARSE_BYTES) {
      // getFileContent holds the whole object in memory, and the parser would
      // refuse it anyway: answer now, without downloading gigabytes to do it.
      const parseError = `File is ${size} bytes; the parser reads at most ${MAX_PARSE_BYTES}`;

      this.logger.log('File too large to parse, skipping', { fileId: file.id, bytes: size });
      await this.updateParseStatus(file.id, ParseStatus.FAILED, { parseError });

      return;
    }

    await this.updateParseStatus(file.id, ParseStatus.PROCESSING);

    try {
      const fileBytes = await this.fileService.getFileContent(context, file.key);

      this.logger.log('Calling parser service', {
        fileId: file.id,
        contentType: file.contentType,
        bytes: fileBytes.length,
      });

      const parsed = await this.parserService.parse(fileBytes, file.contentType, file.filename ?? file.id);

      if (parsed.warnings.length > 0) {
        this.logger.log('Parser warnings', { fileId: file.id, warnings: parsed.warnings });
      }

      const chunkDtos = this.chunkerService.chunkDocument(file.id, file.userId, parsed);

      this.logger.log('Generated chunks', { fileId: file.id, count: chunkDtos.length });

      await this.chunkService.deleteByFileId(file.id);
      const chunks = await this.chunkService.createMany(chunkDtos);

      await this.updateParseStatus(file.id, ParseStatus.COMPLETED, {
        parsedAt: new Date(),
        parserName: parsed.parser.name,
        parserVersion: parsed.parser.version,
        chunkerVersion: chunks[0]?.chunkerVersion ?? null,
      });

      await this.eventService.send(DocumentParsedEvent, {
        fileId: file.id,
        userId: file.userId,
        chunkIds: chunks.map((c) => c.id),
      });

      this.logger.log('Document parse complete', {
        fileId: file.id,
        chunks: chunks.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      this.logger.warn('Document parse failed', {
        fileId: file.id,
        error: message,
      });

      await this.updateParseStatus(file.id, ParseStatus.FAILED, { parseError: message });

      // The parser refused this file (too large, an archive bomb, out of time
      // or memory). Retrying would send the same bytes back for the same
      // answer on every retry in DOCUMENT_PARSING_RETRY, half an hour of them;
      // the failure is recorded on the file.
      if (err instanceof UnparseableDocumentError) {
        return;
      }

      // Rethrow so the OnEvent wrapper's ack.fail() fires — swallowing here
      // would ack.done() the job and lose pg-boss retry/dead-letter for what
      // may be a transient failure (object storage, parser sidecar, DB write).
      throw err;
    }
  }

  private async updateParseStatus(
    fileId: string,
    status: ParseStatus,
    extra: {
      parseError?: string;
      parsedAt?: Date;
      parserName?: string;
      parserVersion?: string;
      chunkerVersion?: string | null;
    } = {},
  ) {
    await this.chunkRepository.manager.query(
      `UPDATE ci.files
         SET parse_status = $1,
             parse_error = $2,
             parsed_at = $3,
             parser_name = $4,
             parser_version = $5,
             chunker_version = $6
       WHERE id = $7`,
      [
        status,
        extra.parseError ?? null,
        extra.parsedAt ?? null,
        extra.parserName ?? null,
        extra.parserVersion ?? null,
        extra.chunkerVersion ?? null,
        fileId,
      ],
    );
  }
}
