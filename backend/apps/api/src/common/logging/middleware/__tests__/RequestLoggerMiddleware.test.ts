import { redactRequestPath } from '../RequestLoggerMiddleware';

/**
 * The request log is mounted `forRoutes('*')`, so anything secret in a URL path
 * is written to the app log on every request. `POST
 * /api/bluebubbles/webhook/:secret` is exactly that shape: BlueBubbles' outgoing
 * webhooks carry no header auth, so the path segment IS the credential, and
 * every delivery from a working install was logging it in plaintext.
 */
describe('redactRequestPath', () => {
  it('redacts the BlueBubbles webhook secret', () => {
    expect(redactRequestPath('/api/bluebubbles/webhook/deadbeefcafe0123')).toBe(
      '/api/bluebubbles/webhook/REDACTED',
    );
  });

  /**
   * The case every real deployment actually produces, and the one the first
   * version of this redaction missed: there is no `setGlobalPrefix`, and both
   * the dev Caddy and the production nginx strip `/api` before forwarding, so
   * what this middleware receives is the BARE path. A pattern anchored on the
   * browser-facing `/api/...` form therefore matched nothing anywhere — while
   * a test that only fed it the prefixed form passed, and the credential kept
   * going to the log on every delivery.
   */
  it('redacts the bare path the server actually receives behind the proxy', () => {
    expect(redactRequestPath('/bluebubbles/webhook/deadbeefcafe0123')).toBe('/bluebubbles/webhook/REDACTED');
    expect(redactRequestPath('/bluebubbles/webhook/abc123?retry=1')).toBe(
      '/bluebubbles/webhook/REDACTED?retry=1',
    );
  });

  it('keeps the route recognizable, and survives a query string', () => {
    // "A webhook was delivered" is what the log line exists to say; dropping the
    // segment entirely would make it indistinguishable from a request that never
    // carried a secret.
    expect(redactRequestPath('/api/bluebubbles/webhook/abc123?retry=1')).toBe(
      '/api/bluebubbles/webhook/REDACTED?retry=1',
    );
  });

  /**
   * A Companion sign-in's start and callback carry an invitation, a PKCE
   * challenge, the native client's state, the Portal's authorization code and
   * the OAuth state in the query. They are single-use, but logs get pasted into
   * bug reports.
   */
  it('redacts the credentials in a Companion sign-in query, keeping the parameter names', () => {
    expect(redactRequestPath('/authenticate/oidc/callback?code=abc123&state=def456')).toBe(
      '/authenticate/oidc/callback?code=REDACTED&state=REDACTED',
    );
    expect(
      redactRequestPath(
        '/authenticate/oidc?signup_code=INVITE&client=native&code_challenge=xyz&app_state=s1&redirect=%2Fchat',
      ),
    ).toBe(
      '/authenticate/oidc?signup_code=REDACTED&client=native&code_challenge=REDACTED&app_state=REDACTED&redirect=%2Fchat',
    );
    // Behind a proxy that keeps the prefix, and with a name sent percent-encoded.
    expect(redactRequestPath('/api/authenticate/oidc/callback?c%6Fde=abc123&error=access_denied')).toBe(
      '/api/authenticate/oidc/callback?c%6Fde=REDACTED&error=access_denied',
    );
  });

  it('leaves the query of other routes alone, including a `state` that is a filter', () => {
    for (const url of ['/jobs?state=failed&limit=50', '/authenticate/oidc', '/authenticate/oidcfoo?code=1']) {
      expect(redactRequestPath(url)).toBe(url);
    }
  });

  it('leaves every other path alone', () => {
    for (const url of [
      '/api/bluebubbles/config',
      '/api/import/runs/9f1c2b7e-0000-4000-8000-000000000000',
      '/graphql?op=Memory',
    ]) {
      expect(redactRequestPath(url)).toBe(url);
    }
  });
});
