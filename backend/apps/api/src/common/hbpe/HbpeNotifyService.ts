import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';

/**
 * Postgres channels HBPE's EventIngester already LISTENs on.
 * Producers are this service — not SQL triggers — so the invalidate path
 * is visible in application logs and call sites.
 */
export const HBPE_NOTIFY_CHANNELS = {
  events: 'ci_events',
  browserActivity: 'ci_browser_activity',
  communications: 'ci_communications',
} as const;

export type HbpeNotifyChannel = (typeof HBPE_NOTIFY_CHANNELS)[keyof typeof HBPE_NOTIFY_CHANNELS];

/** UTC calendar day (`YYYY-MM-DD`) of a timestamptz. UI converts to the user TZ. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Tells HBPE a user-day's inference cache is stale.
 *
 * Payload matches EventIngester: `{ user_id, date }` with `date` in UTC.
 * Failures are logged and swallowed — the 30s token_stream poll is the
 * safety net, and a write must not fail because LISTEN is down.
 */
@Injectable()
export class HbpeNotifyService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(HbpeNotifyService.name);
  }

  async notifyEvents(userId: string, at: Date | Iterable<Date | null | undefined>): Promise<void> {
    return this.notify(HBPE_NOTIFY_CHANNELS.events, userId, at);
  }

  async notifyBrowserActivity(userId: string, at: Date | Iterable<Date | null | undefined>): Promise<void> {
    return this.notify(HBPE_NOTIFY_CHANNELS.browserActivity, userId, at);
  }

  async notifyCommunications(userId: string, at: Date | Iterable<Date | null | undefined>): Promise<void> {
    return this.notify(HBPE_NOTIFY_CHANNELS.communications, userId, at);
  }

  async notify(
    channel: HbpeNotifyChannel,
    userId: string,
    at: Date | Iterable<Date | null | undefined>,
  ): Promise<void> {
    if (!userId) {
      return;
    }

    const dates = new Set<string>();
    const times = at instanceof Date ? [at] : at;
    for (const time of times) {
      if (time instanceof Date && !Number.isNaN(time.getTime())) {
        dates.add(utcDay(time));
      }
    }

    for (const date of dates) {
      const payload = JSON.stringify({ user_id: userId, date });
      try {
        await this.dataSource.query('SELECT pg_notify($1, $2)', [channel, payload]);
        this.logger.log('HBPE cache invalidate notified', { channel, userId, date });
      } catch (error) {
        this.logger.warn('HBPE notify failed', {
          channel,
          userId,
          date,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
