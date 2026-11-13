import type { RequestContext } from '@ci/common/context';
import type { FeatureService } from '@ci/common/feature';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import { PYTHON_FUNCTION_QUEUE_OPTIONS, PythonFunctionService } from '@ci/domains/python-functions';

import { ForecastResolver } from '../ForecastResolver';

/**
 * `triggerHbpe` reports `already_running` when a manual run for this user is
 * still waiting or already running. This fake `EventService` reimplements the
 * two mechanisms that decide it against an in-memory job table: pg-boss's
 * partial unique index on (queue, singleton_key) `WHERE state='created' AND
 * policy='short'`, gated on the REAL `PYTHON_FUNCTION_QUEUE_OPTIONS.hbpe.policy`
 * (so this fails if that policy is ever removed, exactly the bug this queue
 * had), and `hasLiveJob`, which also sees a job that has started.
 */
function makePgBossLikeEventService() {
  const jobs: { queue: string; key: string; state: 'created' | 'active' | 'completed' }[] = [];

  const send = jest.fn(
    async (
      _name: unknown,
      _payload: unknown,
      options?: { queue?: string; singletonKey?: string },
    ): Promise<string[]> => {
      const queue = options?.queue ?? 'default';
      const key = options?.singletonKey ?? '';
      const policy = queue === 'py-fn-hbpe' ? PYTHON_FUNCTION_QUEUE_OPTIONS.hbpe.policy : undefined;

      if (
        policy === 'short' &&
        jobs.some((job) => job.queue === queue && job.key === key && job.state === 'created')
      ) {
        return [];
      }

      jobs.push({ queue, key, state: 'created' });

      return [`job-${jobs.length}`];
    },
  ) as unknown as EventService['send'];

  const hasLiveJob = jest.fn(async (queue: string, key: string) =>
    jobs.some((job) => job.queue === queue && job.key === key && job.state !== 'completed'),
  );

  const eventService = { send, hasLiveJob } as unknown as EventService;

  /** The worker picks every waiting job up, as pg-boss does a moment after the send. */
  const startAll = () =>
    jobs.filter((job) => job.state === 'created').forEach((job) => (job.state = 'active'));
  const finishAll = () => jobs.forEach((job) => (job.state = 'completed'));

  return { eventService, startAll, finishAll, jobs };
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
    const { eventService } = makePgBossLikeEventService();
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
    const { eventService } = makePgBossLikeEventService();
    const logger = { setContext() {}, log() {}, warn() {}, error() {} } as unknown as LoggerService;
    const pythonFunctionService = new PythonFunctionService(eventService, logger);
    const resolver = buildResolver(pythonFunctionService);

    const first = await resolver.triggerHbpe({ userId: 'user-1' } as RequestContext);
    const second = await resolver.triggerHbpe({ userId: 'user-2' } as RequestContext);

    expect(first).toBe('triggered');
    expect(second).toBe('triggered');
  });

  it('reports already_running once the first run has started, which the queue alone would accept', async () => {
    // pg-boss's `short` policy only refuses a duplicate while the first job is
    // still `created`; a second Predict after it went `active` used to start a
    // second hour-long run beside it.
    const queue = makePgBossLikeEventService();
    const logger = { setContext() {}, log() {}, warn() {}, error() {} } as unknown as LoggerService;
    const resolver = buildResolver(new PythonFunctionService(queue.eventService, logger));
    const context = { userId: 'user-1' } as RequestContext;

    expect(await resolver.triggerHbpe(context)).toBe('triggered');
    queue.startAll();

    expect(await resolver.triggerHbpe(context)).toBe('already_running');
    expect(queue.jobs).toHaveLength(1);
  });

  it('lets Predict start again once the last run has finished', async () => {
    const queue = makePgBossLikeEventService();
    const logger = { setContext() {}, log() {}, warn() {}, error() {} } as unknown as LoggerService;
    const resolver = buildResolver(new PythonFunctionService(queue.eventService, logger));
    const context = { userId: 'user-1' } as RequestContext;

    expect(await resolver.triggerHbpe(context)).toBe('triggered');
    queue.startAll();
    queue.finishAll();

    expect(await resolver.triggerHbpe(context)).toBe('triggered');
  });
});
