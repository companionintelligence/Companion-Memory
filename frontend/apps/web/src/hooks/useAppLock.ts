import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { type AppLockSettings, type AppLockStatus, appLockPlugin } from '@ci/common';

/**
 * One shared view of the native lock for every consumer (the gate, the Settings
 * section): the status is fetched once, kept current from the plugin's
 * `lockStateChange` events, and refreshed after every call that can change it.
 *
 * `status` is `null` until the first answer, and stays `null` where there is no plugin
 * (the web, an older shell) — consumers treat that as "no lock here".
 */
let status: AppLockStatus | null = null;
let started = false;
const listeners = new Set<() => void>();

function publish(next: AppLockStatus | null): void {
  status = next;
  listeners.forEach((listener) => listener());
}

async function refresh(): Promise<void> {
  const plugin = appLockPlugin();

  if (!plugin) {
    publish(null);

    return;
  }

  try {
    publish(await plugin.getStatus());
  } catch (error) {
    console.warn('[app-lock] getStatus failed', error);
  }
}

function start(): void {
  if (started) {
    return;
  }

  started = true;

  const plugin = appLockPlugin();

  if (!plugin) {
    return;
  }

  void refresh();

  // Capacitor's bridge hands back a thenable with `then` and `remove` but no `catch`;
  // calling `.catch` on it threw inside the gate's first render and, with no error
  // boundary above it, unmounted the whole app. Adopt it as a real promise, and let
  // nothing in here throw: a lock that cannot subscribe is a lock that still polls.
  try {
    void Promise.resolve(
      plugin.addListener('lockStateChange', ({ locked }) => {
        if (status) {
          publish({ ...status, locked });
        } else {
          void refresh();
        }
      }),
    ).catch((error: unknown) => console.warn('[app-lock] could not subscribe to lock state', error));
  } catch (error) {
    console.warn('[app-lock] could not subscribe to lock state', error);
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  start();

  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => status;

export interface AppLockActions {
  /** Change settings; enabling runs the OS prompt first (see the plugin). */
  configure: (settings: Partial<AppLockSettings>) => Promise<AppLockStatus | null>;
  lock: () => Promise<void>;
  /** Show the prompt. Resolves whatever the outcome; the status says whether it passed. */
  unlock: () => Promise<void>;
  /** The line under the native lock screen's title (a queue count). */
  setLockScreenNote: (text: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useAppLock(): [AppLockStatus | null, AppLockActions] {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    start();
  }, []);

  const configure = useCallback(async (settings: Partial<AppLockSettings>) => {
    const plugin = appLockPlugin();

    if (!plugin) {
      return null;
    }

    const next = await plugin.configure(settings);

    publish(next);

    return next;
  }, []);

  const lock = useCallback(async () => {
    const plugin = appLockPlugin();

    if (plugin) {
      publish(await plugin.lock());
    }
  }, []);

  const unlock = useCallback(async () => {
    const plugin = appLockPlugin();

    if (plugin) {
      publish(await plugin.unlock());
    }
  }, []);

  const setLockScreenNote = useCallback(async (text: string) => {
    await appLockPlugin()?.setLockScreenNote({ text });
  }, []);

  return [current, { configure, lock, unlock, setLockScreenNote, refresh }];
}

/** Test seam: forget the cached status and subscription so a test starts clean. */
export function resetAppLockStoreForTests(): void {
  status = null;
  started = false;
  listeners.clear();
}
