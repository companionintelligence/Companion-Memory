import { setApiBaseUrl } from '@ci/common';
import type { ErrorEvent } from '@sentry/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isChunkLoadError,
  scrubBrowserEvent,
  scrubServerOrigin,
  scrubString,
  scrubUrl,
  shouldDropEvent,
  telemetryConfigUrl,
} from './telemetry';
import { MAX_STRING_LENGTH, SCRUB_CASES } from './telemetryScrubFixtures';

const event = (partial: Partial<ErrorEvent>) => partial as ErrorEvent;

describe('scrubUrl', () => {
  it('drops the query string and hash', () => {
    expect(scrubUrl('https://ci-server.localhost/search?q=my+private+note#results')).toBe(
      'https://ci-server.localhost/search',
    );
  });

  it('keeps a bare path intact', () => {
    expect(scrubUrl('/memories/2026')).toBe('/memories/2026');
  });

  it('leaves the origin and path exactly as written', () => {
    expect(scrubUrl('https://ci-server.localhost/a b/c')).toBe('https://ci-server.localhost/a b/c');
  });

  it('handles unparseable input without throwing', () => {
    expect(scrubUrl('::not a url::?q=secret')).toBe('::not a url::');
  });
});

describe('isChunkLoadError', () => {
  it.each([
    'Failed to fetch dynamically imported module: /assets/x.js',
    'Importing a module script failed.',
    'error loading dynamically imported module: /assets/x.js',
    'Unable to preload CSS for /assets/MapView-abc.css',
  ])('recognises a failed chunk download: %s', (message) => {
    expect(isChunkLoadError(new TypeError(message))).toBe(true);
    expect(isChunkLoadError(message)).toBe(true);
  });

  it.each([
    new Error('Cannot read properties of undefined'),
    undefined,
    null,
    { message: 'Loading chunk 1 failed' },
  ])('does not mistake anything else for one: %s', (error) => {
    expect(isChunkLoadError(error)).toBe(false);
  });
});

describe('shouldDropEvent', () => {
  it.each([
    'Loading chunk 42 failed',
    'Failed to fetch dynamically imported module: /assets/x.js',
    'Unable to preload CSS for /assets/MapView-abc.css',
    'ResizeObserver loop completed with undelivered notifications',
  ])('drops known noise: %s', (message) => {
    expect(shouldDropEvent(event({ message }))).toBe(true);
  });

  it('keeps a real application error', () => {
    expect(shouldDropEvent(event({ message: 'Cannot read properties of undefined' }))).toBe(false);
  });

  it('inspects exception values, not just the message', () => {
    expect(shouldDropEvent(event({ exception: { values: [{ value: 'Loading chunk 7 failed' }] } }))).toBe(
      true,
    );
  });
});

describe('scrubBrowserEvent', () => {
  it('returns null for dropped noise', () => {
    expect(scrubBrowserEvent(event({ message: 'Loading chunk 3 failed' }))).toBeNull();
  });

  it('scrubs the request url and removes cookies and query string', () => {
    const scrubbed = scrubBrowserEvent(
      event({
        message: 'boom',
        request: {
          url: 'https://ci-server.localhost/search?q=private',
          cookies: { sessionToken: 'abc' },
          query_string: 'q=private',
        },
      }),
    );

    expect(scrubbed!.request!.url).toBe('https://ci-server.localhost/search');
    expect(scrubbed!.request!.cookies).toBeUndefined();
    expect(scrubbed!.request!.query_string).toBeUndefined();
  });

  it('scrubs navigation breadcrumbs', () => {
    const scrubbed = scrubBrowserEvent(
      event({
        message: 'boom',
        breadcrumbs: [{ category: 'navigation', data: { from: '/a?q=x', to: '/b?q=y' } }],
      }),
    );

    expect(scrubbed!.breadcrumbs![0]!.data).toEqual({ from: '/a', to: '/b' });
  });

  it('passes a clean event through untouched', () => {
    expect(scrubBrowserEvent(event({ message: 'real failure' }))).toEqual({ message: 'real failure' });
  });
});

describe('scrubBrowserEvent — leaks confirmed by adversarial review', () => {
  it('scrubs fetch/xhr breadcrumb urls, which carry the memory search', () => {
    const scrubbed = scrubBrowserEvent(
      event({
        message: 'boom',
        breadcrumbs: [
          { category: 'fetch', data: { url: '/api/graph/search?query=divorce+lawyer&people=alice' } },
        ],
      }),
    );

    expect(scrubbed!.breadcrumbs![0]!.data!.url).toBe('/api/graph/search');
  });

  it('scrubs console breadcrumb message and arguments', () => {
    const scrubbed = scrubBrowserEvent(
      event({
        message: 'boom',
        breadcrumbs: [
          {
            category: 'console',
            message: 'token=abc123456 at /Users/liam/x',
            data: { arguments: ['Bearer abcdefghijkl'] },
          },
        ],
      }),
    );
    const crumb = scrubbed!.breadcrumbs![0]!;

    expect(crumb.message).not.toContain('abc123456');
    expect(crumb.message).toContain('~/x');
    expect(JSON.stringify(crumb.data!.arguments)).not.toContain('abcdefghijkl');
  });

  it('scrubs the referer header put there by httpContextIntegration', () => {
    const scrubbed = scrubBrowserEvent(
      event({ message: 'boom', request: { headers: { Referer: 'https://x/memory?search=oncology' } } }),
    );

    expect(scrubbed!.request!.headers!.Referer).toBe('https://x/memory');
  });

  it('applies the shared secret and home-path rules the browser was missing', () => {
    const scrubbed = scrubBrowserEvent(
      event({
        message: 'failed at /Users/liam/notes with api_key=sk-live-123456',
        exception: { values: [{ value: 'Bearer eyJhbGciOiJIUzI1NiJ9.a.b rejected' }] },
        extra: { password: 'hunter2' },
      }),
    );

    expect(scrubbed!.message).toContain('~/notes');
    expect(scrubbed!.message).not.toContain('sk-live-123456');
    expect(scrubbed!.exception!.values![0]!.value).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect((scrubbed!.extra as Record<string, unknown>).password).toBe('[Filtered]');
  });
});

describe('shared scrub fixtures — parity with the backend scrubber', () => {
  // The identical list lives at
  // backend/apps/api/src/common/telemetry/scrubFixtures.ts and is run by that
  // suite too. The browser copy originally shipped with none of these rules.
  it.each(SCRUB_CASES.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
    const actual = scrubString(testCase.input);

    if (testCase.expected !== undefined) {
      expect(actual).toBe(testCase.expected);
    }

    for (const forbidden of testCase.mustNotContain ?? []) {
      expect(actual).not.toContain(forbidden);
    }
  });

  it('truncates at the shared limit', () => {
    expect(scrubString('a'.repeat(MAX_STRING_LENGTH + 1000))).toHaveLength(
      MAX_STRING_LENGTH + '… [truncated]'.length,
    );
  });

  it('the two fixture files have not drifted', async () => {
    const [fs, path] = await Promise.all([import('node:fs/promises'), import('node:path')]);
    const here = path.resolve(__dirname, 'telemetryScrubFixtures.ts');
    const backend = path.resolve(
      __dirname,
      '../../../../../backend/apps/api/src/common/telemetry/scrubFixtures.ts',
    );

    const [a, b] = await Promise.all([fs.readFile(here, 'utf8'), fs.readFile(backend, 'utf8')]);

    // The copy carries one extra header comment; the case list must match.
    const cases = (source: string) => source.slice(source.indexOf('export interface ScrubCase'));

    expect(cases(a)).toBe(cases(b));
  });
});

describe('scrubBreadcrumb — sensitive keys, not just values', () => {
  // Regression: iterating breadcrumb.data and scrubbing each VALUE skipped the
  // sensitive-key check, so a bare token (matching no secret pattern on its own)
  // shipped intact. Caught by the CI-Hermes port, not by the original tests.
  it.each([
    ['token', 'abc123456'],
    ['api_key', 'sk-live-000111'],
    ['x-api-key', 'ci_live_222333'],
    ['authorization', 'opaque-value'],
    ['x-ci-hub-user', 'liam'],
  ])('filters a bare data.%s', (key, value) => {
    const scrubbed = scrubBrowserEvent(
      event({ message: 'boom', breadcrumbs: [{ category: 'fetch', data: { [key]: value } }] }),
    );

    expect(scrubbed!.breadcrumbs![0]!.data![key]).toBe('[Filtered]');
  });

  it('still scrubs nested values and keeps url handling', () => {
    const scrubbed = scrubBrowserEvent(
      event({
        message: 'boom',
        breadcrumbs: [
          { category: 'fetch', data: { url: '/api/search?q=private', meta: { path: '/Users/liam/x' } } },
        ],
      }),
    );
    const data = scrubbed!.breadcrumbs![0]!.data!;

    expect(data.url).toBe('/api/search');
    expect((data.meta as Record<string, unknown>).path).toBe('~/x');
  });
});

/** Pretend to be (or not be) the Capacitor WebView for one test. */
function stubPlatform(native: boolean): void {
  vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => native } });
}

describe('telemetryConfigUrl — the consent probe has to reach the appliance', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setApiBaseUrl('');
  });

  it('stays relative on web, where the API is same-origin', () => {
    stubPlatform(false);

    expect(telemetryConfigUrl()).toBe('/api/config/telemetry');
  });

  // The bug this exists to prevent: Capacitor serves the bundle from
  // capacitor://localhost (iOS) / https://localhost (Android), so a relative
  // path resolved against the WebView itself, 404'd, and — because the check
  // fails closed — silently disabled reporting for the whole mobile app.
  it('resolves against the configured server on native', () => {
    stubPlatform(true);
    setApiBaseUrl('https://companion.example.ts.net');

    expect(telemetryConfigUrl()).toBe('https://companion.example.ts.net/api/config/telemetry');
  });

  it('returns null on native before a server is configured, so nothing is reported', () => {
    stubPlatform(true);
    setApiBaseUrl('');

    expect(telemetryConfigUrl()).toBeNull();
  });

  it('does not double up slashes when the origin has a trailing one', () => {
    stubPlatform(true);
    setApiBaseUrl('https://companion.example.ts.net/');

    expect(telemetryConfigUrl()).toBe('https://companion.example.ts.net/api/config/telemetry');
  });
});

describe('scrubServerOrigin — the address of the user’s own appliance', () => {
  it('is a no-op on web, where there is no configured origin', () => {
    expect(scrubServerOrigin('failed to fetch /api/x', '')).toBe('failed to fetch /api/x');
  });

  it('replaces every occurrence, not just the first', () => {
    expect(
      scrubServerOrigin('http://10.0.0.4:3000 redirected to http://10.0.0.4:3000/x', 'http://10.0.0.4:3000'),
    ).toBe('[server] redirected to [server]/x');
  });

  it('treats the origin literally, so regex metacharacters cannot break it', () => {
    expect(scrubServerOrigin('a http://h.o+st/x b', 'http://h.o+st')).toBe('a [server]/x b');
  });

  // A tailnet hostname or LAN IP identifies the user's machine and network, and
  // sendDefaultPii: false does nothing about it — the SDK cannot know the string
  // is sensitive. Enabling reporting on native without this would ship it inside
  // every fetch breadcrumb.
  it('redacts the origin across message, breadcrumb and exception alike', () => {
    const origin = 'https://liambook.tailnet.ts.net';
    const scrubbed = scrubBrowserEvent(
      event({
        message: `POST ${origin}/api/graph failed`,
        exception: { values: [{ value: `connect ECONNREFUSED ${origin}` }] },
        breadcrumbs: [{ category: 'fetch', data: { url: `${origin}/api/search?q=private` } }],
      }),
      origin,
    );

    expect(scrubbed!.message).toBe('POST [server]/api/graph failed');
    expect(scrubbed!.exception!.values![0]!.value).toBe('connect ECONNREFUSED [server]');
    expect(scrubbed!.breadcrumbs![0]!.data!.url).toBe('[server]/api/search');
  });

  it('leaves events untouched when no origin is passed (web behaviour is unchanged)', () => {
    const scrubbed = scrubBrowserEvent(event({ message: 'POST https://example.com/api failed' }));

    expect(scrubbed!.message).toBe('POST https://example.com/api failed');
  });
});

// A source-order assertion, in the same spirit as the fixture-drift test above.
// `main.tsx` is a side-effecting entrypoint (it calls `createRoot`), so importing
// it to observe the ordering is not practical — but the ordering is exactly the
// kind of thing a tidy-up reorders, and getting it wrong raises no error
// anywhere. The only symptom is that the mobile app reports nothing, forever.
describe('main.tsx bootstrap order — the silent one', () => {
  it('resolves the API origin before starting telemetry', async () => {
    const [fs, path] = await Promise.all([import('node:fs/promises'), import('node:path')]);
    const source = await fs.readFile(path.resolve(__dirname, '../main.tsx'), 'utf8');

    // Statement lines only. Both calls are named in the comments that explain
    // this very ordering, and matching those instead reports the opposite
    // order — which is precisely how the first draft of this test failed.
    const statements = source
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('//') && !line.startsWith('*'));

    const apiBase = statements.findIndex((line) => line.startsWith('initApiBaseUrl();'));
    const telemetry = statements.findIndex((line) => line.startsWith('void initTelemetry();'));

    expect(apiBase).toBeGreaterThan(-1);
    expect(telemetry).toBeGreaterThan(-1);

    // `initTelemetry` builds its consent-probe URL from the API origin, and it
    // issues that fetch synchronously — before its first `await` yields — so an
    // origin resolved afterwards arrives too late. Reversed, the probe on native
    // requests a relative path against `capacitor://localhost`, fails, and
    // (failing closed) disables reporting for the entire mobile app.
    expect(apiBase).toBeLessThan(telemetry);
  });
});
