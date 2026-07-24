import { Injectable, OnApplicationBootstrap } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { Cron } from '@ci/common/schedule';

import { ActivityRollupService } from '../services/ActivityRollupService';

const ACTIVITY_ROLLUP_CRON = '0 */15 * * * *';

@Injectable()
export class ActivityRollupCron implements OnApplicationBootstrap {
  private running = false;

  constructor(
    private readonly activityRollupService: ActivityRollupService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ActivityRollupCron.name);
  }

  /**
   * Kick one refresh at startup so a fresh install serves data before the
   * first quarter-hour tick. Fire-and-forget; boot must not wait on it.
   */
  onApplicationBootstrap() {
    void this.refreshRollup();
  }

  @Cron(ACTIVITY_ROLLUP_CRON)
  async refreshRollup() {
    if (this.running) {
      this.logger.warn('Skipping activity rollup refresh; previous run still in progress');

      return;
    }

    this.running = true;

    try {
      await this.activityRollupService.refreshAll();
    } catch (err) {
      this.logger.error(
        'Activity rollup refresh failed',
        err instanceof Error ? err : new Error(String(err)),
      );
    } finally {
      this.running = false;
    }
  }
}
