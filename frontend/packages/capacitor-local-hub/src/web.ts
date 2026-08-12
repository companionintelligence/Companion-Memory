import { WebPlugin } from '@capacitor/core';

import type { LocalHubPlugin, LocalHubStartResult, LocalHubStatusResult } from './definitions';

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
}
