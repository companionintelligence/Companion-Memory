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
    expect(redactRequestPath('/bluebubbles/webhook/deadbeefcafe0123')).toBe(
      '/bluebubbles/webhook/REDACTED',
    );
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
