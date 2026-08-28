import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { Cron } from '@ci/common/schedule';

import { AskExpiryService } from '../services/AskExpiryService';

/**
 * Every five minutes. The window is the worst-case overrun on a deadline the
 * owner set, so it is a security bound rather than a cost knob — and the sweep
 * is a single indexed scan that usually matches nothing.
 */
const ASK_EXPIRY_CRON = '0 */5 * * * *';

/**
 * Drives {@link AskExpiryService.sweep} on a schedule.
 *
 * The @Cron NAME is not decoration: `@ci/common/schedule`'s decorator falls back
 * to `Class.method` for the `ci.cron_runs` key, but `@nestjs/schedule` assigns an
 * unnamed job a random UUID in the SchedulerRegistry, so an unnamed cron is
 * un-addressable across restarts and cannot be deduped. Every scheduled method
 * in this codebase is named for that reason.
 */
@Injectable()
export class AskExpiryCron {
  private running = false;

  constructor(
    private readonly expiryService: AskExpiryService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(AskExpiryCron.name);
  }

  @Cron(ASK_EXPIRY_CRON, { name: 'AskExpiryCron.expireOverdueAsks' })
  async expireOverdueAsks(): Promise<void> {
    // A slow sweep must not stack: two overlapping runs would contend on the
    // same rows through the pessimistic lock and buy nothing, since whatever
    // this run leaves behind is still overdue five minutes from now.
    if (this.running) {
      this.logger.warn('Skipping ask expiry sweep; previous run still in progress');

      return;
    }

    this.running = true;

    try {
      await this.expiryService.sweep();
    } catch (err) {
      this.logger.error('Ask expiry sweep failed', err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.running = false;
    }
  }
}

export { ASK_EXPIRY_CRON };
