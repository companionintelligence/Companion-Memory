import { Injectable, ServiceUnavailableException } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

import type { ForecastResponse } from '../types';

@Injectable()
export class HbpeService {
  private readonly baseUrl = config.services.hbpe.host;

  constructor(private readonly logger: LoggerService) {
    this.logger.setContext('HbpeService');
  }

  async getForecast(horizon = '48h'): Promise<ForecastResponse> {
    const url = `${this.baseUrl}/histogram?horizon=${horizon}`;

    let response: Response;

    try {
      response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      this.logger.warn('HBPE service unreachable', { url, err });
      throw new ServiceUnavailableException('Forecast service unavailable');
    }

    if (!response.ok) {
      this.logger.warn('HBPE service returned error', { url, status: response.status });
      throw new ServiceUnavailableException('Forecast service error');
    }

    return response.json() as Promise<ForecastResponse>;
  }
}
