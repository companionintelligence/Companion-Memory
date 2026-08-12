import { registerPlugin } from '@capacitor/core';

import type { LocalLlmPlugin } from './definitions';

/**
 * Registers the native plugin under the name the Android `@CapacitorPlugin(name =
 * "LocalLLM")` annotation declares, with a web fallback (`./web`) for non-native
 * environments. In the shipped app, the web bundle never imports this module — it
 * reaches the native implementation via `window.Capacitor.Plugins.LocalLLM` instead
 * (see `@ci/common/src/utils/nativeBridge.ts`), matching every other plugin in this
 * repo. This registration exists for completeness/direct consumers (Storybook, future
 * native-only screens) and to keep the package a standard, self-registering Capacitor
 * plugin.
 */
const LocalLlm = registerPlugin<LocalLlmPlugin>('LocalLLM', {
  web: () => import('./web.js').then((m) => new m.LocalLlmWeb()),
});

export * from './definitions';
export { LocalLlm };
