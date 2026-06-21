import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { FeatureService } from '@ci/common/feature';
import { LoggerService } from '@ci/common/logging';
import { HbpeService, type ForecastBucket } from '@ci/domains/predictions';

const FORECAST_BUCKET_DURATION_MS = 30 * 60 * 1000;
const FORECAST_HORIZON = '24h';
const MAX_FORECAST_LINES = 24;

@Injectable()
export class ForecastContextService {
  constructor(
    private readonly hbpeService: HbpeService,
    private readonly featureService: FeatureService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ForecastContextService.name);
  }

  async getRestOfDayBlock(context: UserServiceContext, now = new Date()): Promise<string> {
    if (!(await this.featureService.isFeatureEnabled('hbpe'))) {
      return '';
    }

    try {
      const [forecast, timezone] = await Promise.all([
        this.hbpeService.getForecast(context, FORECAST_HORIZON),
        this.getUserTimezone(context.userId),
      ]);
      const todaysBuckets = forecast.buckets
        .filter((bucket) => this.isRemainingToday(bucket, timezone, now))
        .slice(0, MAX_FORECAST_LINES);

      if (todaysBuckets.length === 0) {
        return '';
      }

      const lines = [
        '## Predicted Rest Of Day',
        `Generated: ${this.formatDateTime(new Date(forecast.generated_at), timezone)}`,
        `Status: ${forecast.system_status}`,
      ];

      todaysBuckets.forEach((bucket) => {
        const start = this.formatTime(new Date(bucket.start_time), timezone);
        const l0 = this.formatTopProbability(bucket.l0_probs);
        const l1 = this.formatTopProbability(bucket.l1_probs);
        const l2 = bucket.l2_probs ? this.formatTopProbability(bucket.l2_probs) : '';
        const labels = [l0, l1, l2].filter(Boolean).join(' | ');

        lines.push(`- ${start}: ${labels}`);
      });

      return lines.join('\n');
    } catch (err) {
      this.logger.warn(`HBPE context block failed for user ${context.userId}: ${err}`);

      return '';
    }
  }

  private async getUserTimezone(userId: string): Promise<string> {
    const result = (await this.dataSource.query('SELECT timezone FROM ci.users WHERE id = $1', [
      userId,
    ])) as Array<{ timezone?: string | null }>;
    const timezone = result[0]?.timezone?.trim();

    if (!timezone || !this.isValidTimezone(timezone)) {
      return 'UTC';
    }

    return timezone;
  }

  private isRemainingToday(bucket: ForecastBucket, timezone: string, now: Date): boolean {
    const start = new Date(bucket.start_time);

    if (Number.isNaN(start.getTime())) {
      return false;
    }

    const end = new Date(start.getTime() + FORECAST_BUCKET_DURATION_MS);

    return end > now && this.getLocalDateKey(start, timezone) === this.getLocalDateKey(now, timezone);
  }

  private formatTopProbability(probabilities: Record<string, number>): string {
    const [label, probability] = Object.entries(probabilities).sort(([, a], [, b]) => b - a)[0] ?? [];

    if (!label || probability == null) {
      return '';
    }

    return `${label} ${Math.round(probability * 100)}%`;
  }

  private formatTime(date: Date, timezone: string): string {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: '2-digit',
    }).format(date);
  }

  private formatDateTime(date: Date, timezone: string): string {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(date);
  }

  private getLocalDateKey(date: Date, timezone: string): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const values = new Map(parts.map((part) => [part.type, part.value]));

    return `${values.get('year')}-${values.get('month')}-${values.get('day')}`;
  }

  private isValidTimezone(timezone: string): boolean {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());

      return true;
    } catch {
      return false;
    }
  }
}
