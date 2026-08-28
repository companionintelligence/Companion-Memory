import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { EventService, OnEvent } from '@ci/domains/events';
import {
  FileService,
  ImageDescriptionBackfillRequestEvent,
  type ImageDescriptionBackfillRequestPayload,
  PreviewGeneratedEvent,
} from '@ci/domains/files';

import { IMAGE_DESCRIPTION_QUEUE, IMAGE_DESCRIPTION_QUEUE_OPTIONS } from '../constants';

const DEFAULT_LIMIT = 500;

/**
 * When image description is turned back on, re-fire preview.generated for
 * originals that still have no description (skipped while off, or previously
 * failed on a text-only model).
 */
@Injectable()
export class ImageDescriptionBackfillListener {
  constructor(
    private readonly fileService: FileService,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ImageDescriptionBackfillListener.name);
  }

  @OnEvent(ImageDescriptionBackfillRequestEvent, {
    queue: IMAGE_DESCRIPTION_QUEUE,
    queueOptions: IMAGE_DESCRIPTION_QUEUE_OPTIONS,
  })
  async handle(payload: ImageDescriptionBackfillRequestPayload): Promise<void> {
    const limit = payload.limit ?? DEFAULT_LIMIT;
    const candidates = await this.fileService.findUndescribedImagePreviews(payload.userId, limit);

    let enqueued = 0;
    for (const candidate of candidates) {
      const jobIds = await this.eventService.send(
        PreviewGeneratedEvent,
        {
          userId: payload.userId,
          previewId: candidate.previewId,
        },
        {
          queue: IMAGE_DESCRIPTION_QUEUE,
          singletonKey: `image-description:${candidate.previewId}`,
        },
      );
      if (jobIds.length > 0) {
        enqueued += 1;
      }
    }

    this.logger.log('Image description backfill enqueued', {
      userId: payload.userId,
      candidates: candidates.length,
      enqueued,
    });
  }
}
