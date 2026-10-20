import { WebPlugin } from '@capacitor/core';

import type { AppLockPlugin, AppLockSettings, AppLockStatus } from './definitions';

/**
 * The web half: there is no OS prompt and no window to secure in a browser, so the lock
 * is reported unavailable and every call is a no-op that answers with that status. The
 * web app hides the feature when `available` is false.
 */
export class AppLockWeb extends WebPlugin implements AppLockPlugin {
  private settings: AppLockSettings = { enabled: false, grace: '30s', secureScreen: true };

  private status(): AppLockStatus {
    return {
      ...this.settings,
      locked: false,
      available: false,
      biometry: 'none',
      reason: 'The app lock is available in the iOS and Android apps.',
    };
  }

  async getStatus(): Promise<AppLockStatus> {
    return this.status();
  }

  async configure(settings: Partial<AppLockSettings>): Promise<AppLockStatus> {
    // Never enables: there is nothing to unlock with on the web.
    this.settings = { ...this.settings, ...settings, enabled: false };

    return this.status();
  }

  async lock(): Promise<AppLockStatus> {
    return this.status();
  }

  async unlock(): Promise<AppLockStatus> {
    return this.status();
  }

  async setLockScreenNote(_options: { text: string }): Promise<void> {
    // No overlay on the web.
  }
}
