import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PORTAL_URL,
  listMemoryServers,
  persistPortalUrl,
  probeMemoryOrigin,
  probePortalOrigin,
  readPersistedPortalUrl,
  requestApplianceToken,
  signInToPortal,
} from './portal-client';

describe('device-connect portal-client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.removeItem('ci.deviceConnect.portalUrl');
  });

  it('signs in with email and returns a session token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ token: 'sess-1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const auth = await signInToPortal('a@b.com', 'secret', 'https://hub.example.com');

    expect(auth.token).toBe('sess-1');
    expect(auth.kind).toBe('session');
    expect(fetch).toHaveBeenCalledWith(
      'https://hub.example.com/api/auth/sign-in/email',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('lists Memory Servers from slug=ci-memory for an OIDC token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            apps: [{ url: 'https://memory.example.com', deviceName: 'Home', deviceSlug: 'home' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const devices = await listMemoryServers(
      { token: 'oidc-at', cookie: null, kind: 'oauth' },
      'https://hub.example.com',
    );

    expect(fetch).toHaveBeenCalledWith(
      'https://hub.example.com/api/users/me/apps?slug=ci-memory',
      expect.anything(),
    );
    expect(devices).toEqual([
      { id: 'home', name: 'Home', status: 'active', memoryUrl: 'https://memory.example.com' },
    ]);
  });

  it("keeps the Memory's resource when the Portal lists one", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            apps: [
              {
                url: 'https://memory.example.com',
                deviceName: 'Home',
                deviceSlug: 'home',
                resource: 'urn:ci:device:home-device',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const devices = await listMemoryServers(
      { token: 'oidc-at', cookie: null, kind: 'oauth' },
      'https://hub.example.com',
    );

    expect(devices).toEqual([
      {
        id: 'home',
        name: 'Home',
        status: 'active',
        memoryUrl: 'https://memory.example.com',
        resource: 'urn:ci:device:home-device',
      },
    ]);
  });

  describe('requestApplianceToken', () => {
    it('posts the resource with the Portal access token and returns the addressed token', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ token: 'addressed', token_type: 'Bearer', expires_in: 900 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      );

      await expect(
        requestApplianceToken('oidc-at', 'urn:ci:device:home-device', 'https://hub.example.com/'),
      ).resolves.toBe('addressed');

      const [url, init] = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
      expect(url).toBe('https://hub.example.com/api/users/me/appliance-token');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer oidc-at');
      expect(JSON.parse(String(init.body))).toEqual({ resource: 'urn:ci:device:home-device' });
    });

    it('asks for a fresh sign-in when the Portal says the access token expired', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));

      await expect(
        requestApplianceToken('stale', 'urn:ci:device:x', 'https://hub.example.com'),
      ).rejects.toThrow(/Sign in again/);
    });

    it('refuses an answer with no token in it', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));

      await expect(
        requestApplianceToken('oidc-at', 'urn:ci:device:x', 'https://hub.example.com'),
      ).rejects.toThrow(/did not return a sign-in/);
    });
  });

  it('filters session-device lists down to a Memory app URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            devices: [
              {
                id: 'd1',
                displayName: 'Studio',
                status: 'active',
                apps: [
                  { slug: 'hub', url: 'https://hub.example.com' },
                  { slug: 'ci-memory', url: 'https://memory.example.com' },
                ],
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const devices = await listMemoryServers(
      { token: 't', cookie: null, kind: 'session' },
      'https://hub.example.com',
    );

    expect(fetch).toHaveBeenCalledWith('https://hub.example.com/api/devices', expect.anything());
    expect(devices[0]?.memoryUrl).toBe('https://memory.example.com');
  });

  it('probes /api/health on the Memory origin (native HTTP, not webview fetch)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));

    await probeMemoryOrigin('https://memory.example.com/');

    expect(fetch).toHaveBeenCalledWith(
      'https://memory.example.com/api/health',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('rejects an unhealthy Memory origin', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));

    await expect(probeMemoryOrigin('https://memory.example.com')).rejects.toThrow(/503/);
  });

  describe('probePortalOrigin (the check before the sign-in sheet opens)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('goes to the Companion origin itself, over the same native HTTP bridge as the other Portal calls', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));

      await probePortalOrigin('https://hub.example.com/');

      expect(fetch).toHaveBeenCalledWith(
        'https://hub.example.com/api/auth/ok',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it.each([404, 500, 503])(
      'counts an HTTP %i as reachable: something is listening there',
      async (status) => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status })));

        await expect(probePortalOrigin('https://hub.example.com')).resolves.toBeUndefined();
      },
    );

    it('rejects when the request gets no answer at all (refused, DNS, offline)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Load failed')));

      await expect(probePortalOrigin('http://192.168.0.4:9')).rejects.toThrow('Load failed');
    });

    it('gives up on a host that swallows the request, even where nothing honours an abort signal', async () => {
      vi.useFakeTimers();
      // Never settles, and ignores the signal — what the native bridge does.
      vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));

      const probe = probePortalOrigin('http://192.168.0.4:9');
      const settled = expect(probe).rejects.toThrow(/No answer from http:\/\/192\.168\.0\.4:9/);

      await vi.advanceTimersByTimeAsync(8_000);
      await settled;
    });
  });

  it('defaults cloud connect to production, not the internal Hub appliance Portal', () => {
    expect(DEFAULT_PORTAL_URL).toBe('https://hub.ci.computer');
    expect(readPersistedPortalUrl()).toBe('https://hub.ci.computer');
  });

  it('persists the Companion URL for the next OIDC hop', () => {
    persistPortalUrl('https://hub.ci.computer/');

    expect(readPersistedPortalUrl()).toBe('https://hub.ci.computer');
  });

  it('does not restore the internal dev cloud host as the Companion URL', () => {
    localStorage.setItem('ci.deviceConnect.portalUrl', 'https://hub.companionintelligence.com');
    expect(readPersistedPortalUrl()).toBe('https://hub.ci.computer');
  });
});
