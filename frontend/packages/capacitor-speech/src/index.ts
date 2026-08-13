import { registerPlugin } from '@capacitor/core';

import type { SpeechPlugin } from './definitions';

/**
 * Registers the native plugin under the name both the Android `@CapacitorPlugin(name =
 * "Speech")` annotation and the iOS plugin's `jsName` declare, with a web fallback
 * (`./web`) for non-native environments. As with `@ci/capacitor-local-llm` and
 * `@ci/capacitor-local-hub`, the shipped web bundle reaches the native implementation via
 * `window.Capacitor.Plugins.Speech` (see `@ci/common/src/utils/speech.ts`) rather than
 * importing this module; this registration exists for completeness/direct consumers and
 * to keep the package a standard, self-registering Capacitor plugin.
 */
const Speech = registerPlugin<SpeechPlugin>('Speech', {
  web: () => import('./web.js').then((m) => new m.SpeechWeb()),
});

export * from './definitions';
export { Speech };
