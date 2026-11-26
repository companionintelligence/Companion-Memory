import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ schedule: vi.fn(), cancel: vi.fn() }));
vi.mock('@ci/common', () => ({
  scheduleLocalNotification: native.schedule,
  cancelLocalNotification: native.cancel,
  isNativePlatform: () => true,
}));

import {
  cancelDeviceReminder,
  clearDeviceReminders,
  reconcileDeviceReminders,
  reminderNotificationId,
  scheduleDeviceReminder,
} from './reminderNotifications';

const future = () => new Date(Date.now() + 3_600_000).toISOString();
const key = (user: string) => 'ci.memory.local-reminders.v1:' + user;

beforeEach(() => {
  localStorage.clear();
  native.schedule.mockReset().mockResolvedValue(true);
  native.cancel.mockReset().mockResolvedValue(true);
});

describe('phone reminder reconciliation', () => {
  it('records only schedules the native OS accepted and refuses past dates', async () => {
    expect(await scheduleDeviceReminder('owner', { id: 'past', at: '2000-01-01', title: 'Past' })).toBe(
      false,
    );
    native.schedule.mockResolvedValueOnce(false);
    expect(await scheduleDeviceReminder('owner', { id: 'r1', at: future(), title: 'Task' })).toBe(false);
    expect(localStorage.getItem(key('owner'))).toBeNull();
    expect(await scheduleDeviceReminder('owner', { id: 'r1', at: future(), title: 'Task' })).toBe(true);
    expect(JSON.parse(localStorage.getItem(key('owner'))!)).toHaveLength(1);
    expect(native.schedule).toHaveBeenLastCalledWith(
      'Task reminder',
      'Task',
      expect.objectContaining({ id: reminderNotificationId('r1'), at: expect.any(Date) }),
    );
  });

  it('cancels remote removals for this account and retains failed cancellations for retry', async () => {
    await scheduleDeviceReminder('owner', { id: 'keep', at: future(), title: 'Keep' });
    await scheduleDeviceReminder('owner', { id: 'remove', at: future(), title: 'Remove' });
    await scheduleDeviceReminder('another', { id: 'other', at: future(), title: 'Other' });
    native.cancel.mockResolvedValueOnce(false);
    expect(await reconcileDeviceReminders('owner', new Set(['keep']))).toBe(false);
    expect(JSON.parse(localStorage.getItem(key('owner'))!)).toHaveLength(2);
    expect(await reconcileDeviceReminders('owner', new Set(['keep']))).toBe(true);
    expect(JSON.parse(localStorage.getItem(key('owner'))!).map((row: { id: string }) => row.id)).toEqual([
      'keep',
    ]);
    expect(JSON.parse(localStorage.getItem(key('another'))!)).toHaveLength(1);
    expect(native.cancel).toHaveBeenCalledTimes(2);
  });

  it('replaces a local schedule consistently and cancellation clears its receipt', async () => {
    await scheduleDeviceReminder('owner', { id: 'r1', at: future(), title: 'Old' });
    await scheduleDeviceReminder('owner', { id: 'r1', at: future(), title: 'Edited' });
    expect(JSON.parse(localStorage.getItem(key('owner'))!)).toEqual([
      expect.objectContaining({ id: 'r1', title: 'Edited' }),
    ]);
    expect(await cancelDeviceReminder('owner', 'r1')).toBe(true);
    expect(JSON.parse(localStorage.getItem(key('owner'))!)).toEqual([]);
  });
});

describe('identity cleanup', () => {
  it('clears alarms across remembered accounts while retaining failed cancellations for a retry', async () => {
    await scheduleDeviceReminder('old-owner', { id: 'old', at: future(), title: 'Private old task' });
    await scheduleDeviceReminder('current-owner', { id: 'current', at: future(), title: 'Current task' });
    native.cancel.mockResolvedValueOnce(false);

    expect(await clearDeviceReminders()).toBe(false);
    expect(JSON.parse(localStorage.getItem(key('old-owner'))!)).toHaveLength(1);
    expect(localStorage.getItem(key('current-owner'))).toBeNull();
    expect(await clearDeviceReminders()).toBe(true);
    expect(localStorage.getItem(key('old-owner'))).toBeNull();
  });
});
