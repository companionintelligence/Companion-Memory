import type { PluginListenerHandle } from '@capacitor/core';

/**
 * How long the app may sit in the background before coming back locked.
 *
 * - `immediately` — lock the moment the app leaves the foreground.
 * - `30s` (default) — long enough that answering a notification does not demand a face
 *   scan, short enough that a handed-over phone re-locks.
 * - `5m`
 * - `never` — lock only on a cold start and on an explicit `lock()`.
 */
export type AppLockGrace = 'immediately' | '30s' | '5m' | 'never';

export const APP_LOCK_GRACES: readonly AppLockGrace[] = ['immediately', '30s', '5m', 'never'];

/**
 * What the device can authenticate with, as the OS reports it.
 *
 * - `strong` — a Class 3 biometric (face / fingerprint) is enrolled.
 * - `weak` — only a Class 2 biometric is enrolled (Android).
 * - `credential-only` — no biometric, but a device PIN / pattern / passcode exists; the
 *   prompt falls back to it, so the lock still works.
 * - `none` — nothing to authenticate with. The lock cannot be enabled; see `reason`.
 */
export type AppLockBiometry = 'strong' | 'weak' | 'credential-only' | 'none';

/** The settings the plugin persists natively (so a cold start can lock before any JS runs). */
export interface AppLockSettings {
  enabled: boolean;
  grace: AppLockGrace;
  /**
   * Blank the app in the task switcher and block screenshots / screen recording.
   * Android: `FLAG_SECURE` on the window, which also blocks the user's own screenshots —
   * hence a setting, default on. iOS has no equivalent flag; the plugin always covers the
   * switcher snapshot with a blur while the lock is enabled, whatever this says.
   */
  secureScreen: boolean;
}

export interface AppLockStatus extends AppLockSettings {
  /** Whether the lock is currently engaged (the native overlay is showing). */
  locked: boolean;
  /** Whether the device can authenticate at all, i.e. whether the lock can be enabled. */
  available: boolean;
  biometry: AppLockBiometry;
  /** Why `available` is false, when it is. */
  reason?: string;
}

export interface AppLockPlugin {
  /** Current settings and lock state. Cheap; the Settings page and the gate poll it on mount. */
  getStatus(): Promise<AppLockStatus>;

  /**
   * Change settings. Turning the lock ON first runs the unlock prompt once, so a user who
   * cannot pass it (no biometric, no passcode) is never locked out of their own memory:
   * if the prompt fails or is cancelled the settings are left as they were. Everything
   * else applies at once. Resolves with the resulting status.
   */
  configure(settings: Partial<AppLockSettings>): Promise<AppLockStatus>;

  /** Engage the lock now (the Settings page's "Lock now"). No-op when the lock is disabled. */
  lock(): Promise<AppLockStatus>;

  /**
   * Show the OS prompt and, on success, disengage the lock. Resolves (never rejects) with
   * the resulting status, so a cancelled prompt simply leaves `locked: true`. The native
   * overlay's own button calls the same thing; this is for the web lock screen's.
   */
  unlock(): Promise<AppLockStatus>;

  /**
   * A line the native overlay shows under its title, e.g. "3 captures waiting to sync".
   * That something is queued is not sensitive; what is, is — so the overlay shows the
   * count and nothing else. Empty text clears it.
   */
  setLockScreenNote(options: { text: string }): Promise<void>;

  /** Fires on every lock / unlock, including the ones the native side decides on its own. */
  addListener(
    eventName: 'lockStateChange',
    listener: (event: { locked: boolean }) => void,
  ): Promise<PluginListenerHandle>;

  removeAllListeners(): Promise<void>;
}
