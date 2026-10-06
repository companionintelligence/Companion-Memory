import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { sidecarAuthHeaders } from '@ci/common/sidecar/sidecarAuth';
import config from '@ci/configuration';

import type { DueResponse, ForecastResponse, ForageTrialResponse, WeekForecastResponse } from '../types';

type ForageLakeSpec = Record<string, unknown>;

/**
 * The day-ahead horizons the sidecar's `/histogram` serves. One today; the MCP
 * forecast tool and the GraphQL `forecast` query both check against this list.
 */
export const FORECAST_HORIZONS = ['24h'] as const;

export type ForecastHorizon = (typeof FORECAST_HORIZONS)[number];

export function isForecastHorizon(value: unknown): value is ForecastHorizon {
  return typeof value === 'string' && (FORECAST_HORIZONS as readonly string[]).includes(value);
}

/** @throws BadRequestException for a horizon the sidecar does not serve. */
export function assertForecastHorizon(value: unknown): asserts value is ForecastHorizon {
  if (!isForecastHorizon(value)) {
    throw new BadRequestException(`Unsupported forecast horizon. Supported: ${FORECAST_HORIZONS.join(', ')}`);
  }
}

/**
 * A sidecar path with its query string built by `URLSearchParams`, never by
 * interpolation.
 *
 * The sidecar takes the user from `user_id` in the query and trusts it: the
 * shared bearer is its only check. So nothing a caller supplies may be able to
 * add a parameter or end the query early. A raw `&user_id=...` or `#` inside an
 * interpolated value did both, and `forecast(horizon:)` could read another
 * account's forecast that way. `URLSearchParams` encodes `&`, `=` and `#`, and
 * the caller's own `user_id` is always set here, from the service context.
 */
function sidecarPath(
  route: string,
  context: UserServiceContext,
  params: Record<string, string> = {},
): string {
  const query = new URLSearchParams(params);

  query.set('user_id', context.userId);

  return `${route}?${query.toString()}`;
}

@Injectable()
export class HbpeService {
  private readonly baseUrl = config.services.hbpe.host;

  constructor(private readonly logger: LoggerService) {
    this.logger.setContext('HbpeService');
  }

  /**
   * @throws BadRequestException for a horizon the sidecar does not serve. Checked
   *   here as well as at the GraphQL edge, so a new caller cannot skip it.
   */
  async getForecast(context: UserServiceContext, horizon: string = '24h'): Promise<ForecastResponse> {
    assertForecastHorizon(horizon);

    return this.get<ForecastResponse>(sidecarPath('/histogram', context, { horizon }));
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
    return this.get<WeekForecastResponse>(
      sidecarPath('/forecast', context, {
        horizon: '7d',
        ...(includeToday ? { include_today: 'true' } : {}),
        ...(timezone ? { timezone } : {}),
      }),
    );
  }

  async getDueList(context: UserServiceContext): Promise<DueResponse> {
    return this.get<DueResponse>(sidecarPath('/forecast/due', context));
  }

  async getForage(context: UserServiceContext, autoload = true): Promise<ForageTrialResponse | null> {
    try {
      return await this.request<ForageTrialResponse>(
        sidecarPath('/forage', context, { autoload: autoload ? 'true' : 'false' }),
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
      sidecarPath('/forage/ask', context),
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
      sidecarPath('/forage/ingest', context),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items }),
      },
      { timeoutMs: 15_000 },
    );
  }

  async forageSample(context: UserServiceContext): Promise<ForageTrialResponse> {
    return this.request<ForageTrialResponse>(sidecarPath('/forage/sample', context), { method: 'POST' });
  }

  async foragePin(context: UserServiceContext, branch: string): Promise<ForageTrialResponse> {
    return this.request<ForageTrialResponse>(
      sidecarPath(`/forage/pin/${encodeURIComponent(branch)}`, context),
      { method: 'POST' },
    );
  }

  async forageReset(context: UserServiceContext): Promise<ForageTrialResponse> {
    return this.request<ForageTrialResponse>(sidecarPath('/forage/ask', context), { method: 'POST' });
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
