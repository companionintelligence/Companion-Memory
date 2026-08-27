import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';
import {
  FILE_PREVIEW_SWEEP_QUEUE,
  FilePreviewSweepRequestEvent,
  type FilePreviewSweepRequestPayload,
} from '@ci/domains/files';

import { STAGE_IDS } from '../constants';
import { PipelineDispatchService } from '../services/PipelineDispatchService';

/**
 * Turns an on-demand request (`POST /api/maintenance/file-preview-sweep`)
 * into an `enrich.file_preview` sweep for that user. The same handoff shape
 * as UnfurlSweepRequestListener: the maintenance API cannot reach
 * PipelineDispatchService across the domain boundary, so it sends an event
 * the pipeline domain consumes.
 */
@Injectable()
export class FilePreviewSweepRequestListener {
  constructor(
    private readonly dispatchService: PipelineDispatchService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(FilePreviewSweepRequestListener.name);
  }

  @OnEvent(FilePreviewSweepRequestEvent, {
    queue: FILE_PREVIEW_SWEEP_QUEUE,
    queueOptions: { policy: 'short' },
  })
  async handleRequest(payload: FilePreviewSweepRequestPayload): Promise<void> {
    const { userId, requestedBy } = payload;

    if (userId == null || userId.length === 0) {
      this.logger.warn('File preview sweep request carries no userId; ignoring', { requestedBy });

      return;
    }

    await this.dispatchService.startSweep({ stage: STAGE_IDS.ENRICH_FILE_PREVIEW, userId });

    this.logger.log('File preview sweep started', {
      requestedBy,
      userId,
      stage: STAGE_IDS.ENRICH_FILE_PREVIEW,
    });
  }
}
