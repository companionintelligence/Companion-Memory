import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { Cron } from '@ci/common/schedule';
import config from '@ci/configuration';

import { AccountPurgeService } from '../services/AccountPurgeService';

/**
 * Hourly rather than daily.
 *
 * `purge_after` is a deadline, not a schedule, so the only thing the interval
 * controls is how long after the deadline the data actually goes. An appliance
 * is often off; an hourly tick means a box that is up for one hour a day still
 * honours the promise on the day it was made, and the claim query is a partial
 * index scan that finds nothing the rest of the time.
 */
const ACCOUNT_PURGE_CRON = '0 20 * * * *';

@Injectable()
export class AccountPurgeCron {
  private running = false;

  constructor(
    private readonly accountPurgeService: AccountPurgeService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(AccountPurgeCron.name);
  }

  @Cron(ACCOUNT_PURGE_CRON, { name: 'AccountPurgeCron.purgeDueAccounts' })
  async purgeDueAccounts() {
    if (!config.accountDeletion.purge.enabled) {
      return;
    }

    // The service takes a database advisory lock per account, which is what
    // actually prevents two workers colliding. This flag is the cheaper guard
    // for the common case: one process whose previous tick is still working.
    if (this.running) {
      this.logger.warn('Skipping account purge; previous run still in progress');

      return;
    }

    this.running = true;

    try {
      const summary = await this.accountPurgeService.purgeDueAccounts();

      if (summary.considered > 0) {
        this.logger.log('Account purge run complete', {
          considered: summary.considered,
          purged: summary.purged,
          failed: summary.failed,
        });
      }
    } catch (err) {
      // A failure here is a failure to keep a deletion promise, so it is logged
      // as an error even though the next tick will retry.
      this.logger.error('Account purge run failed', err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.running = false;
    }
  }
}
