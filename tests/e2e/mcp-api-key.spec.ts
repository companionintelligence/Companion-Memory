import type { PlaywrightWorkerArgs } from '@playwright/test';

import { expect, test } from './fixtures/authenticated';

/**
 * Guards the connect recipe an external MCP client follows: mint an API key in the UI, point a
 * standard MCP client at `/api/mcp`, list tools.
 *
 * Nothing covered this before, which is how the published docs drifted to a URL the server does not
 * route. The spec deliberately exercises the transport the way a third-party client does — raw
 * JSON-RPC over Streamable HTTP — rather than through any internal helper.
 *
 * Both credential headers are asserted: `x-api-key` (long-standing) and `Authorization: Bearer`
 * (most MCP clients expose only a bearer field and cannot send a custom header).
 */

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'ci-e2e', version: '1.0' } },
};

/**
 * Mint a session for the API-only calls below. There is no shared storageState
 * file to borrow: sessions are bound to ip + user_agent and rotate with a 30s
 * grace window, so each consumer signs in for itself (see
 * `fixtures/authenticated.ts`).
 */
async function authenticatedRequestContext(playwright: PlaywrightWorkerArgs['playwright'], baseURL: string) {
  const ctx = await playwright.request.newContext({ baseURL });
  const email = process.env.AUTH_DEFAULT_USER_EMAIL || 'jsmith@example.com';
  const password = process.env.AUTH_DEFAULT_USER_PASSWORD;

  await ctx.get('/api/authenticate/csrf');
  const csrf = (await ctx.storageState()).cookies.find((c) => c.name === 'csrfToken')?.value;
  const res = await ctx.post('/api/authenticate', {
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf ?? '' },
    data: { username: email, password },
  });

  expect(res.ok(), `E2E login failed: ${res.status()} ${await res.text()}`).toBeTruthy();

  // Logging in re-mints the CSRF token from the `anon.` scope to the user's, so
  // read it back *after* the POST.
  const userCsrf = (await ctx.storageState()).cookies.find((c) => c.name === 'csrfToken')?.value ?? '';

  // `/api/keys` is behind `JwtOrPortalAuthGuard` — it wants a **bearer JWT**,
  // not the session cookie. `/authenticate/refresh` is what mints one from the
  // session, exactly as the app does on load; without it every call here is a
  // flat 401 no matter how valid the session is.
  const refreshed = await ctx.post('/api/authenticate/refresh', { headers: { 'X-CSRF-Token': userCsrf } });

  expect(
    refreshed.ok(),
    `Token refresh failed: ${refreshed.status()} ${await refreshed.text()}`,
  ).toBeTruthy();

  const { accessToken } = (await refreshed.json()) as { accessToken: string };

  return { ctx, csrf: userCsrf, accessToken };
}

/** Streamable HTTP replies as plain JSON or as an SSE `data:` line — accept either. */
function parseMcpBody(contentType: string, text: string): Record<string, unknown> {
  if (contentType.includes('application/json')) {
    return JSON.parse(text) as Record<string, unknown>;
  }

  const data = text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('');

  return JSON.parse(data) as Record<string, unknown>;
}

test.describe('MCP endpoint accepts an operator API key', () => {
  let rawKey: string;
  let keyId: string;

  test.beforeAll(async ({ playwright, baseURL }) => {
    // POST /keys is session-guarded and returns
    // the raw key exactly once — the same path a user follows in Settings → API Keys.
    const { ctx, csrf, accessToken } = await authenticatedRequestContext(playwright, baseURL!);

    try {
      const res = await ctx.post('/api/keys', {
        headers: { 'X-CSRF-Token': csrf, Authorization: `Bearer ${accessToken}` },
        data: { name: 'e2e-mcp' },
      });

      expect(res.ok(), `Key creation failed: ${res.status()} ${await res.text()}`).toBeTruthy();

      const body = (await res.json()) as { key: string; id: string };

      rawKey = body.key;
      keyId = body.id;
      expect(rawKey).toBeTruthy();
    } finally {
      await ctx.dispose();
    }
  });

  test.afterAll(async ({ playwright, baseURL }) => {
    // beforeAll may have failed before minting anything; a DELETE on `undefined` just adds a 400 to
    // the failure trace of a run that already has a real error to read.
    if (!keyId) {
      return;
    }

    const { ctx, csrf, accessToken } = await authenticatedRequestContext(playwright, baseURL!);

    try {
      await ctx.delete(`/api/keys/${keyId}`, {
        headers: { 'X-CSRF-Token': csrf, Authorization: `Bearer ${accessToken}` },
      });
    } finally {
      await ctx.dispose();
    }
  });

  for (const [label, headerFor] of [
    ['x-api-key', (key: string) => ({ 'x-api-key': key })],
    ['Authorization: Bearer', (key: string) => ({ Authorization: `Bearer ${key}` })],
  ] as const) {
    test(`initialize and tools/list succeed with ${label}`, async ({ playwright, baseURL }) => {
      const ctx = await playwright.request.newContext({ baseURL });

      try {
        const initRes = await ctx.post('/api/mcp', {
          headers: {
            ...headerFor(rawKey),
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          data: INITIALIZE,
        });

        expect(initRes.status(), `initialize rejected with ${label}`).toBe(200);

        const sessionId = initRes.headers()['mcp-session-id'];
        expect(sessionId, 'initialize must issue an Mcp-Session-Id').toBeTruthy();

        const initBody = parseMcpBody(initRes.headers()['content-type'] ?? '', await initRes.text());
        expect((initBody.result as { serverInfo: { name: string } }).serverInfo.name).toBe(
          'companion-memory',
        );

        const listRes = await ctx.post('/api/mcp', {
          headers: {
            ...headerFor(rawKey),
            'Mcp-Session-Id': sessionId,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          data: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        });

        expect(listRes.status()).toBe(200);

        const listBody = parseMcpBody(listRes.headers()['content-type'] ?? '', await listRes.text());
        const { tools } = listBody.result as { tools: Array<{ name: string }> };

        expect(tools.length).toBeGreaterThan(0);
      } finally {
        await ctx.dispose();
      }
    });
  }

  test('rejects a request with no credential', async ({ playwright, baseURL }) => {
    const ctx = await playwright.request.newContext({ baseURL });

    try {
      const res = await ctx.post('/api/mcp', {
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        data: INITIALIZE,
      });

      expect(res.status()).toBe(401);
    } finally {
      await ctx.dispose();
    }
  });
});
