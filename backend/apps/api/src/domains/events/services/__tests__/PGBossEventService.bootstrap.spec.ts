import { EventEmitter2, EventEmitterReadinessWatcher } from '@nestjs/event-emitter';
import type { DataSource } from 'typeorm';

import type { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

import { EventListenerRegistry } from '../../event-registration';
import { PGBossEventService } from '../PGBossEventService';

type StubLogger = {
  setContext: jest.Mock;
  debug: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
  log: jest.Mock;
};

describe('PGBossEventService bootstrap ordering', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    EventListenerRegistry.clear();
  });

  afterEach(() => {
    EventListenerRegistry.clear();
    jest.useRealTimers();
  });

  it('waits for @OnEvent registration before consuming a queued job', async () => {
    const previousRole = config.role;
    const logger: StubLogger = {
      setContext: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      log: jest.fn(),
    };
    const readiness = new EventEmitterReadinessWatcher();
    const fetch = jest.fn(async () => []);
    const queryRunner = {
      connect: jest.fn(async () => undefined),
      query: jest.fn(async () => []),
      release: jest.fn(async () => undefined),
    };
    const boss = {
      on: jest.fn(),
      start: jest.fn(async () => undefined),
      createQueue: jest.fn(async () => undefined),
      updateQueue: jest.fn(async () => undefined),
      fetch,
      stop: jest.fn(async () => undefined),
    };

    (config as { role: string }).role = 'worker';
    EventListenerRegistry.register('bootstrap.test', 'BootstrapListener', 'handle', 'bootstrap-queue', {
      role: 'worker',
    });

    const service = new PGBossEventService(
      new EventEmitter2(),
      logger as unknown as LoggerService,
      { createQueryRunner: () => queryRunner } as unknown as DataSource,
      readiness,
    );

    try {
      (service as unknown as { boss: unknown }).boss = boss;

      await service.onModuleInit();
      service.onApplicationBootstrap();
      await Promise.resolve();

      expect(fetch).not.toHaveBeenCalled();

      readiness.setReady();
      await Promise.resolve();
      await Promise.resolve();

      expect(fetch).toHaveBeenCalledWith('bootstrap-queue', expect.anything());

      const shutdown = service.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(5_000);
      await shutdown;
    } finally {
      (config as { role: string }).role = previousRole;
    }
  });
});
