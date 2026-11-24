import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { EventService } from '@ci/domains/events';

import { PythonFunctionRunEvent } from '../events';
import {
  PYTHON_FUNCTION_HEARTBEAT_TIMEOUT_SECONDS,
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

    const heartbeatSeconds = PYTHON_FUNCTION_HEARTBEAT_TIMEOUT_SECONDS[target];
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
        // On the job, not the queue; see PYTHON_FUNCTION_HEARTBEAT_TIMEOUT_SECONDS.
        ...(heartbeatSeconds !== undefined ? { heartbeatSeconds } : {}),
      },
    );

    const enqueued = jobIds.length > 0;

    if (enqueued) {
      this.logger.log('Dispatched python function', { target, functionName, userId });
    }

    return enqueued;
  }

  /**
   * `dispatch`, unless a run for this user is already waiting, retrying or
   * running on `target`'s queue, whatever key it was sent with.
   *
   * `dispatch` alone cannot say. The queues' `short` policy refuses a duplicate
   * only while the first copy is still waiting and only one with the same key:
   * Predict (`fn:nightly:<user>:manual`), the 02:30 nightly and the start-up
   * bootstrap sweep (`fn:hbpe:<user>:<day>`) each use their own, so any of them
   * started a second hour-long pipeline beside a running one.
   *
   * Two calls in the same moment can both pass the check. The `short` policy
   * still refuses the second while the first is waiting, when they share a key.
   *
   * @returns true when a job was enqueued; false when a run was already live
   *   or the queue refused the key.
   */
  async dispatchUnlessRunning(
    target: PythonFunctionTarget,
    functionName: string,
    userId: string,
    args: Record<string, unknown> = {},
    options: PythonFunctionDispatchOptions = {},
  ): Promise<boolean> {
    if (await this.eventService.hasLiveJobForUser(PYTHON_FUNCTION_QUEUES[target], userId)) {
      return false;
    }

    return this.dispatch(target, functionName, userId, args, options);
  }
}
