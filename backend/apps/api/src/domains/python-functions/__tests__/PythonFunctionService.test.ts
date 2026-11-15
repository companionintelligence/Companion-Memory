import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';

import { PythonFunctionService } from '../services/PythonFunctionService';

const logger = { setContext() {}, log() {}, warn() {}, error() {} } as unknown as LoggerService;

describe('PythonFunctionService', () => {
  it('rejects function names outside the target allowlist', async () => {
    const eventService = { send: jest.fn() } as unknown as EventService;
    const service = new PythonFunctionService(eventService, logger);

    await expect(service.dispatch('summary', 'not_a_function', 'user-1')).rejects.toThrow(
      /Unknown summary function 'not_a_function'/,
    );
    expect(eventService.send).not.toHaveBeenCalled();
  });

  it('enqueues onto the target queue with user_id merged into args', async () => {
    const eventService = { send: jest.fn().mockResolvedValue(['job-1']) } as unknown as EventService;
    const service = new PythonFunctionService(eventService, logger);

    const enqueued = await service.dispatch(
      'summary',
      'insights_generation',
      'user-1',
      { lookback_hours: 72 },
      { singletonKey: 'fn:insights_generation:user-1:2026-08-08T21', priority: 5 },
    );

    expect(enqueued).toBe(true);
    expect(eventService.send).toHaveBeenCalledWith(
      expect.anything(),
      {
        target: 'summary',
        function: 'insights_generation',
        args: { user_id: 'user-1', lookback_hours: 72 },
        userId: 'user-1',
      },
      {
        queue: 'py-fn-summary',
        singletonKey: 'fn:insights_generation:user-1:2026-08-08T21',
        priority: 5,
      },
    );
  });

  it('reports false when the singleton key dedupes the job away', async () => {
    const eventService = { send: jest.fn().mockResolvedValue([]) } as unknown as EventService;
    const service = new PythonFunctionService(eventService, logger);

    const enqueued = await service.dispatch(
      'hbpe',
      'nightly',
      'user-1',
      {},
      { singletonKey: 'fn:nightly:user-1:d' },
    );

    expect(enqueued).toBe(false);
  });

  it('asks the target queue whether a job with the key is still live', async () => {
    const eventService = { hasLiveJob: jest.fn().mockResolvedValue(true) } as unknown as EventService;
    const service = new PythonFunctionService(eventService, logger);

    await expect(service.hasLiveJob('hbpe', 'fn:nightly:user-1:manual')).resolves.toBe(true);
    expect(eventService.hasLiveJob).toHaveBeenCalledWith('py-fn-hbpe', 'fn:nightly:user-1:manual');
  });
});
