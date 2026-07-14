import fs from 'node:fs';
import path from 'node:path';

import { request } from '@playwright/test';

const AUTH_FILE = path.resolve(__dirname, '../../playwright/.auth/user.json');

/**
 * Log in once over HTTP (mirroring the app's useAuth flow: GET csrf → POST
 * authenticate with the X-CSRF-Token header) and persist the resulting cookies
 * — including the httpOnly session cookie — to storageState. Every authenticated
 * spec reuses this; on first navigation the app's refresh-on-load re-mints the
 * JWT from the session cookie. The UI login path itself is covered by
 * auth.spec.ts, which runs logged-out.
 */
export default async function globalSetup() {
  const baseURL = process.env.E2E_BASE_URL || `http://localhost:${process.env.E2E_WEB_PORT || 5173}`;
  const email = process.env.AUTH_DEFAULT_USER_EMAIL || 'jsmith@example.com';
  const password = process.env.AUTH_DEFAULT_USER_PASSWORD;

  if (!password) {
    throw new Error('AUTH_DEFAULT_USER_PASSWORD must be set for E2E (matches the seeded user).');
  }

  const ctx = await request.newContext({ baseURL });

  // 1) Pre-fetch CSRF — sets the csrfToken cookie in this context.
  await ctx.get('/api/authenticate/csrf');
  const { cookies } = await ctx.storageState();
  const csrf = cookies.find((c) => c.name === 'csrfToken')?.value;
  if (!csrf) {
    throw new Error('E2E login failed: csrfToken cookie was not set by /api/authenticate/csrf');
  }

  // 2) Authenticate — the server sets the session cookie.
  const res = await ctx.post('/api/authenticate', {
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    data: { username: email, password },
  });

  if (!res.ok()) {
    throw new Error(`E2E login failed (${res.status()}): ${await res.text()}`);
  }

  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  await ctx.storageState({ path: AUTH_FILE });
  await ctx.dispose();
}
