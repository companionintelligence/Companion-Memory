import { useEffect, useState, type FormEvent } from 'react';

import { useMutation, useQuery } from '@apollo/client/react';
import { isNativePlatform, requestNotificationPermission } from '@ci/common';
import { Button, Input, Label } from '@ci/shadcn';

import { gql } from '@/graphql';
import { useCurrentUser } from '@/hooks';
import {
  cancelDeviceReminder,
  reconcileDeviceReminders,
  scheduleDeviceReminder,
  subscribeBrowserReminders,
} from '@/lib/reminderNotifications';

export const GET_REMINDERS = gql(`
  query PlanReminders {
    reminders { id taskId blockId fireAt status deliveryMode attempts nextAttemptAt lastError }
    pushPublicKey
  }
`);
const CREATE_REMINDER = gql(`
  mutation PlanCreateReminder($input: CreateReminderInput!) {
    createReminder(input: $input) { success reminder { id fireAt status deliveryMode } }
  }
`);
const CANCEL_REMINDER = gql(
  `mutation PlanCancelReminder($id: ID!) { cancelReminder(id: $id) { id status } }`,
);
const RETRY_REMINDER = gql(`mutation PlanRetryReminder($id: ID!) { retryReminder(id: $id) { id status } }`);
const CONFIRM_DEVICE = gql(
  `mutation PlanConfirmDeviceReminder($id: ID!) { confirmReminderDeviceSchedule(id: $id) { id status } }`,
);
const SUBSCRIBE = gql(
  `mutation PlanSubscribePush($input: PushSubscriptionInput!) { subscribeToPush(input: $input) }`,
);

interface TaskOption {
  id: string;
  title: string;
  status?: string;
}

export function ReminderPanel({ tasks }: { tasks: readonly TaskOption[] }) {
  const native = isNativePlatform();
  const { user } = useCurrentUser();
  const { data, error: loadError, refetch } = useQuery(GET_REMINDERS, { pollInterval: 30_000 });
  const [create] = useMutation(CREATE_REMINDER);
  const [cancel] = useMutation(CANCEL_REMINDER);
  const [retry] = useMutation(RETRY_REMINDER);
  const [confirmDevice] = useMutation(CONFIRM_DEVICE);
  const [subscribe] = useMutation(SUBSCRIBE);
  const [taskId, setTaskId] = useState('');
  const [at, setAt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rows = data?.reminders ?? [];
  const available = tasks.filter((task) => !['done', 'archived', 'skipped'].includes(task.status ?? ''));

  useEffect(() => {
    if (!native || !data || loadError || !user?.id) {
      return;
    }

    const terminalTasks = new Set(
      tasks
        .filter((task) => ['done', 'skipped', 'archived'].includes(task.status ?? ''))
        .map((task) => task.id),
    );
    const active = data.reminders.filter((row) => !row.taskId || !terminalTasks.has(row.taskId));
    void reconcileDeviceReminders(user.id, new Set(active.map((row) => row.id))).then(async (ok) => {
      if (!ok) {
        setError(
          'A cancelled phone reminder could not be removed. Open device notification settings before it is due.',
        );

        return;
      }

      const completed = data.reminders.filter(
        (row) => row.deliveryMode === 'device' && row.taskId && terminalTasks.has(row.taskId),
      );
      if (completed.length > 0) {
        try {
          await Promise.all(completed.map((row) => cancel({ variables: { id: row.id } })));
          await refetch();
        } catch {
          setError(
            'A completed task’s phone reminder was removed locally, but its server status could not update.',
          );
        }
      }
    });
  }, [native, data, loadError, tasks, user?.id, cancel, refetch]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      await refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The reminder could not be updated. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const enable = () =>
    run(async () => {
      if (native) {
        if (!(await requestNotificationPermission())) {
          throw new Error('Allow notifications in your device settings, then try again.');
        }

        setNotice(
          'Phone notifications are enabled. Reminders you add here can run while this phone is offline.',
        );

        return;
      }

      if (!data?.pushPublicKey) {
        throw new Error(
          'Browser notifications need a notification key on this Memory. Ask its administrator to configure Web Push.',
        );
      }

      const sub = await subscribeBrowserReminders(data.pushPublicKey);
      if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys.auth) {
        throw new Error('The browser did not return a notification subscription.');
      }

      const result = await subscribe({
        variables: {
          input: {
            endpoint: sub.endpoint,
            p256dh: sub.keys.p256dh,
            auth: sub.keys.auth,
            userAgent: navigator.userAgent,
          },
        },
      });
      if (!result.data?.subscribeToPush) {
        throw new Error('The notification subscription could not be saved.');
      }

      setNotice('Notifications are enabled for this browser.');
    });

  const confirmPhoneSchedule = async (id: string) => {
    const confirmation = await confirmDevice({ variables: { id } });
    if (!confirmation.data?.confirmReminderDeviceSchedule) {
      const removed = user?.id ? await cancelDeviceReminder(user.id, id) : false;
      throw new Error(
        removed
          ? 'This reminder changed before the phone schedule could be confirmed. Its phone notification was removed. Refresh the plan before trying again.'
          : 'This reminder changed and its phone notification could not be removed. Check device notifications before it is due.',
      );
    }
  };

  const createReminder = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const date = new Date(at);
      if (!taskId || !Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) {
        throw new Error('Choose a task and a time in the future.');
      }

      if (native && !(await requestNotificationPermission())) {
        throw new Error('Allow notifications in your device settings before adding a phone reminder.');
      }

      const result = await create({
        variables: {
          input: { taskId, fireAt: date.toISOString(), deliveryMode: native ? 'device' : 'push' },
        },
      });
      const reminder = result.data?.createReminder.reminder;
      if (!result.data?.createReminder.success || !reminder) {
        throw new Error('The reminder could not be saved.');
      }

      if (native) {
        if (
          !user?.id ||
          !(await scheduleDeviceReminder(user.id, {
            id: reminder.id,
            at: reminder.fireAt,
            title: available.find((task) => task.id === taskId)?.title ?? 'A task is due',
          }))
        ) {
          throw new Error(
            'Your reminder was saved, but this phone could not schedule it. Try “Schedule on this phone” below.',
          );
        }

        await confirmPhoneSchedule(reminder.id);
      }

      setAt('');
      setNotice(
        native
          ? 'Reminder scheduled on this phone.'
          : 'Reminder saved. Enable notifications on a browser to receive it.',
      );
    });
  };

  return (
    <details className="mt-3 border-y border-border py-3 text-sm">
      <summary className="min-h-8 cursor-pointer font-medium">
        Reminders{rows.length > 0 ? ` · ${rows.length}` : ''}
      </summary>
      <div className="space-y-4 pt-3">
        <p className="text-muted-foreground">
          {native
            ? 'Schedule a task reminder on this phone. Changes from other devices apply when you next open this plan.'
            : 'Choose when to be reminded. This Memory sends notifications to browsers you enable.'}
        </p>
        <Button variant="outline" className="min-h-11" disabled={busy} onClick={() => void enable()}>
          Enable notifications
        </Button>
        {loadError && (
          <p role="alert" className="text-destructive">
            Could not load reminders.{' '}
            <button type="button" className="underline" onClick={() => void refetch()}>
              Retry
            </button>
          </p>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        <form onSubmit={createReminder} className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="reminder-task">Task</Label>
            <select
              id="reminder-task"
              value={taskId}
              onChange={(event) => setTaskId(event.target.value)}
              required
              className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">Choose a task</option>
              {available.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="reminder-time">Your local date and time</Label>
            <Input
              id="reminder-time"
              type="datetime-local"
              value={at}
              onChange={(event) => setAt(event.target.value)}
              required
              className="min-h-11"
            />
          </div>
          <Button type="submit" className="min-h-11 sm:col-span-2" disabled={busy || available.length === 0}>
            {busy ? 'Saving…' : 'Add reminder'}
          </Button>
        </form>
        {available.length === 0 && (
          <p className="text-muted-foreground">
            Add an active task first, then choose its reminder time here.
          </p>
        )}
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="break-words font-medium">
                  {tasks.find((task) => task.id === row.taskId)?.title ??
                    (row.blockId ? 'Planned block' : 'Task reminder')}
                </p>
                <p>{new Date(row.fireAt).toLocaleString()}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {row.status === 'scheduled'
                    ? 'Scheduled on a device · delivery unconfirmed'
                    : row.status === 'delivered'
                      ? 'Accepted by notification service'
                      : row.status === 'fired'
                        ? 'Past attempt · delivery unconfirmed'
                        : row.status === 'delivering'
                          ? 'Sending…'
                          : row.status === 'failed'
                            ? row.nextAttemptAt
                              ? `Will retry ${new Date(row.nextAttemptAt).toLocaleString()}`
                              : 'Delivery failed · retry needed'
                            : row.deliveryMode === 'device'
                              ? 'Waiting to be scheduled on a phone'
                              : 'Waiting to send'}
                </p>
                {row.lastError && <p className="mt-1 text-xs text-destructive">{row.lastError}</p>}
              </div>
              <div className="flex flex-wrap gap-2">
                {row.status === 'failed' && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="min-h-11"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await retry({ variables: { id: row.id } });
                      })
                    }
                  >
                    Retry delivery
                  </Button>
                )}
                {native && row.deliveryMode === 'device' && row.status === 'pending' && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="min-h-11"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        if (
                          !user?.id ||
                          !(await scheduleDeviceReminder(user.id, {
                            id: row.id,
                            at: row.fireAt,
                            title: tasks.find((task) => task.id === row.taskId)?.title ?? 'A task is due',
                          }))
                        ) {
                          throw new Error(
                            'Could not schedule this reminder. Check notification permissions.',
                          );
                        }

                        await confirmPhoneSchedule(row.id);
                      })
                    }
                  >
                    Schedule on this phone
                  </Button>
                )}
                {!['delivered', 'fired'].includes(row.status) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="min-h-11"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        if (
                          native &&
                          row.deliveryMode === 'device' &&
                          user?.id &&
                          !(await cancelDeviceReminder(user.id, row.id))
                        ) {
                          throw new Error(
                            'Could not cancel the phone notification. Try again before removing its schedule.',
                          );
                        }

                        const result = await cancel({ variables: { id: row.id } });
                        if (!result.data?.cancelReminder) {
                          throw new Error('The reminder could not be cancelled.');
                        }
                      })
                    }
                  >
                    Cancel reminder
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
