import config from '@ci/configuration';

import type { Connection } from '../../entities/ConnectionEntity';
import { GoogleClient } from '../GoogleClient';

/**
 * The redirect_uri a person's own OAuth app is sent, through GoogleClient. On an install that set
 * no callback variable it was "undefined/oauth/callback", which every provider refuses.
 */
function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

const connection = {
  id: 'conn-1',
  providerId: 'google',
  userId: 'user-1',
  activeEndpoints: [],
} as unknown as Connection;

describe('BaseOAuth2Client redirect_uri (via GoogleClient)', () => {
  const realFetch = global.fetch;
  const saved = {
    oauth: config.auth.oauth.callbackUrl,
    publicBaseUrl: config.auth.oidc.publicBaseUrl,
    appPublicUrl: process.env.APP_PUBLIC_URL,
    appPublicHostname: process.env.APP_PUBLIC_HOSTNAME,
  };

  function clientWithOwnApp() {
    const client = new GoogleClient(makeLogger() as never);
    jest
      .spyOn(client, 'getClientCredentials')
      .mockResolvedValue({ clientId: 'own-app-id', clientSecret: 'own-app-secret' } as never);

    return client;
  }

  beforeEach(() => {
    config.auth.oauth.callbackUrl = '';
    config.auth.oidc.publicBaseUrl = '';
    delete process.env.APP_PUBLIC_URL;
    delete process.env.APP_PUBLIC_HOSTNAME;
  });

  afterEach(() => {
    global.fetch = realFetch;
    config.auth.oauth.callbackUrl = saved.oauth;
    config.auth.oidc.publicBaseUrl = saved.publicBaseUrl;

    for (const [name, value] of [
      ['APP_PUBLIC_URL', saved.appPublicUrl],
      ['APP_PUBLIC_HOSTNAME', saved.appPublicHostname],
    ] as const) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }

    jest.restoreAllMocks();
  });

  it('sends the public base address plus /oauth/callback when only APP_BASE_URL is set', async () => {
    config.auth.oidc.publicBaseUrl = 'http://192.168.1.20:8642';

    const url = new URL(await clientWithOwnApp().getAuthorizationUrl(connection));

    expect(url.searchParams.get('redirect_uri')).toBe('http://192.168.1.20:8642/oauth/callback');
  });

  it('never sends "undefined" when no callback variable is set', async () => {
    const url = new URL(await clientWithOwnApp().getAuthorizationUrl(connection));

    expect(url.searchParams.get('redirect_uri')).toBe(`https://${config.hostname}/oauth/callback`);
  });

  it('with no address configured, sends and exchanges with the address the browser used', async () => {
    const fetchMock = jest.fn(
      async () =>
        new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), {
          status: 200,
        }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = clientWithOwnApp();
    // The connect request and, after the provider's redirect, the callback page's request.
    const connectRequest = { host: '192.168.1.20:8642', forwardedProto: 'http', secure: false };
    const callbackPageRequest = { ...connectRequest };

    const authorizeRedirect = new URL(
      await client.getAuthorizationUrl(connection, connectRequest),
    ).searchParams.get('redirect_uri');
    await client.exchangeAuthorizationCode(connection, 'code-1', callbackPageRequest);

    expect(authorizeRedirect).toBe('http://192.168.1.20:8642/oauth/callback');
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URLSearchParams(String(init.body)).get('redirect_uri')).toBe(authorizeRedirect);
  });

  it('exchanges with the redirect_uri the connection kept from its authorization', async () => {
    const fetchMock = jest.fn(
      async () =>
        new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), {
          status: 200,
        }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const kept = {
      ...connection,
      oauthRedirectUri: 'http://memory.home.arpa:8642/oauth/callback',
    } as Connection;

    await clientWithOwnApp().exchangeAuthorizationCode(kept, 'code-1', {
      host: 'evil.example',
      secure: false,
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URLSearchParams(String(init.body)).get('redirect_uri')).toBe(
      'http://memory.home.arpa:8642/oauth/callback',
    );
  });

  it('keeps the configured address whatever Host the request carries', async () => {
    config.auth.oidc.publicBaseUrl = 'http://192.168.1.20:8642';

    const url = new URL(
      await clientWithOwnApp().getAuthorizationUrl(connection, {
        host: 'evil.example',
        forwardedHost: 'evil.example',
        secure: true,
      }),
    );

    expect(url.searchParams.get('redirect_uri')).toBe('http://192.168.1.20:8642/oauth/callback');
  });

  it('exchanges the code with the same redirect_uri the authorization used', async () => {
    config.auth.oidc.publicBaseUrl = 'http://192.168.1.20:8642';
    const fetchMock = jest.fn(
      async () =>
        new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), {
          status: 200,
        }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = clientWithOwnApp();

    const authorizeRedirect = new URL(await client.getAuthorizationUrl(connection)).searchParams.get(
      'redirect_uri',
    );
    await client.exchangeAuthorizationCode(connection, 'code-1');

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URLSearchParams(String(init.body)).get('redirect_uri')).toBe(authorizeRedirect);
  });
});
