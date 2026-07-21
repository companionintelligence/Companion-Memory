import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { OnEvent, EventService } from '@ci/domains/events';
import { FileService } from '@ci/domains/files';
import { FileUploadedEvent, type FileUploadedPayload } from '@ci/domains/files/events';

import { FileChunkEntity } from '../entities/FileChunkEntity';
import { DocumentParsedEvent } from '../events';
import { DocumentChunkerService } from '../services/DocumentChunkerService';
import { DocumentChunkService } from '../services/DocumentChunkService';
import { DocumentParserService } from '../services/DocumentParserService';
import { ParseStatus } from '../types';

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

  @OnEvent(FileUploadedEvent, { queue: 'document-parsing' })
  async parseDocument(payload: FileUploadedPayload) {
    const context = toServiceContext({ userId: payload.userId });

    const file = await this.fileService.findById(context, payload.fileId);

    if (file == null) {
      this.logger.warn('File not found, skipping document parse', {
        fileId: payload.fileId,
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
