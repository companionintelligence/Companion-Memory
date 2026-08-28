import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';

import {
  PlanningEventNowEvent,
  PlanningInboxScanEvent,
  PlanningTodoProcessEvent,
  PlanningTodoScanEvent,
  PlanningVerifyDoneEvent,
  type PlanningUserJobPayload,
} from '../events';
import { InboxScanService } from '../services/InboxScanService';
import { EventNowService, TodoProcessService, VerifyDoneService } from '../services/TodoProcessService';
import { TodoScanService } from '../services/TodoScanService';

@Injectable()
export class PlanningJobsListener {
  constructor(
    private readonly todoScanService: TodoScanService,
    private readonly todoProcessService: TodoProcessService,
    private readonly inboxScanService: InboxScanService,
    private readonly eventNowService: EventNowService,
    private readonly verifyDoneService: VerifyDoneService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PlanningJobsListener.name);
  }

  // `short`: PlanningJobsCron sends every one of these five events with a
  // per-user `singletonKey` (`planning:<label>:<userId>`), but pg-boss only
  // enforces a singletonKey under `policy: 'short'` — under the default
  // `standard` policy the key is stored and never checked. All five
  // registrations share the 'planning' queue, so they must declare the same
  // value or EventListenerRegistry.register throws on conflict.
  @OnEvent(PlanningTodoScanEvent, { queue: 'planning', queueOptions: { policy: 'short' } })
  async onTodoScan(payload: PlanningUserJobPayload) {
    await this.todoScanService.runForUser(payload.userId);
  }

  @OnEvent(PlanningTodoProcessEvent, { queue: 'planning', queueOptions: { policy: 'short' } })
  async onTodoProcess(payload: PlanningUserJobPayload) {
    await this.todoProcessService.runForUser(payload.userId);
  }

  @OnEvent(PlanningInboxScanEvent, { queue: 'planning', queueOptions: { policy: 'short' } })
  async onInboxScan(payload: PlanningUserJobPayload) {
    await this.inboxScanService.runForUser(payload.userId);
  }

  @OnEvent(PlanningEventNowEvent, { queue: 'planning', queueOptions: { policy: 'short' } })
  async onEventNow(payload: PlanningUserJobPayload) {
    await this.eventNowService.runForUser(payload.userId);
  }

  @OnEvent(PlanningVerifyDoneEvent, { queue: 'planning', queueOptions: { policy: 'short' } })
  async onVerifyDone(payload: PlanningUserJobPayload) {
    await this.verifyDoneService.runForUser(payload.userId);
  }
}
