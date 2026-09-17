import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { serves } from '@ci/common/roles';
import { Cron } from '@ci/common/schedule';
import { EventService } from '@ci/domains/events';
import { FileService, ImageDescriptionBackfillRequestEvent } from '@ci/domains/files';

import { ImageDescriptionPreferenceService } from '../services/ImageDescriptionPreferenceService';

/**
 * Safety net for "Describe images" defaulting ON.
 *
 * The setting's own backfill fires from ONE place —
 * {@link ImageDescriptionPreferenceService.setEnabled} — on a detected
 * false→true transition. `isEnabled` now computes its answer from
 * {@link OllamaService.resolveVisionModel}'s live capability check rather than
 * a stored flag, so a user whose chat model already supports vision is "on"
 * from the moment this code runs, with no transition for `setEnabled` to ever
 * see: nothing calls it, so nothing fires the backfill. That gap is exactly
 * how the first library imported on this appliance sat at zero descriptions
 * — the setting reported "on", and nothing had ever asked for the work.
 *
 * This sweep does not care whether a transition happened. Once a day, and
 * once at boot, it asks the only question that actually matters — is this
 * setting on right now, and is there still undescribed work — and fires the
 * request if so. Idempotent by construction: it reuses the exact singleton
 * key `setEnabled` itself sends on, so pg-boss's `short` policy on
 * IMAGE_DESCRIPTION_QUEUE refuses a duplicate whether a backfill is already
 * chaining through pages from a toggle, a previous sweep tick, or this one.
 * A user with nothing left to describe costs one cheap existence query and
 * nothing else — {@link FileService.listUserIdsWithUndescribedImages} narrows
 * the audience before the one per-user check that is not cheap (a live Ollama
 * round trip via `isEnabled`).
 */
@Injectable()
export class ImageDescriptionSweepCron implements OnApplicationBootstrap {
  constructor(
    private readonly fileService: FileService,
    private readonly imageDescriptionPreference: ImageDescriptionPreferenceService,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ImageDescriptionSweepCron.name);
  }

  /**
   * Catches the gap immediately after a deploy or restart, rather than
   * waiting up to a day for the first scheduled tick — the same shape as
   * `PythonFunctionCrons`' HBPE bootstrap sweep.
   */
  onApplicationBootstrap(): void {
    // Only one process needs to run this: sending the event just writes a
    // pg-boss row, it does not matter which process does that, and running
    // it from both would only mean two redundant sweeps racing each other.
    if (!serves('web')) {
      return;
    }

    // Fire-and-forget: pg-boss may still be initialising its queues during
    // bootstrap, and a failed sweep is retried by the daily cron regardless.
    setTimeout(() => {
      this.sweep().catch((err) => {
        this.logger.warn('Image-description sweep at startup failed', { err });
      });
    }, 30_000);
  }

  @Cron('0 20 3 * * *', { name: 'ImageDescriptionSweepCron.sweep' })
  async sweep(): Promise<void> {
    const candidateUserIds = await this.fileService.listUserIdsWithUndescribedImages();

    if (candidateUserIds.length === 0) {
      return;
    }

    let requested = 0;

    for (const userId of candidateUserIds) {
      try {
        if (!(await this.imageDescriptionPreference.isEnabled(userId))) {
          continue;
        }

        // Same singleton key `setEnabled`'s own false→true transition sends
        // on — deliberately, so this sweep and that toggle can never both
        // have a first-page backfill in flight for the same user at once.
        await this.eventService.send(
          ImageDescriptionBackfillRequestEvent,
          { userId },
          { singletonKey: `image-description-backfill:${userId}` },
        );
        requested += 1;
      } catch (err) {
        this.logger.error(
          `Failed to sweep image-description backfill for user ${userId}`,
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }

    this.logger.log('Image-description sweep complete', {
      usersWithUndescribedImages: candidateUserIds.length,
      requested,
    });
  }
}
