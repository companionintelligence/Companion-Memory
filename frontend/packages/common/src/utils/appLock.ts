/**
 * The web side of the biometric app lock: the plugin's types, the bridge accessor, and
 * the labels the Settings page shows. The lock STATE is native (`@ci/capacitor-app-lock`
 * decides when to lock and draws its own overlay above the WebView); the web app only
 * mirrors it — a route gate that hides the page behind a lock screen, and a Settings
 * section. See `frontend/apps/{ios,android}/SECURITY_ARCHITECTURE.md` § 4.
 */
import { isNativePlatform } from './apiBase';

export type AppLockGrace = 'immediately' | '30s' | '5m' | 'never';

export const APP_LOCK_GRACES: readonly AppLockGrace[] = ['immediately', '30s', '5m', 'never'];

export type AppLockBiometry = 'strong' | 'weak' | 'credential-only' | 'none';

export interface AppLockSettings {
  enabled: boolean;
  grace: AppLockGrace;
  /** Blank the task switcher and block screenshots (Android `FLAG_SECURE`; iOS always blurs). */
  secureScreen: boolean;
}

export interface AppLockStatus extends AppLockSettings {
  locked: boolean;
  /** Whether the device can authenticate at all — the lock can only be enabled when true. */
  available: boolean;
  biometry: AppLockBiometry;
  reason?: string;
}

interface PluginListenerHandle {
  remove(): Promise<void> | void;
}

export interface AppLockPluginBridge {
  getStatus(): Promise<AppLockStatus>;
  configure(settings: Partial<AppLockSettings>): Promise<AppLockStatus>;
  lock(): Promise<AppLockStatus>;
  unlock(): Promise<AppLockStatus>;
  setLockScreenNote(options: { text: string }): Promise<void>;
  addListener(
    eventName: 'lockStateChange',
    listener: (event: { locked: boolean }) => void,
  ): Promise<PluginListenerHandle>;
}

/** The `AppLock` plugin off the runtime Capacitor bridge, or undefined when absent (web, old shell). */
export function appLockPlugin(): AppLockPluginBridge | undefined {
  if (typeof window === 'undefined' || !isNativePlatform()) {
    return undefined;
  }

  return (window as unknown as { Capacitor?: { Plugins?: { AppLock?: AppLockPluginBridge } } }).Capacitor
    ?.Plugins?.AppLock;
}

/** What each grace means, for the Settings picker. */
export const APP_LOCK_GRACE_LABELS: Record<AppLockGrace, { label: string; hint: string }> = {
  immediately: { label: 'Immediately', hint: 'Locks the moment you leave the app.' },
  '30s': {
    label: 'After 30 seconds',
    hint: 'Answering a notification does not ask again; a handed-over phone re-locks.',
  },
  '5m': { label: 'After 5 minutes', hint: 'For switching between apps often.' },
  never: { label: 'Only when the app starts', hint: 'Locks on a cold start and when you tap Lock now.' },
};

/** A one-line description of what the device will ask for. */
export function describeBiometry(biometry: AppLockBiometry): string {
  switch (biometry) {
    case 'strong':
      return 'Face, fingerprint or your device passcode.';
    case 'weak':
      return 'Your enrolled biometric or your device passcode.';
    case 'credential-only':
      return 'Your device PIN, pattern or passcode (no biometric is enrolled).';
    case 'none':
      return 'This device has nothing to unlock with.';
  }
}

/**
 * What is waiting to reach the Memory server, by kind: position fixes from the capture
 * outbox, notes and saved searches from PowerSync's upload queue (and a note the outbox
 * holds on a phone with no replica), and anything the outbox carries under a kind this
 * list does not name.
 */
export interface LockScreenQueueCounts {
  locations?: number;
  notes?: number;
  savedSearches?: number;
  other?: number;
}

const QUEUE_NOUNS: Array<[key: keyof LockScreenQueueCounts, one: string, many: string]> = [
  ['locations', 'location', 'locations'],
  ['notes', 'note', 'notes'],
  ['savedSearches', 'saved search', 'saved searches'],
  ['other', 'capture', 'captures'],
];

/**
 * The note the native lock screen shows about what is waiting to sync: counts by kind,
 * never content -- "17 locations, 1 note and 2 saved searches waiting to sync". Kinds at
 * zero are left out; nothing waiting is an empty note.
 */
export function lockScreenQueueNote(counts: LockScreenQueueCounts): string {
  const parts = QUEUE_NOUNS.flatMap(([key, one, many]) => {
    const n = Math.max(0, Math.trunc(counts[key] ?? 0));

    return n === 0 ? [] : [`${n} ${n === 1 ? one : many}`];
  });

  if (parts.length === 0) {
    return '';
  }

  const list =
    parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;

  return `${list} waiting to sync`;
}
