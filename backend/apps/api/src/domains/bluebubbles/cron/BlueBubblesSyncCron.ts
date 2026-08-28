import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { Cron } from '@ci/common/schedule';

import { BlueBubblesSyncService } from '../services/BlueBubblesSyncService';

/**
 * Every 10 minutes.
 *
 * BlueBubbles pushes new messages to the webhook the moment they arrive, so
 * this is a BACKSTOP, not the primary ingestion path — it exists for the
 * webhook a flaky network dropped, or a BlueBubbles server that was
 * restarted (and so never re-registered) between two messages. Ten minutes
 * is short enough that a missed webhook is invisible in practice, and long
 * enough that a quiet appliance is not opening a REST connection to the
 * configured Mac every few seconds for nothing.
 */
const BLUEBUBBLES_SYNC_CRON = '0 */10 * * * *';

/**
 * Schedule {@link BlueBubblesSyncService.runSync}.
 *
 * `runSync` itself already no-ops quietly when BlueBubbles isn't configured
 * or `enabled`, so this cron ticks unconditionally — the cheap read that
 * decides whether there is anything to do lives there, once, rather than
 * being duplicated here.
 */
@Injectable()
export class BlueBubblesSyncCron {
  private running = false;

  constructor(
    private readonly syncService: BlueBubblesSyncService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(BlueBubblesSyncCron.name);
  }

  @Cron(BLUEBUBBLES_SYNC_CRON, { name: 'BlueBubblesSyncCron.runOnSchedule' })
  async runOnSchedule(): Promise<void> {
    // A sync pass is a handful of sequential REST calls; ten minutes is
    // normally more than enough, but a slow/unreachable BlueBubbles server
    // should not stack a second pass on top of one still running.
    if (this.running) {
      this.logger.warn('Skipping BlueBubbles sync; previous run still in progress');

      return;
    }

    this.running = true;

    try {
      await this.syncService.runSync();
    } catch (err) {
      // Swallowed on purpose, matching every other cron in the codebase: the
      // next tick is ten minutes away and will retry from the same cursor —
      // an unhandled rejection out of a cron is a strictly worse outcome.
      this.logger.error(
        'BlueBubbles sync tick failed; will retry on the next tick',
        err instanceof Error ? err : new Error(String(err)),
      );
    } finally {
      this.running = false;
    }
  }
}
