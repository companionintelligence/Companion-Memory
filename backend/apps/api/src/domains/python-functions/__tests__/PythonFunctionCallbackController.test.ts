import { BadRequestException, ForbiddenException } from '@nestjs/common';

import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';

import { PythonFunctionCallbackController } from '../controllers/PythonFunctionCallbackController';
import type { PythonRunCallbackRequest } from '../guards/PythonRunCallbackGuard';

const logger = { setContext() {}, log() {}, warn() {}, error() {} } as unknown as LoggerService;

function makeController() {
  const eventService = {
    completeJob: jest.fn().mockResolvedValue(undefined),
    failJob: jest.fn().mockResolvedValue(undefined),
  } as unknown as EventService;

  return { controller: new PythonFunctionCallbackController(eventService, logger), eventService };
}

/** What PythonRunCallbackGuard leaves on the request: the run the bearer was minted for. */
function reqFor(jobId: string, queue: string, userId = 'user-1'): PythonRunCallbackRequest {
  return { pythonRun: { userId, jobId, queue } } as PythonRunCallbackRequest;
}

describe('PythonFunctionCallbackController', () => {
  it('completes the deferred job with the run result', async () => {
    const { controller, eventService } = makeController();

    await controller.callback(reqFor('job-1', 'py-fn-summary'), {
      job_id: 'job-1',
      queue: 'py-fn-summary',
      status: 'completed',
      result: { summaries: 3 },
    });

    expect(eventService.completeJob).toHaveBeenCalledWith('py-fn-summary', 'job-1', { summaries: 3 });
    expect(eventService.failJob).not.toHaveBeenCalled();
  });

  it('fails the deferred job with the error message', async () => {
    const { controller, eventService } = makeController();

    await controller.callback(reqFor('job-2', 'py-fn-hbpe'), {
      job_id: 'job-2',
      queue: 'py-fn-hbpe',
      status: 'failed',
      error: 'training crashed',
    });

    expect(eventService.failJob).toHaveBeenCalledWith(
      'py-fn-hbpe',
      'job-2',
      expect.objectContaining({ message: 'training crashed' }),
    );
    expect(eventService.completeJob).not.toHaveBeenCalled();
  });

  it('rejects unknown queues', async () => {
    const { controller, eventService } = makeController();

    await expect(
      controller.callback(reqFor('job-1', 'search-index'), {
        job_id: 'job-1',
        queue: 'search-index',
        status: 'completed',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(eventService.completeJob).not.toHaveBeenCalled();
  });

  it('rejects a missing job id', async () => {
    const { controller } = makeController();

    await expect(
      controller.callback(reqFor('', 'py-fn-summary'), {
        job_id: '',
        queue: 'py-fn-summary',
        status: 'completed',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects unknown statuses', async () => {
    const { controller } = makeController();

    await expect(
      controller.callback(reqFor('job-1', 'py-fn-summary'), {
        job_id: 'job-1',
        queue: 'py-fn-summary',
        status: 'running' as never,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('SECURITY: refuses a body that names a job other than the one the run token was minted for', async () => {
    // The guard proves the caller holds a token for ONE run. Before this, any authenticated
    // principal could complete or dead-letter any job id in either queue.
    const { controller, eventService } = makeController();

    await expect(
      controller.callback(reqFor('job-1', 'py-fn-summary'), {
        job_id: 'job-2',
        queue: 'py-fn-summary',
        status: 'completed',
      }),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      controller.callback(reqFor('job-1', 'py-fn-summary'), {
        job_id: 'job-1',
        queue: 'py-fn-hbpe',
        status: 'completed',
      }),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      controller.callback({} as PythonRunCallbackRequest, {
        job_id: 'job-1',
        queue: 'py-fn-summary',
        status: 'completed',
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(eventService.completeJob).not.toHaveBeenCalled();
    expect(eventService.failJob).not.toHaveBeenCalled();
  });
});
