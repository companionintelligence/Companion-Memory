import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';

import {
  DAILY_METRICS_QUEUE,
  DailyMetricsComputeRequestEvent,
  type DailyMetricsComputeRequestPayload,
} from '../events';
import { DailyMetricsService } from '../services/DailyMetricsService';

/**
 * The single consumer of the {@link DAILY_METRICS_QUEUE} queue. Both producers
 * (the nightly/rolling cron and the historical backfill endpoint) enqueue the
 * same {@link DailyMetricsComputeRequestEvent} shape — one (user, window) job —
 * so retry/backoff semantics and idempotency (computeWindow upserts on
 * (user_id, date)) are identical for scheduled and backfill work.
 */
@Injectable()
export class DailyMetricsComputeListener {
  constructor(
    private readonly dailyMetricsService: DailyMetricsService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(DailyMetricsComputeListener.name);
  }

  @OnEvent(DailyMetricsComputeRequestEvent, { queue: DAILY_METRICS_QUEUE })
  async computeWindow(payload: DailyMetricsComputeRequestPayload): Promise<void> {
    const timezone = payload.timezone ?? 'UTC';

    const computed = await this.dailyMetricsService.computeWindow(
      { userId: payload.userId },
      payload.endDate,
      payload.days,
      timezone,
    );

    this.logger.log('Computed daily-metrics window', {
      userId: payload.userId,
      endDate: payload.endDate,
      days: payload.days,
      timezone,
      rows: computed.length,
    });
  }
}
