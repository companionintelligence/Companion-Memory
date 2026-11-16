import config from '@ci/configuration';
import { resolveOidcCallbackUrl } from '@ci/domains/auth/utils/oidcCallbackUrl';

import {
  type CallbackRequestOrigin,
  callbackRequestOrigin,
  exchangeRedirectUri,
  oauthCallbackUrl,
  oauthCallbackUrlForConnection,
  openIdCallbackUrl,
  sentRedirectUri,
} from './callbackUrls';

/**
 * The addresses a connected service sends the person back to. A plain production install passed
 * none of the variables to the api. Every fallback was `${process.env.APP_PUBLIC_URL}/...`, so
 * the OAuth Setup dialog asked people to register "undefined/oauth/callback".
 */
describe('connection callback addresses', () => {
  const saved = {
    oauth: config.auth.oauth.callbackUrl,
    openid: config.auth.openid.callbackUrl,
    publicBaseUrl: config.auth.oidc.publicBaseUrl,
    hostname: config.hostname,
    appPublicUrl: process.env.APP_PUBLIC_URL,
    appPublicHostname: process.env.APP_PUBLIC_HOSTNAME,
  };

  /** Nothing set but the hostname, which always has a value (its default is ci-server.localhost). */
  function nothingSet() {
    config.auth.oauth.callbackUrl = '';
    config.auth.openid.callbackUrl = '';
    config.auth.oidc.publicBaseUrl = '';
    config.hostname = 'memory.example.com';
    delete process.env.APP_PUBLIC_URL;
    delete process.env.APP_PUBLIC_HOSTNAME;
  }

  beforeEach(nothingSet);

  afterEach(() => {
    config.auth.oauth.callbackUrl = saved.oauth;
    config.auth.openid.callbackUrl = saved.openid;
    config.auth.oidc.publicBaseUrl = saved.publicBaseUrl;
    config.hostname = saved.hostname;

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
  });

  it('never builds an address from an unset variable', () => {
    expect(oauthCallbackUrl()).toBe('https://memory.example.com/oauth/callback');
    expect(openIdCallbackUrl()).toBe('https://memory.example.com/openid/callback');

    for (const url of [oauthCallbackUrl(), openIdCallbackUrl()]) {
      expect(url).not.toContain('undefined');
      expect(url).not.toContain('null');
    }
  });

  it('builds both from the public base address (APP_BASE_URL), without a doubled slash', () => {
    config.auth.oidc.publicBaseUrl = 'http://192.168.1.20:8642/';

    expect(oauthCallbackUrl()).toBe('http://192.168.1.20:8642/oauth/callback');
    expect(openIdCallbackUrl()).toBe('http://192.168.1.20:8642/openid/callback');
  });

  it('prefers APP_PUBLIC_URL to APP_BASE_URL, as the old fallback did', () => {
    config.auth.oidc.publicBaseUrl = 'http://192.168.1.20:8642';
    process.env.APP_PUBLIC_URL = 'https://memory.example.org';

    expect(oauthCallbackUrl()).toBe('https://memory.example.org/oauth/callback');
  });

  it('uses OAUTH_CALLBACK_URL and OPENID_CALLBACK_URL as given when they are set', () => {
    config.auth.oidc.publicBaseUrl = 'http://192.168.1.20:8642';
    process.env.APP_PUBLIC_URL = 'https://memory.example.org';
    config.auth.oauth.callbackUrl = 'https://connect.example.com/oauth/callback';
    config.auth.openid.callbackUrl = 'https://connect.example.com/openid/callback';

    expect(oauthCallbackUrl()).toBe('https://connect.example.com/oauth/callback');
    expect(openIdCallbackUrl()).toBe('https://connect.example.com/openid/callback');
  });

  it('treats a blank value as unset', () => {
    config.auth.oauth.callbackUrl = '   ';
    process.env.APP_PUBLIC_URL = '';
    config.auth.oidc.publicBaseUrl = ' ';

    expect(oauthCallbackUrl()).toBe('https://memory.example.com/oauth/callback');
  });

  it('collapses the doubled slash the compose files give when APP_BASE_URL ends in one', () => {
    config.auth.oauth.callbackUrl = 'http://192.168.1.20:8642//oauth/callback';
    config.auth.openid.callbackUrl = 'http://192.168.1.20:8642//openid/callback';

    expect(oauthCallbackUrl()).toBe('http://192.168.1.20:8642/oauth/callback');
    expect(openIdCallbackUrl()).toBe('http://192.168.1.20:8642/openid/callback');
  });

  it('leaves a set OAUTH_CALLBACK_URL otherwise untouched, query and case included', () => {
    config.auth.oauth.callbackUrl = 'https://Connect.Example.com/oauth/callback?tenant=a//b';

    expect(oauthCallbackUrl()).toBe('https://Connect.Example.com/oauth/callback?tenant=a//b');
  });

  it('passes over a base address with no scheme', () => {
    process.env.APP_PUBLIC_URL = 'memory.example.org';
    config.auth.oidc.publicBaseUrl = 'http://192.168.1.20:8642';

    expect(oauthCallbackUrl()).toBe('http://192.168.1.20:8642/oauth/callback');

    config.auth.oidc.publicBaseUrl = '192.168.1.20:8642';

    expect(openIdCallbackUrl()).toBe('https://memory.example.com/openid/callback');
  });

  it('adds the connection id to the proxied callback with the right separator', () => {
    config.auth.oidc.publicBaseUrl = 'http://192.168.1.20:8642';

    expect(oauthCallbackUrlForConnection('conn-1')).toBe(
      'http://192.168.1.20:8642/oauth/callback?connectionId=conn-1',
    );

    config.auth.oauth.callbackUrl = 'https://connect.example.com/oauth/callback?tenant=a';

    expect(oauthCallbackUrlForConnection('conn-1')).toBe(
      'https://connect.example.com/oauth/callback?tenant=a&connectionId=conn-1',
    );
  });

  describe('on an install with no address configured', () => {
    /** A browser on the LAN talking to the gateway over plain HTTP, as on a plain install. */
    const lan: CallbackRequestOrigin = { host: '192.168.1.20:8642', forwardedProto: 'http', secure: false };

    it('builds both from the address the browser used', () => {
      expect(oauthCallbackUrl(lan)).toBe('http://192.168.1.20:8642/oauth/callback');
      expect(openIdCallbackUrl(lan)).toBe('http://192.168.1.20:8642/openid/callback');
    });

    it('keeps an APP_PUBLIC_HOSTNAME the install sets ahead of the request', () => {
      process.env.APP_PUBLIC_HOSTNAME = 'memory.example.com';

      expect(oauthCallbackUrl(lan)).toBe('https://memory.example.com/oauth/callback');
      expect(openIdCallbackUrl(lan)).toBe('https://memory.example.com/openid/callback');
    });

    it('follows a hostname and the scheme a TLS proxy in front reports', () => {
      expect(oauthCallbackUrl({ host: 'memory.home.arpa:8642', secure: false })).toBe(
        'http://memory.home.arpa:8642/oauth/callback',
      );
      expect(
        oauthCallbackUrl({ host: 'memory.example.com', forwardedProto: 'https, http', secure: false }),
      ).toBe('https://memory.example.com/oauth/callback');
    });

    it('reads the same headers sign-in does, so both name the same origin', () => {
      const requests: CallbackRequestOrigin[] = [
        lan,
        { host: 'memory.home.arpa:8642', secure: false },
        {
          host: 'gateway:8642',
          forwardedHost: 'memory.example.com, gateway',
          forwardedProto: 'https',
          secure: false,
        },
        { host: 'memory.example.com', forwardedHost: ['memory.example.com'], secure: true },
      ];

      for (const request of requests) {
        const signIn = new URL(resolveOidcCallbackUrl(request, '')).origin;

        expect(new URL(oauthCallbackUrl(request)).origin).toBe(signIn);
      }
    });

    it('writes the origin the way the browser compares it', () => {
      expect(oauthCallbackUrl({ host: 'Memory.Home.Arpa:80', secure: false })).toBe(
        'http://memory.home.arpa/oauth/callback',
      );
      expect(oauthCallbackUrl({ host: '[fd00::20]:8642', secure: false })).toBe(
        'http://[fd00::20]:8642/oauth/callback',
      );
    });

    it.each([
      ['a path', 'evil.example/oauth/callback?'],
      ['a user name', 'user@evil.example'],
      ['a query', 'evil.example?x='],
      ['a space', 'evil.example x'],
      ['a backslash', 'evil.example\\@other.example'],
      ['a port past 65535', 'memory.example.com:99999'],
    ])('falls back to the hostname for a forwarded host with %s', (_what, forwardedHost) => {
      expect(oauthCallbackUrl({ host: '192.168.1.20:8642', forwardedHost, secure: false })).toBe(
        'https://memory.example.com/oauth/callback',
      );
    });

    it('falls back to the hostname for a scheme that is not http or https', () => {
      expect(
        oauthCallbackUrl({ host: '192.168.1.20:8642', forwardedProto: 'javascript', secure: false }),
      ).toBe('https://memory.example.com/oauth/callback');
    });
  });

  it('never reads the request on an install that knows its address', () => {
    const forged: CallbackRequestOrigin = {
      host: 'evil.example',
      forwardedHost: 'evil.example',
      secure: true,
    };

    config.auth.oidc.publicBaseUrl = 'http://192.168.1.20:8642';
    expect(oauthCallbackUrl(forged)).toBe('http://192.168.1.20:8642/oauth/callback');
    expect(openIdCallbackUrl(forged)).toBe('http://192.168.1.20:8642/openid/callback');

    process.env.APP_PUBLIC_URL = 'https://memory.example.org';
    expect(oauthCallbackUrl(forged)).toBe('https://memory.example.org/oauth/callback');

    config.auth.oauth.callbackUrl = 'https://connect.example.com/oauth/callback';
    expect(oauthCallbackUrl(forged)).toBe('https://connect.example.com/oauth/callback');
  });

  it('gives CI Portal only a configured address, never one read from a request', () => {
    // oauthCallbackUrlForConnection takes no request at all. With nothing configured it is the
    // hostname fallback; a CI Portal connect needs a Hub, which configures APP_BASE_URL.
    expect(oauthCallbackUrlForConnection('conn-1')).toBe(
      'https://memory.example.com/oauth/callback?connectionId=conn-1',
    );
  });

  describe('the redirect_uri a code exchange sends', () => {
    const lan: CallbackRequestOrigin = { host: '192.168.1.20:8642', secure: false };

    it('is the one the authorization was sent with, whatever the callback request says', () => {
      const connection = { oauthRedirectUri: 'http://memory.home.arpa:8642/oauth/callback' };

      expect(exchangeRedirectUri(connection, lan)).toBe('http://memory.home.arpa:8642/oauth/callback');
      expect(exchangeRedirectUri(connection, { host: 'evil.example', secure: true })).toBe(
        'http://memory.home.arpa:8642/oauth/callback',
      );
    });

    it('is worked out for the callback request when the connection kept none', () => {
      expect(exchangeRedirectUri({ oauthRedirectUri: null }, lan)).toBe(
        'http://192.168.1.20:8642/oauth/callback',
      );
      expect(exchangeRedirectUri({ oauthRedirectUri: '  ' }, lan)).toBe(
        'http://192.168.1.20:8642/oauth/callback',
      );
    });

    it('reads what an authorization address sends', () => {
      expect(
        sentRedirectUri(
          'https://accounts.example.com/auth?client_id=a&redirect_uri=http%3A%2F%2F192.168.1.20%3A8642%2Foauth%2Fcallback',
        ),
      ).toBe('http://192.168.1.20:8642/oauth/callback');
      expect(sentRedirectUri('https://accounts.example.com/auth?client_id=a')).toBeNull();
      expect(sentRedirectUri('not a url')).toBeNull();
    });
  });

  describe('callbackRequestOrigin', () => {
    it('reads the four values sign-in reads from the request', () => {
      expect(
        callbackRequestOrigin({
          headers: {
            host: '192.168.1.20:8642',
            'x-forwarded-host': 'memory.example.com',
            'x-forwarded-proto': 'https',
            cookie: 'not read',
          },
          secure: false,
        }),
      ).toEqual({
        host: '192.168.1.20:8642',
        forwardedHost: 'memory.example.com',
        forwardedProto: 'https',
        secure: false,
      });
    });

    it('is undefined without a request, which leaves the hostname fallback', () => {
      expect(callbackRequestOrigin(undefined)).toBeUndefined();
      expect(callbackRequestOrigin({})).toBeUndefined();
      expect(oauthCallbackUrl(callbackRequestOrigin(undefined))).toBe(
        'https://memory.example.com/oauth/callback',
      );
    });

    it('leaves the hostname fallback for a request that names no host', () => {
      expect(oauthCallbackUrl(callbackRequestOrigin({ headers: {}, secure: false }))).toBe(
        'https://memory.example.com/oauth/callback',
      );
      expect(oauthCallbackUrl({ host: '  ', forwardedHost: ' , gateway', secure: false })).toBe(
        'https://memory.example.com/oauth/callback',
      );
    });
  });
});
