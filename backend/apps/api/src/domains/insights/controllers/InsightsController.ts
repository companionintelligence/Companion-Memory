import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';

import { type BackfillResult, DailyMetricsBackfillService } from '../services/DailyMetricsBackfillService';

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

// Body for POST /api/insights/daily-metrics/backfill. All optional: defaults
// sweep from the user's earliest captured data through today, 30 days per
// enqueued chunk job.
const backfillSchema = z.object({
  /** Inclusive start date (YYYY-MM-DD). Default: earliest captured data. */
  fromDate: isoDateSchema.optional(),
  /** Inclusive end date (YYYY-MM-DD). Default: today (UTC). */
  toDate: isoDateSchema.optional(),
  /** Days per chunk job (default 30). */
  chunkDays: z.coerce.number().int().min(1).max(365).optional(),
  /** IANA timezone for day bucketing (default UTC). */
  timezone: z.string().min(1).optional(),
});

type BackfillRequest = z.infer<typeof backfillSchema>;

/**
 * Operator-facing insights endpoints. POST /api/insights/daily-metrics/backfill
 * enqueues the historical daily-metrics backfill for the signed-in user: one
 * PGBoss job per date-range chunk on the daily-metrics queue, consumed by the
 * same listener as the nightly cron. Re-runnable and idempotent (per-day
 * upserts) — safe to re-invoke to resume after a failure.
 */
@UseGuards(JwtOrApiKeyAuthGuard)
@Controller('api/insights')
export class InsightsController {
  constructor(private readonly backfillService: DailyMetricsBackfillService) {}

  @Post('daily-metrics/backfill')
  async backfillDailyMetrics(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(backfillSchema)) body: BackfillRequest,
  ): Promise<BackfillResult> {
    return this.backfillService.backfill(toServiceContext(context), {
      fromDate: body.fromDate,
      toDate: body.toDate,
      chunkDays: body.chunkDays,
      timezone: body.timezone,
    });
  }
}
