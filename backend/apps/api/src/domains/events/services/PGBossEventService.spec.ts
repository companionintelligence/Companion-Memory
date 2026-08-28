import { EventEmitter2 } from '@nestjs/event-emitter';

import type { LoggerService } from '@ci/common/logging';

import { DEFAULT_JOB_PRIORITY } from '../constants';

import { PGBossEventService } from './PGBossEventService';

/**
 * Unit tests for the bulk-enqueue path (sendMany). The pg-boss client is
 * replaced with a stub — no Postgres. Construction reads CI_QUEUE_SUPPRESS from
 * the environment, so suppression cases construct their own instance. Only the
 * always-registered 'default' queue is used ('search-index' etc. exist only
 * once listeners register at module init, which these tests do not do).
 */
describe('PGBossEventService.sendMany', () => {
  const priorSuppress = process.env.CI_QUEUE_SUPPRESS;

  let logger: { setContext: jest.Mock; debug: jest.Mock; warn: jest.Mock; error: jest.Mock; log: jest.Mock };
  let insert: jest.Mock;

  function makeService(): PGBossEventService {
    logger = { setContext: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn(), log: jest.fn() };
    const service = new PGBossEventService(
      new EventEmitter2(),
      logger as unknown as LoggerService,
      {} as never,
    );
    // pg-boss's insert() resolves with the ids it actually wrote — a short array
    // is how a conflict-discarded bulk row reaches the caller, and a stub that
    // returns `undefined` is a shape the library never produces.
    insert = jest.fn(async (jobs: unknown[]) => jobs.map((_, i) => `bulk-${i}`));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).boss = { insert };

    return service;
  }

  afterEach(() => {
    if (priorSuppress == null) {
      delete process.env.CI_QUEUE_SUPPRESS;
    } else {
      process.env.CI_QUEUE_SUPPRESS = priorSuppress;
    }
  });

  it('bulk-inserts jobs shaped exactly like send() would produce ({...data, name})', async () => {
    delete process.env.CI_QUEUE_SUPPRESS;
    const service = makeService();

    await service.sendMany('default', [
      { name: 'communication.created', data: { communicationId: 'c1' } },
      { name: 'event.created', data: { eventId: 'e1' } },
    ]);

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0][0]).toEqual([
      {
        name: 'default',
        data: { communicationId: 'c1', name: 'communication.created' },
        priority: DEFAULT_JOB_PRIORITY,
      },
      { name: 'default', data: { eventId: 'e1', name: 'event.created' }, priority: DEFAULT_JOB_PRIORITY },
    ]);
  });

  it('stamps a caller-supplied priority onto every inserted job', async () => {
    delete process.env.CI_QUEUE_SUPPRESS;
    const service = makeService();

    await service.sendMany('default', [{ name: 'communication.created', data: { communicationId: 'c1' } }], {
      priority: -5,
    });

    expect(insert.mock.calls[0][0]).toEqual([
      { name: 'default', data: { communicationId: 'c1', name: 'communication.created' }, priority: -5 },
    ]);
  });

  it('carries a caller-supplied singletonKey and startAfter onto every inserted job', async () => {
    delete process.env.CI_QUEUE_SUPPRESS;
    const service = makeService();
    const startAfter = new Date('2026-08-21T00:00:00.000Z');

    await service.sendMany(
      'default',
      [
        { name: 'communication.created', data: { communicationId: 'c1' } },
        { name: 'event.created', data: { eventId: 'e1' } },
      ],
      { singletonKey: 'batch-key', startAfter },
    );

    expect(insert.mock.calls[0][0]).toEqual([
      {
        name: 'default',
        data: { communicationId: 'c1', name: 'communication.created' },
        priority: DEFAULT_JOB_PRIORITY,
        singletonKey: 'batch-key',
        startAfter,
      },
      {
        name: 'default',
        data: { eventId: 'e1', name: 'event.created' },
        priority: DEFAULT_JOB_PRIORITY,
        singletonKey: 'batch-key',
        startAfter,
      },
    ]);
  });

  it('omits singletonKey and startAfter from the inserted jobs when not supplied', async () => {
    delete process.env.CI_QUEUE_SUPPRESS;
    const service = makeService();

    await service.sendMany('default', [{ name: 'communication.created', data: { communicationId: 'c1' } }]);

    expect(insert.mock.calls[0][0][0]).not.toHaveProperty('singletonKey');
    expect(insert.mock.calls[0][0][0]).not.toHaveProperty('startAfter');
  });

  it('splits large batches into bounded insert() chunks', async () => {
    delete process.env.CI_QUEUE_SUPPRESS;
    const service = makeService();
    const events = Array.from({ length: 4500 }, (_, i) => ({
      name: 'communication.created',
      data: { communicationId: `c${i}` },
    }));

    await service.sendMany('default', events);

    // 4500 rows at a 2000-row chunk bound → 2000 + 2000 + 500.
    expect(insert).toHaveBeenCalledTimes(3);
    expect(insert.mock.calls.map((c: unknown[][]) => c[0].length)).toEqual([2000, 2000, 500]);
  });

  it('warns loudly and drops nothing silently when the queue is suppressed via CI_QUEUE_SUPPRESS', async () => {
    process.env.CI_QUEUE_SUPPRESS = 'default,geocode';
    const service = makeService();

    await service.sendMany('default', [{ name: 'communication.created', data: { communicationId: 'c1' } }]);

    expect(insert).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain('CI_QUEUE_SUPPRESS');
  });

  it('warns and sends nothing for an unregistered queue', async () => {
    delete process.env.CI_QUEUE_SUPPRESS;
    const service = makeService();

    await service.sendMany('no-such-queue', [{ name: 'event.created', data: { eventId: 'e1' } }]);

    expect(insert).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('is a no-op for an empty batch', async () => {
    delete process.env.CI_QUEUE_SUPPRESS;
    const service = makeService();

    await service.sendMany('default', []);

    expect(insert).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
