import { AuthError, resolveAuthStrategy } from '../authStrategies';
import type { SigningRequest } from '../authStrategies';

const NO_REQUEST: SigningRequest = { method: 'GET', url: 'https://api.example.com/x', parameters: {} };

describe('auth strategies', () => {
  describe('basic', () => {
    it('emits a base64 Authorization header', () => {
      const strategy = resolveAuthStrategy('basic')!;
      const signature = strategy.sign({}, { username: 'user', password: 'pass' }, NO_REQUEST);

      expect(signature.headers?.Authorization).toBe(`Basic ${Buffer.from('user:pass').toString('base64')}`);
      expect(signature.identity).toBe('basic:user');
    });
  });

  describe('oauth2', () => {
    it('throws AuthError without an access token', () => {
      const strategy = resolveAuthStrategy('oauth2')!;

      expect(() => strategy.sign({}, {}, NO_REQUEST)).toThrow(AuthError);
    });

    it('signs via Bearer header when signature mode is header', () => {
      const strategy = resolveAuthStrategy('oauth2')!;
      const signature = strategy.sign({ signature: 'header' }, { access_token: 'tok' }, NO_REQUEST);

      expect(signature.headers?.Authorization).toBe('Bearer tok');
    });

    it('signs via query parameter by default', () => {
      const strategy = resolveAuthStrategy('oauth2')!;
      const signature = strategy.sign({}, { access_token: 'tok' }, NO_REQUEST);

      expect(signature.parameters?.access_token).toBe('tok');
    });
  });

  describe('oauth1', () => {
    // The worked HMAC-SHA1 example from the Twitter API signing guide
    // (also derivable from RFC 5849 §3.4): known inputs → known signature.
    const schema = {
      type: 'oauth1',
      auth_key: 'xvz1evFS4wEEPTGEFPHBog',
      auth_secret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
    };
    const credentials = {
      oauth_token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
      oauth_token_secret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
      oauth_nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
      oauth_timestamp: '1318622958',
    };
    const request: SigningRequest = {
      method: 'POST',
      url: 'https://api.twitter.com/1/statuses/update.json',
      parameters: {
        include_entities: 'true',
        status: 'Hello Ladies + Gentlemen, a signed OAuth request!',
      },
    };

    it('produces the RFC 5849 HMAC-SHA1 signature for the known vector', () => {
      const strategy = resolveAuthStrategy('oauth1')!;
      const signature = strategy.sign(schema, credentials, request);
      const header = signature.headers?.Authorization ?? '';

      expect(header.startsWith('OAuth ')).toBe(true);
      // tnnArxj06cWHq44gCs1OSKk/jLY= percent-encoded within the header.
      expect(header).toContain('oauth_signature="tnnArxj06cWHq44gCs1OSKk%2FjLY%3D"');
      expect(header).toContain('oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog"');
      expect(header).toContain('oauth_signature_method="HMAC-SHA1"');
      expect(header).toContain('oauth_version="1.0"');
    });

    it('throws AuthError when the map schema lacks consumer credentials', () => {
      const strategy = resolveAuthStrategy('oauth1')!;

      expect(() => strategy.sign({ type: 'oauth1' }, credentials, request)).toThrow(AuthError);
    });

    it('signs two-legged requests without a token', () => {
      const strategy = resolveAuthStrategy('oauth1')!;
      const signature = strategy.sign(
        schema,
        { oauth_nonce: 'fixed', oauth_timestamp: '1318622958' },
        request,
      );

      const header = signature.headers?.Authorization ?? '';

      expect(header).not.toContain('oauth_token=');
      expect(header).toContain('oauth_signature="');
      expect(signature.identity).toBe('oauth1:xvz1evFS4wEEPTGEFPHBog');
    });
  });

  describe('openid', () => {
    it('throws AuthError without a key', () => {
      const strategy = resolveAuthStrategy('openid')!;

      expect(() => strategy.sign({}, {}, NO_REQUEST)).toThrow(AuthError);
    });
  });
});
