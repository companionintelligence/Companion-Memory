import { setApiKey } from '@ci/common';
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetGoogleMapsKeyForTests } from './googleMaps';
import { RouteLayer } from './RouteLayer';

// The real `useSessionAuth` runs on top of this, so the layer is exercised for a web JWT session
// and for the native shell, whose only credential is an API key.
const h = vi.hoisted(() => ({
  auth: { authToken: 'jwt-abc' as string | null, authenticated: true, expired: false },
  map: { addLayer: vi.fn(), removeLayer: vi.fn() },
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => [h.auth, {}] }));

// No <MapContainer> ancestor exists here, so the one thing the layer reads from react-leaflet is
// replaced with a map that records which layers it was given.
vi.mock('react-leaflet', () => ({ useMap: () => h.map }));

vi.mock('./useMap', () => ({ useMap: () => [{ displayRoutes: true }] }));

// Restore `fetch` alone: `vi.unstubAllGlobals()` would also drop the stubs from the shared test setup.
const realFetch = globalThis.fetch;

function stubMapsConfig(body: unknown) {
  // A real Response per call: a body can only be read once, and the lookup may read it as text or JSON.
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', fetchMock);

  return fetchMock;
}

const headersOfCall = (fetchMock: ReturnType<typeof stubMapsConfig>, index: number) =>
  (fetchMock.mock.calls[index]?.[1] as RequestInit | undefined)?.headers as Record<string, string>;

beforeEach(() => {
  resetGoogleMapsKeyForTests();
  h.auth.authToken = 'jwt-abc';
  h.auth.authenticated = true;
  h.auth.expired = false;
  h.map.addLayer.mockClear();
  h.map.removeLayer.mockClear();
});

afterEach(() => {
  setApiKey(null);
  globalThis.fetch = realFetch;
});

describe('RouteLayer', () => {
  it('adds the route layer once the Maps key resolves, asking with the bearer on the web', async () => {
    const fetchMock = stubMapsConfig({ configured: true, apiKey: 'maps-key' });

    render(<RouteLayer locations={[]} />);

    await waitFor(() => expect(h.map.addLayer).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/config/maps');
    expect(headersOfCall(fetchMock, 0).Authorization).toBe('Bearer jwt-abc');
  });

  /**
   * ═══ NO ROUTES ON THE PHONE'S MAP ═══
   *
   * `authToken` is the web JWT, null in the Capacitor app — whose durable credential is a keystore
   * API key. `resolveGoogleMapsApiKey` returned null without asking, so `configured` never turned
   * true and the layer was never added: the phone's map drew no routes and said nothing. And the
   * request itself was a bare relative `fetch('/api/config/maps')` — the app's own origin, not the
   * Memory server — with no key. `GET /config/maps` is `JwtOrApiKeyAuthGuard`.
   */
  describe('native shell (API key, no web JWT)', () => {
    beforeEach(() => {
      h.auth.authToken = null;
      setApiKey('device-key');
    });

    it('adds the route layer, asking for the key with the device key and no bearer', async () => {
      const fetchMock = stubMapsConfig({ configured: true, apiKey: 'maps-key' });

      render(<RouteLayer locations={[]} />);

      await waitFor(() => expect(h.map.addLayer).toHaveBeenCalled());

      const headers = headersOfCall(fetchMock, 0);
      expect(String(fetchMock.mock.calls[0][0])).toContain('/api/config/maps');
      expect(headers['x-api-key']).toBe('device-key');
      expect(headers).not.toHaveProperty('Authorization');
    });

    it('draws no routes when the server has no Maps key configured', async () => {
      const fetchMock = stubMapsConfig({ configured: false });

      render(<RouteLayer locations={[]} />);

      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      // Let the answer land before asserting the layer was never added.
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(h.map.addLayer).not.toHaveBeenCalled();
    });

    it('asks nothing while the session is not signed in', async () => {
      h.auth.authenticated = false;
      const fetchMock = stubMapsConfig({ configured: true, apiKey: 'maps-key' });

      render(<RouteLayer locations={[]} />);

      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(fetchMock).not.toHaveBeenCalled();
      expect(h.map.addLayer).not.toHaveBeenCalled();
    });
  });
});
