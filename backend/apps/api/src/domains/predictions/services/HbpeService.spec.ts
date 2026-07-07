import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';

import type { ForecastBucket, ForecastResponse } from '../types';

import { HbpeService, MAX_FORECAST_RANGE_DAYS } from './HbpeService';

const USER = '00000000-0000-0000-0000-0000000000aa';
const CONTEXT: UserServiceContext = { userId: USER } as UserServiceContext;

function makeService() {
  const logger = {
    setContext: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    log: jest.fn(),
  } as unknown as LoggerService;

  return new HbpeService(logger);
}

function forecastBody(horizonStart?: string): ForecastResponse {
  return {
    horizon: '24h',
    generated_at: '2026-07-07T12:00:00Z',
    system_status: 'READY',
    ...(horizonStart ? { horizon_start: horizonStart } : {}),
    buckets: [{ bucket_index: 0 } as ForecastBucket],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** Extract the horizon_start param from a fetched URL (base host varies by env). */
function horizonStartOf(url: string): string | null {
  return new URL(url).searchParams.get('horizon_start');
}

describe('HbpeService', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  describe('getForecast (back-compat)', () => {
    it('omits horizon_start from the sidecar URL when not provided', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(forecastBody()));

      await makeService().getForecast(CONTEXT);

      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain(`/histogram?horizon=24h&user_id=${USER}`);
      expect(url).not.toContain('horizon_start');
    });
  });

  describe('getForecastRange', () => {
    it('fetches one forecast per day for a 3-day range', async () => {
      fetchMock.mockImplementation(async (url: string) =>
        jsonResponse(forecastBody(horizonStartOf(url) ?? undefined)),
      );

      const results = await makeService().getForecastRange(CONTEXT, '2026-07-08', 3);

      expect(fetchMock).toHaveBeenCalledTimes(3);
      const requestedDays = fetchMock.mock.calls.map(([url]) => horizonStartOf(url as string));
      expect(requestedDays).toEqual(['2026-07-08', '2026-07-09', '2026-07-10']);
      expect(results.map((r) => r.horizon_start)).toEqual(['2026-07-08', '2026-07-09', '2026-07-10']);
      expect(results.every((r) => r.system_status === 'READY')).toBe(true);
    });

    it('caps the range at MAX_FORECAST_RANGE_DAYS', async () => {
      fetchMock.mockImplementation(async (url: string) =>
        jsonResponse(forecastBody(horizonStartOf(url) ?? undefined)),
      );

      const results = await makeService().getForecastRange(CONTEXT, '2026-07-08', 30);

      expect(fetchMock).toHaveBeenCalledTimes(MAX_FORECAST_RANGE_DAYS);
      expect(results).toHaveLength(MAX_FORECAST_RANGE_DAYS);
    });

    it('clamps a non-positive day count to a single day', async () => {
      fetchMock.mockImplementation(async (url: string) =>
        jsonResponse(forecastBody(horizonStartOf(url) ?? undefined)),
      );

      const results = await makeService().getForecastRange(CONTEXT, '2026-07-08', 0);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(results).toHaveLength(1);
    });

    it('defaults the start date to tomorrow (UTC)', async () => {
      fetchMock.mockImplementation(async (url: string) =>
        jsonResponse(forecastBody(horizonStartOf(url) ?? undefined)),
      );

      await makeService().getForecastRange(CONTEXT, undefined, 1);

      const todayUtc = new Date(new Date().toISOString().slice(0, 10));
      const tomorrow = new Date(todayUtc.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      expect(horizonStartOf(fetchMock.mock.calls[0][0] as string)).toBe(tomorrow);
    });

    it('degrades a single failing day to an UNAVAILABLE placeholder without failing the range', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        const day = horizonStartOf(url);
        if (day === '2026-07-09') {
          throw new Error('connect ECONNREFUSED');
        }

        return jsonResponse(forecastBody(day ?? undefined));
      });

      const results = await makeService().getForecastRange(CONTEXT, '2026-07-08', 3);

      expect(results).toHaveLength(3);
      expect(results[0].system_status).toBe('READY');
      expect(results[1]).toMatchObject({
        system_status: 'UNAVAILABLE',
        horizon_start: '2026-07-09',
        buckets: [],
      });
      expect(results[2].system_status).toBe('READY');
    });

    it('degrades a sidecar error status (e.g. out-of-window 400) for that day only', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        const day = horizonStartOf(url);
        if (day === '2026-07-10') {
          return jsonResponse({ detail: 'horizon_start out of range' }, 400);
        }

        return jsonResponse(forecastBody(day ?? undefined));
      });

      const results = await makeService().getForecastRange(CONTEXT, '2026-07-08', 3);

      expect(results.map((r) => r.system_status)).toEqual(['READY', 'READY', 'UNAVAILABLE']);
      expect(results[2].horizon_start).toBe('2026-07-10');
    });

    it('propagates an auth failure instead of masking it as UNAVAILABLE', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ detail: 'user_id is required' }, 401));

      await expect(makeService().getForecastRange(CONTEXT, '2026-07-08', 3)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      // Fails fast on the first day — no point retrying the same credentials.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('rejects a malformed start date', async () => {
      await expect(makeService().getForecastRange(CONTEXT, 'next-tuesday', 3)).rejects.toThrow(
        /Invalid startDate/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('getForecast error mapping (unchanged)', () => {
    it('maps a network failure to ServiceUnavailableException', async () => {
      fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

      await expect(makeService().getForecast(CONTEXT)).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });
});
