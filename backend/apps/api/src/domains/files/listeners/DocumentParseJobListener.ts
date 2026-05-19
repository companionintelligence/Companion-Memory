import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';

import { FileUploadedEvent, type FileUploadedPayload } from '../events';
import { DocumentParserService } from '../services/DocumentParserService';

/**
 * Plan 18 — automatically kicks off document parsing when a file is uploaded.
 *
 * Listens for `FileUploadedEvent` and triggers `DocumentParserService.parseAndIngest`.
 * The call is fire-and-forget: a parse failure is logged but never propagated to
 * the upload response. Unsupported file types are silently skipped.
 */
@Injectable()
export class DocumentParseJobListener {
  constructor(
    private readonly parserService: DocumentParserService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(DocumentParseJobListener.name);
  }

  @OnEvent(FileUploadedEvent, { queue: 'document-parse' })
  async onFileUploaded(payload: FileUploadedPayload): Promise<void> {
    const { fileId, userId } = payload;

    try {
      const result = await this.parserService.parseAndIngest(fileId, userId);

      if (result.skipped) {
        this.logger.log('Document parse skipped', { fileId, reason: result.skipReason });
      } else {
        this.logger.log('Document parse succeeded', {
          fileId,
          chunksWritten: result.chunksWritten,
        });
      }
    } catch (err) {
      // Never let a parse failure break the user's upload flow.
      this.logger.error('Document parse failed — continuing without chunks', {
        fileId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
