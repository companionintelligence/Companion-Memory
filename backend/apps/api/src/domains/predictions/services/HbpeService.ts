import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

import type { ForecastResponse } from '../types';

/** Max days a forecastRange call may span — mirrors the sidecar's today..today+7 window. */
export const MAX_FORECAST_RANGE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class HbpeService {
  private readonly baseUrl = config.services.hbpe.host;

  constructor(private readonly logger: LoggerService) {
    this.logger.setContext('HbpeService');
  }

  async getForecast(
    context: UserServiceContext,
    horizon = '24h',
    horizonStart?: string,
  ): Promise<ForecastResponse> {
    // horizonStart is only ever a server-generated YYYY-MM-DD string (see
    // getForecastRange); omitting it keeps the sidecar's legacy default
    // (tomorrow) and a byte-identical response for existing callers.
    let url = `${this.baseUrl}/histogram?horizon=${horizon}&user_id=${context.userId}`;
    if (horizonStart) {
      url += `&horizon_start=${horizonStart}`;
    }

    let response: Response;

    try {
      response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      this.logger.warn('HBPE service unreachable', { url, err });
      throw new ServiceUnavailableException('Forecast service unavailable');
    }

    if (response.status === 401) {
      throw new UnauthorizedException('Missing or invalid user context');
    }

    if (!response.ok) {
      this.logger.warn('HBPE service returned error', { url, status: response.status });
      throw new ServiceUnavailableException('Forecast service error');
    }

    return response.json() as Promise<ForecastResponse>;
  }

  /**
   * Fetch per-day forecasts for a multi-day window (CI-Engineering#61) —
   * weekly scheduling and the week-heatmap dashboard rows.
   *
   * Calls the sidecar once per day, sequentially. This is cheap: the engine
   * memoizes per-day ONNX outputs in its _output_cache, so all N days share
   * the same trailing-30-day history and each extra day only pays the
   * aggregation pass. Each served day is independently written to
   * hbpe.prediction_log by the sidecar, keeping every day scoreable.
   *
   * Honesty note: every day comes from the SAME recency×day-of-week kernel
   * over the trailing 30 days. Quality does not degrade with distance the way
   * a learned AR model's would — but the DoW boost means day+7 approximates
   * day+0's same-weekday pattern, and q10/q50/q90 stay a cross-day confidence
   * spread, not predictive intervals.
   *
   * A day whose fetch fails is returned as a structured placeholder
   * (system_status: 'UNAVAILABLE', empty buckets) rather than failing the
   * whole range — one flaky day should not blank a week heatmap. Auth
   * failures (401) still propagate: they apply equally to every day.
   *
   * @param startDate First day of the range (YYYY-MM-DD, UTC). Defaults to
   *   tomorrow — the sidecar's own single-day default.
   * @param days Number of consecutive days, clamped to 1..MAX_FORECAST_RANGE_DAYS.
   */
  async getForecastRange(
    context: UserServiceContext,
    startDate?: string,
    days = MAX_FORECAST_RANGE_DAYS,
  ): Promise<ForecastResponse[]> {
    const clampedDays = Math.max(1, Math.min(Math.trunc(days), MAX_FORECAST_RANGE_DAYS));
    const start = this.resolveStartDate(startDate);

    const results: ForecastResponse[] = [];

    for (let i = 0; i < clampedDays; i++) {
      const dayStr = new Date(start.getTime() + i * DAY_MS).toISOString().slice(0, 10);

      try {
        results.push(await this.getForecast(context, '24h', dayStr));
      } catch (err) {
        if (err instanceof UnauthorizedException) {
          throw err;
        }

        // Sidecar down / per-day error (e.g. the day fell outside the
        // sidecar's today..today+7 window): degrade that day only.
        this.logger.warn('Forecast range day unavailable', { day: dayStr, err });
        results.push({
          horizon: '24h',
          generated_at: new Date().toISOString(),
          system_status: 'UNAVAILABLE',
          horizon_start: dayStr,
          buckets: [],
        });
      }
    }

    return results;
  }

  /** Parse a YYYY-MM-DD start date (UTC midnight); default to tomorrow (UTC). */
  private resolveStartDate(startDate?: string): Date {
    if (!startDate) {
      const todayUtc = new Date(new Date().toISOString().slice(0, 10));

      return new Date(todayUtc.getTime() + DAY_MS);
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || Number.isNaN(Date.parse(`${startDate}T00:00:00Z`))) {
      throw new Error(`Invalid startDate '${startDate}': expected YYYY-MM-DD`);
    }

    return new Date(`${startDate}T00:00:00Z`);
  }

  async triggerPipeline(userId: string): Promise<string> {
    const url = `${this.baseUrl}/trigger?user_id=${userId}`;

    try {
      const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(5_000) });
      if (!response.ok) {
        this.logger.warn('HBPE trigger returned error', { url, status: response.status });

        return 'error';
      }

      const body = (await response.json()) as { status: string };

      return body.status ?? 'triggered';
    } catch (err) {
      this.logger.warn('HBPE trigger unreachable', { url, err });

      return 'error';
    }
  }
}
