import { describe, expect, it } from 'vitest';

import { NAVIGATE_FALLBACK_DENYLIST } from '../../vite.config';

/**
 * Workbox answers every navigation with the precached app shell unless its path
 * matches `navigateFallbackDenylist`. A file's Open button opens its presigned
 * object-store URL (`/static/<bucket>/<key>?X-Amz-…`) in a new tab, which is a
 * navigation, so with only `/api/` exempt the tab showed the app's 404 page
 * instead of the file.
 */
function servedByShell(pathname: string): boolean {
  return !NAVIGATE_FALLBACK_DENYLIST.some((rule) => rule.test(pathname));
}

describe('service worker navigation fallback', () => {
  it.each(['/static/companion/b4791adb-e0a9-4a67-b178-fcc71dca93d5', '/api/graphql', '/api/import/runs'])(
    'leaves %s to the network',
    (pathname) => {
      expect(servedByShell(pathname)).toBe(false);
    },
  );

  it.each(['/', '/memory', '/events/01a17686-4703-735d-9dc7-98cea86ed33d', '/memory/static-notes'])(
    'still serves the app for %s',
    (pathname) => {
      expect(servedByShell(pathname)).toBe(true);
    },
  );
});
