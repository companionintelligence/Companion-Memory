import { registerPlugin } from '@capacitor/core';

import type { LocalHubPlugin } from './definitions';

/**
 * Registers the native plugin under the name both the Android `@CapacitorPlugin(name =
 * "LocalHub")` annotation and the iOS plugin declare, with a web fallback (`./web`) for
 * non-native environments. As with `@ci/capacitor-local-llm`, the web bundle reaches the
 * native implementation via `window.Capacitor.Plugins.LocalHub` rather than importing
 * this module directly; this registration exists for completeness/direct consumers and
 * to keep the package a standard, self-registering Capacitor plugin.
 */
const LocalHub = registerPlugin<LocalHubPlugin>('LocalHub', {
  web: () => import('./web.js').then((m) => new m.LocalHubWeb()),
});

export * from './definitions';
export { LocalHub };
