import type { Request } from 'express';

import type { RequestContext } from '@ci/common/context';
import config from '@ci/configuration';

import { GoogleClient } from '../../clients/GoogleClient';
import { ConnectionsController } from '../ConnectionsController';
import { ProvidersController } from '../ProvidersController';

jest.mock('@ci/common/outbound', () => ({
  ...jest.requireActual('@ci/common/outbound'),
  isOutboundEnabled: () => true,
}));

/**
 * The callback address the connect routes send a provider, on an install that configured none: a
 * plain production install without APP_BASE_URL. It is the address the browser used for the
 * request, as sign-in works out its own. The connection keeps it and the code exchange sends it.
 */

const GOOGLE = { id: config.auth.providers.google.id, name: 'Google', authType: 'oauth2', localOnly: false };
const CONNECTION = {
  id: 'conn-1',
  userId: 'user-1',
  providerId: GOOGLE.id,
  provider: GOOGLE,
  activeEndpoints: ['Calendar'],
  accountLabel: 'someone@example.com',
  oauthRedirectUri: null as string | null,
};
const ctx = { userId: 'user-1' } as RequestContext;

/** A request as the gateway hands it to the api, from a browser on the LAN. */
const lanRequest = (host = '192.168.1.20:8642') =>
  ({
    headers: { host, 'x-forwarded-proto': 'http' },
    secure: false,
    user: { role: 'admin' },
  }) as unknown as Request;

function makeGoogle(ownApp: boolean) {
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const google = new GoogleClient(logger as never);
  jest
    .spyOn(google, 'getClientCredentials')
    .mockResolvedValue(ownApp ? { clientId: 'own-app-id', clientSecret: 'own-app-secret' } : null);

  return google;
}

function makeProviders(ownApp: boolean) {
  const google = makeGoogle(ownApp);
  const cloudOAuthProxyService = {
    getProviderNameForId: jest.fn(() => 'google'),
    getAuthorizationUrl: jest.fn(async () => ({ authorization_url: 'https://portal.example.com/authorize' })),
  };
  const connectionService = {
    create: jest.fn(async () => CONNECTION),
    setOAuthRedirectUri: jest.fn(async () => undefined),
  };
  const controller = new ProvidersController(
    { getClientByProviderId: jest.fn(() => google) } as never,
    cloudOAuthProxyService as never,
    connectionService as never,
    { findById: jest.fn(async () => GOOGLE) } as never,
    {} as never,
    {} as never,
    { setContext: jest.fn(), log: jest.fn(), error: jest.fn() } as never,
  );

  return { controller, cloudOAuthProxyService, connectionService };
}

function makeConnections(ownApp: boolean, stored: Partial<typeof CONNECTION> = {}) {
  const google = makeGoogle(ownApp);
  const cloudOAuthProxyService = {
    getProviderNameForId: jest.fn(() => 'google'),
    getAuthorizationUrl: jest.fn(async () => ({ authorization_url: 'https://portal.example.com/authorize' })),
  };
  const connectionService = {
    findById: jest.fn(async () => ({ ...CONNECTION, ...stored })),
    search: jest.fn(async () => []),
    update: jest.fn(async () => CONNECTION),
    setOAuthRedirectUri: jest.fn(async () => undefined),
  };
  const controller = new ConnectionsController(
    { getClientByProviderId: jest.fn(() => google) } as never,
    cloudOAuthProxyService as never,
    connectionService as never,
    {} as never,
    { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
  );

  return { controller, google, cloudOAuthProxyService, connectionService };
}

/** The redirect_uri of the one code exchange `fetchMock` saw. */
function exchangedRedirectUri(fetchMock: jest.Mock): string | null {
  const tokenCall = fetchMock.mock.calls.find(([input]) => String(input).includes('/token'));

  return new URLSearchParams(String((tokenCall as unknown as [string, RequestInit])[1].body)).get(
    'redirect_uri',
  );
}

function mockGoogle() {
  const fetchMock = jest.fn(async (input: unknown) =>
    String(input).includes('/token')
      ? new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }))
      : new Response(JSON.stringify({ id: 'google-account-1' })),
  );
  global.fetch = fetchMock as unknown as typeof fetch;

  return fetchMock;
}

describe('connect routes on an install with no callback address configured', () => {
  const realFetch = global.fetch;
  const saved = {
    oauth: config.auth.oauth.callbackUrl,
    publicBaseUrl: config.auth.oidc.publicBaseUrl,
    appPublicUrl: process.env.APP_PUBLIC_URL,
    appPublicHostname: process.env.APP_PUBLIC_HOSTNAME,
  };

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

  it('POST /providers/:id sends the provider back to the address the browser used and keeps it', async () => {
    const { controller, connectionService } = makeProviders(true);

    const { authorizationUrl } = await controller.connect(
      ctx,
      GOOGLE.id,
      { endpoints: ['Calendar'] } as never,
      lanRequest('memory.home.arpa:8642'),
    );

    expect(new URL(authorizationUrl).searchParams.get('redirect_uri')).toBe(
      'http://memory.home.arpa:8642/oauth/callback',
    );
    expect(connectionService.setOAuthRedirectUri).toHaveBeenCalledWith(
      { userId: 'user-1' },
      'conn-1',
      'http://memory.home.arpa:8642/oauth/callback',
    );
  });

  it('POST /providers/:id never gives CI Portal an address read from the request', async () => {
    const { controller, cloudOAuthProxyService } = makeProviders(false);
    const forged = lanRequest('evil.example');

    await controller.connect(ctx, GOOGLE.id, { endpoints: ['Calendar'] } as never, forged);

    expect(cloudOAuthProxyService.getAuthorizationUrl).toHaveBeenCalledWith(
      'google',
      `https://${config.hostname}/oauth/callback?connectionId=conn-1`,
      expect.anything(),
    );
  });

  it('GET /connections/:id/connect does the same when reconnecting', async () => {
    const { controller, connectionService } = makeConnections(true);

    const { url } = await controller.connect(ctx, CONNECTION.id, lanRequest());

    expect(new URL(url).searchParams.get('redirect_uri')).toBe('http://192.168.1.20:8642/oauth/callback');
    expect(connectionService.setOAuthRedirectUri).toHaveBeenCalledWith(
      { userId: 'user-1' },
      'conn-1',
      'http://192.168.1.20:8642/oauth/callback',
    );
  });

  it('POST /connections/complete exchanges the code with the address the authorization kept', async () => {
    const fetchMock = mockGoogle();
    const { controller } = makeConnections(true, {
      oauthRedirectUri: 'http://memory.home.arpa:8642/oauth/callback',
    });

    // A callback request that names another host changes nothing.
    await controller.completeCallback(
      ctx,
      { flow: 'direct', state: CONNECTION.id, code: 'code-1' },
      lanRequest('evil.example'),
    );

    expect(exchangedRedirectUri(fetchMock)).toBe('http://memory.home.arpa:8642/oauth/callback');
  });

  it('POST /connections/complete works it out for the callback page when the connection kept none', async () => {
    const fetchMock = mockGoogle();
    const { controller } = makeConnections(true);

    await controller.completeCallback(
      ctx,
      { flow: 'direct', state: CONNECTION.id, code: 'code-1' },
      lanRequest(),
    );

    expect(exchangedRedirectUri(fetchMock)).toBe('http://192.168.1.20:8642/oauth/callback');
  });
});
