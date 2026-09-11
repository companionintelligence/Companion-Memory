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
 *
 * Pages itself. One request enqueues at most DEFAULT_LIMIT descriptions and,
 * if the page was full, enqueues the NEXT request behind them on the same
 * one-slot queue — so page two is fetched only after page one's descriptions
 * have run, and the queue never holds more than about one page of vision
 * work. (Before this the request fired once: a 22,870-photo library got 500
 * described and then silence.) The cursor is the last original's id, so a
 * page whose descriptions are still being written cannot shift the next one.
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
    const candidates = await this.fileService.findUndescribedImagePreviews(
      payload.userId,
      limit,
      payload.afterParentFileId,
    );

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

    const last = candidates.at(-1);
    const chained = candidates.length >= limit && last != null;

    if (chained) {
      // Keyed on the cursor, not just the user: the queue's `short` policy
      // refuses a duplicate key, and the user-only key Settings uses would
      // collide with this page's own request while it is still queued.
      await this.eventService.send(
        ImageDescriptionBackfillRequestEvent,
        { userId: payload.userId, limit, afterParentFileId: last.parentFileId },
        { singletonKey: `image-description-backfill:${payload.userId}:${last.parentFileId}` },
      );
    }

    this.logger.log('Image description backfill enqueued', {
      userId: payload.userId,
      candidates: candidates.length,
      enqueued,
      afterParentFileId: payload.afterParentFileId ?? null,
      nextPage: chained ? last.parentFileId : null,
    });
  }
}
