import { localHubHeaders, localHubPlugin, localHubSession } from '@ci/common/src/utils/localHub';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `@ci/common/src/utils/localHub.ts` is the single lookup every consumer of the on-device
 * sidecar goes through — `connectionMode.ts` probes its health with it, `outbox.ts` posts
 * captures to it — and it is loaded by all four targets (web, iOS, Android, desktop).
 * It had no test at all.
 *
 * What is worth pinning here is not the happy path but the *refusals*: every branch that
 * returns `null` exists so a caller on web (or in the Tauri window, or in a shell where
 * `cap sync` never copied the plugin) quietly falls through to the remote CI-Server
 * instead of throwing. A regression that let one of those throw, or that returned a
 * half-built session, would surface as a hard failure on the surface with no sidecar —
 * which is most of them.
 */

interface FakeHub {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  getStatus: ReturnType<typeof vi.fn>;
}

const originalCapacitor = (window as unknown as { Capacitor?: unknown }).Capacitor;

/**
 * Install a fake Capacitor bridge. `isNativePlatform` matters as much as `Plugins` here:
 * `localHubSession()` gates on it first, so a fake that omits it exercises the web path
 * no matter what plugin is registered.
 */
function installBridge(opts: { native: boolean; hub?: FakeHub | undefined; noBridge?: boolean }): void {
  if (opts.noBridge) {
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;

    return;
  }

  (window as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => opts.native,
    Plugins: opts.hub ? { LocalHub: opts.hub } : {},
  };
}

function fakeHub(startResult: unknown): FakeHub {
  return {
    start: vi.fn().mockImplementation(() => Promise.resolve(startResult)),
    stop: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockResolvedValue({ running: true }),
  };
}

afterEach(() => {
  (window as unknown as { Capacitor?: unknown }).Capacitor = originalCapacitor;
});

describe('localHubPlugin() — finding the sidecar on the bridge', () => {
  it('is undefined when there is no Capacitor bridge at all (plain web / Tauri)', () => {
    installBridge({ native: false, noBridge: true });

    expect(localHubPlugin()).toBeUndefined();
  });

  it('is undefined when the bridge exists but the plugin was never synced in', () => {
    // A real shipping failure: the shell builds fine, `Capacitor.Plugins` is populated,
    // and `LocalHub` simply is not among the keys because `cap sync` did not copy it.
    installBridge({ native: true });

    expect(localHubPlugin()).toBeUndefined();
  });

  it('returns the plugin object itself when present', () => {
    const hub = fakeHub({ baseUrl: 'http://127.0.0.1:1', token: 't' });
    installBridge({ native: true, hub });

    expect(localHubPlugin()).toBe(hub);
  });
});

describe('localHubSession() — the refusals that keep web callers on the remote path', () => {
  it('returns null on web even when a LocalHub plugin is somehow registered', async () => {
    // `registerPlugin` installs the *web fallback* under the same key, whose `start()`
    // throws. Gating on `isNativePlatform()` first is what stops that throw from ever
    // being reached.
    const hub = fakeHub({ baseUrl: 'http://127.0.0.1:1', token: 't' });
    installBridge({ native: false, hub });

    await expect(localHubSession()).resolves.toBeNull();
    expect(hub.start).not.toHaveBeenCalled();
  });

  it('returns null when native but the plugin is missing', async () => {
    installBridge({ native: true });

    await expect(localHubSession()).resolves.toBeNull();
  });

  it('returns null instead of rejecting when start() fails', async () => {
    // The server can genuinely fail to bind (no free loopback port, backgrounded app).
    // Callers treat that as "no sidecar", not as an error to surface.
    const hub = fakeHub(null);
    hub.start.mockRejectedValue(new Error('bind failed'));
    installBridge({ native: true, hub });

    await expect(localHubSession()).resolves.toBeNull();
  });

  it('returns null on a half-built session rather than an unusable one', async () => {
    // A baseUrl with no token would produce requests the sidecar answers with 401 on
    // every route; an empty baseUrl would produce fetches against the WebView's own
    // origin. Both are worse than reporting "no sidecar".
    installBridge({ native: true, hub: fakeHub({ baseUrl: 'http://127.0.0.1:8765', token: '' }) });
    await expect(localHubSession()).resolves.toBeNull();

    installBridge({ native: true, hub: fakeHub({ baseUrl: '', token: 'tok' }) });
    await expect(localHubSession()).resolves.toBeNull();
  });

  it('returns baseUrl + token when the sidecar starts', async () => {
    const hub = fakeHub({ baseUrl: 'http://127.0.0.1:8765', token: 'tok-abc' });
    installBridge({ native: true, hub });

    await expect(localHubSession()).resolves.toEqual({
      baseUrl: 'http://127.0.0.1:8765',
      token: 'tok-abc',
    });
  });

  it('drops any extra fields the native side returns', async () => {
    // Only `baseUrl` and `token` are the contract; anything else the plugin grows must
    // not leak into the object callers pass around (and log).
    const hub = fakeHub({ baseUrl: 'http://127.0.0.1:1', token: 'tok', pid: 4242 });
    installBridge({ native: true, hub });

    expect(Object.keys((await localHubSession()) ?? {})).toEqual(['baseUrl', 'token']);
  });

  it('re-asks the plugin on every call — the token is deliberately not cached', async () => {
    // A cached token goes stale the moment the server restarts (app resumed after a
    // process kill), and every subsequent sidecar request 401s. `start()` is idempotent
    // by contract, so re-asking is the cheap correct thing.
    const hub = fakeHub({ baseUrl: 'http://127.0.0.1:1', token: 'first' });
    installBridge({ native: true, hub });

    await localHubSession();
    hub.start.mockResolvedValue({ baseUrl: 'http://127.0.0.1:2', token: 'second' });

    await expect(localHubSession()).resolves.toEqual({
      baseUrl: 'http://127.0.0.1:2',
      token: 'second',
    });
    expect(hub.start).toHaveBeenCalledTimes(2);
  });
});

describe('localHubHeaders()', () => {
  it('sends exactly one header — Authorization: Bearer <token>', () => {
    const headers = localHubHeaders({ baseUrl: 'http://127.0.0.1:1', token: 'tok-abc' });

    expect(headers).toEqual({ Authorization: 'Bearer tok-abc' });

    // Asserted as an exact object *and* by key count on purpose: the sidecar's CORS
    // policy allowlists a fixed set of request headers and the WebView preflights every
    // request, so one extra header here fails the preflight and the request never leaves
    // the browser — a failure that looks like the server being down.
    expect(Object.keys(headers)).toHaveLength(1);
  });
});
