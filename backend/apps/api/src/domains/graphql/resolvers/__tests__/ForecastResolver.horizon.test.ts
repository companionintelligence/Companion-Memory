import { BadRequestException } from '@nestjs/common';

import { ContextService, type RequestContext } from '@ci/common/context';
import type { FeatureService } from '@ci/common/feature';
import type { LoggerService } from '@ci/common/logging';
import type { HbpeService } from '@ci/domains/predictions';

import { ForecastResolver } from '../ForecastResolver';

/**
 * `forecast(horizon:)` is a free String on the wire (the web app declares
 * `$horizon: String`), so the resolver is where it is narrowed to what the
 * sidecar serves. Anything else is refused as the caller's mistake, never sent
 * on and never swallowed into the `null` every other failure becomes.
 */

const ME = '00000000-0000-4000-8000-0000000000aa';
const OTHER = '00000000-0000-4000-8000-0000000000bb';

function buildResolver() {
  const hbpe = {
    getForecast: jest.fn(async () => ({
      horizon: '24h',
      generated_at: '2026-10-06T00:00:00Z',
      system_status: 'READY',
      buckets: [],
    })),
  };
  const logger = { setContext() {}, log() {}, warn() {}, error: jest.fn() } as unknown as LoggerService;
  const featureService = { isFeatureEnabled: jest.fn().mockResolvedValue(true) } as unknown as FeatureService;

  const resolver = new ForecastResolver(
    hbpe as unknown as HbpeService,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    featureService,
    logger,
  );

  return { resolver, hbpe };
}

const context: RequestContext = { userId: ME };

/** `toServiceContext` reads the request context from AsyncLocalStorage. */
function asCaller<T>(fn: () => Promise<T>): Promise<T> {
  return ContextService.run({ traceId: 'test', userId: ME }, fn);
}

describe('ForecastResolver.forecast horizon', () => {
  it.each([
    ['a smuggled user id', `24h&user_id=${OTHER}#`],
    ['a horizon the sidecar does not serve', '7d'],
    ['an empty string', ''],
  ])('refuses %s without asking the sidecar', async (_label, horizon) => {
    const { resolver, hbpe } = buildResolver();

    await expect(asCaller(() => resolver.forecast(context, horizon))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(hbpe.getForecast).not.toHaveBeenCalled();
  });

  it("passes 24h through for the caller's own forecast", async () => {
    const { resolver, hbpe } = buildResolver();

    await asCaller(() => resolver.forecast(context, '24h'));

    expect(hbpe.getForecast).toHaveBeenCalledWith({ userId: ME }, '24h');
  });
});
