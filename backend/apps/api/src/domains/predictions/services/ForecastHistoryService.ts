import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';

export const FORECAST_HISTORY_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface ForecastHistoryBucket {
  bucketIndex: number;
  predictedL0: Array<{ label: string; probability: number }>;
  actualL0: string | null;
}

export interface ForecastHistoryDay {
  date: string;
  buckets: ForecastHistoryBucket[];
}

/**
 * Latest logged forecast per 15-minute bucket from hbpe.prediction_log —
 * the table /histogram already writes and actuals_backfill already fills.
 */
@Injectable()
export class ForecastHistoryService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ForecastHistoryService.name);
  }

  async getHistory(context: UserServiceContext, date: string): Promise<ForecastHistoryBucket[]> {
    if (!FORECAST_HISTORY_DATE_PATTERN.test(date)) {
      throw new BadRequestException('date must be a calendar date formatted YYYY-MM-DD');
    }

    try {
      const rows = (await this.dataSource.query(
        `
        SELECT DISTINCT ON (bucket_index)
               bucket_index, l0_probs, actual_l0
        FROM hbpe.prediction_log
        WHERE user_id = $1
          AND (horizon_start AT TIME ZONE 'UTC')::date = $2::date
        ORDER BY bucket_index ASC, predicted_at DESC
        `,
        [context.userId, date],
      )) as Array<{ bucket_index: number; l0_probs: unknown; actual_l0: string | null }>;

      return rows.map((row) => ({
        bucketIndex: Number(row.bucket_index),
        predictedL0: toEntries(row.l0_probs),
        actualL0: row.actual_l0,
      }));
    } catch (error) {
      if (isMissingRelation(error)) {
        return [];
      }

      throw error;
    }
  }

  async getRecentDays(context: UserServiceContext, days = 5): Promise<ForecastHistoryDay[]> {
    const clamped = Math.min(14, Math.max(1, days));

    try {
      const rows = (await this.dataSource.query(
        `
        SELECT DISTINCT ON (((horizon_start AT TIME ZONE 'UTC')::date), bucket_index)
               (horizon_start AT TIME ZONE 'UTC')::date::text AS date,
               bucket_index, l0_probs, actual_l0
        FROM hbpe.prediction_log
        WHERE user_id = $1
          AND horizon_start >= (now() AT TIME ZONE 'UTC')::date - ($2::int || ' days')::interval
          AND horizon_start < (now() AT TIME ZONE 'UTC')::date
        ORDER BY 1 DESC, bucket_index ASC, predicted_at DESC
        `,
        [context.userId, clamped],
      )) as Array<{ date: string; bucket_index: number; l0_probs: unknown; actual_l0: string | null }>;

      const byDate = new Map<string, ForecastHistoryBucket[]>();
      for (const row of rows) {
        const list = byDate.get(row.date) ?? [];
        list.push({
          bucketIndex: Number(row.bucket_index),
          predictedL0: toEntries(row.l0_probs),
          actualL0: row.actual_l0,
        });
        byDate.set(row.date, list);
      }

      return [...byDate.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, buckets]) => ({ date, buckets }));
    } catch (error) {
      if (isMissingRelation(error)) {
        return [];
      }

      this.logger.warn('Forecast history read failed', {
        userId: context.userId,
        error: error instanceof Error ? error.message : String(error),
      });

      return [];
    }
  }
}

function toEntries(value: unknown): Array<{ label: string; probability: number }> {
  if (!value || typeof value !== 'object') {
    return [];
  }

  return Object.entries(value as Record<string, unknown>)
    .map(([label, probability]) => ({ label, probability: Number(probability) }))
    .filter((entry) => Number.isFinite(entry.probability))
    .sort((a, b) => b.probability - a.probability);
}

function isMissingRelation(error: unknown): boolean {
  const wrapped = error as { code?: string; driverError?: { code?: string } };
  const code = wrapped.code ?? wrapped.driverError?.code;

  return code === '42P01' || code === '3F000';
}
