import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { sidecarAuthHeaders } from '@ci/common/sidecar/sidecarAuth';
import config from '@ci/configuration';

import type { DueResponse, ForecastResponse, ForageTrialResponse, WeekForecastResponse } from '../types';

type ForageLakeSpec = Record<string, unknown>;

@Injectable()
export class HbpeService {
  private readonly baseUrl = config.services.hbpe.host;

  constructor(private readonly logger: LoggerService) {
    this.logger.setContext('HbpeService');
  }

  async getForecast(context: UserServiceContext, horizon = '24h'): Promise<ForecastResponse> {
    return this.get<ForecastResponse>(`/histogram?horizon=${horizon}&user_id=${context.userId}`);
  }

  /**
   * @param includeToday start the window at today rather than tomorrow. The
   *   schedule grid needs it (its first row is today); the feed's Week Ahead
   *   card does not, and leaving it false preserves that card's semantics.
   */
  async getWeekForecast(
    context: UserServiceContext,
    includeToday: boolean = false,
    timezone?: string,
  ): Promise<WeekForecastResponse> {
    const todayParam = includeToday ? '&include_today=true' : '';
    const tzParam = timezone ? `&timezone=${encodeURIComponent(timezone)}` : '';

    return this.get<WeekForecastResponse>(
      `/forecast?horizon=7d&user_id=${context.userId}${todayParam}${tzParam}`,
    );
  }

  async getDueList(context: UserServiceContext): Promise<DueResponse> {
    return this.get<DueResponse>(`/forecast/due?user_id=${context.userId}`);
  }

  async getForage(context: UserServiceContext, autoload = true): Promise<ForageTrialResponse | null> {
    const flag = autoload ? 'true' : 'false';

    try {
      return await this.request<ForageTrialResponse>(
        `/forage?user_id=${context.userId}&autoload=${flag}`,
        { method: 'GET' },
        { allowNotFound: true },
      );
    } catch (err) {
      this.logger.warn('Forage get failed', { err: err instanceof Error ? err.message : String(err) });

      return null;
    }
  }

  async askForage(context: UserServiceContext, spec: ForageLakeSpec): Promise<ForageTrialResponse> {
    return this.request<ForageTrialResponse>(
      `/forage/ask?user_id=${context.userId}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(spec),
      },
      { timeoutMs: 15_000 },
    );
  }

  async ingestForage(context: UserServiceContext, items: unknown[]): Promise<ForageTrialResponse> {
    return this.request<ForageTrialResponse>(
      `/forage/ingest?user_id=${context.userId}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items }),
      },
      { timeoutMs: 15_000 },
    );
  }

  async forageSample(context: UserServiceContext): Promise<ForageTrialResponse> {
    return this.request<ForageTrialResponse>(`/forage/sample?user_id=${context.userId}`, { method: 'POST' });
  }

  async foragePin(context: UserServiceContext, branch: string): Promise<ForageTrialResponse> {
    return this.request<ForageTrialResponse>(
      `/forage/pin/${encodeURIComponent(branch)}?user_id=${context.userId}`,
      { method: 'POST' },
    );
  }

  async forageReset(context: UserServiceContext): Promise<ForageTrialResponse> {
    return this.request<ForageTrialResponse>(`/forage/ask?user_id=${context.userId}`, { method: 'POST' });
  }

  private async get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'GET' });
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    options: { allowNotFound?: boolean; timeoutMs?: number } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    let response: Response;

    try {
      response = await fetch(url, {
        ...init,
        headers: { ...sidecarAuthHeaders(), ...(init.headers as Record<string, string> | undefined) },
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
    } catch (err) {
      this.logger.warn('HBPE service unreachable', { url, err });
      throw new ServiceUnavailableException('Forecast service unavailable');
    }

    if (response.status === 401) {
      throw new UnauthorizedException('Missing or invalid user context');
    }

    if (options.allowNotFound && response.status === 404) {
      return null as T;
    }

    if (!response.ok) {
      this.logger.warn('HBPE service returned error', { url, status: response.status });
      throw new ServiceUnavailableException('Forecast service error');
    }

    return response.json() as Promise<T>;
  }
}
