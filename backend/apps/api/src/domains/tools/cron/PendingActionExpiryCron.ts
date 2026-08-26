import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { Cron } from '@ci/common/schedule';

import { PendingActionService } from '../services/PendingActionService';

/**
 * Every five minutes, matching `AskExpiryCron`. The window is the worst-case
 * overrun on a confirmation deadline, so it is a security bound rather than a
 * cost knob — and the sweep is a single partial-index scan that usually matches
 * nothing.
 */
const PENDING_ACTION_EXPIRY_CRON = '0 */5 * * * *';

/**
 * Drives {@link PendingActionService.sweep}: retires overdue proposals and
 * prunes rows resolved more than a year ago.
 *
 * The @Cron NAME is mandatory, not decoration. `@ci/common/schedule`'s decorator
 * falls back to `Class.method` for the `ci.cron_runs` key, but `@nestjs/schedule`
 * assigns an unnamed job a random UUID in the SchedulerRegistry, so an unnamed
 * cron is un-addressable across restarts and cannot be deduped. Every scheduled
 * method in this codebase is named for that reason.
 */
@Injectable()
export class PendingActionExpiryCron {
  private running = false;

  constructor(
    private readonly pendingActions: PendingActionService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PendingActionExpiryCron.name);
  }

  @Cron(PENDING_ACTION_EXPIRY_CRON, { name: 'PendingActionExpiryCron.sweepPendingActions' })
  async sweepPendingActions(): Promise<void> {
    // A slow sweep must not stack: two overlapping runs would contend on the
    // same rows and buy nothing, since whatever this run leaves behind is still
    // overdue five minutes from now.
    if (this.running) {
      this.logger.warn('Skipping pending-action sweep; previous run still in progress');

      return;
    }

    this.running = true;

    try {
      await this.pendingActions.sweep();
    } catch (err) {
      this.logger.error(
        'Pending-action sweep failed',
        err instanceof Error ? err : new Error(String(err)),
      );
    } finally {
      this.running = false;
    }
  }
}

export { PENDING_ACTION_EXPIRY_CRON };
