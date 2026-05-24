import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

import type { ForecastResponse } from '../types';

@Injectable()
export class HbpeService {
  private readonly baseUrl = config.services.hbpe.host;

  constructor(private readonly logger: LoggerService) {
    this.logger.setContext('HbpeService');
  }

  async getForecast(context: UserServiceContext, horizon = '48h'): Promise<ForecastResponse> {
    const url = `${this.baseUrl}/histogram?horizon=${horizon}&user_id=${context.userId}`;

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
