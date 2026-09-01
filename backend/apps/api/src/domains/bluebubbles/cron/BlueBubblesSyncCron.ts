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
 *
 * There is no in-flight guard here any more, and its absence is the fix rather
 * than an omission. It was a `private running` INSTANCE field, which cannot
 * guard anything that spans processes: this cron is registered in the api and
 * the worker, each with its own copy of the flag, so every tick started two
 * full passes — a live appliance logged 25 runs in two hours. The guard now
 * lives where it can be shared, as a claim on the config row
 * (`BlueBubblesConfigService.claimSync`), which also covers the "Sync now"
 * button the flag never saw at all. A field here would only re-introduce a
 * second, weaker opinion about the same question — and a hung pass could pin
 * it forever, which is what the claim's heartbeat exists to avoid.
 */
@Injectable()
export class BlueBubblesSyncCron {
  constructor(
    private readonly syncService: BlueBubblesSyncService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(BlueBubblesSyncCron.name);
  }

  // `role: 'worker'` because a pass is a full-history parse plus a push into
  // `ci.*` — a job of the same shape as every import stage queue, all of which
  // are `role: 'worker'`. Defaulting to 'web' (see Cron.ts) ran a multi-hour
  // backfill inside the process that serves HTTP.
  @Cron(BLUEBUBBLES_SYNC_CRON, { name: 'BlueBubblesSyncCron.runOnSchedule', role: 'worker' })
  async runOnSchedule(): Promise<void> {
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
    }
  }
}
