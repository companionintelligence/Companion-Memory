import { registerPlugin } from '@capacitor/core';

import type { AppLockPlugin } from './definitions';

/**
 * Registers the native plugin under the name both the Android `@CapacitorPlugin(name =
 * "AppLock")` annotation and the iOS plugin's `jsName` declare, with a web fallback
 * (`./web`) that reports the lock as unavailable. As with the other `@ci/capacitor-*`
 * plugins, the shipped web bundle reaches the native implementation via
 * `window.Capacitor.Plugins.AppLock` (see `@ci/common/src/utils/appLock.ts`) rather than
 * importing this module; the registration here keeps the package a standard,
 * self-registering Capacitor plugin for direct consumers.
 */
const AppLock = registerPlugin<AppLockPlugin>('AppLock', {
  web: () => import('./web.js').then((m) => new m.AppLockWeb()),
});

export * from './definitions';
export { AppLock };
