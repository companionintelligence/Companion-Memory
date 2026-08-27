import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';

import { AGENT_MEMORY_QUEUE, AGENT_MEMORY_QUEUE_OPTIONS } from '../constants';
import { AgentTurnFragmentsEvent, type AgentTurnFragmentsPayload } from '../events';
import { TurnFragmentService } from '../services/TurnFragmentService';

/**
 * Consumer half of {@link TurnFragmentCron}'s fan-out: one job, one user's
 * window. Failures propagate so pg-boss retries this user's job (and only
 * this user's) under the queue's retry policy.
 */
@Injectable()
export class TurnFragmentListener {
  constructor(
    private readonly turnFragmentService: TurnFragmentService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(TurnFragmentListener.name);
  }

  @OnEvent(AgentTurnFragmentsEvent, {
    queue: AGENT_MEMORY_QUEUE,
    queueOptions: AGENT_MEMORY_QUEUE_OPTIONS,
  })
  async handleTurnFragments(payload: AgentTurnFragmentsPayload): Promise<void> {
    // The window travels with the job. A retry an hour later must distil the
    // window it was enqueued for, not the one current when it finally runs.
    const window = { since: new Date(payload.since), until: new Date(payload.until) };

    if (Number.isNaN(window.since.getTime()) || Number.isNaN(window.until.getTime())) {
      this.logger.warn(`Discarding turn-fragment job with an unparseable window for user ${payload.userId}`);

      return;
    }

    const outcome = await this.turnFragmentService.distillForUser(payload.userId, window);

    this.logger.debug('Turn-fragment job complete', { userId: payload.userId, ...outcome });
  }
}
