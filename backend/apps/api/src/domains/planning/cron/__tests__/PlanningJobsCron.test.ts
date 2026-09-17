import type { Repository } from 'typeorm';

import type { FeatureService } from '@ci/common/feature';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import type { UserEntity } from '@ci/domains/user';
import { UserService } from '@ci/domains/user';

import {
  PlanningEventNowEvent,
  PlanningFireRemindersEvent,
  PlanningInboxScanEvent,
  PlanningTodoProcessEvent,
  PlanningTodoScanEvent,
  PlanningVerifyDoneEvent,
} from '../../events';
import { PlanningJobsCron } from '../PlanningJobsCron';

const ONBOARDED = '00000000-0000-0000-0000-0000000000aa';
const SIGNED_UP_ONLY = '00000000-0000-0000-0000-0000000000bb';

type UserRow = Partial<UserEntity> & { id: string; onboarded: boolean };

/**
 * A repository that actually honours `where`, so the audience predicate is
 * exercised rather than asserted: a fan-out that asks for every row gets every
 * row back here, exactly as it would from Postgres.
 */
function makeUserRepository(rows: UserRow[]): Repository<UserEntity> {
  return {
    find: jest.fn(async (options?: { where?: Partial<UserEntity> }) => {
      const where = options?.where ?? {};

      return rows.filter((row) =>
        Object.entries(where).every(([column, value]) => row[column as keyof UserRow] === value),
      );
    }),
  } as unknown as Repository<UserEntity>;
}

function makeLogger(): LoggerService {
  return {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  } as unknown as LoggerService;
}

function makeCron(rows: UserRow[], planningEnabled = true) {
  const eventService = { send: jest.fn(async () => ['job-1']) } as unknown as EventService;
  const featureService = {
    isFeatureEnabled: jest.fn(async () => planningEnabled),
  } as unknown as FeatureService;
  const userService = new UserService(makeUserRepository(rows), eventService);

  return {
    cron: new PlanningJobsCron(eventService, userService, featureService, makeLogger()),
    send: eventService.send as jest.Mock,
  };
}

const POPULATION: UserRow[] = [
  { id: ONBOARDED, onboarded: true, timezone: 'UTC' },
  { id: SIGNED_UP_ONLY, onboarded: false, timezone: 'UTC' },
];

describe('PlanningJobsCron fan-out audience', () => {
  it('enqueues a todo scan for an onboarded user and not for one still in signup', async () => {
    const { cron, send } = makeCron(POPULATION);

    await cron.enqueueTodoScans();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      PlanningTodoScanEvent,
      { userId: ONBOARDED },
      { singletonKey: `planning:todo_scan:${ONBOARDED}` },
    );
  });

  // All six schedules share `fanOut`, but each is a separate cron entry point:
  // a future audience change made in one of them has to be made in all of them.
  it.each([
    ['enqueueTodoScans', PlanningTodoScanEvent, 'todo_scan'],
    ['enqueueTodoProcess', PlanningTodoProcessEvent, 'todo_process'],
    ['enqueueInboxScans', PlanningInboxScanEvent, 'inbox_scan'],
    ['enqueueEventNow', PlanningEventNowEvent, 'event_now'],
    ['enqueueVerifyDone', PlanningVerifyDoneEvent, 'verify_done'],
    ['enqueueFireReminders', PlanningFireRemindersEvent, 'fire_reminders'],
  ] as const)('%s reaches onboarded users only', async (method, event, label) => {
    const { cron, send } = makeCron(POPULATION);

    await cron[method]();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      event,
      { userId: ONBOARDED },
      { singletonKey: `planning:${label}:${ONBOARDED}` },
    );
  });

  it('enqueues nothing when every account is still in signup', async () => {
    const { cron, send } = makeCron([{ id: SIGNED_UP_ONLY, onboarded: false }]);

    await cron.enqueueInboxScans();

    expect(send).not.toHaveBeenCalled();
  });

  it('enqueues nothing while planning is disabled', async () => {
    const { cron, send } = makeCron(POPULATION, false);

    await cron.enqueueTodoScans();

    expect(send).not.toHaveBeenCalled();
  });
});
