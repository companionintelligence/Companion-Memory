import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { connectToDemoServer, healthCheckOrigin, parseDemoServerOrigin } from './demoServer';

/**
 * The demo origin is the one hostname a store reviewer never types. What matters here
 * is that the app only ever offers a demo it can actually reach over TLS: an unset,
 * malformed, or plaintext build value must read as "no demo configured" (so no button
 * renders) rather than as a default worth guessing, and a demo that did not answer
 * must never become the app's persisted API origin.
 */

const { persistApiBaseUrl } = vi.hoisted(() => ({ persistApiBaseUrl: vi.fn() }));

vi.mock('@ci/common', () => ({ persistApiBaseUrl }));

beforeEach(() => {
  persistApiBaseUrl.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseDemoServerOrigin', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace only', '   '],
  ])('is null when the build value is %s', (_label, value) => {
    expect(parseDemoServerOrigin(value)).toBeNull();
  });

  it('is null for a plaintext origin — the demo exists to prove the encrypted path', () => {
    expect(parseDemoServerOrigin('http://demo.ci.computer')).toBeNull();
  });

  it('is null for a non-http(s) scheme', () => {
    expect(parseDemoServerOrigin('ftp://demo.ci.computer')).toBeNull();
  });

  it('is null for an unparseable value rather than falling back to a guessed host', () => {
    expect(parseDemoServerOrigin('demo.ci.computer')).toBeNull();
  });

  it('reduces a configured https URL to a bare origin', () => {
    expect(parseDemoServerOrigin('https://demo.ci.computer/some/path?x=1#y')).toBe(
      'https://demo.ci.computer',
    );
  });

  it('tolerates surrounding whitespace from the build environment', () => {
    expect(parseDemoServerOrigin('  https://demo.ci.computer  ')).toBe('https://demo.ci.computer');
  });

  it('preserves a non-default port', () => {
    expect(parseDemoServerOrigin('https://demo.ci.computer:8443')).toBe('https://demo.ci.computer:8443');
  });
});

describe('healthCheckOrigin', () => {
  it('resolves on a 2xx from the unauthenticated health endpoint', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(healthCheckOrigin('https://demo.ci.computer')).resolves.toBeUndefined();
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://demo.ci.computer/api/health');
  });

  it('throws with the status code on a non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 502 })),
    );

    await expect(healthCheckOrigin('https://demo.ci.computer')).rejects.toThrow(/502/);
  });

  it('aborts rather than hanging when the demo server never answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      ),
    );
    vi.useFakeTimers();

    const pending = healthCheckOrigin('https://slow.ci.computer');
    const assertion = expect(pending).rejects.toThrow(/aborted/);

    await vi.advanceTimersByTimeAsync(8_000);
    await assertion;

    vi.useRealTimers();
  });
});

describe('connectToDemoServer', () => {
  it('persists the demo origin once it answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );

    await connectToDemoServer('https://demo.ci.computer');

    expect(persistApiBaseUrl).toHaveBeenCalledWith('https://demo.ci.computer');
  });

  it('does NOT persist an origin that failed its health check', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 })),
    );

    await expect(connectToDemoServer('https://demo.ci.computer')).rejects.toThrow(/503/);
    expect(persistApiBaseUrl).not.toHaveBeenCalled();
  });
});
