import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { OnEvent, type Acknowledgement } from '@ci/domains/events';

import {
  AGENT_DISPATCH_QUEUE,
  AGENT_DISPATCH_QUEUE_OPTIONS,
} from '../constants';
import {
  AgentTaskBlockedEvent,
  AgentTaskCheckpointEvent,
  AgentTaskCompletedEvent,
  AgentTaskDispatchEvent,
  PlanningTaskResultEvent,
  type AgentTaskBlockedPayload,
  type AgentTaskCheckpointPayload,
  type AgentTaskCompletedPayload,
  type AgentTaskDispatchPayload,
  type PlanningTaskResultPayload,
} from '../events';
import { HubDoorbellService } from '../services/HubDoorbellService';

/**
 * Holds the Jobs-page row `active` until OpenClaw reports, same contract as
 * `python.function.run`. The doorbell is the work this listener owns; Memory
 * already wrote the packet. Fail the job if Hub does not accept the wake so
 * retries show up as retries, not a 1-second completed ghost.
 */
@Injectable()
export class AgentDispatchListener {
  constructor(
    private readonly doorbell: HubDoorbellService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(AgentDispatchListener.name);
  }

  @OnEvent(AgentTaskDispatchEvent, {
    queue: AGENT_DISPATCH_QUEUE,
    autoAcknowledge: false,
    queueOptions: AGENT_DISPATCH_QUEUE_OPTIONS,
  })
  async handleDispatch(payload: AgentTaskDispatchPayload, ack: Acknowledgement): Promise<void> {
    const woke = await this.doorbell.wakeOpenClaw(payload.jobId);

    if (!woke) {
      ack.fail(new Error(`Hub doorbell missed for ${payload.jobId}`));
      return;
    }

    this.logger.debug('OpenClaw dispatch queued', payload);
    ack.defer();
  }

  @OnEvent(AgentTaskCheckpointEvent)
  handleCheckpoint(payload: AgentTaskCheckpointPayload): void {
    this.logger.debug('OpenClaw checkpoint', payload);
  }

  @OnEvent(AgentTaskCompletedEvent)
  handleCompleted(payload: AgentTaskCompletedPayload): void {
    this.logger.debug('OpenClaw dispatch completed', payload);
  }

  @OnEvent(AgentTaskBlockedEvent)
  handleBlocked(payload: AgentTaskBlockedPayload): void {
    this.logger.debug('OpenClaw dispatch blocked', payload);
  }

  @OnEvent(PlanningTaskResultEvent)
  handleResult(payload: PlanningTaskResultPayload): void {
    this.logger.debug('Planning task result from dispatch', payload);
  }
}
