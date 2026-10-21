import type { RequestContext } from '@ci/common/context';
import type { FeatureService } from '@ci/common/feature';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import { PYTHON_FUNCTION_QUEUE_OPTIONS, PythonFunctionService } from '@ci/domains/python-functions';

import { ForecastResolver } from '../ForecastResolver';

/**
 * `triggerHbpe` reports `already_running` by reading `dispatch()`'s return
 * value, which is `false` only when pg-boss actually refused the duplicate
 * `fn:nightly:${userId}:manual` singletonKey — something the mock-`send()`
 * unit tests elsewhere in this domain cannot prove, because they simply tell
 * `send()` what to return. This fake `EventService` instead reimplements the
 * real mechanism (pg-boss's partial unique index on (queue, singleton_key)
 * `WHERE state='created' AND policy='short'`) against an in-memory "created
 * jobs" table, gated on the REAL `PYTHON_FUNCTION_QUEUE_OPTIONS.hbpe.policy`
 * — so this test fails if that policy is ever removed, exactly the bug this
 * queue had.
 */
function makePgBossLikeEventService(): EventService {
  const created = new Set<string>();

  const send = jest.fn(
    async (
      _name: unknown,
      _payload: unknown,
      options?: { queue?: string; singletonKey?: string },
    ): Promise<string[]> => {
      const queue = options?.queue ?? 'default';
      const policy = queue === 'py-fn-hbpe' ? PYTHON_FUNCTION_QUEUE_OPTIONS.hbpe.policy : undefined;
      const dedupeKey = `${queue}:${options?.singletonKey ?? ''}`;

      if (policy === 'short' && created.has(dedupeKey)) {
        return [];
      }

      created.add(dedupeKey);

      return [`job-${created.size}`];
    },
  ) as unknown as EventService['send'];

  return { send } as unknown as EventService;
}

function buildResolver(pythonFunctionService: PythonFunctionService): ForecastResolver {
  const logger = { setContext() {}, log() {}, warn() {}, error() {} } as unknown as LoggerService;
  const featureService = { isFeatureEnabled: jest.fn().mockResolvedValue(true) } as unknown as FeatureService;

  return new ForecastResolver(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    pythonFunctionService,
    {} as never,
    featureService,
    logger,
  );
}

describe('ForecastResolver.triggerHbpe already_running', () => {
  it('reports already_running on a second manual trigger while the first is still pending, given real pg-boss dedup', async () => {
    const eventService = makePgBossLikeEventService();
    const logger = { setContext() {}, log() {}, warn() {}, error() {} } as unknown as LoggerService;
    const pythonFunctionService = new PythonFunctionService(eventService, logger);
    const resolver = buildResolver(pythonFunctionService);
    const context = { userId: 'user-1' } as RequestContext;

    const first = await resolver.triggerHbpe(context);
    const second = await resolver.triggerHbpe(context);

    expect(first).toBe('triggered');
    expect(second).toBe('already_running');
  });

  it('lets a different user trigger independently', async () => {
    const eventService = makePgBossLikeEventService();
    const logger = { setContext() {}, log() {}, warn() {}, error() {} } as unknown as LoggerService;
    const pythonFunctionService = new PythonFunctionService(eventService, logger);
    const resolver = buildResolver(pythonFunctionService);

    const first = await resolver.triggerHbpe({ userId: 'user-1' } as RequestContext);
    const second = await resolver.triggerHbpe({ userId: 'user-2' } as RequestContext);

    expect(first).toBe('triggered');
    expect(second).toBe('triggered');
  });
});
