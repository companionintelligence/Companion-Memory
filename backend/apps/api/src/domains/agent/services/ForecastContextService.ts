import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { FeatureService } from '@ci/common/feature';
import { LoggerService } from '@ci/common/logging';
import { HbpeService, type ForecastBucket } from '@ci/domains/predictions';

/**
 * The width of one HBPE histogram slot: `BUCKET_MINUTES` in
 * `backend/apps/hbpe/src/ci/hbpe/buckets.py`, which emits 96 of them for the
 * 24h horizon. Copied because the sidecar's payload states start times, not a
 * width. `MemoryController.context.test.ts` reads that file and fails when the
 * two disagree; this said 30 for as long as HBPE had said 15.
 */
export const HBPE_SLOT_MINUTES = 15;
const HBPE_SLOT_MS = HBPE_SLOT_MINUTES * 60 * 1000;

/** One rendered line covers one clock hour of slots. */
const LINE_MS = 60 * 60 * 1000;

const FORECAST_HORIZON = '24h';

/**
 * A cap on rendered LINES, which are hours: 24 is the whole 24h horizon.
 *
 * It used to cap SLOTS at the same number, so the "Day Ahead" block an agent
 * keeps for a whole session described the first six hours of the day and
 * stopped. The block costs the same now and covers the day.
 */
const MAX_FORECAST_LINES = 24;

/** The slots that fall in one clock hour, folded into one line. */
interface ForecastLine {
  start: Date;
  end: Date;
  slots: ForecastBucket[];
}

export interface ForecastBlockOptions {
  /**
   * Render a block that is a pure function of the forecast payload, with no
   * wall-clock input at all: no `Generated:` line, and no "has this bucket
   * elapsed yet" filter — the forecast's own 24h horizon is rendered instead
   * of the slice of it that is still ahead of `now`.
   *
   * The L0 `GET /memory/context` block passes this. That endpoint is
   * advertised to out-of-process harnesses (CI-Hermes, CI-OpenClaw) as
   * "called once per session"; a block whose text changes every time a
   * forecast slot elapses makes that contract impossible to honour.
   */
  stable?: boolean;
}

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

  async getRestOfDayBlock(
    context: UserServiceContext,
    now = new Date(),
    { stable = false }: ForecastBlockOptions = {},
  ): Promise<string> {
    if (!(await this.featureService.isFeatureEnabled('hbpe'))) {
      return '';
    }

    try {
      const [forecast, timezone] = await Promise.all([
        this.hbpeService.getForecast(context, FORECAST_HORIZON),
        this.getUserTimezone(context.userId),
      ]);
      const todaysBuckets = stable
        ? forecast.buckets.filter((bucket) => !Number.isNaN(new Date(bucket.start_time).getTime()))
        : forecast.buckets.filter((bucket) => this.isRemainingToday(bucket, timezone, now));
      const hours = this.toHourLines(todaysBuckets);

      if (hours.length === 0) {
        return '';
      }

      const lines = stable
        ? ['## Predicted Day Ahead', `Status: ${forecast.system_status}`]
        : [
            '## Predicted Rest Of Day',
            `Generated: ${this.formatDateTime(new Date(forecast.generated_at), timezone)}`,
            `Status: ${forecast.system_status}`,
          ];

      hours.forEach((hour) => {
        const span = `${this.formatTime(hour.start, timezone)}–${this.formatTime(hour.end, timezone)}`;
        const l0 = this.formatTopProbability(meanProbabilities(hour.slots.map((slot) => slot.l0_probs)));
        const l1 = this.formatTopProbability(meanProbabilities(hour.slots.map((slot) => slot.l1_probs)));
        const l2 = this.formatTopProbability(meanProbabilities(hour.slots.map((slot) => slot.l2_probs)));
        const labels = [l0, l1, l2].filter(Boolean).join(' | ');

        lines.push(`- ${span}: ${labels}`);
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

    const end = new Date(start.getTime() + HBPE_SLOT_MS);

    return end > now && this.getLocalDateKey(start, timezone) === this.getLocalDateKey(now, timezone);
  }

  /**
   * Fold consecutive slots into one line per clock hour, at most
   * {@link MAX_FORECAST_LINES} of them.
   *
   * Hours are taken on the absolute timeline (`floor(t / 1h)`), not from the
   * user's wall clock, so a DST change cannot fold two real hours into one
   * line. In a zone whose offset is a whole number of hours, which is most of
   * them, the two agree. Elsewhere a line reads `5:30–6:30 AM` and still
   * covers one hour. A line whose slots do not fill the hour (the current hour
   * in the rest-of-day block) states the part it covers.
   */
  private toHourLines(buckets: readonly ForecastBucket[]): ForecastLine[] {
    const lines: ForecastLine[] = [];
    let currentHour: number | null = null;
    const ordered = [...buckets].sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time));

    for (const bucket of ordered) {
      const start = new Date(bucket.start_time);
      const hour = Math.floor(start.getTime() / LINE_MS);

      if (hour !== currentHour) {
        if (lines.length === MAX_FORECAST_LINES) {
          break;
        }

        lines.push({ start, end: start, slots: [] });
        currentHour = hour;
      }

      const line = lines[lines.length - 1];

      line.slots.push(bucket);
      line.end = new Date(start.getTime() + HBPE_SLOT_MS);
    }

    return lines;
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

/**
 * The mean of an hour's slot distributions: the chance of each label at a
 * random moment in that hour. A label a slot does not mention counts as zero
 * there, so a class seen in one quarter of the hour is not reported as if it
 * held all four.
 */
function meanProbabilities(
  distributions: ReadonlyArray<Record<string, number> | null | undefined>,
): Record<string, number> {
  const sums: Record<string, number> = {};

  for (const distribution of distributions) {
    for (const [label, probability] of Object.entries(distribution ?? {})) {
      sums[label] = (sums[label] ?? 0) + probability;
    }
  }

  return Object.fromEntries(
    Object.entries(sums).map(([label, sum]) => [label, sum / Math.max(distributions.length, 1)]),
  );
}
