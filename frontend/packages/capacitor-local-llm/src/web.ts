import { WebPlugin } from '@capacitor/core';

import type { GenerateResult, LocalLlmAvailability, LocalLlmPlugin, ModelStatusResult } from './definitions';

/**
 * Web/no-op implementation. There is no on-device LiteRT-LM engine in a browser, so
 * every method reports "unavailable" (or throws for actions that don't make sense
 * without a model). `@ci/common`'s `generateOffline` gates all real calls behind
 * `isNativePlatform()`, so this class exists only to satisfy `registerPlugin`'s web
 * fallback contract for other environments (Storybook, unit tests, `cap run` in a
 * browser tab) that might otherwise throw "not implemented". Methods intentionally
 * ignore their arguments (TS allows implementing a narrower arity) — nothing on web
 * can act on a modelId/prompt/etc.
 */
export class LocalLlmWeb extends WebPlugin implements LocalLlmPlugin {
  async isAvailable(): Promise<LocalLlmAvailability> {
    return { available: false, reason: 'On-device LLM is only available in the native Android app.' };
  }

  async getModelStatus(): Promise<ModelStatusResult> {
    return { status: 'not_downloaded' };
  }

  async downloadModel(): Promise<void> {
    throw this.unavailable('downloadModel is not available on web.');
  }

  async deleteModel(): Promise<void> {
    // Nothing to delete on web — treat as a no-op rather than an error.
  }

  async loadModel(): Promise<void> {
    throw this.unavailable('loadModel is not available on web.');
  }

  async unloadModel(): Promise<void> {
    // Nothing loaded — no-op.
  }

  async generate(): Promise<GenerateResult> {
    throw this.unavailable('generate is not available on web.');
  }

  async generateStream(): Promise<void> {
    throw this.unavailable('generateStream is not available on web.');
  }

  async cancel(): Promise<void> {
    // Nothing in flight — no-op.
  }
}
