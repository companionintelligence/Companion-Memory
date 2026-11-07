import { describe, expect, it } from 'vitest';

import { isAppNavigation } from '../../vite.config';

/**
 * Which page loads the service worker answers (network first, the precached
 * shell only offline) and which it leaves to the browser.
 *
 * A file's Open button opens its presigned object-store URL
 * (`/static/<bucket>/<key>?X-Amz-…`) in a new tab, which is a navigation, so
 * with only `/api/` exempt the tab showed the app's 404 page instead of the
 * file. And a page load answered from the cache never reaches a sign-in in
 * front of Memory, so the app has to ask the network first
 * (Companion-Memory#3392).
 */
const navigation = (pathname: string, mode: RequestMode = 'navigate') => ({
  request: { mode } as Request,
  url: new URL(pathname, 'https://memory.example'),
});

// Workbox copies the matcher into the generated service worker as source text,
// so the copy has to work on its own, with nothing from this module in scope.
const serialized = new Function(`return (${isAppNavigation.toString()})`)() as typeof isAppNavigation;

describe.each([
  ['the matcher', isAppNavigation],
  ['its copy in the service worker', serialized],
])('service worker navigation route: %s', (_label, matches) => {
  it.each(['/static/companion/b4791adb-e0a9-4a67-b178-fcc71dca93d5', '/api/graphql', '/api/import/runs'])(
    'leaves %s to the browser',
    (pathname) => {
      expect(matches(navigation(pathname))).toBe(false);
    },
  );

  it.each(['/', '/memory', '/events/01a17686-4703-735d-9dc7-98cea86ed33d', '/memory/static-notes'])(
    'answers a page load of %s',
    (pathname) => {
      expect(matches(navigation(pathname))).toBe(true);
    },
  );

  it('ignores requests that are not page loads', () => {
    expect(matches(navigation('/memory', 'cors'))).toBe(false);
    expect(matches(navigation('/logo-192x192.png', 'no-cors'))).toBe(false);
  });
});
