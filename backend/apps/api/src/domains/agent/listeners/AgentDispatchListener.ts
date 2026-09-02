import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';

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

/**
 * Keeps agent.task.* off the orphan list. Dispatch work already ran in
 * AgentDispatchService; these listeners exist so the Jobs page can show the row.
 */
@Injectable()
export class AgentDispatchListener {
  constructor(private readonly logger: LoggerService) {
    this.logger.setContext(AgentDispatchListener.name);
  }

  @OnEvent(AgentTaskDispatchEvent)
  handleDispatch(payload: AgentTaskDispatchPayload): void {
    this.logger.debug('OpenClaw dispatch queued', payload);
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
