import { Injectable } from '@nestjs/common';

import { toServiceContext } from '@ci/common/context';
import { OnEvent } from '@ci/domains/events';

import { FileUploadedEvent, FileUploadedPayload } from '../events';
import { FilePreviewService } from '../services/FilePreviewService';

/**
 * Generate the PREVIEW variant for a file the moment it is uploaded.
 *
 * The generator itself lives in {@link FilePreviewService}; this is the
 * upload-path trigger for it. The other trigger is the `enrich.file_preview`
 * pipeline stage, which sweeps for originals that have no preview — the
 * backfill this listener never had, so a preview lost at upload (or a file
 * that predates preview generation) is no longer lost for good.
 *
 * Outcomes are deliberately not inspected here: the service already logs
 * every skip with the file id and content type, and completing the job on a
 * skip is what keeps an undecodable file from being retried forever. IO
 * failures throw out of the service and fail the job, which is the retry.
 */
@Injectable()
export class FilePreviewGenerationListener {
  constructor(private readonly filePreviewService: FilePreviewService) {}

  @OnEvent(FileUploadedEvent, { queue: 'file-preview-generation' })
  async generatePreview(payload: FileUploadedPayload): Promise<void> {
    const context = toServiceContext({ userId: payload.userId });

    await this.filePreviewService.generate(context, {
      fileId: payload.fileId,
      skipDescription: payload.skipDescription,
      model: payload.model,
    });
  }
}
