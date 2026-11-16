import config from '@ci/configuration';

import { oauthCallbackUrl, openIdCallbackUrl } from './callbackUrls';

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
  };

  /** Nothing set but the hostname, which always has a value (its default is ci-server.localhost). */
  function nothingSet() {
    config.auth.oauth.callbackUrl = '';
    config.auth.openid.callbackUrl = '';
    config.auth.oidc.publicBaseUrl = '';
    config.hostname = 'memory.example.com';
    delete process.env.APP_PUBLIC_URL;
  }

  beforeEach(nothingSet);

  afterEach(() => {
    config.auth.oauth.callbackUrl = saved.oauth;
    config.auth.openid.callbackUrl = saved.openid;
    config.auth.oidc.publicBaseUrl = saved.publicBaseUrl;
    config.hostname = saved.hostname;

    if (saved.appPublicUrl === undefined) {
      delete process.env.APP_PUBLIC_URL;
    } else {
      process.env.APP_PUBLIC_URL = saved.appPublicUrl;
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
});
