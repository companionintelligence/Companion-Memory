import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';

import { PLANNING_QUEUE, PLANNING_QUEUE_OPTIONS } from '../constants';
import {
  PlanningEventNowEvent,
  PlanningFireRemindersEvent,
  PlanningInboxScanEvent,
  PlanningTodoProcessEvent,
  PlanningTodoScanEvent,
  PlanningVerifyDoneEvent,
  type PlanningUserJobPayload,
} from '../events';
import { InboxScanService } from '../services/InboxScanService';
import { ReminderDispatchService } from '../services/ReminderDispatchService';
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
    private readonly reminderDispatchService: ReminderDispatchService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PlanningJobsListener.name);
  }

  // One shared value for all six: they share a queue, and pg-boss queue
  // options are queue-wide, so `EventListenerRegistry.register` throws on any
  // disagreement. The reasoning behind each option is on the constant.
  @OnEvent(PlanningTodoScanEvent, { queue: PLANNING_QUEUE, queueOptions: PLANNING_QUEUE_OPTIONS })
  async onTodoScan(payload: PlanningUserJobPayload) {
    await this.todoScanService.runForUser(payload.userId);
  }

  @OnEvent(PlanningTodoProcessEvent, { queue: PLANNING_QUEUE, queueOptions: PLANNING_QUEUE_OPTIONS })
  async onTodoProcess(payload: PlanningUserJobPayload) {
    await this.todoProcessService.runForUser(payload.userId);
  }

  @OnEvent(PlanningInboxScanEvent, { queue: PLANNING_QUEUE, queueOptions: PLANNING_QUEUE_OPTIONS })
  async onInboxScan(payload: PlanningUserJobPayload) {
    await this.inboxScanService.runForUser(payload.userId);
  }

  @OnEvent(PlanningEventNowEvent, { queue: PLANNING_QUEUE, queueOptions: PLANNING_QUEUE_OPTIONS })
  async onEventNow(payload: PlanningUserJobPayload) {
    await this.eventNowService.runForUser(payload.userId);
  }

  @OnEvent(PlanningVerifyDoneEvent, { queue: PLANNING_QUEUE, queueOptions: PLANNING_QUEUE_OPTIONS })
  async onVerifyDone(payload: PlanningUserJobPayload) {
    await this.verifyDoneService.runForUser(payload.userId);
  }

  @OnEvent(PlanningFireRemindersEvent, { queue: PLANNING_QUEUE, queueOptions: PLANNING_QUEUE_OPTIONS })
  async onFireReminders(payload: PlanningUserJobPayload) {
    await this.reminderDispatchService.fireDueRemindersForUser(payload.userId);
  }
}
