import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';
import { FileUploadedEvent, type FileUploadedPayload } from '@ci/domains/files';
import { TemporalClientService } from '@ci/temporal/temporal-client.service';

/**
 * Lightweight listener that triggers Temporal workflow for inventory analysis.
 *
 * The actual image analysis happens in a Temporal workflow running on MEDIUM priority queue,
 * ensuring async processing with retry logic and progress tracking.
 */
@Injectable()
export class InventoryListener {
  constructor(
    private readonly temporalClientService: TemporalClientService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(InventoryListener.name);
  }

  @OnEvent(FileUploadedEvent, { queue: 'inventory' })
  async handleFileUploaded(payload: FileUploadedPayload) {
    this.logger.log('Triggering inventory analysis workflow', {
      fileId: payload.fileId,
      userId: payload.userId,
    });

    try {
      const workflowHandle = await this.temporalClientService.startInventoryAnalysis({
        userId: payload.userId,
        fileId: payload.fileId,
      });

      if (workflowHandle == null) {
        this.logger.error('Failed to start inventory analysis workflow (client not initialized)', {
          fileId: payload.fileId,
        });

        return;
      }

      this.logger.log('Inventory analysis workflow started', {
        workflowId: workflowHandle.workflowId,
        fileId: payload.fileId,
      });
    } catch (error) {
      this.logger.error('Failed to trigger inventory analysis workflow', {
        error: error instanceof Error ? error.message : String(error),
        fileId: payload.fileId,
      });
    }
  }
}
