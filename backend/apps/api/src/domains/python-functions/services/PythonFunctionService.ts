import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { EventService } from '@ci/domains/events';

import { PythonFunctionRunEvent } from '../events';
import {
  PYTHON_FUNCTION_QUEUES,
  PYTHON_FUNCTIONS,
  type PythonFunctionDispatchOptions,
  type PythonFunctionTarget,
} from '../types';

/**
 * Enqueues a named Python function as a pg-boss job. The dispatch listener
 * forwards it to the target service's `/functions/run`; completion arrives
 * out-of-band through the callback controller. This is the ONLY sanctioned way
 * to run summary/HBPE background work — it replaces direct Temporal workflow
 * starts and blocking HTTP calls into those services.
 */
@Injectable()
export class PythonFunctionService {
  constructor(
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PythonFunctionService.name);
  }

  /**
   * @param userId owner of the work — becomes `args.user_id` for the Python
   *   function and the `sub` of the callback JWT the runner signs.
   * @returns true when a job was enqueued (false when a pending job with the
   *   same singletonKey already exists).
   */
  async dispatch(
    target: PythonFunctionTarget,
    functionName: string,
    userId: string,
    args: Record<string, unknown> = {},
    options: PythonFunctionDispatchOptions = {},
  ): Promise<boolean> {
    if (!PYTHON_FUNCTIONS[target].includes(functionName)) {
      throw new Error(
        `Unknown ${target} function '${functionName}'. Known: ${PYTHON_FUNCTIONS[target].join(', ')}`,
      );
    }

    const jobIds = await this.eventService.send(
      PythonFunctionRunEvent,
      {
        target,
        function: functionName,
        args: { user_id: userId, ...args },
        userId,
      },
      {
        queue: PYTHON_FUNCTION_QUEUES[target],
        ...(options.singletonKey ? { singletonKey: options.singletonKey } : {}),
        ...(options.priority !== undefined ? { priority: options.priority } : {}),
      },
    );

    const enqueued = jobIds.length > 0;

    if (enqueued) {
      this.logger.log('Dispatched python function', { target, functionName, userId });
    }

    return enqueued;
  }

  /**
   * Whether a job with this singletonKey is still waiting, retrying or running
   * on `target`'s queue. `dispatch` alone cannot say: the queues' `short` policy
   * refuses a duplicate only while the first copy is still waiting, so once it
   * is running a second dispatch is accepted and both run side by side.
   */
  async hasLiveJob(target: PythonFunctionTarget, singletonKey: string): Promise<boolean> {
    return this.eventService.hasLiveJob(PYTHON_FUNCTION_QUEUES[target], singletonKey);
  }
}
