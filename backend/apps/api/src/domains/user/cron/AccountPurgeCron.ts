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
  constructor(
    private readonly accountPurgeService: AccountPurgeService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(AccountPurgeCron.name);
  }

  // `exclusive`: the service takes a database advisory lock per account, which
  // is what actually prevents two workers colliding; the decorator's guard is
  // the cheaper one for the common case — one process whose previous tick is
  // still working — and it logs the skip and any failure.
  @Cron(ACCOUNT_PURGE_CRON, { name: 'AccountPurgeCron.purgeDueAccounts', exclusive: true })
  async purgeDueAccounts() {
    if (!config.accountDeletion.purge.enabled) {
      // Switched off, nothing is purged; but accounts left ended and unpurged
      // are still reported, so an off switch forgotten after an incident shows.
      await this.accountPurgeService.reportStalledPurges().catch((err: unknown) => {
        this.logger.error(
          'Could not check for stalled account purges',
          err instanceof Error ? err : new Error(String(err)),
        );
      });

      return;
    }

    // A failure here is a failure to keep a deletion promise; the decorator
    // logs it as an error, and the next tick retries.
    const summary = await this.accountPurgeService.purgeDueAccounts();

    if (summary.considered > 0 || summary.stalled > 0) {
      this.logger.log('Account purge run complete', {
        considered: summary.considered,
        purged: summary.purged,
        failed: summary.failed,
        stalled: summary.stalled,
      });
    }
  }
}
