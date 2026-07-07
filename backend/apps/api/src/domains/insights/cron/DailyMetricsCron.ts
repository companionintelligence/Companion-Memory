import { Injectable } from '@nestjs/common';

import { FeatureService } from '@ci/common/feature';
import { LoggerService } from '@ci/common/logging';
import { Cron } from '@ci/common/schedule';
import { EventService } from '@ci/domains/events';
import { UserService } from '@ci/domains/user';

import { todayIso } from '../dateUtil';
import { DAILY_METRICS_QUEUE, DailyMetricsComputeRequestEvent } from '../events';

/** 00:20 UTC daily — shortly after the UTC day rolls over. */
const NIGHTLY_CRON = '0 20 0 * * *';

/** Minute 10 of every hour — keeps "today" rolling forward intraday. */
const ROLLING_CRON = '0 10 * * * *';

/**
 * Scheduled producers for the daily feature store (feature flag
 * 'insights.daily_metrics'). Enqueues one PGBoss job per user onto the
 * daily-metrics queue; {@link DailyMetricsComputeListener} consumes them so a
 * slow/failing user compute never blocks the schedule, and pgboss retry applies
 * per user.
 *
 *  - Nightly (00:20 UTC): a 2-day window ending today — finalizes yesterday
 *    (captures rows that landed after the last intraday tick) and seeds today.
 *  - Hourly (:10): a 1-day window — recomputes today as capture data streams in,
 *    so same-day questions ("how far did I travel today?") stay current.
 *
 * Follow-up: days are bucketed in UTC until users carry a profile timezone.
 */
@Injectable()
export class DailyMetricsCron {
  constructor(
    private readonly eventService: EventService,
    private readonly userService: UserService,
    private readonly featureService: FeatureService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(DailyMetricsCron.name);
  }

  @Cron(NIGHTLY_CRON)
  async nightly(): Promise<void> {
    await this.enqueueForAllUsers(2, 'nightly');
  }

  @Cron(ROLLING_CRON)
  async rolling(): Promise<void> {
    await this.enqueueForAllUsers(1, 'rolling');
  }

  private async enqueueForAllUsers(days: number, trigger: 'nightly' | 'rolling'): Promise<void> {
    if (!(await this.featureService.isFeatureEnabled('insights.daily_metrics'))) {
      return;
    }

    const users = await this.userService.findAll();
    const endDate = todayIso();

    for (const user of users) {
      try {
        await this.eventService.send(
          DailyMetricsComputeRequestEvent,
          { userId: user.id, endDate, days },
          { queue: DAILY_METRICS_QUEUE },
        );
      } catch (err) {
        this.logger.error(
          `Failed to enqueue daily-metrics compute for user ${user.id}`,
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }

    this.logger.log('Enqueued daily-metrics compute jobs', {
      trigger,
      endDate,
      days,
      userCount: users.length,
    });
  }
}
