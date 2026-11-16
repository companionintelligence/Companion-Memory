import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { EventService } from '@ci/domains/events';

import { type PythonRunCallbackRequest, PythonRunCallbackGuard } from '../guards/PythonRunCallbackGuard';
import {
  PYTHON_FUNCTION_QUEUES,
  type PythonFunctionCallbackBody,
  type PythonFunctionHeartbeatBody,
} from '../types';

const CALLBACK_QUEUES = new Set<string>(Object.values(PYTHON_FUNCTION_QUEUES));

/**
 * Completion webhook (and heartbeat) for deferred python-function jobs. The Python runner
 * self-signs a JWT with the shared AUTH_TOKEN_SECRET (same pattern as HBPE's
 * graphql_client), using the run's user as subject, so the standard JWT guard
 * accepts it — no separate service-auth path.
 */
@Controller('function-runs')
export class PythonFunctionCallbackController {
  constructor(
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PythonFunctionCallbackController.name);
  }

  @UseGuards(PythonRunCallbackGuard)
  @Post('callback')
  @HttpCode(204)
  async callback(
    @Req() req: PythonRunCallbackRequest,
    @Body() body: PythonFunctionCallbackBody,
  ): Promise<void> {
    const { job_id: jobId, queue, status } = body;

    assertRunTokenNamesJob(req, jobId, queue);

    if (status === 'completed') {
      // Also while the job waits for a retry. Its heartbeat lapsed (the API was
      // away for minutes) or it expired, then the run finished before the retry
      // reached the runner. Left `retry`, the job would run the whole thing again.
      await this.eventService.completeJob(queue, jobId, body.result, { includeQueued: true });

      return;
    }

    if (status === 'failed') {
      await this.eventService.failJob(queue, jobId, {
        message: body.error ?? 'python function failed without detail',
        failedAt: new Date().toISOString(),
      });

      return;
    }

    throw new BadRequestException(`status must be 'completed' or 'failed'`);
  }

  /**
   * The runner, every minute or so while it holds a run that asked for it
   * (queued or running): the run is still there. pg-boss fails an active job
   * sent with `heartbeatSeconds` once its beats stop, so a run lost with its
   * sidecar stops counting as running within minutes.
   *
   * 409 when the job is not active any more (finished, failed, or waiting for
   * a retry after its beats lapsed). The runner only logs it.
   */
  @UseGuards(PythonRunCallbackGuard)
  @Post('heartbeat')
  @HttpCode(204)
  async heartbeat(
    @Req() req: PythonRunCallbackRequest,
    @Body() body: PythonFunctionHeartbeatBody,
  ): Promise<void> {
    const { job_id: jobId, queue } = body;

    assertRunTokenNamesJob(req, jobId, queue);

    if (!(await this.eventService.touchJob(queue, jobId))) {
      throw new ConflictException('Job is not running');
    }
  }
}

/**
 * The body names a job on a python-function queue and it is the one job the
 * run token admits: a sidecar holding a token for job A cannot report on job B.
 */
function assertRunTokenNamesJob(req: PythonRunCallbackRequest, jobId: unknown, queue: unknown): void {
  if (!jobId || typeof jobId !== 'string') {
    throw new BadRequestException('job_id is required');
  }

  if (typeof queue !== 'string' || !CALLBACK_QUEUES.has(queue)) {
    throw new BadRequestException(`queue must be one of: ${[...CALLBACK_QUEUES].join(', ')}`);
  }

  const run = req.pythonRun;

  if (!run || run.jobId !== jobId || run.queue !== queue) {
    throw new ForbiddenException('Run token does not match this job');
  }
}
