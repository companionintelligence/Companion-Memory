import { defineEvent } from '@ci/domains/events';

/**
 * The dedicated PGBoss queue for daily-metrics compute work. PGBoss `send`
 * fans an event out to every registered queue and listeners self-scope by
 * queue name, so BOTH the senders (cron, backfill endpoint) and the consumer
 * (DailyMetricsComputeListener) must name this queue — a sender without a
 * consumer is a silent drop.
 */
export const DAILY_METRICS_QUEUE = 'daily-metrics';

export const DailyMetricsComputeRequestEvent = 'insights.daily_metrics.compute';

export type DailyMetricsComputeRequestPayload = {
  userId: string;
  /** Inclusive end of the window, YYYY-MM-DD (local to `timezone`). */
  endDate: string;
  /** Window length in days ending at `endDate` (1 = just that day). */
  days: number;
  /** IANA timezone the days are bucketed in; defaults to UTC. */
  timezone?: string;
};

defineEvent<DailyMetricsComputeRequestPayload>(DailyMetricsComputeRequestEvent);

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [DailyMetricsComputeRequestEvent]: DailyMetricsComputeRequestPayload;
  }
}
