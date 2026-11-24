import type { DataSource } from 'typeorm';

import type { LoggerService } from '@ci/common/logging';
import type { CalendarEventService } from '@ci/domains/memory';

import type { PushSubscriptionService } from '../PushSubscriptionService';
import { ReminderDispatchService } from '../ReminderDispatchService';
import type { TaskService } from '../TaskService';
import type { SendResult, WebPushService } from '../WebPushService';

/**
 * Orchestration-level coverage for `deliver()` — mocks everything below
 * `ReminderDispatchService` so these tests are about "does it call the right
 * things on the right result", not about the claim SQL itself (proved
 * separately, against real Postgres, in `ReminderDispatchService.claim.integration.test.ts`).
 */
function makeLogger(): LoggerService {
  return {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  } as unknown as LoggerService;
}

interface Harness {
  service: ReminderDispatchService;
  dataSource: { query: jest.Mock };
  webPush: { sendPush: jest.Mock };
  pushSubscriptions: { listForUser: jest.Mock; remove: jest.Mock };
  taskService: { findById: jest.Mock };
  calendarEventService: { findById: jest.Mock };
}

function makeHarness(): Harness {
  // TypeORM's postgres driver returns `[rows, rowCount]` for a raw
  // UPDATE ... RETURNING — see `claimDueReminders`'s own comment. The mock
  // must match that shape, not a bare rows array.
  const dataSource = { query: jest.fn(async () => [[], 0]) };
  const taskService = { findById: jest.fn(async () => ({ title: 'Call the dentist' })) };
  const calendarEventService = { findById: jest.fn(async () => ({ title: 'Standup' })) };
  const pushSubscriptions = {
    listForUser: jest.fn(async () => [
      { id: 'sub-1', endpoint: 'https://push.example/1', p256dh: 'p', auth: 'a' },
    ]),
    remove: jest.fn(async () => undefined),
  };
  const webPush = { sendPush: jest.fn(async (): Promise<SendResult> => 'ok') };

  const service = new ReminderDispatchService(
    dataSource as unknown as DataSource,
    taskService as unknown as TaskService,
    calendarEventService as unknown as CalendarEventService,
    pushSubscriptions as unknown as PushSubscriptionService,
    webPush as unknown as WebPushService,
    makeLogger(),
  );

  return { service, dataSource, webPush, pushSubscriptions, taskService, calendarEventService };
}

const USER_ID = '00000000-0000-0000-0000-0000000000aa';

describe('ReminderDispatchService', () => {
  it('sends push to every subscription for a claimed task-targeted reminder', async () => {
    const { service, dataSource, webPush, taskService } = makeHarness();

    dataSource.query.mockResolvedValueOnce([
      [{ id: 'rem-1', taskId: 'task-1', blockId: null, source: 'manual', fireAt: new Date() }],
      1,
    ]);

    const result = await service.fireDueRemindersForUser(USER_ID);

    expect(result).toEqual({ fired: 1 });
    expect(taskService.findById).toHaveBeenCalledWith({ userId: USER_ID }, 'task-1');
    expect(webPush.sendPush).toHaveBeenCalledTimes(1);
    expect(webPush.sendPush).toHaveBeenCalledWith(
      { endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } },
      { title: 'Task reminder', body: 'Call the dentist', url: '/', tag: 'reminder:rem-1' },
    );
  });

  it('composes block content from the linked event, not the task branch', async () => {
    const { service, dataSource, webPush, calendarEventService, taskService } = makeHarness();

    dataSource.query.mockResolvedValueOnce([
      [{ id: 'rem-2', taskId: null, blockId: 'event-1', source: 'manual', fireAt: new Date() }],
      1,
    ]);

    await service.fireDueRemindersForUser(USER_ID);

    expect(calendarEventService.findById).toHaveBeenCalledWith({ userId: USER_ID }, 'event-1');
    expect(taskService.findById).not.toHaveBeenCalled();
    expect(webPush.sendPush).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: 'Upcoming block', body: 'Standup' }),
    );
  });

  it('falls back to generic copy when the linked task/block has no title', async () => {
    const { service, dataSource, webPush, taskService } = makeHarness();

    taskService.findById.mockResolvedValueOnce(null);
    dataSource.query.mockResolvedValueOnce([
      [{ id: 'rem-3', taskId: 'task-missing', blockId: null, source: 'manual', fireAt: new Date() }],
      1,
    ]);

    await service.fireDueRemindersForUser(USER_ID);

    expect(webPush.sendPush).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ body: 'A task is due' }),
    );
  });

  /**
   * I-8: a 'gone' push result is standard Web Push for "this endpoint no
   * longer exists" (404/410 — see WebPushService's own mapping). Left
   * unpruned it would be retried on every future reminder for this user,
   * forever. This is the "dead-subscription cleanup" coverage named in the
   * task brief, at the layer that actually acts on the result.
   */
  it('deletes a push subscription that reports "gone" and leaves a live one alone', async () => {
    const { service, dataSource, webPush, pushSubscriptions } = makeHarness();

    pushSubscriptions.listForUser.mockResolvedValueOnce([
      { id: 'dead-sub', endpoint: 'https://push.example/dead', p256dh: 'p', auth: 'a' },
      { id: 'live-sub', endpoint: 'https://push.example/live', p256dh: 'p', auth: 'a' },
    ]);
    webPush.sendPush.mockImplementation(async (sub: { endpoint: string }): Promise<SendResult> =>
      sub.endpoint.endsWith('/dead') ? 'gone' : 'ok',
    );
    dataSource.query.mockResolvedValueOnce([
      [{ id: 'rem-4', taskId: 'task-1', blockId: null, source: 'manual', fireAt: new Date() }],
      1,
    ]);

    await service.fireDueRemindersForUser(USER_ID);

    expect(pushSubscriptions.remove).toHaveBeenCalledTimes(1);
    expect(pushSubscriptions.remove).toHaveBeenCalledWith('dead-sub');
  });

  it('does not delete a subscription on an ordinary send failure ("fail"), only on "gone"', async () => {
    const { service, dataSource, webPush, pushSubscriptions } = makeHarness();

    webPush.sendPush.mockResolvedValueOnce('fail' as SendResult);
    dataSource.query.mockResolvedValueOnce([
      [{ id: 'rem-5', taskId: 'task-1', blockId: null, source: 'manual', fireAt: new Date() }],
      1,
    ]);

    await service.fireDueRemindersForUser(USER_ID);

    expect(pushSubscriptions.remove).not.toHaveBeenCalled();
  });

  it('claims the correct user and passes fire_at through to the SQL parameters', async () => {
    const { service, dataSource } = makeHarness();

    await service.fireDueRemindersForUser(USER_ID);

    expect(dataSource.query).toHaveBeenCalledTimes(1);
    const [, params] = dataSource.query.mock.calls[0] as [string, unknown[]];

    expect(params[0]).toBe(USER_ID);
    expect(params[1]).toBeInstanceOf(Date);
  });

  it("one reminder's delivery failure does not abort the batch or re-throw", async () => {
    const { service, dataSource, webPush } = makeHarness();

    dataSource.query.mockResolvedValueOnce([
      [
        { id: 'rem-fail', taskId: 'task-1', blockId: null, source: 'manual', fireAt: new Date() },
        { id: 'rem-ok', taskId: 'task-2', blockId: null, source: 'manual', fireAt: new Date() },
      ],
      2,
    ]);
    webPush.sendPush.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('ok' as SendResult);

    const result = await service.fireDueRemindersForUser(USER_ID);

    // Both rows were CLAIMED (fired: 2) even though the first delivery threw
    // — the claim already committed and must not be undone by a delivery
    // failure, matching CI-Planning's per-row try/catch.
    expect(result).toEqual({ fired: 2 });
    expect(webPush.sendPush).toHaveBeenCalledTimes(2);
  });

  it('returns { fired: 0 } and sends nothing when there is nothing due', async () => {
    const { service, webPush } = makeHarness();

    const result = await service.fireDueRemindersForUser(USER_ID);

    expect(result).toEqual({ fired: 0 });
    expect(webPush.sendPush).not.toHaveBeenCalled();
  });
});
