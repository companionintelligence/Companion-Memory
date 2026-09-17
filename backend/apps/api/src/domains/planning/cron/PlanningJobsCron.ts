import { Injectable } from '@nestjs/common';

import { FeatureService } from '@ci/common/feature';
import { LoggerService } from '@ci/common/logging';
import { Cron } from '@ci/common/schedule';
import { EventService } from '@ci/domains/events';
import { UserService } from '@ci/domains/user';

import {
  PlanningEventNowEvent,
  PlanningFireRemindersEvent,
  PlanningInboxScanEvent,
  PlanningTodoProcessEvent,
  PlanningTodoScanEvent,
  PlanningVerifyDoneEvent,
} from '../events';

/** Daily morning scan — owner-local wall clock is approximate for fan-out. */
const TODO_SCAN_CRON = '0 6 * * *';
/** Revisit open tasks several times a day. */
const TODO_PROCESS_CRON = '0 */6 * * *';
/** Inbound inbox triage, matching CI-Planning ingest_gmail cadence. */
const INBOX_SCAN_CRON = '*/30 * * * *';
/** Planned blocks entering the present. */
const EVENT_NOW_CRON = '15 * * * *';
/** Catch-up after blocks end. */
const VERIFY_DONE_CRON = '45 * * * *';
/**
 * Reminder claim-and-deliver tick, matching CI-Planning's `fire_reminders`
 * cadence (`'* * * * *'` in the source). Every minute, same as the other four
 * sub-hourly entries here — none of PlanningJobsCron's five siblings carry a
 * seconds field or a non-zero-second offset (see
 * `common/schedule/__tests__/cronSecondOffsets.test.ts`, whose registry does
 * not include this cron at all), so this keeps that same shape rather than
 * introducing one schedule here that behaves differently from its neighbours.
 */
const FIRE_REMINDERS_CRON = '* * * * *';

/**
 * Fan-out only. Each job carries a real `userId`; planning services never see
 * SYSTEM_USER (roadmap invariant 7).
 */
@Injectable()
export class PlanningJobsCron {
  constructor(
    private readonly eventService: EventService,
    private readonly userService: UserService,
    private readonly featureService: FeatureService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PlanningJobsCron.name);
  }

  @Cron(TODO_SCAN_CRON, { name: 'PlanningJobsCron.todoScan' })
  async enqueueTodoScans() {
    await this.fanOut(PlanningTodoScanEvent, 'todo_scan');
  }

  @Cron(TODO_PROCESS_CRON, { name: 'PlanningJobsCron.todoProcess' })
  async enqueueTodoProcess() {
    await this.fanOut(PlanningTodoProcessEvent, 'todo_process');
  }

  @Cron(INBOX_SCAN_CRON, { name: 'PlanningJobsCron.inboxScan' })
  async enqueueInboxScans() {
    await this.fanOut(PlanningInboxScanEvent, 'inbox_scan');
  }

  @Cron(EVENT_NOW_CRON, { name: 'PlanningJobsCron.eventNow' })
  async enqueueEventNow() {
    await this.fanOut(PlanningEventNowEvent, 'event_now');
  }

  @Cron(VERIFY_DONE_CRON, { name: 'PlanningJobsCron.verifyDone' })
  async enqueueVerifyDone() {
    await this.fanOut(PlanningVerifyDoneEvent, 'verify_done');
  }

  @Cron(FIRE_REMINDERS_CRON, { name: 'PlanningJobsCron.fireReminders' })
  async enqueueFireReminders() {
    await this.fanOut(PlanningFireRemindersEvent, 'fire_reminders');
  }

  private async fanOut(
    event:
      | typeof PlanningTodoScanEvent
      | typeof PlanningTodoProcessEvent
      | typeof PlanningInboxScanEvent
      | typeof PlanningEventNowEvent
      | typeof PlanningVerifyDoneEvent
      | typeof PlanningFireRemindersEvent,
    label: string,
  ) {
    if (!(await this.featureService.isFeatureEnabled('planning.enabled'))) {
      return;
    }

    const users = await this.userService.findAllOnboarded();
    let enqueued = 0;

    for (const user of users) {
      await this.eventService.send(
        event,
        { userId: user.id },
        { singletonKey: `planning:${label}:${user.id}` },
      );
      enqueued += 1;
    }

    this.logger.log(`Enqueued planning.${label}`, { users: enqueued });
  }
}
