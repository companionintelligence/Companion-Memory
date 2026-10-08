import { BadRequestException } from '@nestjs/common';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';

import { HbpeService } from '../HbpeService';

/**
 * The HBPE sidecar takes its user from `user_id` in the query string and
 * trusts it; the shared bearer is its only check. So the property worth
 * pinning here is narrow: whatever a caller hands this service, the request
 * that leaves it names exactly one user, the caller, and nothing a caller
 * supplied can add a parameter or cut the query short.
 *
 * `forecast(horizon: "24h&user_id=<other>#")` used to do both: the injected
 * `user_id` came first and the `#` turned the real one into a fragment, which
 * fetch never sends.
 */

const ME = '00000000-0000-4000-8000-0000000000aa';
const OTHER = '00000000-0000-4000-8000-0000000000bb';
const CTX: UserServiceContext = { userId: ME };

/** The values a caller controls, written the way one would to smuggle a parameter. */
const INJECTED = `24h&user_id=${OTHER}#`;

describe('HbpeService', () => {
  const realFetch = globalThis.fetch;
  let urls: URL[];
  let service: HbpeService;

  beforeEach(() => {
    urls = [];
    globalThis.fetch = (async (input: unknown) => {
      urls.push(new URL(String(input)));

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const logger = { setContext: jest.fn(), warn: jest.fn(), log: jest.fn(), error: jest.fn() };
    service = new HbpeService(logger as unknown as LoggerService);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** The one request this test made, after asserting there was exactly one. */
  function sent(): URL {
    expect(urls).toHaveLength(1);

    return urls[0];
  }

  describe('getForecast', () => {
    it('refuses a horizon the sidecar does not serve, before anything is sent', async () => {
      await expect(service.getForecast(CTX, INJECTED)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.getForecast(CTX, '7d')).rejects.toBeInstanceOf(BadRequestException);

      expect(urls).toEqual([]);
    });

    it("asks for the caller's own 24h histogram", async () => {
      await service.getForecast(CTX, '24h');

      const url = sent();
      expect(url.pathname).toBe('/histogram');
      expect(url.searchParams.get('horizon')).toBe('24h');
      expect(url.searchParams.getAll('user_id')).toEqual([ME]);
    });

    it('defaults to 24h', async () => {
      await service.getForecast(CTX);

      expect(sent().searchParams.get('horizon')).toBe('24h');
    });
  });

  it('encodes a timezone instead of letting it add parameters', async () => {
    await service.getWeekForecast(CTX, true, `UTC&user_id=${OTHER}#`);

    const url = sent();
    expect(url.pathname).toBe('/forecast');
    expect(url.searchParams.getAll('user_id')).toEqual([ME]);
    expect(url.searchParams.get('timezone')).toBe(`UTC&user_id=${OTHER}#`);
    expect(url.searchParams.get('include_today')).toBe('true');
    expect(url.searchParams.get('horizon')).toBe('7d');
    expect(url.hash).toBe('');
  });

  it('leaves include_today and timezone out when they are not asked for', async () => {
    await service.getWeekForecast(CTX);

    const url = sent();
    expect(url.searchParams.has('include_today')).toBe(false);
    expect(url.searchParams.has('timezone')).toBe(false);
  });

  it('keeps a pinned branch name inside its path segment', async () => {
    await service.foragePin(CTX, `x?user_id=${OTHER}#`);

    const url = sent();
    expect(url.pathname).toBe(`/forage/pin/${encodeURIComponent(`x?user_id=${OTHER}#`)}`);
    expect(url.searchParams.getAll('user_id')).toEqual([ME]);
    expect(url.hash).toBe('');
  });

  it.each([
    ['getDueList', (s: HbpeService) => s.getDueList(CTX), '/forecast/due'],
    ['getForage', (s: HbpeService) => s.getForage(CTX, false), '/forage'],
    ['askForage', (s: HbpeService) => s.askForage(CTX, { branches: [] }), '/forage/ask'],
    ['ingestForage', (s: HbpeService) => s.ingestForage(CTX, []), '/forage/ingest'],
    ['forageSample', (s: HbpeService) => s.forageSample(CTX), '/forage/sample'],
    ['forageReset', (s: HbpeService) => s.forageReset(CTX), '/forage/ask'],
  ])('%s names the caller, and only the caller', async (_name, call, pathname) => {
    await call(service);

    const url = sent();
    expect(url.pathname).toBe(pathname);
    expect(url.searchParams.getAll('user_id')).toEqual([ME]);
  });
});
