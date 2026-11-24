import { cancelLocalNotification, isNativePlatform, scheduleLocalNotification } from '@ci/common';

interface LocalReminder {
  id: string;
  at: string;
  title: string;
}
const STORE = 'ci.memory.local-reminders.v1:';

export function reminderNotificationId(id: string): number {
  let value = 2166136261;
  for (const char of id) {
    value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  }

  return ((value >>> 0) % 2_000_000_000) + 1;
}

function read(userId: string): LocalReminder[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORE + userId) ?? '[]');

    return Array.isArray(saved)
      ? saved.filter(
          (row): row is LocalReminder =>
            row && typeof row.id === 'string' && typeof row.at === 'string' && typeof row.title === 'string',
        )
      : [];
  } catch {
    return [];
  }
}

function write(userId: string, rows: LocalReminder[]) {
  localStorage.setItem(STORE + userId, JSON.stringify(rows));
}

export async function scheduleDeviceReminder(userId: string, reminder: LocalReminder): Promise<boolean> {
  if (!Number.isFinite(Date.parse(reminder.at)) || Date.parse(reminder.at) <= Date.now()) {
    return false;
  }

  const ok = await scheduleLocalNotification('Task reminder', reminder.title, {
    id: reminderNotificationId(reminder.id),
    at: new Date(reminder.at),
  });
  if (ok) {
    write(userId, [...read(userId).filter((row) => row.id !== reminder.id), reminder]);
  }

  return ok;
}

export async function cancelDeviceReminder(userId: string, id: string): Promise<boolean> {
  const ok = await cancelLocalNotification(reminderNotificationId(id));
  if (ok) {
    write(
      userId,
      read(userId).filter((row) => row.id !== id),
    );
  }

  return ok;
}

/** Remote cancellations reconcile when this device next reads the plan. */
export async function reconcileDeviceReminders(userId: string, activeIds: Set<string>): Promise<boolean> {
  let ok = true;
  for (const row of read(userId)) {
    if (!activeIds.has(row.id)) {
      ok = (await cancelDeviceReminder(userId, row.id)) && ok;
    }
  }

  return ok;
}

/** Clear task alarms before changing identity or forgetting their cancellation receipts. */
export async function clearDeviceReminders(): Promise<boolean> {
  if (!isNativePlatform()) {
    return true;
  }

  try {
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).filter(
      (key): key is string => Boolean(key?.startsWith(STORE)),
    );
    let ok = true;
    for (const key of keys) {
      const userId = key.slice(STORE.length);
      for (const reminder of read(userId)) {
        ok = (await cancelDeviceReminder(userId, reminder.id)) && ok;
      }

      if (read(userId).length === 0) {
        localStorage.removeItem(key);
      }
    }

    return ok;
  } catch {
    // Unknown storage state is not proof that this phone has no alarms.
    return false;
  }
}

export class DeviceReminderCleanupError extends Error {
  constructor() {
    super(
      'Some task reminders could not be removed from this phone. Check notification settings, then try again. Your reminder cancellation records have been kept.',
    );
    this.name = 'DeviceReminderCleanupError';
  }
}

export async function requireDeviceRemindersCleared(): Promise<void> {
  if (!(await clearDeviceReminders())) {
    throw new DeviceReminderCleanupError();
  }
}

export async function subscribeBrowserReminders(publicKey: string): Promise<PushSubscriptionJSON> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    throw new Error(
      'Notifications need a supported browser. On iPhone, add this Memory to your Home Screen and open it there.',
    );
  }

  if ((await Notification.requestPermission()) !== 'granted') {
    throw new Error(
      'Notifications are blocked. Allow them in your browser or device settings, then try again.',
    );
  }

  let timeout: number | undefined;
  let registration: ServiceWorkerRegistration;
  try {
    registration = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => {
        timeout = window.setTimeout(
          () =>
            reject(
              new Error('The notification service is not ready. Reload this installed app and try again.'),
            ),
          10_000,
        );
      }),
    ]);
  } finally {
    window.clearTimeout(timeout);
  }

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    const raw = atob(publicKey.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: bytes,
    });
  }

  return subscription.toJSON();
}
