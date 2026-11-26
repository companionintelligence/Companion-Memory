import { MockedProvider } from '@apollo/client/testing/react';
import { fireEvent, render, screen } from '@testing-library/react';
import { parse } from 'graphql';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { reminderNotificationId } from '@/lib/reminderNotifications';

import { GET_REMINDERS, ReminderPanel } from './ReminderPanel';

const native = vi.hoisted(() => ({ schedule: vi.fn(), cancel: vi.fn() }));
vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  isNativePlatform: () => true,
  scheduleLocalNotification: native.schedule,
  cancelLocalNotification: native.cancel,
}));
vi.mock('@/hooks', () => ({ useCurrentUser: () => ({ user: { id: 'owner' } }) }));

const CONFIRM = parse(
  'mutation PlanConfirmDeviceReminder($id: ID!) { confirmReminderDeviceSchedule(id: $id) { id status } }',
);

beforeEach(() => {
  localStorage.clear();
  native.schedule.mockReset().mockResolvedValue(true);
  native.cancel.mockReset().mockResolvedValue(true);
});

function showReminder() {
  return render(
    <MockedProvider
      mocks={[
        {
          request: { query: GET_REMINDERS },
          maxUsageCount: 10,
          result: {
            data: {
              reminders: [
                {
                  __typename: 'ReminderType',
                  id: 'reminder',
                  taskId: 'task',
                  blockId: null,
                  fireAt: new Date(Date.now() + 3_600_000).toISOString(),
                  status: 'pending',
                  deliveryMode: 'device',
                  attempts: 0,
                  nextAttemptAt: null,
                  lastError: null,
                },
              ],
              pushPublicKey: null,
            },
          },
        },
        {
          request: { query: CONFIRM, variables: { id: 'reminder' } },
          result: { data: { confirmReminderDeviceSchedule: null } },
        },
      ]}
    >
      <ReminderPanel tasks={[{ id: 'task', title: 'Private task' }]} />
    </MockedProvider>,
  );
}

describe('phone reminder confirmation', () => {
  it('removes a phone alarm if the server no longer accepts its schedule', async () => {
    showReminder();
    fireEvent.click(await screen.findByText(/Reminders/));
    fireEvent.click(await screen.findByRole('button', { name: 'Schedule on this phone' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Its phone notification was removed');
    expect(native.cancel).toHaveBeenCalledWith(reminderNotificationId('reminder'));
    expect(JSON.parse(localStorage.getItem('ci.memory.local-reminders.v1:owner')!)).toEqual([]);
    expect(screen.queryByText('Reminder scheduled on this phone.')).not.toBeInTheDocument();
  });

  it('retains a failed cancellation receipt and clearly warns about the remaining alarm', async () => {
    native.cancel.mockResolvedValue(false);
    showReminder();
    fireEvent.click(await screen.findByText(/Reminders/));
    fireEvent.click(await screen.findByRole('button', { name: 'Schedule on this phone' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('phone notification could not be removed');
    expect(JSON.parse(localStorage.getItem('ci.memory.local-reminders.v1:owner')!)).toHaveLength(1);
  });
});
