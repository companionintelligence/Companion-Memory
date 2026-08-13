import { WebPlugin } from '@capacitor/core';

import type {
  LocalHubPlugin,
  LocalHubSecureGetResult,
  LocalHubStartResult,
  LocalHubStatusResult,
} from './definitions';

/**
 * Web/no-op implementation. There is no embedded HTTP server in a browser tab, so
 * `start()` reports unavailable and status always reads "not running". This exists only
 * to satisfy `registerPlugin`'s web fallback contract for environments (Storybook, unit
 * tests, `cap run` in a browser tab) that might otherwise throw "not implemented" instead
 * of a clear, intentional error.
 */
export class LocalHubWeb extends WebPlugin implements LocalHubPlugin {
  async start(): Promise<LocalHubStartResult> {
    throw this.unavailable('LocalHub is only available in the native app.');
  }

  async stop(): Promise<void> {
    // Nothing running on web -- no-op.
  }

  async getStatus(): Promise<LocalHubStatusResult> {
    return { running: false };
  }

  /**
   * The secure store is `unavailable`, not silently backed by `localStorage`. A browser has
   * no keystore, and quietly answering from `localStorage` here would let a caller believe
   * a value was protected when it is readable by any script on the origin — the same class
   * of lie this store was built to remove. `@ci/common`'s `secureStorageGet` picks the
   * `localStorage` fallback explicitly, on the web path, where that trade-off is visible.
   */
  async secureGet(): Promise<LocalHubSecureGetResult> {
    throw this.unavailable('LocalHub secure storage is only available in the native app.');
  }

  async secureSet(): Promise<void> {
    throw this.unavailable('LocalHub secure storage is only available in the native app.');
  }

  async secureRemove(): Promise<void> {
    throw this.unavailable('LocalHub secure storage is only available in the native app.');
  }
}
